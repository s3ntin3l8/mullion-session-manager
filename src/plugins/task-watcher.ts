import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { startTaskWatcher } from "../services/task-watcher.js";
import { resolveBackend } from "../services/session-backend.js";
import { HostRequestError, HostUnreachableError } from "../services/remote-host-client.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { resolveTaskMasterConfig } from "../services/task-config.js";

// Statuses a task-owned worktree is still "in use" for — the same
// non-terminal set task-reconciler.ts polls, minus "backlog"/"ready" (never
// have a worktreePath at all — that's only stamped after a successful
// claim) and "done"/"failed" (routes/tasks.ts and the reconcilers already
// clean those up via removeWorktreeIfClean at the moment they transition;
// see this file's own boot-sweep doc comment for why this exists anyway).
const ACTIVE_WORKTREE_STATUSES = ["claimed", "in_progress", "reviewing"] as const;

/**
 * Phase 6's 6.8 (issue #283), widened to remote hosts by #484 — a boot-time
 * sweep that removes task worktrees left behind by a crash-mid-cleanup or
 * an out-of-band `rm -rf` of the DB but not the filesystem (or vice versa).
 * The steady-state cleanup paths (routes/tasks.ts's approve,
 * task-reconciler.ts's budget-exceeded path, session-reconciler.ts's
 * session-exit path) already remove a task's worktree the moment it goes
 * done/failed — this exists only for what those miss: a worktree whose
 * task row was deleted/reset entirely, or whose cleanup call itself never
 * got to run (a mid-cleanup process kill).
 *
 * Every project is grouped by host and swept via `resolveBackend`
 * (`listTaskWorktreeDirs`/`pruneWorktrees`, both already host-aware) rather
 * than reading the primary's own filesystem directly — mirrors
 * task-reconciler.ts's own byHost grouping shape exactly, including
 * fail-fast per host, but ONLY on a transport-level failure
 * (`HostUnreachableError`, or a `HostRequestError` whose `statusCode` is
 * specifically `404` — a missing route, confirming this host's agent build
 * predates #484's proxy routes; any OTHER 4xx is a per-project problem, see
 * the catch block's own comment) — the rest of that host's projects are
 * skipped rather than paying N serial request timeouts inside the
 * `onReady` hook, since a host that's down (or genuinely too old) for one
 * project is down/too-old for all of them. Host-unreachable is expected
 * and fine here — claim-time `clearOrphanedTaskWorktree` (already
 * remote-capable since #283) remains the correctness backstop, so a host
 * that's down at boot just gets its orphan cleanup deferred, never lost.
 *
 * Any OTHER error (Hermes review, PR #590 — e.g. a local DB read glitch
 * inside this loop) is per-project, exactly like the pre-#484 local-only
 * sweep and task-reconciler.ts's own per-row try/catches elsewhere: logged
 * and skipped, never treated as "this whole host is down." A local
 * project's `resolveBackend` never actually throws for a git-level failure
 * (`listTaskWorktreeDirs`/`pruneWorktrees` are both best-effort), but
 * conflating "some unexpected error happened" with "this host is
 * unreachable" would silently abort every other LOCAL project's boot
 * sweep too — a real resilience regression from the per-project
 * containment this had before remote hosts existed.
 *
 * Computes the delete list itself (task rows are only visible to the
 * primary) and passes it to `pruneWorktrees`, never a bare `cwd` — see that
 * function's own doc comment for why an explicit list is the only safe
 * shape here. Even a wrongly-flagged "orphan" (e.g. a path-normalization
 * mismatch against `tasks.worktreePath`) is protected by
 * `pruneWorktrees`'s own clean-check gate underneath: a worktree actually
 * in use by a live agent is very unlikely to be clean, so it's skipped, not
 * destroyed.
 */
