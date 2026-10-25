import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as SettingsModule from "../../src/services/settings.js";
import type { PROrWithChecks } from "../../src/services/github.js";

const mocks = vi.hoisted(() => ({
  listPullRequestReviews: vi.fn(),
  getReviewRunForPr: vi.fn(),
}));

vi.mock("../../src/services/github-write.js", () => ({
  listPullRequestReviews: mocks.listPullRequestReviews,
}));
vi.mock("../../src/services/hermes-review.js", () => ({
  getReviewRunForPr: mocks.getReviewRunForPr,
}));
vi.mock("../../src/services/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SettingsModule>();
  return {
    ...actual,
    getStoredSettings: () => ({
      ...actual.DEFAULT_SETTINGS,
      reviewRelay: { ...actual.DEFAULT_SETTINGS.reviewRelay, reviewerBotLogin: "hermes[bot]" },
    }),
  };
});

import {
  annotateRelayReviewState,
  getRelayReviewState,
  resolveReviewedCommit,
  overlayRelayRuns,
  pruneLandedMemo,
} from "../../src/services/relay-review-state.js";

// A new app per test: the memo lives on the app, so tests cannot share answers.
const makeApp = () => ({ log: { warn: vi.fn() }, db: {} }) as unknown as FastifyInstance;

const run = (runId = "run_1") => ({
  runId,
  owner: "acme",
  repo: "widgets",
  prNumber: 41,
  headSha: "sha41",
  dispatchedAt: Date.parse("2026-01-01T00:00:00Z"),
});

const hermesReview = {
  author: "hermes[bot]",
  authorIsBot: true,
  state: "APPROVED",
  commitId: "sha41",
  submittedAt: "2026-01-01T00:05:00Z",
  body: "Looks good",
};

const ask = (app: FastifyInstance) =>
  getRelayReviewState(app, { owner: "acme", repo: "widgets", prNumber: 41, token: "tok" });

beforeEach(() => {
  mocks.listPullRequestReviews.mockReset();
  mocks.getReviewRunForPr.mockReset();
  mocks.getReviewRunForPr.mockReturnValue(run());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-01-01T00:10:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getRelayReviewState memo", () => {
  it("keeps a landed review past the TTL without re-fetching it (#1744)", async () => {
    // The poller asks every few seconds; a landed review is settled enough to
    // be re-checked only rarely, not once per tick.
    mocks.listPullRequestReviews.mockResolvedValue([hermesReview]);
    const app = makeApp();
    expect(await ask(app)).toMatchObject({ state: "landed", verdict: "APPROVED" });
    vi.setSystemTime(Date.now() + 9 * 60_000);
    expect(await ask(app)).toMatchObject({ state: "landed", verdict: "APPROVED" });
    expect(mocks.listPullRequestReviews).toHaveBeenCalledTimes(1);
  });

  it("re-checks a landed review eventually, so a dismissed one stops reading landed", async () => {
    mocks.listPullRequestReviews
      .mockResolvedValueOnce([hermesReview])
      .mockResolvedValue([{ ...hermesReview, state: "DISMISSED" }]);
    const app = makeApp();
    expect(await ask(app)).toMatchObject({ state: "landed" });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await ask(app)).toMatchObject({ state: "requested", landedChecked: true });
    expect(mocks.listPullRequestReviews).toHaveBeenCalledTimes(2);
  });

  it("backs off on a run too old for a review to still be coming", async () => {
    mocks.listPullRequestReviews.mockResolvedValue([]);
    mocks.getReviewRunForPr.mockReturnValue({
      ...run(),
      dispatchedAt: Date.now() - 25 * 60 * 60_000,
    });
    const app = makeApp();
    await ask(app);
    vi.setSystemTime(Date.now() + 60_000);
    await ask(app);
    expect(mocks.listPullRequestReviews).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await ask(app);
    expect(mocks.listPullRequestReviews).toHaveBeenCalledTimes(2);
  });

  it("re-fetches a requested (not yet landed) review after the TTL", async () => {
    mocks.listPullRequestReviews.mockResolvedValue([]);
    const app = makeApp();
    expect(await ask(app)).toMatchObject({ state: "requested", landedChecked: true });
    vi.setSystemTime(Date.now() + 5_000);
    await ask(app);
    expect(mocks.listPullRequestReviews).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6_000);
    await ask(app);
    expect(mocks.listPullRequestReviews).toHaveBeenCalledTimes(2);
  });

  it("re-fetches a failed lookup after the TTL, not terminally", async () => {
    mocks.listPullRequestReviews.mockRejectedValueOnce(new Error("boom"));
    mocks.listPullRequestReviews.mockResolvedValue([hermesReview]);
    const app = makeApp();
    expect(await ask(app)).toMatchObject({ state: "requested", landedChecked: false });
    vi.setSystemTime(Date.now() + 11_000);
    expect(await ask(app)).toMatchObject({ state: "landed" });
  });

  it("checks again for a new run of the same PR", async () => {
    mocks.listPullRequestReviews.mockResolvedValueOnce([hermesReview]).mockResolvedValue([]);
    const app = makeApp();
    expect(await ask(app)).toMatchObject({ state: "landed" });
    mocks.getReviewRunForPr.mockReturnValue(run("run_2"));
    expect(await ask(app)).toMatchObject({ state: "requested", runId: "run_2" });
    expect(mocks.listPullRequestReviews).toHaveBeenCalledTimes(2);
  });

  it("finds a review whose commit_id GitHub re-pointed at a newer head (#129)", async () => {
    // The run was dispatched for sha41; "Update branch" has since moved the
    // head, and GitHub re-pointed the approval's commit_id with it. The review
    // is the run's all the same: it was submitted after the dispatch.
    mocks.listPullRequestReviews.mockResolvedValue([{ ...hermesReview, commitId: "sha-merge" }]);
    expect(await ask(makeApp())).toMatchObject({
      state: "landed",
      verdict: "APPROVED",
    });
  });

  it("ignores another bot's review of the head", async () => {
    mocks.listPullRequestReviews.mockResolvedValue([{ ...hermesReview, author: "claude[bot]" }]);
    expect(await ask(makeApp())).toMatchObject({ state: "requested", landedChecked: true });
  });
});

