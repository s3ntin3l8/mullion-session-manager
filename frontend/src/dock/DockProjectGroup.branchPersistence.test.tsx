// @vitest-environment jsdom
// Issue #3230 — stopping a Dock dev server must keep its selected branch or
// worktree instead of resetting to the main checkout (including after a reload,
// a Dock remount, or when the session was started externally). Kept as a
// sibling file rather than growing DockMonitor.test.tsx past the repo's
// max-file-lines ratchet.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "../Dock.js";
import { useDashboardStore } from "../store/index.js";
import { readStoredDockControlWorktrees } from "../store/helpers.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { GitBranchesResult } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";

vi.mock("../TerminalPane.js", () => ({
  TerminalPane: ({ params }: { params: { sessionId: number } }) => (
    <div data-testid="terminal-pane" data-session-id={params.sessionId} />
  ),
}));

const PROJECT = makeProject({ id: 1, name: "mullion", cwd: "/home/x/mullion" });
const GIT_REFS: GitBranchesResult = {
  branches: [
    { name: "main", isCurrent: true },
    { name: "feat/ahead", isCurrent: false },
    { name: "topic-0", isCurrent: false },
  ],
  worktrees: [{ path: "/home/x/mullion", branch: "main", isMain: true }],
  remoteBranches: [],
};

describe("DockProjectGroup — branch selector persistence (#3230)", () => {
  beforeEach(() => {
    localStorage.clear();
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/github/prs": () => jsonResponse(204),
      "GET /api/projects/:id/dock": () =>
        jsonResponse(200, [{ id: "dev", title: "Dev server", command: "npm run dev" }]),
      "GET /api/projects/:id/github": () => jsonResponse(204),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    resetStore({
      projects: [PROJECT],
      sessions: [],
      sessionsLoaded: true,
      gitBranchesByProject: { 1: GIT_REFS },
      settings: {
        ...DEFAULT_SETTINGS,
        sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a running preview branch selected after the session ends and across a remount", async () => {
    const runningSession = makeSession({
      id: 42,
      projectId: 1,
      kind: "dock",
      command: "npm run dev",
      cwd: "/home/x/mullion/.mullion-worktrees/dock-preview-feat-ahead-1234",
      previewBranch: "feat/ahead",
      status: "active",
    });
    useDashboardStore.setState({ sessions: [runningSession] });

    const { unmount } = render(
      <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
    );

    const picker = await screen.findByRole("button", { name: "Dev server worktree" });
    expect(picker.textContent).toContain("feat/ahead (preview)");

    // Wait for the running session's resolved value to be persisted to the store/localStorage.
    await waitFor(() => {
      expect(readStoredDockControlWorktrees()).toEqual({ "1": { dev: "branch:feat/ahead" } });
    });

    // Session ends: selector must keep showing feat/ahead (preview), not reset to main.
    act(() => {
      useDashboardStore.setState({ sessions: [] });
    });
    expect(screen.getByRole("button", { name: "Dev server worktree" }).textContent).toContain(
      "feat/ahead (preview)",
    );

    // Unmount and mount a fresh Dock instance (simulates collapse/expand or remount):
    unmount();
    render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

    const remountedPicker = await screen.findByRole("button", { name: "Dev server worktree" });
    expect(remountedPicker.textContent).toContain("feat/ahead (preview)");
  });

  it("persists a manual pick made while stopped across a remount and store reload", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
    );

    const picker = await screen.findByRole("button", { name: "Dev server worktree" });
    expect(picker.textContent).toContain("main");

    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: "topic-0 (preview)" }));

    expect(screen.getByRole("button", { name: "Dev server worktree" }).textContent).toContain(
      "topic-0 (preview)",
    );
    expect(readStoredDockControlWorktrees()).toEqual({ "1": { dev: "branch:topic-0" } });

    // Simulate remount AND a full page reload (store re-initialized from localStorage).
    unmount();
    resetStore({
      projects: [PROJECT],
      sessions: [],
      sessionsLoaded: true,
      gitBranchesByProject: { 1: GIT_REFS },
      dockControlWorktrees: readStoredDockControlWorktrees(),
      settings: DEFAULT_SETTINGS,
    });

    render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
    const reloadedPicker = await screen.findByRole("button", { name: "Dev server worktree" });
    expect(reloadedPicker.textContent).toContain("topic-0 (preview)");
  });

  it("does not clobber a manual branch switch while the outgoing session is still stopping", async () => {
    const user = userEvent.setup();
    let resolveDelete!: () => void;
    const deleteSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const createSession = vi.fn().mockResolvedValue({});
    const runningSession = makeSession({
      id: 42,
      projectId: 1,
      kind: "dock",
      command: "npm run dev",
      cwd: "/home/x/mullion/.mullion-worktrees/dock-preview-feat-ahead-1234",
      previewBranch: "feat/ahead",
      status: "active",
    });
    useDashboardStore.setState({
      sessions: [runningSession],
      deleteSession,
      createSession,
    });

    render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
    const picker = await screen.findByRole("button", { name: "Dev server worktree" });
    await waitFor(() => {
      expect(readStoredDockControlWorktrees()).toEqual({ "1": { dev: "branch:feat/ahead" } });
    });

    // Switch to topic-0 while deleteSession is still pending.
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: "topic-0 (preview)" }));

    expect(deleteSession).toHaveBeenCalledWith(42);
    expect(readStoredDockControlWorktrees()).toEqual({ "1": { dev: "branch:topic-0" } });

    // Trigger a sync-effect re-run while the outgoing session is still in
    // `sessions` and `deleteSession` is pending — pins `syncedSessionByControlRef`.
    act(() => {
      useDashboardStore.setState({ sessions: [{ ...runningSession }] });
    });
    expect(readStoredDockControlWorktrees()).toEqual({ "1": { dev: "branch:topic-0" } });

    await act(async () => {
      resolveDelete();
    });
    await waitFor(() => {
      expect(createSession).toHaveBeenCalled();
    });
    expect(readStoredDockControlWorktrees()).toEqual({ "1": { dev: "branch:topic-0" } });
  });

  it("launches with the remembered worktree path even before git refs have loaded", async () => {
    const user = userEvent.setup();
    const createSession = vi.fn().mockResolvedValue({});
    resetStore({
      projects: [PROJECT],
      sessions: [],
      sessionsLoaded: true,
      gitBranchesByProject: {},
      dockControlWorktrees: { "1": { dev: "/home/x/mullion-wt" } },
      createSession,
      settings: DEFAULT_SETTINGS,
    });

    render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

    const startButton = await screen.findByRole("button", {
      name: "Dev server — click to start log streaming",
    });
    await user.click(startButton);

    expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
      cwd: "/home/x/mullion-wt",
      kind: "dock",
      dockControlId: "dev",
    });
  });

  it("does not replay a stale remembered path once git refs have loaded with nothing to show", async () => {
    const user = userEvent.setup();
    const createSession = vi.fn().mockResolvedValue({});
    resetStore({
      projects: [PROJECT],
      sessions: [],
      sessionsLoaded: true,
      gitBranchesByProject: {},
      gitRefsLoadedIds: { 1: true },
      dockControlWorktrees: { "1": { dev: "/home/x/removed-wt" } },
      createSession,
      settings: DEFAULT_SETTINGS,
    });

    render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

    const startButton = await screen.findByRole("button", {
      name: "Dev server — click to start log streaming",
    });
    await user.click(startButton);

    expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
      kind: "dock",
      dockControlId: "dev",
    });
  });
});
