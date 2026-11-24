import { useState } from "react";
import { ApiError } from "./api/index.js";
import type { Task } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";

/** The 409 an Approve gets for a tracking epic with open sub-issues (#1020). */
export function isTrackingEpicConflict(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.statusCode === 409 &&
    err.code === "tracking-epic-with-open-sub-issues"
  );
}

/**
 * The request side of a task's spawn/promote actions (Claim, Retry, Approve,
 * Re-review): one `submitting` flag, one error, and the per-action failure
 * text. Shared by the full `TaskActions` block and the GitHub sidebar's
 * compact row actions (#2461), so the two cannot drift.
 *
 * No optimistic state: each action fires its request and the next tasks poll
 * reflects whatever actually happened (GateActions' pattern).
 *
 * `onError`, when given, receives every error (and `null` when an action
 * starts) instead of the hook keeping it: a list row has no room for its own
 * error line and reports it to its section.
 */
export function useTaskActions(
  task: Task,
  opts: { onError?: (message: string | null) => void } = {},
) {
  const claimTask = useDashboardStore((s) => s.claimTask);
  const retryTask = useDashboardStore((s) => s.retryTask);
  const approveTask = useDashboardStore((s) => s.approveTask);
  const reReviewTask = useDashboardStore((s) => s.reReviewTask);
  const [submitting, setSubmitting] = useState(false);
  const [ownError, setOwnError] = useState<string | null>(null);
  // #1020 — non-null while a tracking-epic warning awaits confirmation.
  const [trackingEpicWarning, setTrackingEpicWarning] = useState<string | null>(null);
  const setError = opts.onError ?? setOwnError;

  const run = async (
    action: () => Promise<unknown>,
    fallback: string,
    // Retry has always shown any Error's message, the rest only an ApiError's.
    anyError = false,
  ): Promise<boolean> => {
    setSubmitting(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      const shown = anyError ? err instanceof Error : err instanceof ApiError;
      setError(shown ? (err as Error).message : fallback);
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  /** Approve; a tracking epic's 409 sets `trackingEpicWarning` (and returns
   *  "tracking-epic") instead of an error, so the caller can ask to confirm. */
  const approve = async (force = false): Promise<"ok" | "tracking-epic" | "error"> => {
    setSubmitting(true);
    setError(null);
    try {
      await (force ? approveTask(task.id, { force: true }) : approveTask(task.id));
      setTrackingEpicWarning(null);
      return "ok";
    } catch (err) {
      if (isTrackingEpicConflict(err)) {
        setTrackingEpicWarning(err.message);
        return "tracking-epic";
      }
      setError(err instanceof ApiError ? err.message : "Failed to approve task");
      return "error";
    } finally {
      setSubmitting(false);
    }
  };

  return {
    submitting,
    error: ownError,
    setError,
    trackingEpicWarning,
    setTrackingEpicWarning,
    claim: () => run(() => claimTask(task.id), "Failed to claim task"),
    retry: () => run(() => retryTask(task.id), "Failed to retry task", true),
    reReview: () => run(() => reReviewTask(task.id), "Failed to re-review task"),
    approve,
  };
}