describe("pruneLandedMemo", () => {
  it("honours each entry's own TTL in the age sweep, and still evicts the oldest over the cap", () => {
    const memo = new Map<string, { at: number; ttl?: number }>([
      ["old-long-ttl", { at: 0, ttl: 600_000 }],
      ["old-short-ttl", { at: 1 }],
      ["fresh", { at: 20_000 }],
    ]);
    pruneLandedMemo(memo, 20_000, 2);
    expect([...memo.keys()]).toEqual(["old-long-ttl", "fresh"]);
    memo.set("newer", { at: 20_001 });
    pruneLandedMemo(memo, 20_001, 2);
    // Still over the cap after the sweep: the oldest goes, long TTL or not.
    expect([...memo.keys()]).toEqual(["fresh", "newer"]);
  });
});

describe("annotateRelayReviewState", () => {
  const pr = (number: number) => ({ number, title: `PR ${number}` }) as unknown as PROrWithChecks;
  const repoRef = { owner: "acme", repo: "widgets" };

  it("returns the list untouched when the relay knows none of the PRs", async () => {
    mocks.getReviewRunForPr.mockReturnValue(null);
    const prs = [pr(41)];
    expect(await annotateRelayReviewState(makeApp(), prs, repoRef, "tok")).toBe(prs);
    expect(mocks.listPullRequestReviews).not.toHaveBeenCalled();
  });

  it("annotates only PRs with a run, without the review's text", async () => {
    mocks.getReviewRunForPr.mockImplementation((_o, _r, n: number) => (n === 41 ? run() : null));
    mocks.listPullRequestReviews.mockResolvedValue([hermesReview]);
    const [a, b] = await annotateRelayReviewState(makeApp(), [pr(41), pr(42)], repoRef, "tok");
    expect(a.relayReview).toMatchObject({ state: "landed", verdict: "APPROVED" });
    expect(a.relayReview).not.toHaveProperty("body");
    expect(b).not.toHaveProperty("relayReview");
  });

  it("says a review was requested but cannot be confirmed without a token", async () => {
    const [a] = await annotateRelayReviewState(makeApp(), [pr(41)], repoRef, null);
    expect(a.relayReview).toMatchObject({ state: "requested", landedChecked: false });
    expect(mocks.listPullRequestReviews).not.toHaveBeenCalled();
  });
});

