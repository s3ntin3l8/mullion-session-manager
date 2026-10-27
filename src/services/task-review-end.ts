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
import { resolveCommitSha } from "./git-refs.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
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
 * default base (zero changed files). "Superseded" ends a task as `done`, so it
 * needs positive evidence; anything unreadable is `false`:
 *  - no worktree/branch, no base ref, or a host the diff cannot be read on;
 *  - a worktree whose HEAD is not the task branch's tip. A rebase stopped on a
 *    conflict leaves HEAD detached at the new base, where the diff is empty
 *    although the worker's commits only survive on the branch ref.
 * A remote-hosted worktree is not checked (no route reports the branch tip),
 * so it reads as "not superseded": a closed PR there ends `failed`, the safe
 * direction.
 */
export async function branchHasNothingToMerge(
  app: FastifyInstance,
  task: TaskRow,
): Promise<boolean> {
  if (!task.worktreePath || !task.branchName) return false;
  if (resolveTaskWorkerHost(app, task) !== LOCAL_HOST_ID) return false;
  try {
    const base = getDefaultBaseRef(task.worktreePath);
    if (base === null) return false;
    const [head, tip] = await Promise.all([
      resolveCommitSha(task.worktreePath, "HEAD"),
      resolveCommitSha(task.worktreePath, `refs/heads/${task.branchName}`),
    ]);
    if (head === null || head !== tip) return false;
    const stats = await getDiffStats(task.worktreePath, base, { fresh: true });
    return stats !== null && stats.filesChanged === 0;
  } catch {
    return false;
  }
}

/**
 * An auto-rebase window that ended with the branch identical to its base: the
 * same change landed another way, so nothing is left to review or merge.
 */
export async function endIfRebaseEmptied(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
  now: number,
  staleMs: number,
): Promise<boolean> {
  if (task.rebaseStartedAt === null || now - task.rebaseStartedAt.getTime() < staleMs) {
    return false;
  }
  if (!(await branchHasNothingToMerge(app, task))) return false;
  return endReviewingTask(app, task, project, "superseded");
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
