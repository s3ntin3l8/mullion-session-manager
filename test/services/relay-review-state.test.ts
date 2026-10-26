import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as SettingsModule from "../../src/services/settings.js";
import type { PROrWithChecks } from "../../src/services/github.js";

const mocks = vi.hoisted(() => ({
  listPullRequestReviews: vi.fn(),
  listReviewMarkers: vi.fn(),
  getReviewRunForPr: vi.fn(),
}));

vi.mock("../../src/services/github-write.js", () => ({
  listPullRequestReviews: mocks.listPullRequestReviews,
  listReviewMarkers: mocks.listReviewMarkers,
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
  mocks.listReviewMarkers.mockReset();
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

describe("rehydrating the landed state after a restart (no run in memory)", () => {
  // A finished ledger marker that ran 00:00-00:08, and Hermes's review at 00:05.
  const marker = {
    oid: "sha41",
    id: 77,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:08:00Z",
  };
  beforeEach(() => {
    mocks.getReviewRunForPr.mockReturnValue(null);
  });

  it("rebuilds `landed` from a ledger marker paired with the reviewer's review", async () => {
    mocks.listPullRequestReviews.mockResolvedValue([
      { ...hermesReview, state: "COMMENTED", htmlUrl: "https://github.com/r/1" },
    ]);
    mocks.listReviewMarkers.mockResolvedValue([marker]);
    expect(await ask(makeApp())).toMatchObject({
      state: "landed",
      runId: "marker-77",
      landedChecked: true,
      author: "hermes[bot]",
      verdict: "COMMENTED",
      htmlUrl: "https://github.com/r/1",
    });
  });

  it("stays `none` when no marker covers the review, or there is no reviewer review", async () => {
    mocks.listPullRequestReviews.mockResolvedValue([
      { ...hermesReview, submittedAt: "2026-01-01T05:00:00Z" },
    ]);
    mocks.listReviewMarkers.mockResolvedValue([marker]);
    expect(await ask(makeApp())).toEqual({ state: "none" });

    mocks.listPullRequestReviews.mockResolvedValue([]);
    expect(await ask(makeApp())).toEqual({ state: "none" });
    expect(mocks.listReviewMarkers).toHaveBeenCalledTimes(1);
  });

  it("ignores another bot's review and a failed GitHub read", async () => {
    mocks.listPullRequestReviews.mockResolvedValue([{ ...hermesReview, author: "claude[bot]" }]);
    expect(await ask(makeApp())).toEqual({ state: "none" });
    mocks.listPullRequestReviews.mockRejectedValue(new Error("boom"));
    const app = makeApp();
    expect(await ask(app)).toEqual({ state: "none" });
    expect(app.log.warn).toHaveBeenCalled();
  });

  it("memoizes per PR, and needs a token", async () => {
    mocks.listPullRequestReviews.mockResolvedValue([hermesReview]);
    mocks.listReviewMarkers.mockResolvedValue([marker]);
    const app = makeApp();
    await ask(app);
    await ask(app);
    expect(mocks.listPullRequestReviews).toHaveBeenCalledTimes(1);
    expect(
      await getRelayReviewState(makeApp(), {
        owner: "acme",
        repo: "widgets",
        prNumber: 41,
        token: null,
      }),
    ).toEqual({ state: "none" });
  });

  it("annotates a PR the reviewer already reviewed, and folds the relay into its summary", async () => {
    mocks.listPullRequestReviews.mockResolvedValue([hermesReview]);
    mocks.listReviewMarkers.mockResolvedValue([marker]);
    const summary = { decision: "COMMENTED", relay: null, latest: [] };
    const reviewed = {
      number: 41,
      reviewers: [{ login: "hermes", state: "COMMENTED" }],
      reviewSummary: summary,
    } as unknown as PROrWithChecks;
    const other = { number: 42, reviewers: [] } as unknown as PROrWithChecks;
    const [a, b] = await annotateRelayReviewState(
      makeApp(),
      [reviewed, other],
      { owner: "acme", repo: "widgets" },
      "tok",
    );
    expect(a.relayReview).toMatchObject({ state: "landed", runId: "marker-77" });
    expect(a.reviewSummary?.relay).toMatchObject({ state: "landed", reviewer: "hermes[bot]" });
    expect(b).toBe(other);
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

  it("keeps the summary's relay in step with the requested overlay", () => {
    mocks.getReviewRunForPr.mockReturnValue(run("run_2"));
    const withSummary = {
      number: 41,
      reviewSummary: { decision: null, relay: null, latest: [] },
    } as unknown as PROrWithChecks;
    const [shown] = overlayRelayRuns([withSummary], repoRef);
    expect(shown.reviewSummary?.relay).toMatchObject({ state: "requested" });
    expect(withSummary.reviewSummary?.relay).toBeNull();
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
    // Deliberately not in id order: the newest is decided by id, not by position. Each run
    // started within 90 minutes before the review (a run cannot have lasted longer).
    const markers = async () => [
      { oid: "new", id: 2, startedAt: "2026-01-01T23:40:00Z", completedAt: "2026-01-09T00:00:00Z" },
      {
        oid: "silent",
        id: 3,
        startedAt: "2026-01-03T00:00:00Z",
        completedAt: "2026-01-09T00:00:00Z",
      },
      { oid: "old", id: 1, startedAt: "2026-01-01T23:30:00Z", completedAt: "2026-01-09T00:00:00Z" },
    ];
    expect(await resolve([review()], { markers })).toBe("new");
  });

  it("does not pair an older silent marker with a LATER review from another run (#133)", async () => {
    // Marker A's run posted the review at 10:20. Marker B (newer) ran 11:00-11:30
    // and posted nothing. A later review at 13:00 comes from a run whose marker
    // was never written. With a lower bound only, that review paired B and the
    // base was B — a base that is too new, which skips code nobody reviewed.
    const markers = async () => [
      {
        oid: "reviewed",
        id: 1,
        startedAt: "2026-01-01T10:00:00Z",
        completedAt: "2026-01-01T10:30:00Z",
      },
      {
        oid: "silent",
        id: 2,
        startedAt: "2026-01-01T11:00:00Z",
        completedAt: "2026-01-01T11:30:00Z",
      },
    ];
    const reviews = [
      review({ submittedAt: "2026-01-01T10:20:00Z" }),
      review({ submittedAt: "2026-01-01T13:00:00Z" }),
    ];
    expect(await resolve(reviews, { markers })).toBe("reviewed");
  });

  it("allows for clock skew between the marker's close and the review", async () => {
    // The marker is closed from the workflow's runner or this server, the review
    // is stamped by GitHub: a few seconds of skew must not un-pair a genuine one.
    const markers = async () => [
      {
        oid: "reviewed",
        id: 1,
        startedAt: "2026-01-01T10:00:00Z",
        completedAt: "2026-01-01T10:30:00Z",
      },
    ];
    expect(await resolve([review({ submittedAt: "2026-01-01T10:30:30Z" })], { markers })).toBe(
      "reviewed",
    );
    // Past the slack it is another run's review: no pairing, and with a commit_id
    // newer than the review nothing is known, so the whole diff.
    expect(
      await resolve([review({ submittedAt: "2026-01-01T10:32:00Z" })], {
        markers,
        committedAt: async () => "2026-01-02T00:00:00Z",
      }),
    ).toBe("");
  });

  it("does not pair a silent marker that was closed hours late with an unrelated review", async () => {
    // Run A (10:00-10:30) posted the review at 10:20. Run B (11:00) posted nothing and was
    // closed with "now" at 17:00. An unrelated review at 13:00 comes from a run whose marker
    // was never written. Without a cap on the run length the late close made B pair it, and
    // the base became B: too new, code skipped (s3ntin3l8/.github#133).
    const markers = async () => [
      {
        oid: "reviewed",
        id: 1,
        startedAt: "2026-01-01T10:00:00Z",
        completedAt: "2026-01-01T10:30:00Z",
      },
      {
        oid: "silent",
        id: 2,
        startedAt: "2026-01-01T11:00:00Z",
        completedAt: "2026-01-01T17:00:00Z",
      },
    ];
    const reviews = [
      review({ submittedAt: "2026-01-01T10:20:00Z" }),
      review({ submittedAt: "2026-01-01T13:00:00Z" }),
    ];
    expect(await resolve(reviews, { markers })).toBe("reviewed");
  });

  it("still pairs a genuine run that was closed just as late", async () => {
    const markers = async () => [
      {
        oid: "late",
        id: 2,
        startedAt: "2026-01-01T11:00:00Z",
        completedAt: "2026-01-01T17:00:00Z",
      },
    ];
    expect(await resolve([review({ submittedAt: "2026-01-01T11:20:00Z" })], { markers })).toBe(
      "late",
    );
  });

  it("caps a run at 90 minutes whatever its close says", async () => {
    const markers = async () => [
      {
        oid: "m",
        id: 1,
        startedAt: "2026-01-01T10:00:00Z",
        completedAt: "2026-01-01T23:00:00Z",
      },
    ];
    const committedAt = async () => "2026-01-02T00:00:00Z"; // newer than the review: untrusted
    // 89 min after the start: inside the cap.
    expect(
      await resolve([review({ submittedAt: "2026-01-01T11:29:00Z" })], { markers, committedAt }),
    ).toBe("m");
    // 95 min after the start: past it, so no pairing and nothing is known: the whole diff.
    expect(
      await resolve([review({ submittedAt: "2026-01-01T11:35:00Z" })], { markers, committedAt }),
    ).toBe("");
  });

  it("does not pair a marker with a dismissed review (the escape hatch)", async () => {
    // Dismissing the review retracts the pairing: the marker alone is not a
    // review, so rule 1 is empty and, with no landed review left, so is rule 2.
    const markers = async () => [
      {
        oid: "reviewed",
        id: 1,
        startedAt: "2026-01-01T11:00:00Z",
        completedAt: "2026-01-09T00:00:00Z",
      },
    ];
    expect(await resolve([review({ state: "DISMISSED" })], { markers })).toBe("");
  });

  it("says so when the ledger or a commit cannot be read", async () => {
    const onError = vi.fn();
    expect(
      await resolve([review({ commitId: "sha-old" })], {
        markers: async () => {
          throw new Error("FORBIDDEN");
        },
        onError,
      }),
    ).toBe("sha-old");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("ledger unreadable"));
    onError.mockClear();
    expect(
      await resolve([review()], {
        committedAt: async () => {
          throw new Error("gone");
        },
        onError,
      }),
    ).toBe("");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("unreadable"));
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
