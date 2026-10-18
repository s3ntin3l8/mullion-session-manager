import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PROrWithChecks } from "../../src/services/github.js";
import {
  enrichPrsWithReviewState,
  graphqlBackoffRemainingMs,
  resetGraphqlBackoffForTests,
} from "../../src/services/github-pr-reviews.js";
import {
  isGitHubRateLimited,
  resetGitHubRateLimitForTests,
} from "../../src/services/github-fetch.js";

function pr(number: number): PROrWithChecks {
  return {
    number,
    title: `PR ${number}`,
    htmlUrl: `https://github.com/o/r/pull/${number}`,
    author: "me",
    headSha: "sha",
    headBranch: `b${number}`,
    baseBranch: "main",
    ciStatus: "success",
    actionsRuns: [],
    isDraft: false,
    updatedAt: null,
    reviewDecision: null,
    mergeable: null,
    mergeStateStatus: null,
    reviewers: [],
    requestedReviewers: [],
    unresolvedThreads: null,
    commentCount: null,
    prPhase: "unknown",
  };
}

function gqlNode(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    isDraft: false,
    updatedAt: "2026-10-18T10:00:00Z",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "alice" } }] },
    latestOpinionatedReviews: { nodes: [{ author: { login: "bob" }, state: "APPROVED" }] },
    comments: { totalCount: 3 },
    ...over,
  };
}

function listResponse(nodes: unknown[], remaining = 4000) {
  return new Response(
    JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining, resetAt: "2099-01-01T00:00:00Z" },
        repository: { pullRequests: { nodes } },
      },
    }),
    { status: 200 },
  );
}

function threadsResponse(unresolvedByPr: Record<number, number>) {
  const repository: Record<string, unknown> = {};
  for (const [n, unresolved] of Object.entries(unresolvedByPr)) {
    repository[`p${n}`] = {
      reviewThreads: {
        nodes: [
          ...Array.from({ length: unresolved }, () => ({ isResolved: false })),
          { isResolved: true },
        ],
      },
    };
  }
  return new Response(
    JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 4000, resetAt: "2099-01-01T00:00:00Z" },
        repository,
      },
    }),
    { status: 200 },
  );
}

describe("enrichPrsWithReviewState", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resetGraphqlBackoffForTests();
    resetGitHubRateLimitForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fills review fields, thread counts and the derived phase", async () => {
    fetchMock
      .mockResolvedValueOnce(listResponse([gqlNode(1)]))
      .mockResolvedValueOnce(threadsResponse({ 1: 2 }));
    const prs = [pr(1)];
    await enrichPrsWithReviewState("tok", "o", "r", prs);

    expect(prs[0]).toMatchObject({
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      requestedReviewers: ["alice"],
      reviewers: [{ login: "bob", state: "APPROVED" }],
      commentCount: 3,
      unresolvedThreads: 2,
      updatedAt: "2026-10-18T10:00:00Z",
      prPhase: "ready_to_merge",
    });
  });

  it("only re-queries threads for PRs whose updatedAt moved", async () => {
    // Own repo name: the thread cache is module-level.
    fetchMock
      .mockResolvedValueOnce(listResponse([gqlNode(1), gqlNode(2)]))
      .mockResolvedValueOnce(threadsResponse({ 1: 1, 2: 0 }));
    await enrichPrsWithReviewState("tok", "o", "cache-repo", [pr(1), pr(2)]);

    fetchMock
      .mockResolvedValueOnce(
        listResponse([gqlNode(1), gqlNode(2, { updatedAt: "2026-10-18T11:00:00Z" })]),
      )
      .mockResolvedValueOnce(threadsResponse({ 2: 4 }));
    const second = [pr(1), pr(2)];
    await enrichPrsWithReviewState("tok", "o", "cache-repo", second);

    const threadsQuery = JSON.parse(fetchMock.mock.calls[3][1].body as string).query as string;
    expect(threadsQuery).toContain("p2:");
    expect(threadsQuery).not.toContain("p1:");
    expect(second.map((p) => p.unresolvedThreads)).toEqual([1, 4]);
  });

  it("leaves PRs untouched when the request fails or errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const prs = [pr(1)];
    await enrichPrsWithReviewState("tok", "o", "fail-repo", prs);
    expect(prs[0].reviewDecision).toBeNull();
    expect(prs[0].unresolvedThreads).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await enrichPrsWithReviewState("tok", "o", "fail-repo", prs);
    expect(prs[0].reviewDecision).toBeNull();
  });

  it("backs off GraphQL only — a 403 never trips the process-wide REST budget", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("slow down", { status: 403, headers: { "retry-after": "120" } }),
    );
    await enrichPrsWithReviewState("tok", "o", "limit-repo", [pr(1)]);
    expect(graphqlBackoffRemainingMs()).toBeGreaterThan(60_000);
    expect(isGitHubRateLimited()).toBe(false);

    // Backed off: no further request is made.
    fetchMock.mockClear();
    await enrichPrsWithReviewState("tok", "o", "limit-repo", [pr(1)]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a RATE_LIMITED error body as a backoff", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "x" }] }), {
        status: 200,
      }),
    );
    await enrichPrsWithReviewState("tok", "o", "rl-repo", [pr(1)]);
    expect(graphqlBackoffRemainingMs()).toBeGreaterThan(0);
  });

  it("backs off until reset when the remaining budget is nearly gone", async () => {
    fetchMock
      .mockResolvedValueOnce(listResponse([gqlNode(1)], 50))
      .mockResolvedValueOnce(threadsResponse({ 1: 0 }));
    await enrichPrsWithReviewState("tok", "o", "budget-repo", [pr(1)]);
    expect(graphqlBackoffRemainingMs()).toBeGreaterThan(1_000_000);
  });

  it("makes no request when there are no PRs", async () => {
    await enrichPrsWithReviewState("tok", "o", "empty-repo", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
