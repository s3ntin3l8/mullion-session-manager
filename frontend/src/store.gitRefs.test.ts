// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "./store/index.js";
import type {
  Project,
  GitBranchesResult,
  GitHubPRsStatus,
  GitRefsBatchResult,
} from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

// refreshGitRefs' `projectIds` param (see that action's own doc comment in
// slices/git.ts) — a production incident had every project's git-branches +
// github/prs refetched on a single project's WS event, exhausting the
// git-branches route's 30/min rate limit within seconds under CI load. A
// second incident (issue #1005/#1007, the 0.3.8 update) hit the same 30/min
// ceiling via a different trigger — repeated page reloads, each firing one
// request pair per project. Both are why refreshGitRefs now issues a SINGLE
// batched GET /api/projects/git-refs request instead of N pairs. These
// tests lock in that a scoped call only asks for (and overwrites) the named
// projects and leaves the rest of the cached maps untouched, while an
// unscoped call still does the original full replace — same contract as
// before batching, just over one request instead of N.

const PROJECT_1: Project = {
  id: 1,
  name: "one",
  cwd: "/home/x/one",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  autoFetch: null,
  ruleFiles: [],
  defaultAgent: null,
  defaultReviewAgent: null,
  mergeOnApprove: null,
  autoApprove: null,
  maxAutoReturnRounds: null,
  conventionalCommitTitles: null,
  autoTagRelease: null,
  injectAgentGuide: null,
  injectProjectBriefing: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PROJECT_2: Project = { ...PROJECT_1, id: 2, name: "two", cwd: "/home/x/two" };

function branchesFor(name: string): GitBranchesResult {
  return { branches: [{ name, isCurrent: true }], worktrees: [], remoteBranches: [] };
}

const EMPTY_PRS: GitHubPRsStatus = {
  prs: [],
  prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
};

/** Parses `ids=1,2,3` off a `/api/projects/git-refs?ids=...` URL. */
function idsFromGitRefsUrl(url: string): number[] {
  const match = /^\/api\/projects\/git-refs\?ids=([\d,]+)$/.exec(url);
  if (!match) throw new Error(`not a git-refs batch url: ${url}`);
  return match[1].split(",").map(Number);
}

/** Default batch response: `branch-<id>` + empty PRs for every requested id. */
function defaultBatchResponse(ids: number[]): GitRefsBatchResult {
  const branches: Record<string, GitBranchesResult> = {};
  const prs: Record<string, GitHubPRsStatus> = {};
  for (const id of ids) {
    branches[id] = branchesFor(`branch-${id}`);
    prs[id] = EMPTY_PRS;
  }
  return { branches, prs };
}

describe("store.refreshGitRefs (scoped vs. full refresh)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const ids = idsFromGitRefsUrl(url);
      return jsonResponse(200, defaultBatchResponse(ids));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({
      projects: [PROJECT_1, PROJECT_2],
      gitBranchesByProject: {},
      prsByProject: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches every project when called with no projectIds", async () => {
    await useDashboardStore.getState().refreshGitRefs();

    expect(useDashboardStore.getState().gitBranchesByProject[1]).toEqual(branchesFor("branch-1"));
    expect(useDashboardStore.getState().gitBranchesByProject[2]).toEqual(branchesFor("branch-2"));
    expect(fetchMock).toHaveBeenCalledTimes(1); // one batched request for every project
  });

  it("scopes the fetch to just the named project ids", async () => {
    await useDashboardStore.getState().refreshGitRefs([1]);

    expect(fetchMock).toHaveBeenCalledTimes(1); // one batched request, scoped to project 1 only
    expect(idsFromGitRefsUrl(String(fetchMock.mock.calls[0][0]))).toEqual([1]);
    expect(useDashboardStore.getState().gitBranchesByProject[1]).toEqual(branchesFor("branch-1"));
  });

  it("merges a scoped refresh into the existing maps instead of dropping other projects' cached data", async () => {
    useDashboardStore.setState({
      gitBranchesByProject: { 2: branchesFor("stale-branch-2") },
      prsByProject: { 2: EMPTY_PRS },
    });

    await useDashboardStore.getState().refreshGitRefs([1]);

    expect(useDashboardStore.getState().gitBranchesByProject[1]).toEqual(branchesFor("branch-1"));
    // Project 2 was never in this scoped call — its previously-cached entry
    // must survive untouched, not get wiped by a wholesale replace.
    expect(useDashboardStore.getState().gitBranchesByProject[2]).toEqual(
      branchesFor("stale-branch-2"),
    );
  });

  it("an unscoped call still replaces the maps wholesale (drops entries for projects no longer in the list)", async () => {
    useDashboardStore.setState({
      projects: [PROJECT_1],
      gitBranchesByProject: { 1: branchesFor("branch-1"), 99: branchesFor("gone") },
      prsByProject: { 1: EMPTY_PRS, 99: EMPTY_PRS },
    });

    await useDashboardStore.getState().refreshGitRefs();

    expect(useDashboardStore.getState().gitBranchesByProject[99]).toBeUndefined();
  });

  // Hermes review, PR #680: the in-flight dedup used to return the CURRENTLY
  // RUNNING promise for any call that arrived mid-flight, silently dropping
  // a scoped call's own project ids if they weren't part of what was already
  // running — project 2's refs would stay stale until the next WS event.
  it("queues a scoped call that arrives while another is in flight, instead of dropping it", async () => {
    let resolveProject1: (() => void) | undefined;
    const project1Gate = new Promise<void>((resolve) => {
      resolveProject1 = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const ids = idsFromGitRefsUrl(url);
      if (ids.includes(1)) await project1Gate;
      return jsonResponse(200, defaultBatchResponse(ids));
    });

    const firstRun = useDashboardStore.getState().refreshGitRefs([1]);
    // Arrives while project 1's batch request is still hung on
    // project1Gate — must not be silently dropped just because a refresh
    // is already running.
    const secondRun = useDashboardStore.getState().refreshGitRefs([2]);
    expect(secondRun).toBe(firstRun); // same in-flight promise, queued behind it

    resolveProject1!();
    await firstRun;
    // The queued call re-fires in the `.finally()` once the first settles —
    // it's its own async chain (fetch + JSON parsing), not one microtask tick.
    await vi.waitFor(() =>
      expect(useDashboardStore.getState().gitBranchesByProject[2]).toEqual(branchesFor("branch-2")),
    );
    expect(useDashboardStore.getState().gitBranchesByProject[1]).toEqual(branchesFor("branch-1"));
  });

  it("an unscoped call queued behind an in-flight scoped one wins over it (still refetches every project)", async () => {
    let resolveProject2: (() => void) | undefined;
    const project2Gate = new Promise<void>((resolve) => {
      resolveProject2 = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const ids = idsFromGitRefsUrl(url);
      if (ids.includes(2)) await project2Gate;
      return jsonResponse(200, defaultBatchResponse(ids));
    });
    useDashboardStore.setState({
      gitBranchesByProject: { 1: branchesFor("branch-1"), 99: branchesFor("stale") },
      prsByProject: { 1: EMPTY_PRS, 99: EMPTY_PRS },
    });

    const firstRun = useDashboardStore.getState().refreshGitRefs([2]);
    void useDashboardStore.getState().refreshGitRefs(); // unscoped, queued behind it

    resolveProject2!();
    await firstRun;
    // The unscoped requeue prunes project 99, which neither call's own
    // explicit scope named — proving it ran as a full refresh, not a
    // scoped one that happened to include every current project.
    await vi.waitFor(() =>
      expect(useDashboardStore.getState().gitBranchesByProject[99]).toBeUndefined(),
    );
    expect(useDashboardStore.getState().gitBranchesByProject[1]).toEqual(branchesFor("branch-1"));
  });
});
