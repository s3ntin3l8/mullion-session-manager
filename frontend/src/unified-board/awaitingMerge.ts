import type { Task } from "../api/index.js";

// A task's `done` means approved, not merged (docs/tasks.md) — a done task with
// a PR and no `mergedAt` still has an open PR waiting on a merge. Derived from
// fields the board already loads; `mergedAt` is set whether Mullion or a human
// merged it, so the badge clears itself when the task update arrives.
export function isAwaitingMerge(task: Task): boolean {
  return task.status === "done" && task.prNumber !== null && task.mergedAt === null;
}

// The reason, from existing fields only. `mergeOnApprove` is the project's
// setting (null/undefined = off, the default).
export function awaitingMergeReason(
  task: Pick<Task, "mergeRequestedAt" | "mergeError">,
  mergeOnApprove: boolean | null | undefined,
): string {
  if (task.mergeError) return task.mergeError;
  if (task.mergeRequestedAt !== null) return "Merge requested, waiting";
  if (!mergeOnApprove) return "Merge on approve is off for this project";
  return "PR is still open";
}

// The reconciler records this prefix (MERGE_UNCONFIRMED_PREFIX,
// src/services/task-reconciler.ts) when a merge request timed out on the wire
// and GitHub could not be asked what happened. It is neither a failure nor a
// proof the PR is still open, so the drawer renders it neutrally.
export const MERGE_UNCONFIRMED_PREFIX = "Merge status unconfirmed";

export function isMergeUnconfirmed(task: Pick<Task, "mergeError">): boolean {
  return task.mergeError?.startsWith(MERGE_UNCONFIRMED_PREFIX) ?? false;
}
