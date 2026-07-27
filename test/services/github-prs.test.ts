import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getRepoPRsStatus,
  setRepoPRsStatus,
  getPRsStatus,
  getWorkflowRunJobs,
  getJobLogs,
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
}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
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
