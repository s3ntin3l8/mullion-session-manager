// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "./store/index.js";
import type { Project, GitBranchesResult, GitHubPRsStatus } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

// refreshGitRefs' `projectIds` param (see that action's own doc comment in
// slices/git.ts) — a production incident had every project's git-branches +
// github/prs refetched on a single project's WS event, exhausting the
// git-branches route's 30/min rate limit within seconds under CI load.
// These tests lock in that a scoped call only fetches/overwrites the named
// projects and leaves the rest of the cached maps untouched, while an
// unscoped call still does the original full replace.

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

describe("store.refreshGitRefs (scoped vs. full refresh)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const branchesMatch = /^\/api\/projects\/(\d+)\/git-branches$/.exec(url);
      if (branchesMatch) return jsonResponse(200, branchesFor(`branch-${branchesMatch[1]}`));
      const prsMatch = /^\/api\/projects\/(\d+)\/github\/prs$/.exec(url);
      if (prsMatch) return jsonResponse(200, EMPTY_PRS);
      throw new Error(`unexpected fetch: ${url}`);
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
    expect(fetchMock).toHaveBeenCalledTimes(4); // 2 projects x (branches + prs)
  });

  it("scopes the fetch to just the named project ids", async () => {
    await useDashboardStore.getState().refreshGitRefs([1]);

    expect(fetchMock).toHaveBeenCalledTimes(2); // only project 1's branches + prs
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
});
