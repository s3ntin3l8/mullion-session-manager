import { describe, it, expect, vi, afterEach } from "vitest";
import { resetGitHubRateLimitForTests } from "../../src/services/github-fetch.js";
import {
  getRepoPRsStatus,
  setRepoPRsStatus,
  getPRsStatus,
  normalizeRollupState,
  combineCiStatus,
  parseOtherChecks,
  getWorkflowRunJobs,
  getJobLogs,
  fetchRunsForHead,
  fetchRunsForHeadChecked,
  applyPrPhase,
  computeCiStatus,
} from "../../src/services/github.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

function mockGithubApi(opts: {
  pulls?: unknown[];
  headRuns?: Record<string, unknown[]>;
  pullsOk?: boolean;
  /** Status to answer /actions/runs with instead of a 200 (e.g. 403/429). */
  runsStatus?: number;
}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/actions/runs") && opts.runsStatus) {
      return Promise.resolve(new Response("nope", { status: opts.runsStatus }));
    }
    if (url.includes("/actions/runs")) {
      // /actions/runs?head_sha=...
      const sha = new URL(url).searchParams.get("head_sha");
      const runs = sha && opts.headRuns ? opts.headRuns[sha] : undefined;
      return Promise.resolve(jsonResponse(200, { workflow_runs: runs ?? [] }));
    }
    // /pulls?state=open&per_page=100
    if (opts.pullsOk === false) return Promise.resolve(new Response("nope", { status: 403 }));
    return Promise.resolve(jsonResponse(200, opts.pulls ?? []));
  });
}

const PULL_BASE = {
  user: { login: "author1" },
  head: { sha: "sha1", ref: "fix-thing" },
  base: { ref: "main" },
};

const PULL_OK = {
  ...PULL_BASE,
  number: 1,
  title: "Fix thing",
  html_url: "https://github.com/o/r/pull/1",
};
const PULL_FAIL = {
  ...PULL_BASE,
  number: 2,
  title: "Broken test",
  html_url: "https://github.com/o/r/pull/2",
  user: undefined,
  head: { sha: "sha2", ref: "fix-test" },
  base: { ref: "main" },
};
const PULL_PENDING = {
  ...PULL_BASE,
  number: 3,
  title: "WIP feature",
  html_url: "https://github.com/o/r/pull/3",
  head: { sha: "sha3", ref: "feature-x" },
  base: { ref: "develop" },
};

const RUN_SUCCESS = {
  name: "CI",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/o/r/actions/runs/1",
  head_sha: "sha1",
};
const RUN_FAILURE = {
  name: "CI",
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/o/r/actions/runs/2",
  head_sha: "sha2",
};

describe("getRepoPRsStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty prs array for a repo with no open PRs", async () => {
    vi.stubGlobal("fetch", mockGithubApi({ pulls: [] }));
    const result = await getRepoPRsStatus("tok", "no-prs-owner", "repo");
    expect(result.prs).toEqual([]);
    expect(result.prSummary).toEqual({ total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 });
  });

  it("maps API pull items to the PROrWithChecks shape", async () => {
    vi.stubGlobal("fetch", mockGithubApi({ pulls: [PULL_OK], headRuns: {} }));
    const result = await getRepoPRsStatus("tok", "shape-owner", "repo");
    expect(result.prs).toHaveLength(1);
    expect(result.prs[0]).toEqual({
      number: 1,
      title: "Fix thing",
      htmlUrl: "https://github.com/o/r/pull/1",
      author: "author1",
      headSha: "sha1",
      headBranch: "fix-thing",
      baseBranch: "main",
      ciStatus: null,
      actionsRuns: [],
      // Review fields stay neutral until the poller's GraphQL enrichment
      // runs (github-pr-reviews.ts); the REST list only knows draft/updated.
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
      // The head-run lookup answered (with no runs), which is still an answer.
      ciFetched: true,
      prPhase: "unknown",
    });
  });

  it("fetches Actions runs for each PR head SHA and computes ciStatus", async () => {
    vi.stubGlobal(
      "fetch",
      mockGithubApi({
        pulls: [PULL_OK, PULL_FAIL],
        headRuns: { sha1: [RUN_SUCCESS], sha2: [RUN_FAILURE] },
      }),
    );
    const result = await getRepoPRsStatus("tok", "ci-owner", "repo");
    expect(result.prs).toHaveLength(2);
    expect(result.prs[0].ciStatus).toBe("success");
    expect(result.prs[0].actionsRuns).toHaveLength(1);
    expect(result.prs[0].actionsRuns[0].name).toBe("CI");
    expect(result.prs[1].ciStatus).toBe("failure");
  });

  it("handles null user gracefully (author becomes null)", async () => {
    vi.stubGlobal("fetch", mockGithubApi({ pulls: [PULL_FAIL], headRuns: {} }));
    const result = await getRepoPRsStatus("tok", "null-author-owner", "repo");
    expect(result.prs[0].author).toBeNull();
  });

  it("computes correct summary counts", async () => {
    vi.stubGlobal(
      "fetch",
      mockGithubApi({
        pulls: [PULL_OK, PULL_FAIL, PULL_PENDING],
        headRuns: { sha1: [RUN_SUCCESS], sha2: [RUN_FAILURE], sha3: [] },
      }),
    );
    const result = await getRepoPRsStatus("tok", "summary-owner", "repo");
    expect(result.prSummary).toEqual({ total: 3, pass: 1, fail: 1, pending: 0, unknown: 1 });
  });

  it("throws GitHubApiError on a non-ok response from /pulls", async () => {
    vi.stubGlobal("fetch", mockGithubApi({ pullsOk: false }));
    await expect(getRepoPRsStatus("tok", "error-owner", "repo")).rejects.toThrow();
  });

  it("degrades on individual head SHA fetch failures (gracefully treats as null ciStatus)", async () => {
    vi.stubGlobal("fetch", mockGithubApi({ pulls: [PULL_OK], headRuns: {} }));
    const result = await getRepoPRsStatus("tok", "degrade-owner", "repo");
    // No runs at all → ciStatus null, which counts as unknown
    expect(result.prs[0].ciStatus).toBeNull();
    expect(result.prs[0].actionsRuns).toEqual([]);
  });
});