describe("overlayRelayRuns", () => {
  const repoRef = { owner: "acme", repo: "widgets" };
  const pr = (relayReview?: PROrWithChecks["relayReview"]) =>
    ({ number: 41, ...(relayReview ? { relayReview } : {}) }) as unknown as PROrWithChecks;

  it("makes no network call and returns the same list when nothing differs", () => {
    mocks.getReviewRunForPr.mockReturnValue(null);
    const prs = [pr()];
    expect(overlayRelayRuns(prs, repoRef)).toBe(prs);
    expect(mocks.listPullRequestReviews).not.toHaveBeenCalled();
  });

  it("keeps the cached annotation when it describes the current run", () => {
    const prs = [pr({ state: "landed", runId: "run_1", verdict: "APPROVED" })];
    expect(overlayRelayRuns(prs, repoRef)).toBe(prs);
  });

  it("shows a run the cache does not know yet as requested, leaving the cache alone", () => {
    mocks.getReviewRunForPr.mockReturnValue(run("run_2"));
    const cached = pr({ state: "landed", runId: "run_1", verdict: "APPROVED" });
    const [shown] = overlayRelayRuns([cached], repoRef);
    expect(shown.relayReview).toMatchObject({
      state: "requested",
      runId: "run_2",
      landedChecked: false,
    });
    expect(cached.relayReview).toMatchObject({ state: "landed", runId: "run_1" });
  });
});

describe("resolveReviewedCommit (s3ntin3l8/.github#129)", () => {
  const review = (over: Record<string, unknown> = {}) => ({
    author: "hermes[bot]",
    authorIsBot: true,
    state: "APPROVED",
    commitId: "sha-now",
    submittedAt: "2026-01-02T00:00:00Z",
    ...over,
  });
  const resolve = (
    reviews: ReturnType<typeof review>[],
    over: Partial<Parameters<typeof resolveReviewedCommit>[0]> = {},
  ) =>
    resolveReviewedCommit({
      reviews,
      reviewerBotLogin: "hermes[bot]",
      committedAt: async () => "2026-01-01T00:00:00Z",
      ...over,
    });

  it("is empty with no landed review by the reviewer", async () => {
    expect(await resolve([])).toBe("");
    expect(await resolve([review({ author: "claude[bot]" })])).toBe("");
    expect(await resolve([review({ state: "PENDING", submittedAt: null })])).toBe("");
    expect(await resolve([review({ authorIsBot: false })])).toBe("");
  });

  it("takes the newest marker that a landed review was submitted after", async () => {
    // Deliberately not in id order: the newest is decided by id, not by position.
    const markers = async () => [
      { oid: "new", id: 2, startedAt: "2026-01-01T11:00:00Z" },
      { oid: "silent", id: 3, startedAt: "2026-01-03T00:00:00Z" },
      { oid: "old", id: 1, startedAt: "2026-01-01T10:00:00Z" },
    ];
    expect(await resolve([review()], { markers })).toBe("new");
  });

  it("falls back to the commit_id when the ledger fails or names nothing", async () => {
    const reviews = [review({ commitId: "sha-old" })];
    expect(
      await resolve(reviews, {
        markers: async () => {
          throw new Error("no checks scope");
        },
      }),
    ).toBe("sha-old");
    expect(await resolve(reviews, { markers: async () => [] })).toBe("sha-old");
  });

  it("trusts a commit_id only while the commit is not newer than the review", async () => {
    expect(await resolve([review()], { committedAt: async () => "2026-01-03T00:00:00Z" })).toBe("");
    expect(await resolve([review()], { committedAt: async () => "" })).toBe("");
    expect(
      await resolve([review()], {
        committedAt: async () => {
          throw new Error("gone");
        },
      }),
    ).toBe("");
    expect(await resolve([review({ commitId: "" })])).toBe("");
    expect(await resolve([review({ submittedAt: null })])).toBe("");
  });
});
