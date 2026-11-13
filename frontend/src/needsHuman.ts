import { formatRelativeUntil } from "./relativeTime.js";

// Why Task Master's automatic review loop stopped and is waiting on a human —
// the board card and the task drawer share this wording so they can't drift.
// `null`/"cap" is the original (and still most common) reason: the round cap.
export type NeedsHumanReason =
  | "cap"
  | "no-progress"
  | "finding-persisted"
  | "rebase-exhausted"
  | "blocked-threads"
  | "review-post-failed"
  | "pr-closed"
  | "ci-status-stalled";

/** The reasons tied to a merge that cannot proceed. Unlike the review-loop
 * reasons they do not depend on the round cap or its announce stamp. */
export function isMergeNeedsHumanReason(
  reason: NeedsHumanReason | null | undefined,
): reason is "rebase-exhausted" | "blocked-threads" | "pr-closed" | "ci-status-stalled" {
  return (
    reason === "rebase-exhausted" ||
    reason === "blocked-threads" ||
    reason === "pr-closed" ||
    reason === "ci-status-stalled"
  );
}

export function needsHumanText(reason: NeedsHumanReason | null | undefined): string {
  switch (reason) {
    case "no-progress":
      return "worker returned without a change";
    case "finding-persisted":
      return "same finding still open after two rounds";
    case "rebase-exhausted":
      return "auto-rebase gave up, the PR still conflicts with main";
    case "blocked-threads":
      return "merge blocked on unresolved review conversations";
    case "pr-closed":
      return "the PR was closed without merging, so nothing landed";
    case "review-post-failed":
      return "approving review could not be posted to GitHub";
    // #2904 — a non-Actions status (codecov's `codecov/patch`) stayed pending
    // on a head whose Actions checks are all green, and re-running the
    // coverage upload twice did not settle it. Nothing in the diff can fix
    // it: the provider itself is the one that stopped reporting.
    case "ci-status-stalled":
      return "a CI status stayed pending after green CI — a Codecov-side stall; re-run the coverage upload";
    default:
      return "round cap reached";
  }
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

// The foreign review threads blocking a `blocked-threads` merge, as recorded
// by the reconciler (`MergeBlockedThreads`, services/task-merge-human.ts).
export interface BlockedThreadInfo {
  author: string;
  location: string | null;
  excerpt: string;
  url: string | null;
  alert: { number: number | null; url: string | null } | null;
}
export interface MergeBlockedThreadsInfo {
  total: number;
  threads: BlockedThreadInfo[];
}

/** Parse `task.mergeBlockedThreads`; null (generic message) when absent or malformed. */
export function parseMergeBlockedThreads(
  raw: string | null | undefined,
): MergeBlockedThreadsInfo | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as MergeBlockedThreadsInfo;
    if (!v || !Array.isArray(v.threads) || v.threads.length === 0) return null;
    return { total: Math.max(v.total || 0, v.threads.length), threads: v.threads };
  } catch {
    return null;
  }
}

/** One thread as a sentence: "github-advanced-security at src/x.ts:52: Path injection (code-scanning alert #520)". */
export function blockedThreadText(t: BlockedThreadInfo): string {
  const where = t.location ? ` at ${t.location}` : "";
  const what = t.excerpt ? `: ${t.excerpt}` : "";
  const alert = t.alert
    ? ` (code-scanning alert${t.alert.number != null ? ` #${t.alert.number}` : ""})`
    : "";
  return `${t.author}${where}${what}${alert}`;
}

/** Only GitHub https links are rendered as anchors. */
export function safeGithubUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\/github\.com\//.test(url) ? url : null;
}
