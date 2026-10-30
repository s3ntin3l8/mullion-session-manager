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
