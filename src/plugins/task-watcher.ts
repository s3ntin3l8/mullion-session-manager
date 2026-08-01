import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { startTaskWatcher } from "../services/task-watcher.js";
import { listTaskWorktreeDirs, pruneWorktrees } from "../services/git-worktree.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";

// Statuses a task-owned worktree is still "in use" for — the same
// non-terminal set task-reconciler.ts polls, minus "backlog"/"ready" (never
// have a worktreePath at all — that's only stamped after a successful
// claim) and "done"/"failed" (routes/tasks.ts and the reconcilers already
// clean those up via removeWorktreeIfClean at the moment they transition;
// see this file's own boot-sweep doc comment for why this exists anyway).
const ACTIVE_WORKTREE_STATUSES = ["claimed", "in_progress", "reviewing"] as const;

/**
 * Phase 6's 6.8 (issue #283) — a boot-time sweep that removes task
 * worktrees left behind by a crash-mid-cleanup or an out-of-band `rm -rf`
 * of the DB but not the filesystem (or vice versa). The steady-state
 * cleanup paths (routes/tasks.ts's approve, task-reconciler.ts's
 * budget-exceeded path, session-reconciler.ts's session-exit path) already
 * remove a task's worktree the moment it goes done/failed — this exists
 * only for what those miss: a worktree whose task row was deleted/reset
 * entirely, or whose cleanup call itself never got to run (a mid-cleanup
 * process kill). Scoped to **local** projects only — this runs on the
 * primary at its own boot time, reading the local filesystem directly, not
 * through `resolveBackend`; a remote-hosted project's orphans live on that
 * agent's own filesystem, out of reach of a hook that runs at the
 * primary's boot time, not the agent's.
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
    .filter((row) => row.hostId === LOCAL_HOST_ID || !row.hostId);

  for (const project of projectRows) {
    try {
      const dirs = listTaskWorktreeDirs(project.cwd);
      if (dirs.length === 0) continue;

      const activePaths = new Set(
        app.db
          .select({ worktreePath: tasks.worktreePath })
          .from(tasks)
          .where(
            and(eq(tasks.projectId, project.id), inArray(tasks.status, ACTIVE_WORKTREE_STATUSES)),
          )
          .all()
          .map((row) => row.worktreePath)
          .filter((worktreePath): worktreePath is string => worktreePath !== null),
      );
      const orphans = dirs.filter((dir) => !activePaths.has(dir));
      if (orphans.length === 0) continue;

      const result = await pruneWorktrees(project.cwd, orphans);
      if (result.removed.length > 0 || result.skipped.length > 0) {
        app.log.info(
          {
            projectId: project.id,
            removed: result.removed.length,
            skipped: result.skipped.length,
          },
          "task-watcher: boot-time orphan worktree sweep",
        );
      }
      if (result.skipped.length > 0) {
        app.log.debug(
          { projectId: project.id, skipped: result.skipped },
          "task-watcher: orphan worktrees left in place (dirty, conflicted, or invalid)",
        );
      }
    } catch (err) {
      app.log.warn(
        { err, projectId: project.id },
        "task-watcher: boot-time orphan worktree sweep failed for this project",
      );
    }
  }
}

// Phase 2.5 Task Master, Thin Slice (issue #214/#227) — inert unless both
// this is the primary role (mirrors githubPRPollerPlugin) AND
// MULLION_TASK_MASTER_ENABLED is set (default false — see env.ts). Flag-off
// means zero behavior change: no timers started, GET /api/tasks always
// returns [] (see routes/tasks.ts).
export const taskWatcherPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;
  if (!app.config.MULLION_TASK_MASTER_ENABLED) return;

  let cleanup: (() => void) | null = null;

  app.addHook("onReady", () => {
    // Fire-and-forget (Hermes review, PR #476): each git call inside the
    // sweep can take up to GIT_TIMEOUT_MS (15s), times however many
    // projects/orphans exist — awaiting it here would delay `listen()`
    // itself on a slow/hung filesystem. Claim-time `clearOrphanedTaskWorktree`
    // and the steady-state →done/→failed cleanup paths already cover
    // correctness; this sweep is a best-effort catch-up for what those
    // miss, not something startup needs to wait on.
    void pruneOrphanTaskWorktreesOnBoot(app).catch((err) => {
      app.log.warn({ err }, "task-watcher: boot-time orphan worktree sweep threw");
    });
    cleanup = startTaskWatcher(app);
  });

  app.addHook("onClose", () => {
    if (cleanup) cleanup();
  });
});
