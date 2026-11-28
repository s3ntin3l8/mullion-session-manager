// @vitest-environment jsdom
// #3588 — a dock start that waits for the project's setup recipe on the server
// says so ("Installing dependencies…"), a failed recipe names its reason, a
// run that exits says when the project has no recipe, and a branch preview's
// runs are visible under the preview control. Through the real bottom <Dock>
// and the right sidebar's Dock view.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "../Dock.js";
import { DockSidebarView } from "../right-sidebar/DockSidebarView.js";
import { useDashboardStore } from "../store/index.js";
import { ApiError } from "../api/index.js";
import type { Preview, Session } from "../api/index.js";
import type { RightSidebarActions } from "../right-sidebar/views.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";

vi.mock("../TerminalPane.js", () => ({
  TerminalPane: ({ params }: { params: { sessionId: number } }) => (
    <div data-testid="terminal-pane" data-session-id={params.sessionId} />
  ),
}));

const PROJECT = makeProject({ id: 1, name: "aurora", cwd: "/home/x/aurora" });
let setups: unknown[];
let scrollbackText: string;

describe("Dock: waiting for the setup recipe (#3588)", () => {
  let createSession: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Session>>>;

  beforeEach(() => {
    localStorage.clear();
    setups = [];
    scrollbackText = "";
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/dock": () =>
        jsonResponse(200, [{ id: "dev", title: "Dev server", command: "make dev" }]),
      "GET /api/projects/:id/dock/setups": () => jsonResponse(200, setups),
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
    resetStore({ projects: [PROJECT], sessions: [] });
    useDashboardStore.setState({
      createSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      sessionsLoaded: true,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const renderDock = () =>
    render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
  const toasts = () => useDashboardStore.getState().toasts.map((t) => t.message);

  it("shows Installing dependencies… while the server installs, then clears it", async () => {
    let finish!: (s: Session) => void;
    createSession.mockReturnValue(new Promise<Session>((r) => (finish = r)));
    setups = [{ projectId: 1, hostId: "local", dockControlId: "dev", branch: null, startedAt: 1 }];
    renderDock();
    await userEvent.click(await screen.findByText("Dev server"));
    expect(
      await screen.findByText("Installing dependencies…", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    await act(async () => finish(makeSession({ id: 42, projectId: 1, kind: "dock" })));
    await waitFor(() => expect(screen.queryByText("Installing dependencies…")).toBeNull());
  });

  it("reports a failed recipe with its reason", async () => {
    createSession.mockRejectedValue(
      new ApiError(
        "Installing dependencies failed (exit code 1); the command was not run.\nnpm ERR! 404",
        424,
        "setup_failed",
      ),
    );
    renderDock();
    await userEvent.click(await screen.findByText("Dev server"));
    expect(await screen.findByText("Installing dependencies failed")).toBeInTheDocument();
    expect(toasts()).toEqual([
      expect.stringContaining("Couldn't start Dev server on this server: Installing dependencies"),
    ]);
  });

  it("adds the no-recipe hint to an early exit, using the output the row kept", async () => {
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
        sessions: [
          {
            ...started,
            status: "exited",
            exitCode: null,
            lastExitCode: 1,
            lastOutput: "Error [ERR_MODULE_NOT_FOUND]: tsx",
            setupHint: "no-recipe",
          } as Session,
        ],
      }),
    );
    await waitFor(() =>
      expect(toasts()).toEqual([
        expect.stringMatching(
          /exit code 1\)\. Last output: Error \[ERR_MODULE_NOT_FOUND\]: tsx This project has no setup recipe/,
        ),
      ]),
    );
  });

  it("lists a branch preview's runs under the preview control", async () => {
    const running = makeSession({
      id: 7,
      projectId: 1,
      kind: "dock",
      command: "make dev",
      status: "active",
      cwd: "/home/x/aurora/.mullion-worktrees/dock-preview-feat-a-1",
    } as Partial<Session>);
    const failed = makeSession({
      id: 8,
      projectId: 1,
      kind: "dock",
      command: "make dev",
      status: "exited",
      cwd: "/home/x/aurora/.mullion-worktrees/dock-preview-feat-b-2",
      lastExitCode: 1,
      lastOutput: "Cannot find module 'tsx'",
      setupHint: "no-recipe",
    } as Partial<Session>);
    const onOpenSession = vi.fn();
    useDashboardStore.setState({
      sessions: [running, failed],
      previews: [
        { slug: "a", kind: "project", projectId: 1, sessionId: 7, branch: "feat/a" },
        { slug: "b", kind: "project", projectId: 1, sessionId: 8, branch: "feat/b" },
      ] as Preview[],
    });
    render(
      <Dock
        workspaceProjectIds={[1]}
        onOpenGitHub={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenSession={onOpenSession}
      />,
    );
    expect(await screen.findByText("Preview feat/b · exited (code 1)")).toBeInTheDocument();
    expect(screen.getByText("Preview feat/a · running")).toBeInTheDocument();
    expect(screen.getByText("Cannot find module 'tsx'")).toBeInTheDocument();
    expect(screen.getByText(/This project has no setup recipe/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenSession).toHaveBeenCalledWith(running);
  });

  it("shows the same in the right sidebar's Dock view", async () => {
    const failed = makeSession({
      id: 8,
      projectId: 1,
      kind: "dock",
      command: "make dev",
      status: "exited",
      cwd: "/home/x/aurora/.mullion-worktrees/dock-preview-feat-b-2",
      lastExitCode: 3,
    } as Partial<Session>);
    useDashboardStore.setState({ sessions: [failed] });
    const actions = { onOpenDockConfig: vi.fn() } as unknown as RightSidebarActions;
    render(<DockSidebarView projectId={1} actions={actions} />);
    expect(await screen.findByText("Preview session 8 · exited (code 3)")).toBeInTheDocument();
  });
});
