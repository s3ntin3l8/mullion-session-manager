// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DockSidebarView } from "./DockSidebarView.js";
import type { RightSidebarActions } from "./views.js";
import { useDashboardStore } from "../store/index.js";
import type { GitBranchesResult, Session } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";

// The log itself is a TerminalPane; here it is a stand-in that records its
// props. That the real one does not register as a terminal input target is
// proven against the real TerminalPane in TerminalPane.test.tsx.
vi.mock("../TerminalPane.js", () => ({
  TerminalPane: ({ params, readOnly }: { params: { sessionId: number }; readOnly?: boolean }) => (
    <div
      data-testid="terminal-pane"
      data-session-id={params.sessionId}
      data-read-only={String(readOnly)}
    />
  ),
}));

const PROJECT = makeProject({ id: 1, name: "aurora-web", cwd: "/home/x/aurora" });

const docker = (over: Record<string, unknown>) => ({
  composeProject: "aurora-dev",
  service: "api",
  containerName: "aurora-dev-api-1",
  state: "running",
  status: "Up 2 hours",
  imageRef: "ghcr.io/x/api:1.4.2",
  imageId: "sha256:aaa",
  buildable: false,
  pullable: true,
  ...over,
});

const DEV = { id: "dev", title: "dev", command: "npm run dev" };
const API = {
  id: "docker:aurora-dev:api",
  title: "api",
  command: "docker compose logs -f api",
  source: "docker",
  docker: docker({}),
};
const WEB = {
  id: "docker:aurora-prod:web",
  title: "web",
  command: "docker compose logs -f web",
  source: "docker",
  docker: docker({
    composeProject: "aurora-prod",
    service: "web",
    containerName: "aurora-prod-web-1",
    state: "exited",
    imageRef: "ghcr.io/x/web:1.4.2",
  }),
};

let controls: unknown[];
let checkUpdate: unknown;
const calls: string[] = [];

function dockSession(id: number, name: string | null, command: string): Session {
  return makeSession({
    id,
    projectId: 1,
    kind: "dock",
    status: "active",
    name,
    nameLocked: name !== null,
    command,
  } as Partial<Session>);
}

