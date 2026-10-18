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
    reviewStateKnown: false,
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

  it("reuses the last known review state when a later call fails (no flapping)", async () => {
    fetchMock
      .mockResolvedValueOnce(listResponse([gqlNode(1)]))
      .mockResolvedValueOnce(threadsResponse({ 1: 2 }));
    await enrichPrsWithReviewState("tok", "o", "stale-repo", [pr(1)]);

    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    const again = [pr(1)];
    await enrichPrsWithReviewState("tok", "o", "stale-repo", again);
    expect(again[0]).toMatchObject({
      reviewDecision: "APPROVED",
      unresolvedThreads: 2,
      commentCount: 3,
      prPhase: "ready_to_merge",
    });
  });

  it("keeps the previous thread count when only the thread lookup fails", async () => {
    fetchMock
      .mockResolvedValueOnce(listResponse([gqlNode(1)]))
      .mockResolvedValueOnce(threadsResponse({ 1: 3 }));
    await enrichPrsWithReviewState("tok", "o", "thread-fail-repo", [pr(1)]);

    fetchMock
      .mockResolvedValueOnce(listResponse([gqlNode(1, { updatedAt: "2026-10-18T12:00:00Z" })]))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const again = [pr(1)];
    await enrichPrsWithReviewState("tok", "o", "thread-fail-repo", again);
    expect(again[0].unresolvedThreads).toBe(3);
  });

  it("re-fetches thread counts after the cache max age even if updatedAt is unchanged", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(listResponse([gqlNode(1)]))
        .mockResolvedValueOnce(threadsResponse({ 1: 2 }));
      await enrichPrsWithReviewState("tok", "o", "ttl-repo", [pr(1)]);

      vi.advanceTimersByTime(6 * 60_000);
      fetchMock
        .mockResolvedValueOnce(listResponse([gqlNode(1)]))
        .mockResolvedValueOnce(threadsResponse({ 1: 0 }));
      const again = [pr(1)];
      await enrichPrsWithReviewState("tok", "o", "ttl-repo", again);
      expect(again[0].unresolvedThreads).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("survives a nulled pullRequests connection or thread connection", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { repository: { pullRequests: null } } }), {
        status: 200,
      }),
    );
    const none = [pr(1)];
    await expect(enrichPrsWithReviewState("tok", "o", "null-repo", none)).resolves.toBeUndefined();
    expect(none[0].reviewStateKnown).toBe(false);

    fetchMock.mockResolvedValueOnce(listResponse([gqlNode(1)])).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { repository: { p1: { reviewThreads: null } } } }), {
        status: 200,
      }),
    );
    const noThreads = [pr(1)];
    await enrichPrsWithReviewState("tok", "o", "null-threads-repo", noThreads);
    expect(noThreads[0].unresolvedThreads).toBeNull();
    expect(noThreads[0].reviewStateKnown).toBe(true);
  });

  it("keeps a known review decision when only the comment count is nulled", async () => {
    fetchMock
      .mockResolvedValueOnce(
        listResponse([gqlNode(1, { reviewDecision: "CHANGES_REQUESTED", comments: null })]),
      )
      .mockResolvedValueOnce(threadsResponse({ 1: 0 }));
    const prs = [pr(1)];
    await enrichPrsWithReviewState("tok", "o", "partial-repo", prs);
    expect(prs[0].commentCount).toBeNull();
    expect(prs[0].prPhase).toBe("changes_requested");
  });

  it("warns once per distinct failure and logs the GraphQL cost", async () => {
    const log = { warn: vi.fn(), debug: vi.fn() };
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await enrichPrsWithReviewState("tok", "o", "log-repo", [pr(1)], log);
    await enrichPrsWithReviewState("tok", "o", "log-repo", [pr(1)], log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({ reason: "http 500" });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(listResponse([gqlNode(1)]))
      .mockResolvedValueOnce(threadsResponse({ 1: 0 }));
    await enrichPrsWithReviewState("tok", "o", "log-repo", [pr(1)], log);
    expect(log.debug).toHaveBeenCalledWith(
      { cost: 1, remaining: 4000 },
      "[github-pr-reviews] GraphQL budget",
    );
  });

  it("warns once for a partial response (data + errors) across ticks", async () => {
    const log = { warn: vi.fn(), debug: vi.fn() };
    const partial = () =>
      new Response(
        JSON.stringify({
          data: { repository: { pullRequests: { nodes: [gqlNode(1)] } } },
          errors: [{ type: "FORBIDDEN", message: "denied" }],
        }),
        { status: 200 },
      );
    fetchMock.mockImplementation(async (_u: unknown, init: { body: string }) =>
      init.body.includes("reviewThreads") ? threadsResponse({ 1: 0 }) : partial(),
    );
    await enrichPrsWithReviewState("tok", "o", "partial-warn-repo", [pr(1)], log);
    await enrichPrsWithReviewState("tok", "o", "partial-warn-repo", [pr(1)], log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({ reason: "FORBIDDEN" });
  });

  it("makes no request when there are no PRs", async () => {
    await enrichPrsWithReviewState("tok", "o", "empty-repo", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
