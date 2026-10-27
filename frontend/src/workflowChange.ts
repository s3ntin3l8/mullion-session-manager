// The workflow-change approval gate's payload (`tasks.workflowChange`, set by
// the backend's task-workflow-gate.ts while a push waits on the operator).
import type { Task } from "./api/index.js";

export interface WorkflowChange {
  sha: string;
  files: string[];
}

export function parseWorkflowChange(raw: string | null | undefined): WorkflowChange | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<WorkflowChange>;
    if (typeof v.sha === "string" && Array.isArray(v.files)) {
      return { sha: v.sha, files: v.files.filter((f): f is string => typeof f === "string") };
    }
  } catch {
    // a corrupt value reads as "nothing waiting"
  }
  return null;
}

/** The workflow hold supersedes an earlier push rejection, but not a new
 * token-mint failure or an unrelated GitHub error. Keep the stored error so
 * it becomes visible again if the hold clears without a successful push.
 * This matches historical App errors stored before the backend started
 * rewriting this rejection; PAT/OAuth and current host errors stay visible. */
export function visibleTaskSyncError(
  task: Pick<Task, "workflowChange" | "githubSyncError">,
): string | null {
  const error = task.githubSyncError;
  if (
    parseWorkflowChange(task.workflowChange) &&
    error?.includes("refusing to allow a GitHub App to create or update workflow") &&
    error.includes("without `workflows` permission")
  ) {
    return null;
  }
  return error;
}
