// @vitest-environment jsdom
// #3557 — starting a dock control on another host ("Run on: <Mac>") said
// nothing when the launch failed there. Through the real bottom `<Dock>`: the
// cwd it sends is the chosen host's, a refused launch names its reason, and a
// run that exits at once keeps its last output in the log pane.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "../Dock.js";
import { DockSidebarView } from "../right-sidebar/DockSidebarView.js";
import { useDashboardStore } from "../store/index.js";
import { ApiError, LOCAL_HOST_ID } from "../api/index.js";
import type { GitBranchesResult, Session } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeHost, makeProject, makeSession } from "../test/fixtures.js";
import * as dd from "../test/dropdown.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";

vi.mock("../TerminalPane.js", () => ({
  TerminalPane: ({ params }: { params: { sessionId: number } }) => (
    <div data-testid="terminal-pane" data-session-id={params.sessionId} />
  ),
}));

const PROJECT = makeProject({
  id: 1,
  name: "aurora",
  cwd: "/home/x/aurora",
  hostCwds: { mac: "/Users/x/aurora" },
});
const MAC = makeHost({ id: "mac", name: "macbook", health: "online" });
const REFS: GitBranchesResult = {
  branches: [
    { name: "main", isCurrent: true },
    { name: "feature-x", isCurrent: false },
  ],
  worktrees: [
    { path: "/home/x/aurora", branch: "main", isMain: true },
    { path: "/home/x/aurora/.mullion-worktrees/feature-x", branch: "feature-x", isMain: false },
  ],
  remoteBranches: [],
};

let controls: unknown[];
let scrollbackText: string;

