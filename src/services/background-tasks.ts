// Issue #428 — the outstanding-work predicate for Claude Code's
// `background_tasks` (Stop/SubagentStop hook field). Pure, no I/O — same
// testability posture as attention-detect.ts/session-status.ts, and shared
// by both the backend gate (pty-manager.ts) and toInfo()'s filtered list, so
// the "what counts as still running" rule lives in exactly one place.
//
// A task's `status` is a bare, agent-reported string (hook-protocol.ts's
// `BackgroundTask.status: string`, no enum) — Claude Code's own docs give
// `TaskNotificationStatus = "completed" | "failed" | "stopped"` for the
// terminal set, and a live capture (session_events, issue #428's own
// investigation) confirmed a running one reports `"running"`. Anything
// MISSING or UNRECOGNIZED counts as outstanding: a wrong "still working" is
// self-correcting (the staleness sweep in pty-manager.ts's
// clearStaleBlockedIfOlderThan clears it once the session goes quiet), while
// a wrong "done" would resurrect exactly the bug this module exists to fix.

import type { BackgroundTask } from "./hook-protocol.js";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
  "cancelled",
  "canceled",
  "error",
  "timed_out",
  "succeeded",
  "done",
]);

/** Defensive about `task.status`'s type despite `BackgroundTask` typing it as
 * `string` — hook-protocol.ts's `validateBackgroundTasksField` only checks
 * each element is a non-null object, not that its individual fields match
 * their declared types (see that function's own doc comment for why: a
 * stricter check would let a future Claude Code field shape break every
 * `Stop` message outright). */
export function isBackgroundTaskOutstanding(task: BackgroundTask): boolean {
  const status = task.status;
  if (typeof status !== "string") return true;
  return !TERMINAL_STATUSES.has(status.trim().toLowerCase());
}

export function filterOutstandingBackgroundTasks(
  tasks: readonly BackgroundTask[],
): BackgroundTask[] {
  return tasks.filter(isBackgroundTaskOutstanding);
}