async function pruneOrphanTaskWorktreesOnBoot(app: FastifyInstance): Promise<void> {
  const projectRows = app.db
    .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
    .from(projects)
    .all()
    .map((row) => ({ ...row, hostId: row.hostId || LOCAL_HOST_ID }));

  const byHost = new Map<string, typeof projectRows>();
  for (const row of projectRows) {
    const group = byHost.get(row.hostId) ?? [];
    group.push(row);
    byHost.set(row.hostId, group);
  }

  await Promise.all(
    [...byHost.entries()].map(async ([hostId, hostProjects]) => {
      const backend = resolveBackend(app, hostId);
      for (const project of hostProjects) {
        try {
          const dirs = await backend.listTaskWorktreeDirs(project.cwd);
          if (dirs.length === 0) continue;

          const activePaths = new Set(
            app.db
              .select({ worktreePath: tasks.worktreePath })
              .from(tasks)
              .where(
                and(
                  eq(tasks.projectId, project.id),
                  inArray(tasks.status, ACTIVE_WORKTREE_STATUSES),
                ),
              )
              .all()
              .map((row) => row.worktreePath)
              .filter((worktreePath): worktreePath is string => worktreePath !== null),
          );
          const orphans = dirs.filter((dir) => !activePaths.has(dir));
          if (orphans.length === 0) continue;

          const result = await backend.pruneWorktrees(project.cwd, orphans);
          if (result.removed.length > 0 || result.skipped.length > 0) {
            app.log.info(
              {
                projectId: project.id,
                hostId,
                removed: result.removed.length,
                skipped: result.skipped.length,
              },
              "task-watcher: boot-time orphan worktree sweep",
            );
          }
          if (result.skipped.length > 0) {
            app.log.debug(
              { projectId: project.id, hostId, skipped: result.skipped },
              "task-watcher: orphan worktrees left in place (dirty, conflicted, or invalid)",
            );
          }
        } catch (err) {
          // #484, Hermes review PR #590 — only a transport-level failure
          // (the host itself is unreachable, or a 404 confirming its agent
          // build predates the proxy routes — a host-wide fact, not a
          // per-project one) aborts the rest of THIS host's projects; see
          // this function's own doc comment for why. Independent review,
          // same PR — HostRequestError covers ANY 4xx, not just a missing
          // route (e.g. a genuine resolveWithinRoots 400 for THIS
          // project's own cwd), so only `statusCode === 404` actually
          // means "this host's build is too old," never a bare
          // `instanceof` check. Any other error — including a
          // non-404 HostRequestError — is this project's own problem
          // alone: logged and skipped, the loop continues to the next
          // project on the same host.
          if (
            err instanceof HostUnreachableError ||
            (err instanceof HostRequestError && err.statusCode === 404)
          ) {
            app.log.warn(
              { err, projectId: project.id, hostId },
              "task-watcher: boot-time orphan worktree sweep failed — skipping the rest of this host's projects",
            );
            return;
          }
          app.log.warn(
            { err, projectId: project.id, hostId },
            "task-watcher: boot-time orphan worktree sweep failed for this project",
          );
        }
      }
    }),
  );
}

// Phase 2.5 Task Master, Thin Slice (issue #214/#227). Registered whenever
// this is the primary role (mirrors githubPRPollerPlugin) — no longer
// gated on MULLION_TASK_MASTER_ENABLED at registration time.
//
// Settings UI follow-up (Task Master enable/disable is now runtime-
// toggleable, see task-config.ts): the plugin always registers so a toggle
// flip takes effect without a restart. The timer still always starts;
// startTaskWatcher's pollOnce() checks the *resolved* enabled state
// (env default, overridable via settings.taskMaster.enabled) at the top of
// every sweep and skips GitHub ingest + auto-claim entirely when it's off,
// same short-circuit shape as the pre-existing autoClaimPaused check. This
// is a deliberate behavior change from the old "flag off = plugin never
// registers, zero timers, zero DB queries" contract: a disabled install now
// runs a cheap timer that does one settings SELECT per tick and nothing
// else. GET /api/tasks stays unconditional either way — it always served
// the local board regardless of this plugin once 6.9 shipped (see
// routes/tasks.ts's own doc comment).
export const taskWatcherPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  let cleanup: (() => void) | null = null;

  app.addHook("onReady", () => {
    // Fire-and-forget (Hermes review, PR #476): each git call inside the
    // sweep can take up to GIT_TIMEOUT_MS (15s), times however many
    // projects/orphans exist — awaiting it here would delay `listen()`
    // itself on a slow/hung filesystem. Claim-time `clearOrphanedTaskWorktree`
    // and the steady-state →done/→failed cleanup paths already cover
    // correctness; this sweep is a best-effort catch-up for what those
    // miss, not something startup needs to wait on.
    //
    // Gated on the resolved enabled state (not the raw env var) so a
    // disabled instance skips the filesystem/DB work entirely, matching
    // pollOnce()'s own gate below.
    if (resolveTaskMasterConfig(app).enabled) {
      void pruneOrphanTaskWorktreesOnBoot(app).catch((err) => {
        app.log.warn({ err }, "task-watcher: boot-time orphan worktree sweep threw");
      });
    }
    cleanup = startTaskWatcher(app);
  });

  app.addHook("onClose", () => {
    if (cleanup) cleanup();
  });
});