describe("Dock: starting a control on another host (#3557)", () => {
  let createSession: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Session>>>;

  beforeEach(() => {
    localStorage.clear();
    controls = [{ id: "dev", title: "Dev server", command: "make dev" }];
    scrollbackText = "";
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/dock": () => jsonResponse(200, controls),
      "GET /api/projects/:id/github": () => jsonResponse(204),
      "GET /api/projects/:id/github/prs": () => jsonResponse(204),
      "GET /api/sessions/:id/scrollback": () => jsonResponse(200, { text: scrollbackText }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
    createSession = vi.fn<(...args: unknown[]) => Promise<Session>>();
    resetStore({ projects: [PROJECT], sessions: [], hosts: [MAC] });
    useDashboardStore.setState({
      createSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      sessionsLoaded: true,
      gitBranchesByProject: { 1: REFS },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const renderDock = () =>
    render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
  const runOnMac = () =>
    dd.pickDropdownOption(
      screen.getByRole("combobox", { name: "Run dock controls on host" }),
      "mac",
    );
  const toasts = () => useDashboardStore.getState().toasts.map((t) => t.message);

  it("starts the main checkout on the chosen host without the own host's path", async () => {
    createSession.mockResolvedValue(makeSession({ id: 42, projectId: 1, kind: "dock" }));
    renderDock();
    const header = await screen.findByText("Dev server");
    runOnMac();
    await userEvent.click(header);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const opts = createSession.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toEqual(
      expect.objectContaining({ kind: "dock", dockControlId: "dev", targetHostId: "mac" }),
    );
    // /home/x/aurora does not exist on the Mac: the server uses its own root there.
    expect(opts).not.toHaveProperty("cwd");
    expect(toasts()).toEqual([]);
  });

  it("moves a control's own directory under the chosen host's checkout", async () => {
    controls = [{ id: "dev", title: "Dev server", command: "make dev", cwd: "/home/x/aurora/web" }];
    useDashboardStore.setState({ gitBranchesByProject: {} });
    createSession.mockResolvedValue(makeSession({ id: 42, projectId: 1, kind: "dock" }));
    renderDock();
    const header = await screen.findByText("Dev server");
    runOnMac();
    await userEvent.click(header);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][2]).toEqual(
      expect.objectContaining({ cwd: "/Users/x/aurora/web", targetHostId: "mac" }),
    );
  });

  it("refuses a worktree that exists on the own host only, and says so", async () => {
    localStorage.setItem(
      "dockControlWorktrees",
      JSON.stringify({ 1: { dev: "/home/x/aurora/.mullion-worktrees/feature-x" } }),
    );
    useDashboardStore.setState({
      dockControlWorktrees: { "1": { dev: "/home/x/aurora/.mullion-worktrees/feature-x" } },
    });
    renderDock();
    const header = await screen.findByText("Dev server");
    runOnMac();
    await userEvent.click(header);
    expect(await screen.findByText("Failed to start")).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
    expect(toasts()).toEqual([
      expect.stringMatching(
        /^Couldn't start Dev server on macbook: \/home\/x\/aurora\/\.mullion-worktrees\/feature-x is a checkout on this server only\./,
      ),
    ]);
  });

  it("shows the server's reason when the host refuses the launch, and stays off", async () => {
    createSession.mockRejectedValue(
      new ApiError("macbook: cwd does not exist: /Users/x/aurora", 502),
    );
    renderDock();
    const header = await screen.findByText("Dev server");
    runOnMac();
    await userEvent.click(header);
    expect(await screen.findByText("Failed to start")).toBeInTheDocument();
    expect(toasts()).toEqual([
      "Couldn't start Dev server on macbook: cwd does not exist: /Users/x/aurora",
    ]);
    expect(screen.queryByTestId("terminal-pane")).toBeNull();
  });

  it("names the reason for a refused start on the project's own host too", async () => {
    createSession.mockRejectedValue(new Error("Host is unreachable"));
    renderDock();
    await userEvent.click(await screen.findByText("Dev server"));
    expect(await screen.findByText("Failed to start")).toBeInTheDocument();
    expect(toasts()).toEqual(["Couldn't start Dev server on this server: Host is unreachable"]);
  });

  it("keeps the last output of a run that exits at once in the log pane", async () => {
    const started = makeSession({
      id: 42,
      projectId: 1,
      kind: "dock",
      dockControlId: "dev",
      command: "make dev",
      status: "active",
      hostId: "mac",
      resolvedHostId: "mac",
    } as Partial<Session>);
    createSession.mockImplementation(async () => {
      useDashboardStore.setState({ sessions: [started] });
      return started;
    });
    scrollbackText = "make: *** [dev] Error 2\nError: .env not found\n\n";
    renderDock();
    const header = await screen.findByText("Dev server");
    runOnMac();
    await userEvent.click(header);
    expect(await screen.findByTestId("terminal-pane")).toHaveAttribute("data-session-id", "42");

    // The host's program ended: the reconciler marks the row exited.
    act(() =>
      useDashboardStore.setState({
        sessions: [{ ...started, status: "exited", exitCode: 2 } as Session],
      }),
    );

    expect(
      await screen.findByText("Dev server exited right after starting on macbook (exit code 2)."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Error: \.env not found/)).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-pane")).toBeNull();
    expect(toasts()).toEqual([
      "Dev server exited right after starting on macbook (exit code 2). Last output: Error: .env not found",
    ]);
  });

  it("does not report a run the user stopped", async () => {
    const started = makeSession({
      id: 42,
      projectId: 1,
      kind: "dock",
      dockControlId: "dev",
      command: "make dev",
      status: "active",
    } as Partial<Session>);
    createSession.mockImplementation(async () => {
      useDashboardStore.setState({ sessions: [started] });
      return started;
    });
    renderDock();
    await userEvent.click(await screen.findByText("Dev server"));
    await screen.findByTestId("terminal-pane");
    // A killed row's live status derives "exited" too (session-status.ts).
    act(() =>
      useDashboardStore.setState({
        sessions: [{ ...started, status: "killed", sessionStatus: "exited" } as Session],
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(toasts()).toEqual([]);
    expect(screen.queryByText(/exited right after starting/)).toBeNull();
  });

  it("does not report a one-shot command that finished cleanly", async () => {
    const started = makeSession({
      id: 42,
      projectId: 1,
      kind: "dock",
      command: "make dev",
      status: "active",
    } as Partial<Session>);
    createSession.mockImplementation(async () => {
      useDashboardStore.setState({ sessions: [started] });
      return started;
    });
    renderDock();
    await userEvent.click(await screen.findByText("Dev server"));
    await screen.findByTestId("terminal-pane");
    act(() =>
      useDashboardStore.setState({
        sessions: [{ ...started, status: "exited", exitCode: 0 } as Session],
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(toasts()).toEqual([]);
  });

  it("locks the host selector while a control runs, so Restart cannot move it to another host (#3556)", async () => {
    const running = makeSession({
      id: 42,
      projectId: 1,
      kind: "dock",
      command: "make dev",
      status: "active",
      cwd: "/home/x/aurora/.mullion-worktrees/feature-x",
      hostId: "local",
      resolvedHostId: "local",
    } as Partial<Session>);
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    useDashboardStore.setState({ sessions: [running], deleteSession });
    createSession.mockResolvedValue(makeSession({ id: 43, projectId: 1, kind: "dock" }));
    render(<DockSidebarView projectId={1} actions={{ onOpenDockConfig: vi.fn() } as never} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Dev server, running/ }));
    // A Restart onto a host the worktree lacks cannot be asked for any more:
    // the selector shows where it runs and is disabled until it stops.
    expect(screen.getByRole("combobox", { name: /^Run dock controls on host/ })).toBeDisabled();
    const group = screen.getByRole("group", { name: "Dev server actions" });
    await userEvent.click(within(group).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(deleteSession).toHaveBeenCalledWith(42);
    expect(createSession.mock.calls[0][2]).not.toHaveProperty("targetHostId");
    expect(toasts()).toEqual([]);
  });

  it("shows the report in the Dock view too", async () => {
    const started = makeSession({
      id: 42,
      projectId: 1,
      kind: "dock",
      command: "make dev",
      status: "active",
    } as Partial<Session>);
    createSession.mockImplementation(async () => {
      useDashboardStore.setState({ sessions: [started] });
      return started;
    });
    scrollbackText = "Error: .env not found\n";
    render(<DockSidebarView projectId={1} actions={{ onOpenDockConfig: vi.fn() } as never} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Dev server, stopped/ }));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    act(() =>
      useDashboardStore.setState({
        sessions: [{ ...started, status: "exited", exitCode: 1 } as Session],
      }),
    );
    expect(
      await screen.findByText(
        "Dev server exited right after starting on this server (exit code 1).",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Error: .env not found")).toBeInTheDocument();
  });

  // Unique surface vs. DockSidebarView.test.tsx (which covers the sidebar badge
  // and selector label): pins the bottom <Dock>'s start-failure toast
  // (reportStartFailure -> hostLabel(launchHostId)) for #3570.
  it("labels a remote-owned project's own host by name and local host by name when not own host (#3570)", async () => {
    const remoteProject = makeProject({
      id: 1,
      name: "aurora",
      cwd: "/Users/x/aurora",
      hostId: "mac",
      hostCwds: { [LOCAL_HOST_ID]: "/home/x/aurora" },
    });
    const localHost = makeHost({ id: LOCAL_HOST_ID, name: "linux-box", health: "online" });
    resetStore({ projects: [remoteProject], sessions: [], hosts: [MAC, localHost] });
    createSession.mockRejectedValue(new Error("Host is unreachable"));
    useDashboardStore.setState({
      createSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      sessionsLoaded: true,
      gitBranchesByProject: { 1: REFS },
    });
    renderDock();
    const header = await screen.findByText("Dev server");
    // Own host is "mac", so default start labels it "macbook".
    await userEvent.click(header);
    expect(await screen.findByText("Failed to start")).toBeInTheDocument();
    expect(toasts()).toEqual(["Couldn't start Dev server on macbook: Host is unreachable"]);

    // Picking the local host on a remote-owned project labels it by its host name, not "this server".
    dd.pickDropdownOption(
      screen.getByRole("combobox", { name: "Run dock controls on host" }),
      LOCAL_HOST_ID,
    );
    await userEvent.click(header);
    await waitFor(() =>
      expect(toasts()).toEqual([
        "Couldn't start Dev server on macbook: Host is unreachable",
        "Couldn't start Dev server on linux-box: Host is unreachable",
      ]),
    );
  });
});
