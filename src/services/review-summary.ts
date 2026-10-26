// The one place a PR's review status is computed (epic #1965, A2). The list
// (github-pr-reviews.ts) and the detail (github-pr-detail.ts) both call
// `buildReviewSummary`, so the two cannot disagree about "reviewed by whom".
//
// Input is GitHub's `latestReviews` — the latest review per author in EVERY
// state. `latestOpinionatedReviews` drops COMMENTED, which is exactly what bots
// (Hermes, claude[bot]) post, so a bot-reviewed PR read as "No reviews yet".

import type { RelayReviewState, ReviewSummary, ReviewSummaryEntry } from "../shared/types.js";
import type { PrReviewDecision } from "./github-pr-phase.js";

/** A review body is prose from anyone; bound what the summary carries. */
const MAX_BODY_CHARS = 4_000;

export interface GqlLatestReviewNode {
  author: { login: string; __typename?: string } | null;
  state: string;
  body?: string | null;
  submittedAt?: string | null;
  commit?: { oid: string } | null;
}

/** The GraphQL selection both queries use, so they cannot drift. */
export const LATEST_REVIEWS_SELECTION =
  "latestReviews(first: 20) { nodes { author { login __typename } state body submittedAt commit { oid } } }";

export interface ReviewSummaryInput {
  reviewDecision: PrReviewDecision;
  reviews: readonly (GqlLatestReviewNode | null)[];
  requestedReviewers: readonly string[];
  unresolvedThreads: number | null;
  headSha: string;
  relayReview?: RelayReviewState | null;
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

/** The lean per-reviewer list (`reviewers`) the phase derivation reads. */
export function reviewersOf(
  nodes: readonly (GqlLatestReviewNode | null)[],
): { login: string; state: string }[] {
  return nodes
    .filter((n): n is GqlLatestReviewNode & { author: { login: string } } => !!n && !!n.author)
    .map((n) => ({ login: n.author.login, state: n.state }));
}

function relayOf(relay: RelayReviewState | null | undefined): ReviewSummary["relay"] {
  if (!relay || relay.state === "none") return null;
  return {
    state: relay.state,
    reviewer: relay.author ?? null,
    url: relay.htmlUrl ?? null,
  };
}

export function buildReviewSummary(input: ReviewSummaryInput): ReviewSummary {
  const approved: string[] = [];
  const changesRequested: string[] = [];
  const commented: string[] = [];
  const candidates: ReviewSummaryEntry[] = [];
  const unresolved = input.unresolvedThreads ?? 0;

  for (const n of input.reviews) {
    if (!n?.author) continue;
    const login = n.author.login;
    if (n.state === "APPROVED") approved.push(login);
    else if (n.state === "CHANGES_REQUESTED") changesRequested.push(login);
    else if (n.state === "COMMENTED") commented.push(login);
    else continue; // DISMISSED / PENDING say nothing about the PR
    const body = clip((n.body ?? "").trim());
    // Something to read: a body, or an inline-only review while threads are open.
    if (body === "" && !(n.state !== "APPROVED" && unresolved > 0)) continue;
    const reviewedSha = n.commit?.oid ?? "";
    candidates.push({
      author: login,
      isBot: n.author.__typename === "Bot",
      state: n.state,
      body,
      submittedAt: n.submittedAt ?? null,
      reviewedSha,
      stale: reviewedSha !== "" && input.headSha !== "" && reviewedSha !== input.headSha,
    });
  }

  const newestFirst = (a: ReviewSummaryEntry, b: ReviewSummaryEntry) =>
    Date.parse(b.submittedAt ?? "") - Date.parse(a.submittedAt ?? "") || 0;
  candidates.sort(newestFirst);
  const latest = [candidates.find((c) => !c.isBot), candidates.find((c) => c.isBot)].filter(
    (c): c is ReviewSummaryEntry => c !== undefined,
  );
  latest.sort(newestFirst);

  let decision: ReviewSummary["decision"] = input.reviewDecision;
  if (decision === null) {
    if (changesRequested.length > 0) decision = "CHANGES_REQUESTED";
    else if (approved.length > 0) decision = "APPROVED";
    else if (commented.length > 0) decision = "COMMENTED";
    else if (input.requestedReviewers.length > 0) decision = "REVIEW_REQUIRED";
  }

  return {
    decision,
    approved,
    changesRequested,
    commented,
    requested: [...input.requestedReviewers],
    relay: relayOf(input.relayReview),
    unresolvedThreads: input.unresolvedThreads,
    latest,
  };
}

/** The same summary with the relay's state folded in (the relay is annotated after the review fetch). */
export function withRelay(
  summary: ReviewSummary,
  relayReview: RelayReviewState | null | undefined,
): ReviewSummary {
  return { ...summary, relay: relayOf(relayReview) };
}
