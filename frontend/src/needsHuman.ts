import { formatRelativeUntil } from "./relativeTime.js";
import type { ApprovalState } from "../../src/shared/types.js";
export type { ApprovalState } from "../../src/shared/types.js";

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
  | "ci-status-stalled"
  | "ci-unfixable"
  | "ci-still-red"
  | "review-inconclusive"
  | "rate-limited"
  | "worker-not-started";

/** The two review-loop reasons that name a red CI check (`ciHoldNote` carries
 * the check names and, for `ci-unfixable`, the worker's reason). Unlike the
 * round-cap reasons they are shown even while the task still holds an approval,
 * which is exactly when they happen (a CI fix keeps the approval). */
export function isCiHoldReason(
  reason: NeedsHumanReason | null | undefined,
): reason is "ci-unfixable" | "ci-still-red" {
  return reason === "ci-unfixable" || reason === "ci-still-red";
}

/** The card-sized stand-in for a `ciHoldNote`: the failing check's name when
 * there is one, else a count. The note is `names` or `names — workerReason`
 * (services/task-ci-return-hold.ts), and the reason can run to a paragraph, so
 * the board card shows this and keeps the full note for its tooltip and the
 * task drawer. Assumes no check name contains ", " (none here does; a
 * multi-parameter matrix name like `build (ubuntu, 20)` would be miscounted). */
export function ciHoldNoteSummary(note: string | null | undefined): string | null {
  if (!note) return null;
  const names = note.split(" — ")[0].split(", ").filter(Boolean);
  if (names.length === 0) return null;
  return names.length === 1 ? names[0] : `${names.length} checks`;
}

/** What a human can do about a parked red check. */
export const CI_HOLD_HINT =
  'Approve the task, then use "Merge anyway" if the failing check is not required. If it is required, fix the cause on the base branch and update this branch, which re-arms the task.';

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

export function needsHumanText(
  reason: NeedsHumanReason | null | undefined,
  note?: string | null,
  /** "short": a CI-hold note becomes `(name)` / `(N checks)` — the board card. */
  form: "full" | "short" = "full",
): string {
  if (form === "short" && isCiHoldReason(reason)) {
    const summary = ciHoldNoteSummary(note);
    return `${needsHumanText(reason)}${summary ? ` (${summary})` : ""}`;
  }
  switch (reason) {
    case "worker-not-started":
      return "worker has not started a turn — check its terminal for a startup prompt";
    case "ci-unfixable":
      return note
        ? `a CI check can't be fixed from this PR: ${note}`
        : "a CI check can't be fixed from this PR";
    case "ci-still-red":
      return note
        ? `CI still red after the worker and two reruns: ${note}`
        : "CI still red after the worker and two reruns";
    case "review-inconclusive":
      return "the review ended without a verdict twice — retry the review or review by hand";
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
    // #3234 — the provider quota resets beyond the park limit, so the worker
    // was stopped rather than held for days; the card adds the reset time.
    case "rate-limited":
      return "provider quota exhausted";
    default:
      return "round cap reached";
  }
}

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
