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
