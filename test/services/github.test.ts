import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitHubApiError,
  getRepoStatus,
  getCacheSizeForTests,
  MAX_CACHE_ENTRIES,
} from "../../src/services/github.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const ISSUE = {
  number: 27,
  title: "GitHub integration",
  html_url: "https://github.com/o/r/issues/27",
  user: { login: "s3ntin3l8" },
};
const PR = {
  number: 38,
  title: "add credential storage",
  html_url: "https://github.com/o/r/pull/38",
  user: { login: "s3ntin3l8" },
  pull_request: {},
};

// getRepoStatus now makes up to three requests per uncached call: the
// issues/PRs list, a repo-info lookup (for default_branch), and the Actions
// runs list on that branch (issue #27 phase 5) — the latter two are
// best-effort and degrade to actionsRuns: [] on any failure. Routes each by
// URL suffix so tests can assert realistic, deterministic call counts
// instead of coupling to an unlabeled total.
function mockGithubApi(opts: {
  issues?: unknown[];
  defaultBranch?: string | null;
  runs?: unknown[];
  repoInfoOk?: boolean;
  runsOk?: boolean;
}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/actions/runs")) {
      if (opts.runsOk === false) return Promise.resolve(new Response("nope", { status: 403 }));
      return Promise.resolve(jsonResponse(200, { workflow_runs: opts.runs ?? [] }));
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      if (opts.repoInfoOk === false) return Promise.resolve(new Response("nope", { status: 404 }));
      return Promise.resolve(
        jsonResponse(
          200,
          opts.defaultBranch === null ? {} : { default_branch: opts.defaultBranch ?? "main" },
        ),
      );
    }
    // .../issues?state=open&per_page=100
    return Promise.resolve(jsonResponse(200, opts.issues ?? []));
  });
}

