// Pure PR "phase" derivation — the single answer to "what does this PR need
// from me next?", shared by every badge (sidebar list, session row, rail
// badge) so they can never disagree. No I/O, no imports beyond a type: kept
// out of github.ts so the frontend-facing shape can be unit-tested alone.

import type { GitHubCiStatus } from "./github.js";

export type PrReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;

/**
 * - `draft`: not ready for anyone yet.
 * - `conflicts`: cannot merge until rebased.
 * - `ci_failing`: a required signal is red.
 * - `changes_requested`: a reviewer asked for changes.
 * - `review_pending`: waiting on a review (required, requested, or blocked).
 * - `ci_pending`: approved (or no review needed) but CI is still running.
 * - `ready_to_merge`: nothing left to wait for.
 * - `unknown`: review state couldn't be fetched (GraphQL failed or backed
 *   off), so "nothing left to wait for" can't be claimed — CI-only signals
 *   (`ci_failing`, `ci_pending`) still apply.
 */
export type PrPhase =
  | "draft"
  | "conflicts"
  | "ci_failing"
  | "changes_requested"
  | "review_pending"
  | "ci_pending"
  | "ready_to_merge"
  | "unknown";

export interface PrPhaseInput {
  /** False when the review fields are still their defaults (not fetched). */
  reviewStateKnown: boolean;
  isDraft: boolean;
  mergeable: PrMergeable;
  mergeStateStatus: string | null;
  reviewDecision: PrReviewDecision;
  requestedReviewers: readonly string[];
  ciStatus: GitHubCiStatus;
}

export function derivePrPhase(pr: PrPhaseInput): PrPhase {
  if (pr.isDraft) return "draft";
  if (!pr.reviewStateKnown) {
    if (pr.ciStatus === "failure") return "ci_failing";
    if (pr.ciStatus === "in_progress") return "ci_pending";
    return "unknown";
  }
  if (pr.mergeable === "CONFLICTING") return "conflicts";
  if (pr.ciStatus === "failure") return "ci_failing";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "review_pending";
  // No review requirement configured (decision is null) but someone was
  // asked, or branch protection still reports the PR as blocked.
  if (pr.reviewDecision === null && pr.requestedReviewers.length > 0) return "review_pending";
  if (pr.mergeStateStatus === "BLOCKED" && pr.ciStatus !== "in_progress") return "review_pending";
  if (pr.ciStatus === "in_progress") return "ci_pending";
  return "ready_to_merge";
}

/** Phases that want the user's attention, in sort order (most urgent first). */
export const PR_ATTENTION_PHASES: readonly PrPhase[] = [
  "ci_failing",
  "changes_requested",
  "conflicts",
];

/** The slice of a PR the change-detection compares (and later notifies on). */
export interface PrSnapshot {
  number: number;
  headSha: string;
  isDraft: boolean;
  ciStatus: GitHubCiStatus;
  reviewDecision: PrReviewDecision;
  mergeable: PrMergeable;
  unresolvedThreads: number | null;
  commentCount: number | null;
  prPhase: PrPhase;
}

export interface PrChange {
  number: number;
  kind: "opened" | "closed" | "updated";
  before: PrSnapshot | null;
  after: PrSnapshot | null;
}

export function snapshotPr(pr: PrSnapshot): PrSnapshot {
  return {
    number: pr.number,
    headSha: pr.headSha,
    isDraft: pr.isDraft,
    ciStatus: pr.ciStatus,
    reviewDecision: pr.reviewDecision,
    mergeable: pr.mergeable,
    unresolvedThreads: pr.unresolvedThreads,
    commentCount: pr.commentCount,
    prPhase: pr.prPhase,
  };
}

/**
 * What changed between two polls of one repo's open PRs. A PR missing from
 * `next` is reported as `closed` (merged or closed — the poller can't tell
 * which). Order: opened, updated, closed, each by PR number.
 */
export function diffPrSnapshots(
  prev: ReadonlyMap<number, PrSnapshot>,
  next: readonly PrSnapshot[],
): PrChange[] {
  const changes: PrChange[] = [];
  const seen = new Set<number>();
  for (const after of [...next].sort((a, b) => a.number - b.number)) {
    seen.add(after.number);
    const before = prev.get(after.number) ?? null;
    if (!before) {
      changes.push({ number: after.number, kind: "opened", before: null, after });
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ number: after.number, kind: "updated", before, after });
    }
  }
  for (const [number, before] of [...prev.entries()].sort((a, b) => a[0] - b[0])) {
    if (!seen.has(number)) changes.push({ number, kind: "closed", before, after: null });
  }
  return changes;
}
