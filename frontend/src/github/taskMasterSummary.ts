import type { Task } from "../api/types.js";
import {
  approvalStateText,
  isCiHoldReason,
  isMergeNeedsHumanReason,
  needsHumanText,
} from "../needsHuman.js";

// There is no "waiting" status: a task is waiting when it is `claimed` and
// `failureReason` is set (dispatch held — host offline, parked).
function isWaiting(t: Task): boolean {
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

/** What kind of needs-you a task is, for the bell's Tasks section (#3459):
 * "failed" (the task, its merge or its release failed), "review" (a review
 * approved it and it waits on your approval), or "stopped" (the review loop, a
 * parked CI check, a merge or a worker that never started holds it for a
 * human). */
export type TaskNeedsYouKind = "failed" | "review" | "stopped";

/** Why a task needs a human and what kind of needs-you that is, or null when
 * it does not: the one definition, so the reason and its kind cannot drift. */
export function taskNeedsYou(t: Task): { reason: string; kind: TaskNeedsYouKind } | null {
  if (t.archivedAt) return null;
  if (t.status === "in_progress" && t.needsHumanReason === "worker-not-started") {
    return { reason: needsHumanText(t.needsHumanReason), kind: "stopped" };
  }
  if (t.status === "failed") return { reason: t.failureReason ?? "failed", kind: "failed" };
  // A parked red CI check names itself even while an approval is held (that is when
  // it happens), so it comes before the approval line.
  if (isCiHoldReason(t.needsHumanReason) && t.autoReturnCapAnnouncedAt) {
    return { reason: needsHumanText(t.needsHumanReason, t.ciHoldNote), kind: "stopped" };
  }
  if (t.approvalState === "awaiting-human") {
    return { reason: approvalStateText(t.approvalState, t.autoReturnRounds), kind: "review" };
  }
  if (isMergeNeedsHumanReason(t.needsHumanReason)) {
    return { reason: needsHumanText(t.needsHumanReason), kind: "stopped" };
  }
  if (t.autoReturnCapped) {
    return { reason: needsHumanText(t.needsHumanReason, t.ciHoldNote), kind: "stopped" };
  }
  if (t.mergeError) return { reason: `merge failed: ${t.mergeError}`, kind: "failed" };
  if (t.releaseError) return { reason: `release failed: ${t.releaseError}`, kind: "failed" };
  return null;
}

/** Why a task needs a human, or null when it does not. */
export function needsYouReason(t: Task): string | null {
  return taskNeedsYou(t)?.reason ?? null;
}

export function needsYouTasks(
  tasks: Task[],
): Array<{ task: Task; reason: string; kind: TaskNeedsYouKind }> {
  const out: Array<{ task: Task; reason: string; kind: TaskNeedsYouKind }> = [];
  for (const task of tasks) {
    const needs = taskNeedsYou(task);
    if (needs) out.push({ task, ...needs });
  }
  return out;
}
