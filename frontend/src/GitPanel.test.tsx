// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { GitPanel } from "./GitPanel.js";
import type { GitBranchesResult, GitStatus } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CLEAN_STATUS: GitStatus = {
  branch: "main",
  hash: "abc1234",
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  hasConflicts: false,
};

// Routes a mocked fetch by URL — GitPanel now fires two independent requests
// (git-status and, separately, git-branches for issue #162's branch/worktree
// list), so a single undifferentiated mock can no longer stand in for both.
// Defaults each endpoint to a 204 ("not applicable") unless a test overrides
// it, matching what an unrelated endpoint would actually do for a project
// these tests don't care about.
function mockFetch(opts: {
  status?: () => Response | Promise<Response>;
  branches?: () => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/git-status")) {
      return Promise.resolve(opts.status ? opts.status() : new Response(null, { status: 204 }));
    }
    if (url.includes("/git-branches")) {
      return Promise.resolve(opts.branches ? opts.branches() : new Response(null, { status: 204 }));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
  });
}

describe("GitPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the branch, hash, and a clean-tree message once loaded", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: () => jsonResponse(200, CLEAN_STATUS) }));
    render(<GitPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
    expect(screen.getByText("Working tree clean")).toBeInTheDocument();
    expect(screen.getByText("Clean")).toBeInTheDocument();
  });

  it("shows a not-applicable message on a 204 response, without listing anything", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<GitPanel params={{ projectId: 2 }} />);

    expect(await screen.findByText(/Not a git repository/)).toBeInTheDocument();
  });

  it("degrades to the not-applicable message on a fetch error too", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: () => Promise.reject(new Error("network down")) }));
    render(<GitPanel params={{ projectId: 3 }} />);

    expect(await screen.findByText(/Not a git repository/)).toBeInTheDocument();
  });

  it("lists changed files with their status code", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () =>
          jsonResponse(200, {
            ...CLEAN_STATUS,
            isClean: false,
            files: [
              { path: "src/a.ts", status: "M" },
              { path: "src/new.ts", status: "?" },
            ],
          }),
      }),
    );
    render(<GitPanel params={{ projectId: 4 }} />);

    expect(await screen.findByText("Changes (2)")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/new.ts")).toBeInTheDocument();
  });

  it("shows ahead/behind counts when they differ from zero", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: () => jsonResponse(200, { ...CLEAN_STATUS, ahead: 2, behind: 1 }) }),
    );
    render(<GitPanel params={{ projectId: 5 }} />);

    expect(await screen.findByText("↑2 ↓1")).toBeInTheDocument();
  });

  it("shows a conflict callout when hasConflicts is true", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () =>
          jsonResponse(200, {
            ...CLEAN_STATUS,
            isClean: false,
            hasConflicts: true,
            files: [{ path: "src/a.ts", status: "U" }],
          }),
      }),
    );
    render(<GitPanel params={{ projectId: 6 }} />);

    expect(await screen.findByText(/unresolved merge conflicts/)).toBeInTheDocument();
  });

  it("lists branches, marking the current one", async () => {
    const branchesResult: GitBranchesResult = {
      branches: [
        { name: "main", isCurrent: true },
        { name: "feature/foo", isCurrent: false },
      ],
      worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
    };
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        branches: () => jsonResponse(200, branchesResult),
      }),
    );
    render(<GitPanel params={{ projectId: 7 }} />);

    expect(await screen.findByText("Branches (2)")).toBeInTheDocument();
    expect(screen.getByText("feature/foo")).toBeInTheDocument();
    expect(screen.getByText("current")).toBeInTheDocument();
  });

  it("lists worktrees, tagging the main one and showing a detached HEAD as such", async () => {
    const branchesResult: GitBranchesResult = {
      branches: [{ name: "main", isCurrent: true }],
      worktrees: [
        { path: "/home/x/project", branch: "main", isMain: true },
        { path: "/home/x/.tessera-worktrees/1", branch: "agent/task-1", isMain: false },
        { path: "/home/x/.claude/worktrees/2", branch: null, isMain: false },
      ],
    };
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        branches: () => jsonResponse(200, branchesResult),
      }),
    );
    render(<GitPanel params={{ projectId: 8 }} />);

    expect(await screen.findByText("Worktrees (3)")).toBeInTheDocument();
    expect(screen.getByText("/home/x/project")).toBeInTheDocument();
    expect(screen.getByText("main (main)")).toBeInTheDocument();
    expect(screen.getByText("/home/x/.tessera-worktrees/1")).toBeInTheDocument();
    expect(screen.getByText("agent/task-1")).toBeInTheDocument();
    expect(screen.getByText("/home/x/.claude/worktrees/2")).toBeInTheDocument();
    expect(screen.getByText("detached")).toBeInTheDocument();
  });

  it("shows no branches/worktrees sections when git-branches 204s", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: () => jsonResponse(200, CLEAN_STATUS) }));
    render(<GitPanel params={{ projectId: 9 }} />);

    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.queryByText(/^Branches/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Worktrees/)).not.toBeInTheDocument();
  });
});
