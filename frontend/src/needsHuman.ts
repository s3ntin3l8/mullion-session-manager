import { formatRelativeUntil } from "./relativeTime.js";

// Why Task Master's automatic review loop stopped and is waiting on a human —
// the board card and the task drawer share this wording so they can't drift.
// `null`/"cap" is the original (and still most common) reason: the round cap.
export type NeedsHumanReason = "cap" | "no-progress" | "finding-persisted";

export function needsHumanText(reason: NeedsHumanReason | null | undefined): string {
  switch (reason) {
    case "no-progress":
      return "worker returned without a change";
    case "finding-persisted":
      return "same finding still open after two rounds";
    default:
      return "round cap reached";
  }
}

// #2327 — the red-CI auto-return can't tell required checks from optional
// ones when branch protection is unreadable, so it never fires. Shared by the
// board card and the drawer. Null when there is nothing to say.
export function ciGatingUnavailableText(
  reason: "forbidden" | "not-found" | "other" | null | undefined,
  source: "app" | "account" | null | undefined,
): string | null {
  if (!reason) return null;
  const why =
    reason === "forbidden"
      ? "permission denied"
      : reason === "not-found"
        ? "no branch protection"
        : "lookup failed";
  const via = source === "app" ? " (GitHub App)" : source === "account" ? " (account token)" : "";
  return `CI gating unavailable: required checks unreadable — ${why}${via}`;
}

// #2234 — a task whose last review approved and is waiting on its approval.
// Shared by the board card and the task drawer so the two can't drift.
export type ApprovalState = "awaiting-human" | "auto-pending";

/** The round-badge / strip text. `rounds` is `task.autoReturnRounds` (rounds
 * spent). The approving review is written as `## Round ${rounds + 1}` (an
 * approval spends no round), so that is the number shown — it matches the
 * drawer's "Latest: round N" line. With no round spent there is no prefix. */
export function approvalStateText(state: ApprovalState, rounds: number): string {
  const what =
    state === "awaiting-human"
      ? "approved, needs your approval"
      : "approved, auto-approving once CI is green";
  if (rounds > 0) return `Round ${rounds + 1} · ${what}`;
  return what.charAt(0).toUpperCase() + what.slice(1);
}

// A `reviewing` task with no live review session is waiting, not stuck — the
// server derives why (`reviewPhase`, services/task-approval-state.ts). Shared
// by the board card and the drawer. `hadReview` = a previous round's findings
// exist, i.e. the review was cleared by an auto-rebase rather than never run.
// Null when the task is not in either waiting phase.
export function reviewPhaseText(
  phase: "rebasing" | "awaiting-review" | "no-reviewer" | null | undefined,
  reReviewAt: number | null | undefined,
  hadReview: boolean,
): string | null {
  if (phase === "rebasing") {
    // The hold-back ends as soon as the rebase worker's work is finished, so
    // the window's end is the latest the re-review can start, not the time.
    const when = reReviewAt ? ` ${formatRelativeUntil(reReviewAt)} at the latest` : "";
    return `${hadReview ? "Reviewed, then conflicted with main — " : "Conflicted with main — "}auto-rebasing; re-review starts${when}`;
  }
  if (phase === "awaiting-review") return "Waiting for the review to start";
  if (phase === "no-reviewer") {
    return "No review agent is configured for this task — nothing will start a review, so a human reviews it";
  }
  return null;
}
