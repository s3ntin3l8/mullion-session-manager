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
    // The poller asks every few seconds; a review that landed does not
    // un-land, so it must not cost a GitHub call per tick forever.
    mocks.listPullRequestReviews.mockResolvedValue([hermesReview]);
    const app = makeApp();
    expect(await ask(app)).toMatchObject({ state: "landed", verdict: "APPROVED" });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    expect(await ask(app)).toMatchObject({ state: "landed", verdict: "APPROVED" });
    expect(mocks.listPullRequestReviews).toHaveBeenCalledTimes(1);
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

  it("ignores another bot's review of the head", async () => {
    mocks.listPullRequestReviews.mockResolvedValue([{ ...hermesReview, author: "claude[bot]" }]);
    expect(await ask(makeApp())).toMatchObject({ state: "requested", landedChecked: true });
  });
});

describe("pruneLandedMemo", () => {
  it("spares a terminal entry in the age sweep, but evicts it when over the cap", () => {
    const memo = new Map<string, { at: number; terminal?: boolean }>([
      ["old-terminal", { at: 0, terminal: true }],
      ["old-requested", { at: 1 }],
      ["fresh", { at: 20_000 }],
    ]);
    pruneLandedMemo(memo, 20_000, 2);
    expect([...memo.keys()]).toEqual(["old-terminal", "fresh"]);
    memo.set("newer", { at: 20_001 });
    pruneLandedMemo(memo, 20_001, 2);
    // Still over the cap after the sweep: the oldest goes, terminal or not.
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
