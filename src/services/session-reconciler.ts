import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { projects, sessions, tasks } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { resolveBackend } from "./session-backend.js";
import { HostRequestError } from "./remote-host-client.js";
import { closeSessionBrowserBindings } from "./session-browsers.js";
import { cleanupPreviewWorktree } from "./git-worktree.js";
import { syncTaskTransition } from "./task-github-sync.js";
import { recordTaskTransition } from "./task-state.js";

/**
 * Detects sessions whose program exited on its own — user typed `exit`, a
 * crash — rather than via an explicit DELETE /api/sessions/:id. Fixes the
 * M2-era gap: such a session left a stale dtach socket with `status` still
 * "active" forever, so the next getOrCreate() would silently bootstrap a
 * fresh program under the same id instead of surfacing that it had ended.
 *
 * Source of truth is each host's own isMasterAlive (the session's systemd
 * scope on whichever host owns it — local via app.pty, remote via
 * SessionBackend/RemoteHostClient), not anything tracked in this process's
 * memory — so this correctly catches a session that exited before this
 * process ever re-attached to it (e.g. right after a restart). Only
 * "active" rows are checked: "killed" and previously-reconciled "exited"
 * rows are already-settled and skipped.
 *
 * Grouped and queried one bulk call per host (issue #26) rather than one
 * call per session — and critically, a host that's merely unreachable right
 * now is *skipped entirely*, never treated as "every session on it is
 * dead": a transient network blip to a healthy remote agent must never
 * mass-flip its sessions to "exited" (the dtach masters are almost
 * certainly still fine; only an affirmative "not alive" from a *reachable*
 * host is trusted).
 */
