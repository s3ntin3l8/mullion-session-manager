// Shared by PrDetailView's test files: one open PR with a review, two threads
// and a comment, and a `fetch` stub that serves it. Not a test itself.
import { vi } from "vitest";
import { jsonResponse } from "../test/jsonResponse.js";
import type { GitHubPrDetail, ReviewSummary } from "../api/types.js";

export const PR: GitHubPrDetail = {
  number: 12,
  title: "Add thing",
  htmlUrl: "https://github.com/a/b/pull/12",
  state: "OPEN",
  isDraft: false,
  author: "me",
  bodyHtml: "<p>desc</p>",
  baseBranch: "main",
  headBranch: "feat-thing",
  headSha: "abc",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  commitCount: 1,
  commits: [{ oid: "commit-1", headline: "feat: thing", author: "Me", committedDate: "t" }],
  files: [{ filename: "src/a.ts", status: "modified", additions: 10, deletions: 2 }],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  requestedReviewers: [],
  reviewers: [{ login: "bob", state: "APPROVED" }],
  reviews: [
    {
      author: "bob",
      state: "APPROVED",
      bodyHtml: "<p>lgtm</p>",
      createdAt: "2026-01-02T00:00:00Z",
    },
  ],
  threads: [
    {
      id: "T1",
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: 4,
      comments: [
        { author: "bob", bodyHtml: "<p>guard null</p>", createdAt: "2026-01-02T00:00:00Z" },
      ],
    },
    {
      id: "T2",
      isResolved: true,
      isOutdated: false,
      path: "src/b.ts",
      line: 1,
      comments: [{ author: "bob", bodyHtml: "<p>old nit</p>", createdAt: "2026-01-02T00:00:00Z" }],
    },
  ],
  comments: [{ author: "carol", bodyHtml: "<p>nice</p>", createdAt: "2026-01-03T00:00:00Z" }],
  ciStatus: "success",
  ciKnown: true,
  actionsRuns: [
    {
      name: "CI",
      status: "completed",
      conclusion: "success",
      htmlUrl: "https://github.com/a/b/actions/runs/1",
      headSha: "abc",
    },
  ],
  prPhase: "ready_to_merge",
};

export const summaryOf = (over: Partial<ReviewSummary>): ReviewSummary => ({
  decision: null,
  approved: [],
  changesRequested: [],
  commented: [],
  requested: [],
  relay: null,
  unresolvedThreads: 0,
  latest: [],
  ...over,
});

export function stub(
  pr: GitHubPrDetail,
  extra?: (url: string, init?: RequestInit) => Response | null,
) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const custom = extra?.(url, init);
    if (custom) return Promise.resolve(custom);
    return Promise.resolve(jsonResponse(200, pr));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