describe("DockSidebarView (#3012)", () => {
  const onOpenDockConfig = vi.fn();
  const actions = { onOpenDockConfig } as unknown as RightSidebarActions;
  let createSession: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<Session>>>;
  let deleteSession: ReturnType<typeof vi.fn<(id: number) => Promise<void>>>;

  beforeEach(() => {
    localStorage.clear();
    calls.length = 0;
    controls = [DEV, API, WEB];
    checkUpdate = {
      updateAvailable: true,
      currentImageId: "sha256:aaa",
      latestImageId: "sha256:bbb",
      imageRef: "ghcr.io/x/api:1.4.2",
      checkedAt: "2026-10-01T09:00:00Z",
    };
    onOpenDockConfig.mockClear();
    const record = (name: string, body: unknown) => () => {
      calls.push(name);
      return jsonResponse(name.startsWith("stack") ? 201 : 200, body);
    };
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/dock": () => jsonResponse(200, controls),
      "POST /api/projects/:id/docker/check-update": () => {
        calls.push("check-update");
        return jsonResponse(200, checkUpdate);
      },
      "POST /api/projects/:id/docker/service/restart": record("service-restart", {
        success: true,
      }),
      "POST /api/projects/:id/docker/service/stop": record("service-stop", { success: true }),
      "POST /api/projects/:id/docker/service/start": record("service-start", { success: true }),
      "POST /api/projects/:id/docker/stack/restart": record("stack-restart", { reused: true }),
      "POST /api/projects/:id/docker/stack/apply": record("stack-apply", { reused: true }),
      "POST /api/projects/:id/docker/stack/stop": record("stack-stop", { reused: true }),
      "POST /api/projects/:id/docker/update": record("stack-pull", { reused: true }),
      "POST /api/projects/:id/docker/stack/rebuild": record("stack-rebuild", { reused: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    createSession = vi
      .fn<(...args: unknown[]) => Promise<Session>>()
      .mockResolvedValue({} as Session);
    deleteSession = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
    resetStore({ projects: [PROJECT], sessions: [] });
    useDashboardStore.setState({ createSession, deleteSession, sessionsLoaded: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderView = () => render(<DockSidebarView projectId={1} actions={actions} />);

  it("shows one section for commands and one per Compose stack, by compose project", async () => {
    renderView();
    const commands = await screen.findByRole("region", { name: "Commands" });
    expect(within(commands).getByRole("button", { name: /^dev, stopped/ })).toBeInTheDocument();
    const dev = screen.getByRole("region", { name: "Stack aurora-dev" });
    const prod = screen.getByRole("region", { name: "Stack aurora-prod" });
    expect(within(dev).getByRole("button", { name: /^api, running/ })).toBeInTheDocument();
    expect(within(prod).getByRole("button", { name: /^web, exited/ })).toBeInTheDocument();
    // A dev and a prod stack never share a section.
    expect(within(dev).queryByRole("button", { name: /^web/ })).toBeNull();
    // The image tag stays on the service row.
    expect(within(dev).getByTitle("ghcr.io/x/api:1.4.2")).toHaveTextContent("1.4.2");
  });

  it("drops the bottom Dock's GitHub row and browser shortcut", async () => {
    renderView();
    await screen.findByRole("region", { name: "Commands" });
    expect(screen.queryByText(/Preview/)).toBeNull();
    expect(document.querySelector(".dock-github-row, .dock-group-header")).toBeNull();
  });

  it("offers the dock.json editor when the project has nothing to show", async () => {
    controls = [];
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Set up dock.json" }));
    expect(onOpenDockConfig).toHaveBeenCalledWith(1);
  });

  it("selects a command on tap without starting it; Start starts it", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^dev, stopped/ }));
    const group = screen.getByRole("group", { name: "dev actions" });
    expect(createSession).not.toHaveBeenCalled();
    expect(within(group).getByRole("button", { name: "Restart" })).toBeDisabled();
    expect(screen.getByText("Not running. Start it to see its log.")).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "Start" }));
    expect(createSession).toHaveBeenCalledWith(
      1,
      "npm run dev",
      expect.objectContaining({ kind: "dock" }),
    );
  });

  it("stops a running command only on the second tap, and restarts it", async () => {
    const running = dockSession(7, null, "npm run dev");
    useDashboardStore.setState({ sessions: [running] });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^dev, running/ }));
    const group = screen.getByRole("group", { name: "dev actions" });
    await userEvent.click(within(group).getByRole("button", { name: "Stop" }));
    expect(deleteSession).not.toHaveBeenCalled();
    await userEvent.click(within(group).getByRole("button", { name: "Tap again to stop" }));
    expect(deleteSession).toHaveBeenCalledWith(7);

    deleteSession.mockClear();
    await userEvent.click(within(group).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    expect(deleteSession).toHaveBeenCalledWith(7);
  });

  it("shows a running row's log, read only", async () => {
    useDashboardStore.setState({ sessions: [dockSession(7, null, "npm run dev")] });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^dev, running/ }));
    const pane = await screen.findByTestId("terminal-pane");
    expect(pane).toHaveAttribute("data-session-id", "7");
    expect(pane).toHaveAttribute("data-read-only", "true");
  });

  it("offers a branch picker for a command when the project has several checkouts", async () => {
    const branches: GitBranchesResult = {
      branches: [
        { name: "main", isCurrent: true },
        { name: "feature-x", isCurrent: false },
      ],
      worktrees: [{ path: "/home/x/aurora", branch: "main", isMain: true }],
      remoteBranches: [],
    };
    useDashboardStore.setState({ gitBranchesByProject: { 1: branches } });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^dev, stopped/ }));
    expect(screen.getByRole("button", { name: "dev branch" })).toBeInTheDocument();
  });

  it("starts a service's log stream when it is selected", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^api, running/ }));
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(
        1,
        "docker compose logs -f api",
        expect.objectContaining({ kind: "dock", name: "docker-logs:aurora-dev-api-1" }),
      ),
    );
  });

  it("runs a service's restart, stop (two taps) and check for update", async () => {
    useDashboardStore.setState({
      sessions: [dockSession(8, "docker-logs:aurora-dev-api-1", "docker compose logs -f api")],
    });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^api, running/ }));
    const group = screen.getByRole("group", { name: "api actions" });
    await userEvent.click(within(group).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(calls).toContain("service-restart"));
    await userEvent.click(within(group).getByRole("button", { name: "Stop" }));
    expect(calls).not.toContain("service-stop");
    await userEvent.click(within(group).getByRole("button", { name: "Tap again to stop" }));
    await waitFor(() => expect(calls).toContain("service-stop"));
    await userEvent.click(within(group).getByRole("button", { name: "Check for update" }));
    // The update marks the image tag on the row.
    expect(
      await screen.findByRole("button", { name: /^api, running, update available/ }),
    ).toBeInTheDocument();
  });

  it("offers Start for a stopped service", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^web, exited/ }));
    const group = screen.getByRole("group", { name: "web actions" });
    await userEvent.click(within(group).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(calls).toContain("service-start"));
  });

  it("disables Check for update for a service built from source", async () => {
    controls = [{ ...API, docker: docker({ pullable: false, buildable: true }) }];
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^api, running/ }));
    expect(screen.getByRole("button", { name: "Check for update" })).toBeDisabled();
  });

  it("opens a stack's own actions as a sheet with touch-size rows", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "aurora-dev stack actions" }));
    const sheet = await screen.findByRole("dialog", { name: "aurora-dev stack actions" });
    const rows = within(sheet)
      .getAllByRole("button")
      .filter((b) => b.classList.contains("dock-view-sheet-row"));
    expect(rows.map((r) => r.textContent)).toEqual([
      "Restart stack",
      "Apply config",
      "Pull & restart stack",
      "Stop stack",
    ]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Restart stack" }));
    await waitFor(() => expect(calls).toContain("stack-restart"));
  });

  it("asks for a second tap before stopping a whole stack", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "aurora-dev stack actions" }));
    const sheet = await screen.findByRole("dialog", { name: "aurora-dev stack actions" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Stop stack" }));
    expect(calls).not.toContain("stack-stop");
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Tap again — stops the whole stack" }),
    );
    await waitFor(() => expect(calls).toContain("stack-stop"));
  });

  it("does not run the Dock's auto-attach, nor start the row it selects by default", async () => {
    controls = [API];
    useDashboardStore.setState({
      settings: {
        ...useDashboardStore.getState().settings,
        dock: { ...useDashboardStore.getState().settings.dock, autoAttachDockerLogs: true },
      },
    });
    renderView();
    await screen.findByRole("region", { name: "Stack aurora-dev" });
    // The service is selected by default, but only a tap starts its log.
    expect(screen.getByRole("group", { name: "api actions" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(createSession).not.toHaveBeenCalled();
  });
});