// Exported for task-reconciler.ts's review-spawn CI gate (see github.ts's
// own doc comments on both) — getRepoPRsStatus above already exercises them
// indirectly; these pin the two functions' own direct contracts.
describe("ciFetched from the real run lookups", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // A 429 above trips the process-wide rate-limit budget.
    resetGitHubRateLimitForTests();
  });

  it("is true for a real answer, even an empty one, and false when the lookup failed", async () => {
    vi.stubGlobal("fetch", mockGithubApi({ pulls: [PULL_OK], headRuns: {} }));
    const answered = await getRepoPRsStatus("tok", "ci-owner", "ok-repo");
    expect(answered.prs[0]).toMatchObject({ ciStatus: null, ciFetched: true });

    for (const status of [403, 429, 500]) {
      resetGitHubRateLimitForTests();
      vi.stubGlobal("fetch", mockGithubApi({ pulls: [PULL_OK], runsStatus: status }));
      const failed = await getRepoPRsStatus("tok", "ci-owner", `fail-${status}`);
      expect(failed.prs[0]).toMatchObject({ ciStatus: null, ciFetched: false });
    }

    resetGitHubRateLimitForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/actions/runs")
          ? Promise.reject(new Error("network down"))
          : Promise.resolve(jsonResponse(200, [PULL_OK])),
      ),
    );
    const offline = await getRepoPRsStatus("tok", "ci-owner", "net-repo");
    expect(offline.prs[0]).toMatchObject({ ciStatus: null, ciFetched: false });
  });

  it("a failed lookup keeps an otherwise-ready PR from being called ready", async () => {
    vi.stubGlobal("fetch", mockGithubApi({ pulls: [PULL_OK], runsStatus: 403 }));
    const { prs } = await getRepoPRsStatus("tok", "ci-owner", "ready-repo");
    const pr = prs[0];
    // As if the review enrichment had run and found nothing outstanding.
    Object.assign(pr, {
      reviewStateKnown: true,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "UNSTABLE",
    });
    applyPrPhase(pr);
    expect(pr.prPhase).toBe("unknown");
    // GitHub calling it CLEAN is the tie-break that makes it ready.
    pr.mergeStateStatus = "CLEAN";
    applyPrPhase(pr);
    expect(pr.prPhase).toBe("ready_to_merge");
  });

  it("fetchRunsForHeadChecked reports the outcome; fetchRunsForHead stays lenient", async () => {
    vi.stubGlobal("fetch", mockGithubApi({ headRuns: { sha1: [RUN_SUCCESS] } }));
    expect(await fetchRunsForHeadChecked("tok", "o", "r", "sha1")).toMatchObject({ ok: true });
    expect((await fetchRunsForHeadChecked("tok", "o", "r", "sha-none")).ok).toBe(true);
    vi.stubGlobal("fetch", mockGithubApi({ runsStatus: 403 }));
    expect(await fetchRunsForHeadChecked("tok", "o", "r", "sha1")).toEqual({ ok: false, runs: [] });
    expect(await fetchRunsForHead("tok", "o", "r", "sha1")).toEqual([]);
  });
});

