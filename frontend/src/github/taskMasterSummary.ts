import type { Task } from "../api/types.js";
import { approvalStateText, needsHumanText } from "../needsHuman.js";

export interface TaskMasterCounts {
  ready: number;
  running: number;
  reviewing: number;
  awaitingApproval: number;
  waiting: number;
  failed: number;
}

// There is no "waiting" status: a task is waiting when it is `claimed` and
// `failureReason` is set (dispatch held — host offline, parked).
export function isWaiting(t: Task): boolean {
  return t.status === "claimed" && !!t.failureReason;
}

export function countTasks(tasks: Task[]): TaskMasterCounts {
  const c: TaskMasterCounts = {
    ready: 0,
    running: 0,
    reviewing: 0,
    awaitingApproval: 0,
    waiting: 0,
    failed: 0,
  };
  for (const t of tasks) {
    if (t.approvalState === "awaiting-human") c.awaitingApproval++;
    if (t.status === "ready") c.ready++;
    else if (t.status === "reviewing" && t.approvalState !== "awaiting-human") c.reviewing++;
    else if (t.status === "failed") c.failed++;
    else if (isWaiting(t)) c.waiting++;
    else if (t.status === "claimed" || t.status === "in_progress") c.running++;
  }
  return c;
}

/** Why a task needs a human, or null when it does not. */
export function needsYouReason(t: Task): string | null {
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
