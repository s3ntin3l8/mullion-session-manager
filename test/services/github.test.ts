import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GitHubApiError,
  getRepoStatus,
  getCacheSizeForTests,
  MAX_CACHE_ENTRIES,
  fetchRequiredStatusContexts,
  fetchCheckRunsForHead,
  getDefaultBranch,
  repoHasExternalReviewWorkflow,
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

// #755 — one owner/repo/branch triple per test, unmocked global cache: this
// module-scope cache persists across tests in the same process (same
// pattern getRepoStatus's own prsCache/statusCache already rely on, no
// reset export exists for those either), so a shared key would let an
// earlier test's cached result leak into a later one.
describe("fetchRequiredStatusContexts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the required contexts from branch protection", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { required_status_checks: { contexts: ["CI", "lint"] } }),
    );
    const result = await fetchRequiredStatusContexts("tok", "o", "required-contexts-repo", "main");
    expect(result).toEqual(["CI", "lint"]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/o/required-contexts-repo/branches/main/protection"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("returns [] when protection exists but no status checks are required", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { required_status_checks: null }));
    const result = await fetchRequiredStatusContexts("tok", "o", "no-required-checks-repo", "main");
    expect(result).toEqual([]);
  });

  it("returns null (fail closed), not [], on a 403 — the App token lacks administration:read", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 403 }));
    const result = await fetchRequiredStatusContexts("tok", "o", "forbidden-repo", "main");
    expect(result).toBeNull();
  });

  it("returns null (fail closed) on a 404 — no protection configured, or the branch doesn't exist", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const result = await fetchRequiredStatusContexts("tok", "o", "no-protection-repo", "main");
    expect(result).toBeNull();
  });

  it("returns null (fail closed) on a network failure, never throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(
      fetchRequiredStatusContexts("tok", "o", "network-down-repo", "main"),
    ).resolves.toBeNull();
  });

  it("caches a successful lookup — a second call for the same repo/branch makes no further request", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { required_status_checks: { contexts: ["CI"] } }),
    );
    await fetchRequiredStatusContexts("tok", "o", "cache-hit-repo", "main");
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await fetchRequiredStatusContexts("tok", "o", "cache-hit-repo", "main");
    expect(second).toEqual(["CI"]);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does NOT cache a failed lookup — a retry after a 403 makes a fresh request", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { required_status_checks: { contexts: ["CI"] } }),
    );
    const first = await fetchRequiredStatusContexts("tok", "o", "retry-after-403-repo", "main");
    expect(first).toBeNull();
    const second = await fetchRequiredStatusContexts("tok", "o", "retry-after-403-repo", "main");
    expect(second).toEqual(["CI"]);
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});

describe("getDefaultBranch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the repo's default_branch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { default_branch: "main" }));
    expect(await getDefaultBranch("tok", "o", "r")).toBe("main");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/o/r"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("throws GitHubApiError on a non-ok response", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(getDefaultBranch("tok", "o", "r")).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("throws GitHubApiError when the response has no default_branch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await expect(getDefaultBranch("tok", "o", "r")).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("rejects an invalid owner/repo before ever calling fetch", async () => {
    await expect(getDefaultBranch("tok", "not valid/owner", "r")).rejects.toThrow(
      /Invalid GitHub owner/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// #755 fresh-review finding: Check Run names (this API) and Workflow Run
// names (`fetchRunsForHead`) are two different GitHub namespaces — verified
// live against this repo's own protected branch (a single workflow run like
// "CI/CD" fans out into per-job check runs like "test-node /
// lint-and-test"), and it's the check-run name that actually matches
// `required_status_checks.contexts`.
describe("fetchCheckRunsForHead", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns check-run name/conclusion pairs for the head commit", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        check_runs: [
          { name: "test-node / lint-and-test", conclusion: "success" },
          { name: "test-e2e", conclusion: "failure" },
        ],
      }),
    );
    const result = await fetchCheckRunsForHead("tok", "o", "check-runs-repo", "sha-head");
    expect(result).toEqual([
      { name: "test-node / lint-and-test", conclusion: "success" },
      { name: "test-e2e", conclusion: "failure" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/o/check-runs-repo/commits/sha-head/check-runs"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("degrades to [] on a non-ok response, never throws", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(
      fetchCheckRunsForHead("tok", "o", "check-runs-404-repo", "sha-head"),
    ).resolves.toEqual([]);
  });

  it("degrades to [] on a network failure, never throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(
      fetchCheckRunsForHead("tok", "o", "check-runs-down-repo", "sha-head"),
    ).resolves.toEqual([]);
  });
});

