import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { projects, sessions, tasks } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { resolveBackend } from "./session-backend.js";
import { HostRequestError } from "./remote-host-client.js";
import { closeSessionBrowserBindings } from "./session-browsers.js";
import { cleanupPreviewWorktree } from "./git-worktree.js";

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
        if (hostId === LOCAL_HOST_ID) app.pty.kill(String(row.session.id));
        // Clean up preview worktrees BEFORE flipping status (Hermes/Claude
        // review, PR #341). If removal fails, a future reconcile pass
        // still finds the row as "active" and retries; flipping first
        // would permanently orphan the entry.
        const cleaned = await cleanupPreviewWorktree(row.session.id, app.log);
        // #182 — same teardown as the user-initiated DELETE path
        // (routes/sessions.ts's killSession), for the auto-detected
        // program-exited-on-its-own case.
        closeSessionBrowserBindings(app, row.session.id);
        // Only flip to exited when worktree cleanup succeeded (or there was
        // nothing to clean). On failure the row stays active so the next
        // reconcile pass retries cleanupPreviewWorktree.
        if (cleaned) {
          app.db
            .update(sessions)
            .set({ status: "exited" })
            .where(eq(sessions.id, row.session.id))
            .run();
          // Phase 6 Task Master (6.2/#215, issue #282) — a task claimed by
          // this session dies with it if the session exits before the task
          // reached "reviewing" (the turn is over and the work is
          // committed on its branch by then — see task-state.ts's own
          // comment on why "reviewing" is deliberately NOT
          // session-liveness-dependent). Inside this same `if (cleaned)`
          // block, not a separate uncoordinated write: putting it outside
          // would let the two flips desync when cleanup fails and this
          // pass retries — the task would flip to failed on an attempt
          // whose worktree cleanup then failed and got retried, mismatched
          // against a session row still "active".
          const taskUpdate = app.db
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
            .run();
          if (taskUpdate.changes > 0) {
            app.log.info(
              { sessionId: row.session.id, to: "failed" },
              "task reconcile: transitioned (session exited)",
            );
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
