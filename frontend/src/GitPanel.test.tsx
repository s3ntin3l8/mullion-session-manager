// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { render, screen } from "@testing-library/react";
import { GitPanel } from "./GitPanel.js";
import type { GitBranchesResult, GitStatus } from "./api.js";
import { LIVE_REFRESH_INTERVAL_MS } from "./store.js";

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

  it("stays in the loading state on a fetch error, never incorrectly claiming 'not a repo'", async () => {
    // A raw network error (or a thrown ApiError for a 503 "git status
    // temporarily unavailable" response) with no prior successful fetch to
    // fall back to — the panel has no real answer yet, so it should keep
    // showing "Loading…" rather than asserting a wrong "not a git
    // repository" state it can't actually confirm.
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    vi.stubGlobal("fetch", fetchMock);
    render(<GitPanel params={{ projectId: 3 }} />);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(/Not a git repository/)).not.toBeInTheDocument();
  });

  it("keeps showing the last-known-good status across a later transient poll failure", async () => {
    vi.useFakeTimers();
    try {
      // git-branches always 204s here — this test is only exercising the
      // git-status poll's LKG behavior. Tracked by call count (not
      // mockImplementationOnce) since the branches effect's own fetch can
      // interleave with the status poll's calls under fake timers.
      let statusCallCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-branches")) {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        statusCallCount += 1;
        // The second git-status call (the next poll tick) fails transiently
        // (e.g. a 503) — the panel must keep rendering the branch/clean
        // status from the first, successful fetch instead of reverting to
        // "Not a git repository".
        if (statusCallCount === 2) {
          return Promise.reject(new Error("git status unavailable"));
        }
        return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<GitPanel params={{ projectId: 7 }} />);

      // Flush the mount-time fetch's promise chain and let React commit the
      // resulting state update — `act` is what makes the update actually
      // land in the DOM before we assert on it under fake timers.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("main")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_REFRESH_INTERVAL_MS);
      });

      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("Working tree clean")).toBeInTheDocument();
      expect(screen.queryByText(/Not a git repository/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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