// Sequential review phase (branchdam-mobile #83's investigation) — one
// owner/repo per test, unmocked global cache, same reasoning as
// fetchRequiredStatusContexts's own describe block above.
describe("repoHasExternalReviewWorkflow", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function listResponse(entries: { path: string; type: string }[]) {
    return jsonResponse(200, entries);
  }

  function rawResponse(text: string) {
    return new Response(text, { status: 200 });
  }

  it("returns true when a workflow file declares a ready_for_review pull_request trigger", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/contents/.github/workflows/hermes-review.yml")) {
        return Promise.resolve(
          rawResponse("on:\n  pull_request:\n    types: [opened, ready_for_review]\n"),
        );
      }
      return Promise.resolve(
        listResponse([{ path: ".github/workflows/hermes-review.yml", type: "file" }]),
      );
    });

    const result = await repoHasExternalReviewWorkflow("tok", "o", "has-reviewer-repo");
    expect(result).toBe(true);
  });

  it("returns false when every workflow file exists but none mention ready_for_review", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/contents/.github/workflows/ci-cd.yml")) {
        return Promise.resolve(rawResponse("on:\n  pull_request:\n"));
      }
      return Promise.resolve(listResponse([{ path: ".github/workflows/ci-cd.yml", type: "file" }]));
    });

    const result = await repoHasExternalReviewWorkflow("tok", "o", "ci-only-repo");
    expect(result).toBe(false);
  });

  it("returns false (fail closed) when the repo has no workflows directory at all", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const result = await repoHasExternalReviewWorkflow("tok", "o", "no-workflows-repo");
    expect(result).toBe(false);
  });

  it("returns false (fail closed) on a network failure, never throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(
      repoHasExternalReviewWorkflow("tok", "o", "network-down-workflows-repo"),
    ).resolves.toBe(false);
  });

  it("ignores non-.yml/.yaml entries in the workflows directory", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/contents/.github/workflows/")) {
        throw new Error("should never fetch a non-workflow file");
      }
      return Promise.resolve(
        listResponse([
          { path: ".github/workflows/README.md", type: "file" },
          { path: ".github/workflows/scripts", type: "dir" },
        ]),
      );
    });

    const result = await repoHasExternalReviewWorkflow("tok", "o", "no-yaml-files-repo");
    expect(result).toBe(false);
  });

  it("caches a successful lookup — a second call for the same repo makes no further request", async () => {
    // A genuinely empty workflows directory (200, []) — not a 404 — is the
    // "successful lookup" this caches; a 404 is a non-ok response and
    // follows fetchRequiredStatusContexts's own "don't cache a failure"
    // convention below.
    fetchMock.mockResolvedValue(listResponse([]));
    await repoHasExternalReviewWorkflow("tok", "o", "cache-hit-workflows-repo");
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await repoHasExternalReviewWorkflow("tok", "o", "cache-hit-workflows-repo");
    expect(second).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does NOT cache a 404 (no workflows directory) — a retry makes a fresh request", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    await repoHasExternalReviewWorkflow("tok", "o", "no-cache-404-workflows-repo");
    const callsAfterFirst = fetchMock.mock.calls.length;
    await repoHasExternalReviewWorkflow("tok", "o", "no-cache-404-workflows-repo");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst * 2);
  });

  it("does NOT cache a failed lookup — a retry after a network failure makes a fresh request", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    fetchMock.mockResolvedValueOnce(
      listResponse([{ path: ".github/workflows/hermes-review.yml", type: "file" }]),
    );
    fetchMock.mockResolvedValueOnce(
      rawResponse("on:\n  pull_request:\n    types: [ready_for_review]\n"),
    );

    const first = await repoHasExternalReviewWorkflow(
      "tok",
      "o",
      "retry-after-network-failure-repo",
    );
    expect(first).toBe(false);
    const second = await repoHasExternalReviewWorkflow(
      "tok",
      "o",
      "retry-after-network-failure-repo",
    );
    expect(second).toBe(true);
  });
});
