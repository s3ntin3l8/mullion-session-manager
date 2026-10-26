import { describe, expect, it } from "vitest";
import {
  buildReviewSummary,
  reviewersOf,
  withRelay,
  type GqlLatestReviewNode,
} from "../../src/services/review-summary.js";

// Recorded shape of what `latestReviews` returns for a PR whose only review is
// the Hermes bot's COMMENTED one — `latestOpinionatedReviews` returned [] here,
// which is the "No reviews yet" bug (epic #1965, R2).
const hermesCommented: GqlLatestReviewNode = {
  author: { login: "s3ntin3l8-hermes", __typename: "Bot" },
  state: "COMMENTED",
  body: "Two things to look at.",
  submittedAt: "2026-10-20T10:00:00Z",
  commit: { oid: "aaa111" },
};

const base = {
  reviewDecision: null,
  requestedReviewers: [] as string[],
  unresolvedThreads: 0,
  headSha: "aaa111",
};

describe("buildReviewSummary", () => {
  it("counts a COMMENTED-only bot review", () => {
    const s = buildReviewSummary({ ...base, reviews: [hermesCommented] });
    expect(s.commented).toEqual(["s3ntin3l8-hermes"]);
    expect(s.decision).toBe("COMMENTED");
    expect(s.latest).toEqual([
      expect.objectContaining({
        author: "s3ntin3l8-hermes",
        isBot: true,
        state: "COMMENTED",
        body: "Two things to look at.",
        reviewedSha: "aaa111",
        stale: false,
      }),
    ]);
  });

  it("buckets every state and ignores DISMISSED/PENDING and authorless reviews", () => {
    const s = buildReviewSummary({
      ...base,
      requestedReviewers: ["carol"],
      reviews: [
        { author: { login: "a" }, state: "APPROVED" },
        { author: { login: "b" }, state: "CHANGES_REQUESTED" },
        { author: { login: "c" }, state: "COMMENTED" },
        { author: { login: "d" }, state: "DISMISSED" },
        { author: { login: "e" }, state: "PENDING" },
        { author: null, state: "COMMENTED" },
        null,
      ],
    });
    expect(s).toMatchObject({
      approved: ["a"],
      changesRequested: ["b"],
      commented: ["c"],
      requested: ["carol"],
      decision: "CHANGES_REQUESTED",
    });
  });

  it("prefers GitHub's own decision and derives one otherwise", () => {
    const approved: GqlLatestReviewNode = { author: { login: "a" }, state: "APPROVED" };
    expect(buildReviewSummary({ ...base, reviews: [approved] }).decision).toBe("APPROVED");
    expect(
      buildReviewSummary({ ...base, reviewDecision: "REVIEW_REQUIRED", reviews: [approved] })
        .decision,
    ).toBe("REVIEW_REQUIRED");
    expect(buildReviewSummary({ ...base, requestedReviewers: ["x"], reviews: [] }).decision).toBe(
      "REVIEW_REQUIRED",
    );
    expect(buildReviewSummary({ ...base, reviews: [] }).decision).toBeNull();
  });

  it("keeps the latest human and the latest bot, newest first, and marks a moved head stale", () => {
    const human: GqlLatestReviewNode = {
      author: { login: "bob", __typename: "User" },
      state: "CHANGES_REQUESTED",
      body: "no",
      submittedAt: "2026-10-21T10:00:00Z",
      commit: { oid: "old" },
    };
    const olderHuman: GqlLatestReviewNode = {
      author: { login: "ann", __typename: "User" },
      state: "COMMENTED",
      body: "meh",
      submittedAt: "2026-10-19T10:00:00Z",
      commit: { oid: "old" },
    };
    const s = buildReviewSummary({ ...base, reviews: [olderHuman, hermesCommented, human] });
    expect(s.latest.map((e) => e.author)).toEqual(["bob", "s3ntin3l8-hermes"]);
    expect(s.latest[0]).toMatchObject({ reviewedSha: "old", stale: true });
    expect(s.latest[1].stale).toBe(false);
  });

  it("pins an empty-body review only while it leaves threads open, never an approval", () => {
    const inline: GqlLatestReviewNode = {
      author: { login: "bob" },
      state: "COMMENTED",
      body: "",
      submittedAt: "2026-10-21T10:00:00Z",
    };
    expect(buildReviewSummary({ ...base, reviews: [inline] }).latest).toEqual([]);
    const open = buildReviewSummary({ ...base, unresolvedThreads: 2, reviews: [inline] });
    expect(open.latest).toHaveLength(1);
    expect(open.latest[0]).toMatchObject({ reviewedSha: "", stale: false });
    const approval: GqlLatestReviewNode = { ...inline, state: "APPROVED" };
    expect(
      buildReviewSummary({ ...base, unresolvedThreads: 2, reviews: [approval] }).latest,
    ).toEqual([]);
  });

  it("bounds a huge body", () => {
    const s = buildReviewSummary({
      ...base,
      reviews: [{ ...hermesCommented, body: "x".repeat(10_000) }],
    });
    expect(s.latest[0].body.length).toBeLessThan(4_100);
  });
});

describe("withRelay / reviewersOf", () => {
  const summary = buildReviewSummary({ ...base, reviews: [hermesCommented] });

  it("folds the relay's state in, and nothing for state none", () => {
    expect(
      withRelay(summary, { state: "landed", author: "hermes[bot]", htmlUrl: "https://x/r" }).relay,
    ).toEqual({ state: "landed", reviewer: "hermes[bot]", url: "https://x/r" });
    expect(withRelay(summary, { state: "requested" }).relay).toEqual({
      state: "requested",
      reviewer: null,
      url: null,
    });
    expect(withRelay(summary, { state: "none" }).relay).toBeNull();
    expect(withRelay(summary, undefined).relay).toBeNull();
  });

  it("reduces nodes to login/state pairs", () => {
    expect(reviewersOf([hermesCommented, null, { author: null, state: "APPROVED" }])).toEqual([
      { login: "s3ntin3l8-hermes", state: "COMMENTED" },
    ]);
  });
});
