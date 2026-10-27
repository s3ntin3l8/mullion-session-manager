// Ending a `reviewing` task from what GitHub says about its PR (#2103).
//
// Before this, the only exits from `reviewing` were a human approve/reject/
// give-up or the linked issue closing. A PR that was merged out of band, closed
// without merging, or emptied by an auto-rebase (the same fix landed on the
// base branch another way) left the task polling GitHub forever. This module is
// the one place that decides which terminal state such a task gets, shared by
// the reconciler's sweeps and the `pull_request` webhook.
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { tasks, type projects } from "../db/schema.js";
import { getDiffStats, getDefaultBaseRef } from "./git-diff.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { resolveTaskWorkerHost } from "./session-live-info.js";
import { cleanupTaskSessions, cleanupTaskWorktree } from "./task-approve.js";
import { syncTaskTransition } from "./task-github-sync.js";
import { recordTaskTransition } from "./task-state.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** Why a reviewing task is being ended. */
export type ReviewEnd =
  /** The PR was merged (here or on GitHub directly). */
  | "merged"
  /** The PR was closed without merging. */
  | "closed"
  /** Nothing is left to merge: the base branch already has the change. */
  | "superseded";

export const CLOSED_WITHOUT_MERGE_REASON = "PR closed without merging";

/**
 * True only when the task's branch is verifiably identical to the repo's
 * default base (zero changed files). Anything unreadable — no worktree, no
 * base ref, an unreachable host, an agent build that omits the base flag — is
 * `false`: "superseded" ends a task as `done`, so it needs positive evidence.
 */
export async function branchHasNothingToMerge(
  app: FastifyInstance,
  task: TaskRow,
): Promise<boolean> {
  if (!task.worktreePath) return false;
  const hostId = resolveTaskWorkerHost(app, task);
  try {
    if (hostId === LOCAL_HOST_ID) {
      const base = getDefaultBaseRef(task.worktreePath);
      if (base === null) return false;
      const stats = await getDiffStats(task.worktreePath, base, { fresh: true });
      return stats !== null && stats.filesChanged === 0;
    }
    const { stats, baseResolved } = await getRemoteHostClient(app, hostId).resolveGitDiffStats(
      task.worktreePath,
      "AUTO",
      { fresh: true },
    );
    return baseResolved === true && stats !== null && stats.filesChanged === 0;
  } catch {
    return false;
  }
}

/**
 * Moves a `reviewing` task to its terminal state. CAS on `reviewing`, so a
 * concurrent approve/reject/give-up wins and this reports `false`. Clears the
 * rebase bookkeeping so nothing keeps polling for the ended task.
 */
export async function endReviewingTask(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
  end: ReviewEnd,
): Promise<boolean> {
  const now = new Date();
  const terminal = end === "closed" ? ("failed" as const) : ("done" as const);
  const common = { rebaseStartedAt: null, mergeError: null, completedAt: now };
  const patch =
    end === "closed"
      ? { ...common, status: "failed" as const, failureReason: CLOSED_WITHOUT_MERGE_REASON }
      : end === "merged"
        ? { ...common, status: "done" as const, mergedAt: now, archivedAt: now }
        : { ...common, status: "done" as const };

  const [updated] = app.db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
    .returning()
    .all();
  if (!updated) return false;

  recordTaskTransition(app, {
    taskId: task.id,
    projectId: task.projectId,
    from: "reviewing",
    to: terminal,
    via: `pr-${end}`,
    context: { prNumber: task.prNumber },
  });
  await syncTaskTransition(app, updated, project, terminal, {
    prUrl: updated.prUrl ?? undefined,
  });
  cleanupTaskWorktree(app, updated, project);
  cleanupTaskSessions(app, updated);
  app.log.info(
    { taskId: task.id, prNumber: task.prNumber, end },
    "task reconcile: ended a reviewing task from its PR state",
  );
  return true;
}

/**
 * Applies GitHub's view of a reviewing task's PR. An open PR is none of this
 * module's business (returns `false`); a merged one ends `done`; one closed
 * without merging ends `done` ("superseded") when its branch holds nothing
 * beyond the base, else `failed`.
 */
export async function endReviewingOnPrState(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
  pr: { state: "open" | "closed"; merged: boolean },
): Promise<boolean> {
  if (pr.merged) return endReviewingTask(app, task, project, "merged");
  if (pr.state !== "closed") return false;
  const superseded = await branchHasNothingToMerge(app, task);
  return endReviewingTask(app, task, project, superseded ? "superseded" : "closed");
}
