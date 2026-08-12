// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitPanel } from "./GitPanel.js";
import type { GitBranchesResult, GitStatus } from "./api/index.js";
import { LIVE_REFRESH_INTERVAL_MS, useDashboardStore } from "./store/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

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
      remoteBranches: [],
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
        { path: "/home/x/.mullion-worktrees/1", branch: "agent/task-1", isMain: false },
        { path: "/home/x/.claude/worktrees/2", branch: null, isMain: false },
      ],
      remoteBranches: [],
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
    expect(screen.getByText("/home/x/.mullion-worktrees/1")).toBeInTheDocument();
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

  // Issue #442 — branch/worktree mutation UI.
  describe("branch/worktree management (issue #442)", () => {
    it("disables Delete for the current branch and one checked out in another worktree", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "checked-out-elsewhere", isCurrent: false },
          { name: "deletable", isCurrent: false },
        ],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          {
            path: "/home/x/.mullion-worktrees/other",
            branch: "checked-out-elsewhere",
            isMain: false,
          },
        ],
        remoteBranches: [],
      };
      vi.stubGlobal(
        "fetch",
        mockFetch({
          status: () => jsonResponse(200, CLEAN_STATUS),
          branches: () => jsonResponse(200, branchesResult),
        }),
      );
      render(<GitPanel params={{ projectId: 10 }} />);

      await screen.findByText("Branches (3)");
      const deleteButtons = screen.getAllByText("Delete");
      expect(deleteButtons).toHaveLength(3);
      expect(deleteButtons[0]).toBeDisabled(); // main (current)
      expect(deleteButtons[1]).toBeDisabled(); // checked out elsewhere
      expect(deleteButtons[2]).not.toBeDisabled(); // deletable
    });

    it("on a git-level refusal, shows a message and Force button; Force succeeds and refreshes branches", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "unmerged-branch", isCurrent: false },
        ],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      let branchesCallCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branch-delete")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { force?: boolean };
          return Promise.resolve(
            body.force
              ? jsonResponse(200, { deleted: true })
              : jsonResponse(200, { deleted: false, reason: "unmerged" }),
          );
        }
        if (url.includes("/git-branches")) {
          branchesCallCount += 1;
          return Promise.resolve(jsonResponse(200, branchesResult));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 11 }} />);

      await screen.findByText("Branches (2)");
      const callsAfterMount = branchesCallCount;

      const deleteButtons = screen.getAllByText("Delete");
      // ConfirmButton needs an arm click, then a confirm click.
      await user.click(deleteButtons[1]);
      await user.click(deleteButtons[1]);

      expect(await screen.findByText(/not fully merged|unmerged/i)).toBeInTheDocument();
      const forceButton = await screen.findByText("Force");
      await user.click(forceButton);
      await user.click(forceButton);

      await vi.waitFor(() => expect(branchesCallCount).toBeGreaterThan(callsAfterMount));
    });

    // Independent review on PR #505 — a THROWN branch-delete failure (a 503
    // host-unreachable, or a 429 off the route's rate limit) used to be
    // swallowed into console.debug only, with no user-visible change at
    // all: the same "transient failure looks like nothing happened" class
    // this PR's refreshBranches fix already addresses on the read path.
    it("shows a message when the branch-delete request itself throws (not a git-level refusal)", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "deletable", isCurrent: false },
        ],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branch-delete")) {
          return Promise.resolve(jsonResponse(503, { message: "Host is unreachable" }));
        }
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 14 }} />);

      await screen.findByText("Branches (2)");
      const deleteButtons = screen.getAllByText("Delete");
      await user.click(deleteButtons[1]);
      await user.click(deleteButtons[1]);

      expect(await screen.findByText(/unreachable/i)).toBeInTheDocument();
      // A thrown request failure isn't a git-level refusal reason — Force
      // can't fix an unreachable host, so it must not be offered here.
      expect(screen.queryByText("Force")).not.toBeInTheDocument();
    });

    it("disables Remove for the main worktree, and a successful worktree remove refreshes branches", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          { path: "/home/x/.mullion-worktrees/foo", branch: "foo", isMain: false },
        ],
        remoteBranches: [],
      };
      let branchesCallCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-worktree-remove")) {
          return Promise.resolve(jsonResponse(200, { removed: true }));
        }
        if (url.includes("/git-branches")) {
          branchesCallCount += 1;
          return Promise.resolve(jsonResponse(200, branchesResult));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 12 }} />);

      await screen.findByText("Worktrees (2)");
      const removeButtons = screen.getAllByText("Remove");
      expect(removeButtons).toHaveLength(2);
      expect(removeButtons[0]).toBeDisabled();
      expect(removeButtons[1]).not.toBeDisabled();

      const callsBefore = branchesCallCount;
      await user.click(removeButtons[1]);
      await user.click(removeButtons[1]);

      await vi.waitFor(() => expect(branchesCallCount).toBeGreaterThan(callsBefore));
    });

    // Hermes review on PR #505 — "Open session here" had no in-flight
    // guard; a double-click before the first request resolves could create
    // two sessions.
    it("disables Open session here while a create-session request is in flight, and issues only one call", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          { path: "/home/x/.mullion-worktrees/foo", branch: "foo", isMain: false },
        ],
        remoteBranches: [],
      };
      let createSessionCalls = 0;
      let resolveCreateSession: (() => void) | undefined;
      // U6 — "Open session here" now goes through the STORE's createSession
      // action rather than calling api.createSession directly, so it also
      // fires a GET /api/sessions (refreshSessions) once the POST resolves.
      // Both share the same "/api/sessions" URL substring, so the POST/GET
      // branches have to be told apart by method (the create-in-flight
      // guard below only cares about POST calls).
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        if (url.includes("/actions")) {
          return Promise.resolve(
            jsonResponse(200, [
              { id: "agent:claude", title: "Claude", command: "claude", kind: "agent" },
            ]),
          );
        }
        if (url.includes("/api/sessions") && method === "POST") {
          createSessionCalls += 1;
          return new Promise((resolve) => {
            resolveCreateSession = () => resolve(jsonResponse(201, { id: 1 }));
          });
        }
        if (url.includes("/api/sessions")) {
          // The post-create refreshSessions() GET — resolve immediately so
          // it doesn't itself become a second in-flight request.
          return Promise.resolve(jsonResponse(200, []));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 16 }} />);

      await screen.findByText("Worktrees (2)");
      const openButtons = screen.getAllByText("Open session here");
      expect(openButtons).toHaveLength(1); // main worktree doesn't get one

      await user.click(openButtons[0]);
      await vi.waitFor(() => expect(openButtons[0]).toBeDisabled());
      // A second click while the first request is still in flight must not
      // fire a second createSession call.
      await user.click(openButtons[0]);
      await vi.waitFor(() => expect(createSessionCalls).toBe(1));

      resolveCreateSession?.();
      await vi.waitFor(() => expect(openButtons[0]).not.toBeDisabled());
    });

    // U6 — "Open session here" used to call api.createSession directly,
    // discarding the created session and never firing refreshSessions(), so
    // no panel ever opened and the new row only appeared up to
    // LIVE_REFRESH_INTERVAL_MS later via the next poll tick. This proves
    // both halves of the fix: (1) the store action is used, not the raw api
    // client — observable as a GET /api/sessions (refreshSessions) firing
    // right after the POST, which api.createSession alone would never
    // trigger — and (2) the resulting session reaches onOpenSession, which
    // is what actually opens a pane for it.
    it("U6 — opens a session via the store action (not the raw api client) and hands it to onOpenSession", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          { path: "/home/x/.mullion-worktrees/foo", branch: "foo", isMain: false },
        ],
        remoteBranches: [],
      };
      const NEW_SESSION = {
        id: 42,
        projectId: 20,
        parentSessionId: null,
        name: null,
        nameLocked: false,
        command: "claude",
        cwd: "/home/x/.mullion-worktrees/foo",
        liveCwd: null,
        previewBranch: null,
        kind: "terminal",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastAttachedAt: null,
        alive: true,
        subscriberCount: 0,
        activity: "idle",
        lastActivityAt: null,
        attention: false,
        attentionAt: null,
        lastTitle: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        endedReason: null,
        liveBranch: null,
        exitCode: null,
        attentionKind: null,
        errorDetail: null,
        lastAssistantMessage: null,
        compactState: "idle",
        subagentCount: 0,
        subagents: [],
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        stateRestored: true,
        staleHooks: false,
        restoredVersion: null,
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
        sessionStatusDetail: null,
        hookEmits: [],
        pendingDevServerPort: null,
        outstandingBackgroundTasks: [],
        sessionStatusAttentionRequired: false,
      };
      let listSessionsCalls = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        if (url.includes("/actions")) {
          return Promise.resolve(
            jsonResponse(200, [
              { id: "agent:claude", title: "Claude", command: "claude", kind: "agent" },
            ]),
          );
        }
        if (url.includes("/api/sessions") && method === "POST") {
          return Promise.resolve(jsonResponse(201, NEW_SESSION));
        }
        if (url.includes("/api/sessions")) {
          listSessionsCalls += 1;
          return Promise.resolve(jsonResponse(200, [NEW_SESSION]));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const onOpenSession = vi.fn();
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 20 }} onOpenSession={onOpenSession} />);

      await screen.findByText("Worktrees (2)");
      await user.click(screen.getByText("Open session here"));

      await vi.waitFor(() =>
        expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 42 })),
      );
      // Only the store's createSession action also calls refreshSessions()
      // — api.createSession alone never would. This is what makes the new
      // row show up in the sidebar/tab strip immediately instead of
      // waiting out the next live-refresh poll tick.
      expect(listSessionsCalls).toBeGreaterThan(0);
    });

    it("Prune stale calls the prune endpoint and refreshes branches", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      let branchesCallCount = 0;
      let pruneCalled = false;
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-worktree-prune")) {
          pruneCalled = true;
          return Promise.resolve(jsonResponse(200, { pruned: true }));
        }
        if (url.includes("/git-branches")) {
          branchesCallCount += 1;
          return Promise.resolve(jsonResponse(200, branchesResult));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 13 }} />);

      await screen.findByText("Worktrees (1)");
      const callsBefore = branchesCallCount;
      await user.click(screen.getByText("Prune stale"));

      await vi.waitFor(() => {
        expect(pruneCalled).toBe(true);
        expect(branchesCallCount).toBeGreaterThan(callsBefore);
      });
    });

    // Independent review on PR #505 — same swallowed-throw gap as the
    // branch-delete case above, for the panel-level Prune stale button.
    it("shows a message when the prune request itself throws", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-worktree-prune")) {
          return Promise.resolve(jsonResponse(503, { message: "Host is unreachable" }));
        }
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 15 }} />);

      await screen.findByText("Worktrees (1)");
      await user.click(screen.getByText("Prune stale"));

      expect(await screen.findByText(/unreachable/i)).toBeInTheDocument();
    });

    // Hermes review on PR #505 — "Open session here" used to silently
    // no-op when no launcher resolved (unlike Delete/Remove, which always
    // surface a message).
    it("shows a message when no launcher is configured for Open session here", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          { path: "/home/x/.mullion-worktrees/foo", branch: "foo", isMain: false },
        ],
        remoteBranches: [],
      };
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, []));
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 17 }} />);

      await screen.findByText("Worktrees (2)");
      await user.click(screen.getByText("Open session here"));

      expect(await screen.findByText(/no launcher/i)).toBeInTheDocument();
    });

    it("keeps showing last-known-good branches/worktrees after a mutation whose refresh transiently fails", async () => {
      // The real bug this fixes: the old `.catch(() => setBranchesResult(null))`
      // made a transient refresh failure right after a mutation look like
      // "my delete destroyed the panel" — see refreshBranches's own doc
      // comment in GitPanel.tsx.
      const branchesResult: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "mergeable", isCurrent: false },
        ],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      let branchesCallCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branch-delete")) {
          return Promise.resolve(jsonResponse(200, { deleted: true }));
        }
        if (url.includes("/git-branches")) {
          branchesCallCount += 1;
          if (branchesCallCount === 1) return Promise.resolve(jsonResponse(200, branchesResult));
          return Promise.resolve(new Response("unavailable", { status: 503 }));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 14 }} />);

      await screen.findByText("Branches (2)");
      const deleteButtons = screen.getAllByText("Delete");
      await user.click(deleteButtons[1]);
      await user.click(deleteButtons[1]);

      await vi.waitFor(() => expect(branchesCallCount).toBeGreaterThan(1));
      expect(screen.getByText("Branches (2)")).toBeInTheDocument();
      expect(screen.getByText("mergeable")).toBeInTheDocument();
    });

    it("a mutation also invalidates store.ts's independent gitBranchesByProject cache (SessionRow's own branch display)", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [{ name: "main", isCurrent: true }],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      const originalRefreshGitRefs = useDashboardStore.getState().refreshGitRefs;
      const refreshGitRefsSpy = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ refreshGitRefs: refreshGitRefsSpy });
      try {
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
          if (url.includes("/git-worktree-prune")) {
            return Promise.resolve(jsonResponse(200, { pruned: true }));
          }
          if (url.includes("/git-branches"))
            return Promise.resolve(jsonResponse(200, branchesResult));
          return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
        });
        vi.stubGlobal("fetch", fetchMock);
        const user = userEvent.setup();
        render(<GitPanel params={{ projectId: 15 }} />);

        await screen.findByText("Worktrees (1)");
        expect(refreshGitRefsSpy).not.toHaveBeenCalled();
        await user.click(screen.getByText("Prune stale"));

        await vi.waitFor(() => expect(refreshGitRefsSpy).toHaveBeenCalled());
      } finally {
        useDashboardStore.setState({ refreshGitRefs: originalRefreshGitRefs });
      }
    });
  });
});
