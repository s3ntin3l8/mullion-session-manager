import type { PROrWithChecks } from "../../src/services/github.js";

// The review-state half of a PROrWithChecks (filled by the GraphQL
// enrichment). Spread into fixtures that only care about the CI half.
export const PR_REVIEW_DEFAULTS: Pick<
  PROrWithChecks,
  | "isDraft"
  | "updatedAt"
  | "reviewDecision"
  | "mergeable"
  | "mergeStateStatus"
  | "reviewers"
  | "requestedReviewers"
  | "unresolvedThreads"
  | "commentCount"
  | "reviewStateKnown"
  | "ciFetched"
  | "prPhase"
> = {
  isDraft: false,
  updatedAt: null,
  reviewDecision: null,
  mergeable: null,
  mergeStateStatus: null,
  reviewers: [],
  requestedReviewers: [],
  unresolvedThreads: null,
  commentCount: null,
  reviewStateKnown: false,
  ciFetched: false,
  prPhase: "unknown",
};
