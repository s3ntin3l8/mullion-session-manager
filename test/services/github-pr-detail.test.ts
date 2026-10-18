import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPrDetail,
  invalidatePrDetail,
  resetPrDetailCacheForTests,
} from "../../src/services/github-pr-detail.js";
import { resetGraphqlBackoffForTests } from "../../src/services/github-pr-reviews.js";
import { resetGitHubRateLimitForTests } from "../../src/services/github-fetch.js";

const GQL_PR = {
  number: 5,
  title: "Add thing",
  url: "https://github.com/o/r/pull/5",
  bodyHTML: "<p>body</p>",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feat",
  headRefOid: "abc123",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  author: { login: "me" },
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "CHANGES_REQUESTED",
  commits: {
    totalCount: 1,
    nodes: [
      {
        commit: {
          oid: "abc123",
          messageHeadline: "feat: thing",
          committedDate: "2026-01-01T00:00:00Z",
          author: { name: "Me" },
        },
      },
    ],
  },
  reviewRequests: { nodes: [{ requestedReviewer: { login: "alice" } }, null] },
  latestOpinionatedReviews: { nodes: [{ author: { login: "bob" }, state: "CHANGES_REQUESTED" }] },
  reviews: {
    nodes: [
      {
        author: { login: "bob" },
        state: "CHANGES_REQUESTED",
        bodyHTML: "<p>no</p>",
        submittedAt: "2026-01-02T00:00:00Z",
      },
      { author: { login: "bob" }, state: "COMMENTED", bodyHTML: "  ", submittedAt: null },
    ],
  },
  reviewThreads: {
    nodes: [
      {
        isResolved: false,
        isOutdated: false,
        path: "a.ts",
        line: 3,
        comments: { nodes: [{ author: { login: "bob" }, bodyHTML: "<p>fix</p>", createdAt: "t" }] },
      },
    ],
  },
  comments: { nodes: [{ author: null, bodyHTML: "<p>hi</p>", createdAt: "t" }] },
};

describe("getPrDetail", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetPrDetailCacheForTests();
    resetGraphqlBackoffForTests();
    resetGitHubRateLimitForTests();
    fetchMock = vi.fn((url: string) => {
      if (url.includes("/graphql")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { repository: { pullRequest: GQL_PR } } }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify([{ filename: "a.ts", status: "modified", additions: 10, deletions: 2 }]),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("maps header, reviews (dropping empty COMMENTED wrappers), threads, comments and files", async () => {
    const d = await getPrDetail("tok", "o", "r", 5);
    expect(d).toMatchObject({
      number: 5,
      state: "OPEN",
      headSha: "abc123",
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      requestedReviewers: ["alice"],
      reviewers: [{ login: "bob", state: "CHANGES_REQUESTED" }],
      commitCount: 1,
      files: [{ filename: "a.ts", additions: 10 }],
      threads: [{ path: "a.ts", line: 3, isResolved: false }],
      comments: [{ author: null, bodyHtml: "<p>hi</p>" }],
    });
    expect(d.reviews).toHaveLength(1);
    expect(d.commits[0]).toMatchObject({ headline: "feat: thing", author: "Me" });
  });

  it("caches for 30s and refetches after invalidation", async () => {
    await getPrDetail("tok", "o", "r", 5);
    const calls = fetchMock.mock.calls.length;
    await getPrDetail("tok", "o", "r", 5);
    expect(fetchMock.mock.calls.length).toBe(calls);
    invalidatePrDetail("o", "r", 5);
    await getPrDetail("tok", "o", "r", 5);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    invalidatePrDetail("o", "r");
  });

  it("throws 404 for a missing PR and 502 when GraphQL is unavailable", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/graphql")
          ? new Response(JSON.stringify({ data: { repository: { pullRequest: null } } }), {
              status: 200,
            })
          : new Response("[]", { status: 200 }),
      ),
    );
    await expect(getPrDetail("tok", "o", "r", 99)).rejects.toMatchObject({ statusCode: 404 });

    resetPrDetailCacheForTests();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/graphql") ? new Response("no", { status: 500 }) : new Response("[]"),
      ),
    );
    await expect(getPrDetail("tok", "o", "r", 5)).rejects.toMatchObject({ statusCode: 502 });
  });

  it("pages through the file list and keeps what it has if a later page fails", async () => {
    const file = (n: number) => ({
      filename: `f${n}.ts`,
      status: "added",
      additions: 1,
      deletions: 0,
    });
    const page1 = Array.from({ length: 100 }, (_, i) => file(i));
    const page2 = [file(100), file(101)];
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/graphql")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { repository: { pullRequest: GQL_PR } } })),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(url.includes("page=2") ? page2 : page1), { status: 200 }),
      );
    });
    const d = await getPrDetail("tok", "o", "r", 5);
    expect(d.files).toHaveLength(102);

    resetPrDetailCacheForTests();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/graphql")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { repository: { pullRequest: GQL_PR } } })),
        );
      }
      return Promise.resolve(
        url.includes("page=2")
          ? new Response("no", { status: 403 })
          : new Response(JSON.stringify(page1), { status: 200 }),
      );
    });
    const partial = await getPrDetail("tok", "o", "r", 5);
    expect(partial.files).toHaveLength(100);
  });

  it("returns no files when the files call fails", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/graphql")
          ? new Response(JSON.stringify({ data: { repository: { pullRequest: GQL_PR } } }))
          : new Response("no", { status: 403 }),
      ),
    );
    const d = await getPrDetail("tok", "o", "r", 5);
    expect(d.files).toEqual([]);
  });
});