describe("fetchRunsForHead", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the latest run per distinct workflow name for the given head sha", async () => {
    vi.stubGlobal("fetch", mockGithubApi({ headRuns: { sha1: [RUN_SUCCESS] } }));
    const runs = await fetchRunsForHead("tok", "owner", "repo", "sha1");
    expect(runs).toEqual([
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://github.com/o/r/actions/runs/1",
        headSha: "sha1",
      },
    ]);
  });

  it("returns [] (never throws) when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    await expect(fetchRunsForHead("tok", "owner", "repo", "sha1")).resolves.toEqual([]);
  });

  it("returns [] (never throws) on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    await expect(fetchRunsForHead("tok", "owner", "repo", "sha1")).resolves.toEqual([]);
  });

  it("rejects an invalid owner/repo before ever calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchRunsForHead("tok", "bad owner", "repo", "sha1")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("computeCiStatus", () => {
  it("returns null for no runs at all — the same signal as every run being skipped/cancelled", () => {
    expect(computeCiStatus([])).toBeNull();
    expect(
      computeCiStatus([
        { name: "a", status: "completed", conclusion: "skipped", htmlUrl: "u", headSha: "s" },
        { name: "b", status: "completed", conclusion: "cancelled", htmlUrl: "u", headSha: "s" },
      ]),
    ).toBeNull();
  });

  it("returns in_progress when any run hasn't completed yet", () => {
    expect(
      computeCiStatus([
        { name: "a", status: "queued", conclusion: null, htmlUrl: "u", headSha: "s" },
      ]),
    ).toBe("in_progress");
  });

  it("returns success only when every meaningful run succeeded", () => {
    expect(
      computeCiStatus([
        { name: "a", status: "completed", conclusion: "success", htmlUrl: "u", headSha: "s" },
        { name: "b", status: "completed", conclusion: "skipped", htmlUrl: "u", headSha: "s" },
      ]),
    ).toBe("success");
  });

  it("returns failure when any meaningful run didn't succeed", () => {
    expect(
      computeCiStatus([
        { name: "a", status: "completed", conclusion: "success", htmlUrl: "u", headSha: "s" },
        { name: "b", status: "completed", conclusion: "failure", htmlUrl: "u", headSha: "s" },
      ]),
    ).toBe("failure");
  });
});

describe("setRepoPRsStatus / getPRsStatus cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips data through the cache", () => {
    const data = { prs: [], prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 } };
    const owner = "rt-owner";
    const repo = "rt-repo";
    expect(getPRsStatus(owner, repo)).toBeNull();
    setRepoPRsStatus(owner, repo, data);
    const got = getPRsStatus(owner, repo);
    expect(got).toEqual(data);
  });

  it("serves an entry past the TTL flagged stale instead of dropping it", () => {
    vi.useFakeTimers();
    try {
      const data = { prs: [], prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 } };
      setRepoPRsStatus("swr-owner", "swr-repo", data);
      expect(getPRsStatus("swr-owner", "swr-repo")?.stale).toBeUndefined();
      vi.advanceTimersByTime(10 * 60_000);
      expect(getPRsStatus("swr-owner", "swr-repo")).toEqual({ ...data, stale: true });
      // Reading never deletes: it is still there on the next read.
      expect(getPRsStatus("swr-owner", "swr-repo")?.stale).toBe(true);
      // A refresh makes it fresh again.
      setRepoPRsStatus("swr-owner", "swr-repo", data);
      expect(getPRsStatus("swr-owner", "swr-repo")?.stale).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops serving an entry once it is older than the max stale age", () => {
    vi.useFakeTimers();
    try {
      setRepoPRsStatus("old-owner", "old-repo", {
        prs: [],
        prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
      });
      vi.advanceTimersByTime(29 * 60_000);
      expect(getPRsStatus("old-owner", "old-repo")?.stale).toBe(true);
      vi.advanceTimersByTime(2 * 60_000);
      expect(getPRsStatus("old-owner", "old-repo")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null for a different owner/repo than what was stored", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
    setRepoPRsStatus("owner-a", "repo-a", {
      prs: [],
      prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
    });
    expect(getPRsStatus("owner-b", "repo-b")).toBeNull();
  });
});