export async function reconcileExitedSessions(app: FastifyInstance): Promise<void> {
  const active = app.db
    .select({ session: sessions, hostId: projects.hostId })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(eq(sessions.status, "active"))
    .all();
  if (active.length === 0) return;

  const byHost = new Map<string, typeof active>();
  for (const row of active) {
    const group = byHost.get(row.hostId) ?? [];
    group.push(row);
    byHost.set(row.hostId, group);
  }

  await Promise.all(
    [...byHost.entries()].map(async ([hostId, rows]) => {
      const backend = resolveBackend(app, hostId);
      let aliveById: Record<string, boolean>;
      try {
        aliveById = await backend.isMasterAlive(rows.map((r) => String(r.session.id)));
      } catch (err) {
        // Still skip either way (no per-session data survives a thrown
        // bulk call, from either error) — but a HostRequestError means the
        // host IS reachable and just rejected the request (a real,
        // persistent agent-side bug, not a transient blip), so unlike
        // HostUnreachableError it will keep recurring every cycle without
        // ever resolving on its own. Logged distinctly so that's visible
        // to an operator rather than reading identically to "network blip."
        if (err instanceof HostRequestError) {
          app.log.warn(
            { hostId, err },
            "session reconcile: host rejected the liveness request (reachable but erroring), skipping its sessions",
          );
        } else {
          app.log.warn(
            { hostId, err },
            "session reconcile: host unreachable, skipping its sessions",
          );
        }
        return;
      }

      for (const row of rows) {
        const alive = aliveById[String(row.session.id)];
        // A key this reachable host's response simply omitted (agent
        // version skew, a partial/malformed body) is "unknown," not "not
        // alive" — `alive === false` (an *explicit* answer) is the only
        // thing allowed to flip a row to exited. Treating a missing key as
        // false would hit the exact mass-exit landmine this PR exists to
        // avoid, just one layer deeper than "host unreachable."
        if (alive === undefined) {
          app.log.warn(
            { hostId, sessionId: row.session.id },
            "session reconcile: host omitted liveness for this session, skipping",
          );
          continue;
        }
        if (alive) continue;

        // Stop tracking our now-orphaned attach-client, if any (only
        // meaningful for a local session — a remote agent's own PtyManager
        // has nothing tracked here to clear), then mark the row so
        // terminal.ts's preValidation stops offering to reattach to it.
        if (hostId === LOCAL_HOST_ID) {
          app.pty.kill(String(row.session.id));
          // B9 — this loop already confirmed via isMasterAlive that the
          // process is genuinely gone (not just detached), so any seed
          // stashed for this id (the promote flow) can never be picked up
          // by a SessionStart hook now — discard it rather than leaking it
          // forever. See PtyManager.discardPendingSeed's own doc comment
          // for why this must NOT happen inside kill() itself.
          app.pty.discardPendingSeed(String(row.session.id));
        }

        // A9 — kill/attach TOCTOU: flip the row to "exited" BEFORE awaiting
        // cleanupPreviewWorktree below, not after.
        //
        // This deliberately OVERRIDES PR #341's original ordering (see git
        // blame), which flipped status only after a successful cleanup
        // specifically so a failed cleanup left the row "active" for a
        // future reconcile pass to retry. That protection is no longer
        // needed, and keeping it open a real orphan window: while the row
        // still reads "active", a `/ws/terminal` upgrade for this exact
        // session — one this loop has already confirmed via isMasterAlive
        // is NOT alive — passes preValidation and the attach re-check (both
        // just read `active`), and bootstrapMaster() spins up a brand-new
        // systemd-run scope for it. This loop then finishes and flips the
        // row to "exited" underneath that brand-new master, orphaning it
        // exactly like A9's other call site (session-lifecycle.ts's
        // killSession).
        //
        // Flipping unconditionally (rather than gating this write itself on
        // "active") is safe because the thing PR #341's ordering
        // protected — worktree-removal retry — no longer depends on it:
        // cleanupPreviewWorktree() (git-worktree.ts) already marks a failed
        // removal `pendingRemoval` and the module's own 5s sync tick
        // retries it forever, independent of this row's `status`. That's
        // the exact mechanism killSession (session-lifecycle.ts) already
        // relies on for the identical case, so this reconciler is now
        // consistent with it rather than carrying its own bespoke
        // stay-active-and-retry path.
        //
        // CAS'd on `status = "active"` (issue #988's residual gap, on top
        // of #1001's fix) — this SELECT's own snapshot of "active" rows can
        // go stale during the `isMasterAlive`/`isMasterAliveBatch` call
        // above: task-reseed.ts's force re-seed (`reseedTaskIfSessionExited`)
        // flips a still-active session to "killed" BEFORE it awaits its own
        // `terminate()`, precisely so a slow-to-stop scope stays out of this
        // sweep's reach for the whole stop window (#1001). But if that
        // terminate's target process responds to SIGTERM fast enough,
        // `isMasterAlive` can legitimately observe "not alive" for a row
        // this pass already fetched a moment earlier — i.e. the exact
        // moment BEFORE the kill-CAS landed. Writing here unconditionally
        // would silently overwrite that "killed" back to "exited" and, far
        // worse, fall through into the task-failure/worktree-removal block
        // below for a task whose re-seed is still actively spawning into
        // that exact worktree — task 258971's incident, PR #136. `changes
        // === 0` means some other writer already won that race for this
        // session; that writer owns resolving whatever it's claimed to
        // (task-reseed's own success/rollback path, or a plain kill), so
        // this pass backs off from the task-level teardown entirely rather
        // than racing it. This creates no NEW stuck-task exposure: any
        // writer that moves a session off "active" already drops it out of
        // this sweep's own re-queried WHERE clause on every later tick
        // regardless (e.g. a human directly killing a task's worker session
        // via DELETE /api/sessions/:id today never gets caught here either)
        // — losing this CAS just makes the in-flight tick consistent with
        // how every subsequent tick would already treat the row.
        const flipped = app.db
          .update(sessions)
          .set({ status: "exited" })
          .where(and(eq(sessions.id, row.session.id), eq(sessions.status, "active")))
          .run();

        // Unconditional regardless of the CAS above — both are keyed to
        // this session id alone (a preview-worktree binding, a browser
        // binding), idempotent no-ops if already cleared, and correct to
        // run either way since `isMasterAlive` already confirmed the real
        // OS-level process is gone: whether THIS pass or some other writer
        // owns the DB row's terminal transition doesn't change that.
        const cleaned = await cleanupPreviewWorktree(row.session.id, app.log);
        // #182 — same teardown as the user-initiated DELETE path
        // (session-lifecycle.ts's killSession), for the auto-detected
        // program-exited-on-its-own case.
        closeSessionBrowserBindings(app, row.session.id);

        if (flipped.changes === 0) {
          app.log.info(
            { sessionId: row.session.id, hostId },
            "session reconcile: lost the race to flip this session to exited — another writer already claimed its terminal transition (e.g. an in-flight re-seed), skipping this task's own teardown",
          );
          continue;
        }

        // Phase 6 Task Master (6.2/#215, issue #282) — a task claimed by
        // this session dies with it if the session exits before the task
        // reached "reviewing" (the turn is over and the work is committed
        // on its branch by then — see task-state.ts's own comment on why
        // "reviewing" is deliberately NOT session-liveness-dependent). No
        // longer gated on `cleaned`: that gate existed only to keep this
        // transition in lockstep with a session row that could still be
        // "active" on a retry pass (PR #341) — now that the row above
        // always flips to "exited" on this same pass, there is no future
        // retry pass to desync against, so gating this on worktree-removal
        // success would just mean a session whose worktree happened to fail
        // to remove leaves its task stuck at "claimed"/"in_progress"
        // forever, with nothing left to ever revisit it.
        //
        // Captured before the UPDATE below, purely so the transition event
        // can report an accurate `from` — `.returning()` only gives back
        // the row's NEW values, not what it was before this write.
        const [taskBeforeExit] = app.db
          .select({ id: tasks.id, status: tasks.status })
          .from(tasks)
          .where(
            and(
              eq(tasks.sessionId, row.session.id),
              inArray(tasks.status, ["claimed", "in_progress"]),
            ),
          )
          .all();
        const [updatedTask] = app.db
          .update(tasks)
          .set({
            status: "failed",
            failureReason: "session exited before the task reached reviewing",
            completedAt: new Date(),
          })
          .where(
            and(
              eq(tasks.sessionId, row.session.id),
              inArray(tasks.status, ["claimed", "in_progress"]),
            ),
          )
          .returning()
          .all();
        if (updatedTask) {
          recordTaskTransition(app, {
            taskId: updatedTask.id,
            projectId: updatedTask.projectId,
            from: (taskBeforeExit?.status as "claimed" | "in_progress" | undefined) ?? "claimed",
            to: "failed",
            via: "session-death",
            context: { sessionId: row.session.id },
          });
          const [project] = app.db
            .select()
            .from(projects)
            .where(eq(projects.id, updatedTask.projectId))
            .all();
          if (project) {
            await syncTaskTransition(app, updatedTask, project, "failed");
            // 6.8/#283 — same best-effort, leave-dirty-trees-in-place
            // posture as task-reconciler.ts's budget-exceeded path.
            if (updatedTask.worktreePath) {
              await resolveBackend(app, project.hostId)
                .removeWorktreeIfClean(updatedTask.worktreePath, project.cwd)
                .catch((err) => {
                  app.log.warn(
                    { err, taskId: updatedTask.id, worktreePath: updatedTask.worktreePath },
                    "session reconcile: removeWorktreeIfClean threw after task failure",
                  );
                });
            }
          }
        }
        app.log.info(
          { sessionId: row.session.id, hostId, worktreeCleaned: cleaned },
          "session reconciled: program exited on its own",
        );
      }
    }),
  );
}
