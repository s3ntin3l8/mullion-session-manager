import type { Task } from "../api/types.js";
import { approvalStateText, needsHumanText } from "../needsHuman.js";

// There is no "waiting" status: a task is waiting when it is `claimed` and
// `failureReason` is set (dispatch held — host offline, parked).
export function isWaiting(t: Task): boolean {
  return t.status === "claimed" && !!t.failureReason;
}

/** The one status a task is listed under, or null when it is neither active nor
 * waiting on a human (backlog, done, cancelled). Archived tasks are never listed. */
export type TaskBucket =
  | "ready"
  | "running"
  | "reviewing"
  | "awaitingApproval"
  | "waiting"
  | "failed"
  // Not active work, but something still wants a human (a merge or release error).
  | "attention";

export function taskBucket(t: Task): TaskBucket | null {
  if (t.archivedAt) return null;
  if (t.status === "failed") return "failed";
  if (t.status === "ready") return "ready";
  if (t.status === "reviewing")
    return t.approvalState === "awaiting-human" ? "awaitingApproval" : "reviewing";
  if (isWaiting(t)) return "waiting";
  if (t.status === "claimed" || t.status === "in_progress") return "running";
  return needsYouReason(t) ? "attention" : null;
}

/** Why a task needs a human, or null when it does not. */
export function needsYouReason(t: Task): string | null {
  if (t.archivedAt) return null;
  if (t.status === "failed") return t.failureReason ?? "failed";
  if (t.approvalState === "awaiting-human") {
    return approvalStateText(t.approvalState, t.autoReturnRounds);
  }
  if (t.autoReturnCapped) return needsHumanText(t.needsHumanReason);
  if (t.mergeError) return `merge failed: ${t.mergeError}`;
  if (t.releaseError) return `release failed: ${t.releaseError}`;
  return null;
}

export function needsYouTasks(tasks: Task[]): Array<{ task: Task; reason: string }> {
  const out: Array<{ task: Task; reason: string }> = [];
  for (const task of tasks) {
    const reason = needsYouReason(task);
    if (reason) out.push({ task, reason });
  }
  return out;
}