describe("non-Actions check helpers", () => {
  it("normalizes rollup states and folds them into the CI status", () => {
    expect(normalizeRollupState("SUCCESS")).toBe("success");
    expect(normalizeRollupState("ERROR")).toBe("failure");
    expect(normalizeRollupState("EXPECTED")).toBe("pending");
    expect(normalizeRollupState("???")).toBeNull();
    expect(combineCiStatus("success", null)).toBe("success");
    expect(combineCiStatus(null, null)).toBeNull();
    expect(combineCiStatus("success", "failure")).toBe("failure");
    expect(combineCiStatus("failure", "success")).toBe("failure");
    expect(combineCiStatus("success", "pending")).toBe("in_progress");
    expect(combineCiStatus("in_progress", "success")).toBe("in_progress");
    expect(combineCiStatus(null, "success")).toBe("success");
  });

  it("keeps only the rollup contexts that are not Actions runs", () => {
    expect(
      parseOtherChecks([
        null,
        {
          __typename: "CheckRun",
          name: "ci",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          checkSuite: { app: { slug: "github-actions" } },
        },
        {
          __typename: "CheckRun",
          name: "codecov",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://c/1",
          checkSuite: { app: { slug: "codecov" } },
        },
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "CheckRun", name: "build", status: "IN_PROGRESS" },
        {
          __typename: "StatusContext",
          context: "legacy",
          state: "PENDING",
          targetUrl: "https://s/1",
        },
        { __typename: "StatusContext", context: "odd", state: "weird" },
      ]),
    ).toEqual([
      { name: "codecov", state: "failure", url: "https://c/1", source: "check_run" },
      { name: "lint", state: "neutral", url: null, source: "check_run" },
      { name: "build", state: "pending", url: null, source: "check_run" },
      { name: "legacy", state: "pending", url: "https://s/1", source: "status" },
      { name: "odd", state: "neutral", url: null, source: "status" },
    ]);
  });
});

describe("getWorkflowRunJobs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns jobs mapped from the API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            total_count: 1,
            jobs: [
              {
                id: 101,
                name: "build",
                status: "completed",
                conclusion: "success",
                started_at: "2024-01-01T00:00:00Z",
                completed_at: "2024-01-01T00:05:00Z",
                html_url: "https://github.com/o/r/actions/runs/1/jobs/101",
                steps: [
                  { name: "checkout", status: "completed", conclusion: "success", number: 1 },
                  { name: "test", status: "completed", conclusion: "success", number: 2 },
                ],
              },
            ],
          }),
        ),
      ),
    );
    const jobs = await getWorkflowRunJobs("tok", "owner", "repo", 1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      id: 101,
      name: "build",
      status: "completed",
      conclusion: "success",
      startedAt: "2024-01-01T00:00:00Z",
      completedAt: "2024-01-01T00:05:00Z",
      htmlUrl: "https://github.com/o/r/actions/runs/1/jobs/101",
      steps: [
        { name: "checkout", status: "completed", conclusion: "success", number: 1 },
        { name: "test", status: "completed", conclusion: "success", number: 2 },
      ],
    });
  });

  it("returns empty array on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );
    const jobs = await getWorkflowRunJobs("tok", "owner", "repo", 1);
    expect(jobs).toEqual([]);
  });

  it("returns empty array on fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network failure"))),
    );
    const jobs = await getWorkflowRunJobs("tok", "owner", "repo", 1);
    expect(jobs).toEqual([]);
  });

  it("handles null steps gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            total_count: 1,
            jobs: [
              {
                id: 102,
                name: "deploy",
                status: "queued",
                conclusion: null,
                started_at: null,
                completed_at: null,
                html_url: "https://github.com/o/r/actions/runs/1/jobs/102",
                steps: null,
              },
            ],
          }),
        ),
      ),
    );
    const jobs = await getWorkflowRunJobs("tok", "owner", "repo", 1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].steps).toEqual([]);
  });
});

describe("getJobLogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns truncated logs (last N lines)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          textResponse(200, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")),
        ),
      ),
    );
    const logs = await getJobLogs("tok", "owner", "repo", 1, 10);
    expect(logs).not.toBeNull();
    const lines = logs!.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("line 91");
    expect(lines[9]).toBe("line 100");
  });

  it("returns null on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 403 }))),
    );
    const logs = await getJobLogs("tok", "owner", "repo", 1);
    expect(logs).toBeNull();
  });

  it("returns null on fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network failure"))),
    );
    const logs = await getJobLogs("tok", "owner", "repo", 1);
    expect(logs).toBeNull();
  });

  it("uses default of 50 lines when not specified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          textResponse(200, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")),
        ),
      ),
    );
    const logs = await getJobLogs("tok", "owner", "repo", 1);
    expect(logs).not.toBeNull();
    const lines = logs!.split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("line 51");
  });
});