describe("getRepoStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("splits issues API entries into issues vs. PRs by the pull_request field", async () => {
    fetchMock = mockGithubApi({ issues: [ISSUE, PR] });
    vi.stubGlobal("fetch", fetchMock);
    // Unique owner/repo per test — getRepoStatus's cache is module-level
    // (shared across tests in this file), so a repeated "o/r" key would
    // read a previous test's cached result instead of hitting the mock.
    const status = await getRepoStatus("tok", "split-owner", "split-repo");
    expect(status.openIssues).toBe(1);
    expect(status.openPRs).toBe(1);
    expect(status.issues).toEqual([
      { number: 27, title: "GitHub integration", htmlUrl: ISSUE.html_url, author: "s3ntin3l8" },
    ]);
    expect(status.pulls).toEqual([
      { number: 38, title: "add credential storage", htmlUrl: PR.html_url, author: "s3ntin3l8" },
    ]);
    expect(status.repo).toEqual({
      owner: "split-owner",
      repo: "split-repo",
      htmlUrl: "https://github.com/split-owner/split-repo",
    });
  });

  it("sends a bearer token, User-Agent, and Accept header", async () => {
    fetchMock = mockGithubApi({ issues: [] });
    vi.stubGlobal("fetch", fetchMock);
    await getRepoStatus("my-token", "auth-owner", "auth-repo");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/auth-owner/auth-repo/issues?state=open&per_page=100",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my-token",
          "User-Agent": expect.any(String),
          Accept: expect.any(String),
        }),
      }),
    );
  });

  it("caches within the TTL window without a second round of fetches", async () => {
    fetchMock = mockGithubApi({ issues: [ISSUE] });
    vi.stubGlobal("fetch", fetchMock);
    await getRepoStatus("tok", "cache-owner", "cache-repo");
    const callsAfterFirst = fetchMock.mock.calls.length;
    await getRepoStatus("tok", "cache-owner", "cache-repo");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("throws GitHubApiError on a non-ok response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: "Not Found" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getRepoStatus("tok", "missing-owner", "missing-repo")).rejects.toThrow(
      GitHubApiError,
    );
  });

  it("throws GitHubApiError when the network request fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getRepoStatus("tok", "unreachable-owner", "unreachable-repo")).rejects.toThrow(
      GitHubApiError,
    );
  });

  it("caps the module-level cache at MAX_CACHE_ENTRIES, evicting the oldest entry (Hermes review, PR #39)", async () => {
    fetchMock = mockGithubApi({ issues: [] });
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
      await getRepoStatus("tok", `cap-owner-${i}`, "repo");
    }
    expect(getCacheSizeForTests()).toBe(MAX_CACHE_ENTRIES);

    // The oldest entries (0-4) were evicted to make room — re-fetching one
    // of them costs a real round of fetches again, not a cache hit.
    const callsBefore = fetchMock.mock.calls.length;
    await getRepoStatus("tok", "cap-owner-0", "repo");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  describe("Actions/CI status (issue #27 phase 5)", () => {
    const RUN_SUCCESS = {
      name: "CI",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/o/r/actions/runs/1",
      head_sha: "abc123",
    };
    const RUN_FAILURE = {
      name: "CI",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/o/r/actions/runs/2",
      head_sha: "def456",
    };
    const RUN_IN_PROGRESS = {
      name: "Deploy",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/o/r/actions/runs/3",
      head_sha: "ghi789",
    };

    it("reports ciStatus success when the latest run per workflow all succeeded", async () => {
      fetchMock = mockGithubApi({ issues: [], runs: [RUN_SUCCESS] });
      vi.stubGlobal("fetch", fetchMock);
      const status = await getRepoStatus("tok", "ci-success-owner", "repo");
      expect(status.ciStatus).toBe("success");
      expect(status.actionsRuns).toEqual([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: RUN_SUCCESS.html_url,
          headSha: "abc123",
        },
      ]);
    });

    it("reports ciStatus failure when any latest run didn't succeed", async () => {
      fetchMock = mockGithubApi({ issues: [], runs: [RUN_FAILURE] });
      vi.stubGlobal("fetch", fetchMock);
      const status = await getRepoStatus("tok", "ci-failure-owner", "repo");
      expect(status.ciStatus).toBe("failure");
    });

    it("reports ciStatus in_progress when any latest run hasn't completed", async () => {
      fetchMock = mockGithubApi({ issues: [], runs: [RUN_SUCCESS, RUN_IN_PROGRESS] });
      vi.stubGlobal("fetch", fetchMock);
      const status = await getRepoStatus("tok", "ci-progress-owner", "repo");
      expect(status.ciStatus).toBe("in_progress");
    });

    it("treats skipped/cancelled runs as neutral, not a failure (Hermes review, PR #42)", async () => {
      const skipped = { ...RUN_SUCCESS, name: "Deploy", conclusion: "skipped" };
      fetchMock = mockGithubApi({ issues: [], runs: [RUN_SUCCESS, skipped] });
      vi.stubGlobal("fetch", fetchMock);
      const status = await getRepoStatus("tok", "ci-skipped-owner", "repo");
      // One real success, one skipped (excluded) — still overall success,
      // not dragged to failure just because a workflow was skipped.
      expect(status.ciStatus).toBe("success");
    });

    it("reports ciStatus null when every latest run is skipped/cancelled", async () => {
      const cancelled = { ...RUN_SUCCESS, conclusion: "cancelled" };
      fetchMock = mockGithubApi({ issues: [], runs: [cancelled] });
      vi.stubGlobal("fetch", fetchMock);
      const status = await getRepoStatus("tok", "ci-all-cancelled-owner", "repo");
      expect(status.ciStatus).toBeNull();
    });

    it("keeps only the first (most recent) run per workflow name", async () => {
      const older = { ...RUN_SUCCESS, html_url: "https://github.com/o/r/actions/runs/0" };
      fetchMock = mockGithubApi({ issues: [], runs: [RUN_FAILURE, older] });
      vi.stubGlobal("fetch", fetchMock);
      const status = await getRepoStatus("tok", "ci-dedup-owner", "repo");
      expect(status.actionsRuns).toHaveLength(1);
      expect(status.actionsRuns[0].htmlUrl).toBe(RUN_FAILURE.html_url);
    });

    it("degrades to actionsRuns: [] and ciStatus: null when Actions is unavailable, without failing the whole call", async () => {
      fetchMock = mockGithubApi({ issues: [ISSUE], repoInfoOk: false });
      vi.stubGlobal("fetch", fetchMock);
      const status = await getRepoStatus("tok", "ci-unavailable-owner", "repo");
      expect(status.actionsRuns).toEqual([]);
      expect(status.ciStatus).toBeNull();
      // The issues/PRs half of the same call is unaffected.
      expect(status.openIssues).toBe(1);
    });

    it("degrades gracefully when the repo has no default_branch in the response", async () => {
      fetchMock = mockGithubApi({ issues: [], defaultBranch: null });
      vi.stubGlobal("fetch", fetchMock);
      const status = await getRepoStatus("tok", "ci-no-branch-owner", "repo");
      expect(status.actionsRuns).toEqual([]);
      expect(status.ciStatus).toBeNull();
    });

    it("degrades gracefully when the runs endpoint itself fails", async () => {
      fetchMock = mockGithubApi({ issues: [], runsOk: false });
      vi.stubGlobal("fetch", fetchMock);
      const status = await getRepoStatus("tok", "ci-runs-fail-owner", "repo");
      expect(status.actionsRuns).toEqual([]);
      expect(status.ciStatus).toBeNull();
    });
  });
});
