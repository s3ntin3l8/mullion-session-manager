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

// The two host-git entry points as one mock pair: `resolveRepoRefResult`
// (the review-post and own-thread helpers use this non-collapsing variant)
// returns the `{ ok, value }` shape around the same `resolveRepoRef` stub.
export const repoRefMocks = (fn: (...args: unknown[]) => unknown) => ({
  resolveRepoRef: fn,
  resolveRepoRefResult: async (...args: unknown[]) => ({ ok: true, value: await fn(...args) }),
});
