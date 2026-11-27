// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DockSidebarView } from "./DockSidebarView.js";
import { Dock } from "../Dock.js";
import type { RightSidebarActions } from "./views.js";
import { useDashboardStore } from "../store/index.js";
import { ApiError } from "../api/index.js";
import type { GitBranchesResult, Session } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeHost, makeProject, makeSession } from "../test/fixtures.js";
import * as dd from "../test/dropdown.js";
import { mockFetch } from "../test/mockFetch.js";
import { SERVER_INFO_FIXTURE } from "../test/serverInfoFixture.js";
import { resetStore } from "../test/resetStore.js";
import companionCss from "../styles/companion-views.css?raw";

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

// null: the dock GET fails (500).
let controls: unknown[] | null;
let checkUpdate: unknown;
let serverPreviewsEnabled: boolean;
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
    serverPreviewsEnabled = true;
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
      "GET /api/server-info": () =>
        jsonResponse(200, { ...SERVER_INFO_FIXTURE, previewsEnabled: serverPreviewsEnabled }),
      "GET /api/projects/:id/dock": () =>
        controls === null ? jsonResponse(500, {}) : jsonResponse(200, controls),
      // The bottom Dock's own GitHub row, for the tests that mount it too.
      "GET /api/projects/:id/github": () => jsonResponse(204),
      "GET /api/projects/:id/github/prs": () => jsonResponse(204),
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
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
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

  describe("running a control on another host (#3425)", () => {
    const MAC = makeHost({ id: "mac", name: "Mac mini", health: "online" });
    const spanning = makeProject({
      id: 1,
      name: "aurora-web",
      cwd: "/home/x/aurora",
      hostCwds: { mac: "/Users/x/aurora" },
    });

    it("offers no host choice for a project that lives on one host", async () => {
      renderView();
      await screen.findByRole("region", { name: "Commands" });
      expect(screen.queryByRole("combobox", { name: "Run dock controls on host" })).toBeNull();
    });

    it("follows a control already running on another host, so Restart keeps it there", async () => {
      const running = {
        ...dockSession(7, null, "npm run dev"),
        hostId: "mac",
        resolvedHostId: "mac",
      } as Session;
      resetStore({ projects: [spanning], sessions: [running], hosts: [MAC] });
      useDashboardStore.setState({ createSession, deleteSession, sessionsLoaded: true });
      renderView();
      // #3556 — the row says where it runs.
      await userEvent.click(
        await screen.findByRole("button", { name: "dev, running on Mac mini" }),
      );
      const picker = screen.getByRole("combobox", { name: "Run dock controls on host" });
      // Not "this server": it is running on the Mac.
      expect(dd.dropdownValue(picker)).toBe("mac");
      const group = screen.getByRole("group", { name: "dev actions" });
      await userEvent.click(within(group).getByRole("button", { name: "Restart" }));
      await waitFor(() => expect(createSession).toHaveBeenCalled());
      expect(createSession.mock.calls[0][2]).toEqual(
        expect.objectContaining({ kind: "dock", targetHostId: "mac" }),
      );
    });

    describe("while a control runs, the selector shows its host and is locked (#3556)", () => {
      const picker = () => screen.getByRole("combobox", { name: "Run dock controls on host" });

      it("a stopped control: no host badge, the selector picks the next start's host", async () => {
        resetStore({ projects: [spanning], sessions: [], hosts: [MAC] });
        useDashboardStore.setState({ createSession, deleteSession, sessionsLoaded: true });
        renderView();
        await screen.findByRole("button", { name: "dev, stopped" });
        expect(picker()).not.toBeDisabled();
        expect(screen.getByText("Next start on")).toBeInTheDocument();
        expect(document.querySelector(".dock-host-picker")?.getAttribute("title")).toMatch(
          /next Start runs/,
        );
      });

      it("a pick made while stopped does not override where it then runs", async () => {
        resetStore({ projects: [spanning], sessions: [], hosts: [MAC] });
        useDashboardStore.setState({ createSession, deleteSession, sessionsLoaded: true });
        renderView();
        await screen.findByRole("button", { name: "dev, stopped" });
        dd.pickDropdownOption(picker(), "mac");
        expect(dd.dropdownValue(picker())).toBe("mac");

        // ...but it runs on the primary (started elsewhere, or before the pick).
        act(() => {
          useDashboardStore.setState({
            sessions: [
              { ...dockSession(7, null, "npm run dev"), resolvedHostId: "local" } as Session,
            ],
          });
        });
        await userEvent.click(
          await screen.findByRole("button", { name: "dev, running on this server" }),
        );
        expect(dd.dropdownValue(picker())).toBe("__own__");
        expect(picker()).toBeDisabled();
        expect(screen.getByText("Running on")).toBeInTheDocument();
        expect(document.querySelector(".dock-host-picker")?.getAttribute("title")).toBe(
          "dev is running on this server. Stop dev to run it on another host.",
        );
        // Restart keeps it where it runs, not on the stale pick.
        await userEvent.click(
          within(screen.getByRole("group", { name: "dev actions" })).getByRole("button", {
            name: "Restart",
          }),
        );
        await waitFor(() => expect(createSession).toHaveBeenCalled());
        expect(createSession.mock.calls[0][2]).not.toHaveProperty("targetHostId");

        // Stopped again: the pick is back and the selector unlocked.
        act(() => {
          useDashboardStore.setState({ sessions: [] });
        });
        await screen.findByRole("button", { name: "dev, stopped" });
        expect(picker()).not.toBeDisabled();
        expect(dd.dropdownValue(picker())).toBe("mac");
      });

      it("the bottom Dock badges a running control with its host, not the selector's", async () => {
        resetStore({
          projects: [spanning],
          sessions: [
            { ...dockSession(7, null, "npm run dev"), resolvedHostId: "local" } as Session,
          ],
          hosts: [MAC],
        });
        useDashboardStore.setState({ createSession, deleteSession, sessionsLoaded: true });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        expect(await screen.findByText("on this server")).toHaveAttribute(
          "title",
          "Running on this server",
        );
        expect(picker()).toBeDisabled();
        expect(dd.dropdownValue(picker())).toBe("__own__");

        act(() => {
          useDashboardStore.setState({
            sessions: [
              {
                ...dockSession(8, null, "npm run dev"),
                hostId: "mac",
                resolvedHostId: "mac",
              } as Session,
            ],
          });
        });
        expect(await screen.findByText("on Mac mini")).toBeInTheDocument();
        expect(dd.dropdownValue(picker())).toBe("mac");

        act(() => {
          useDashboardStore.setState({ sessions: [] });
        });
        await waitFor(() => expect(picker()).not.toBeDisabled());
        expect(document.querySelector(".dock-monitor-host")).toBeNull();
      });

      it("names every running control, and shows a host that left the list as itself", async () => {
        const LOGS = { id: "logs", title: "logs", command: "tail -f log" };
        controls = [DEV, LOGS];
        resetStore({
          projects: [spanning],
          sessions: [
            { ...dockSession(7, null, "npm run dev"), resolvedHostId: "old-box" } as Session,
            { ...dockSession(9, null, "tail -f log"), resolvedHostId: "local" } as Session,
          ],
          hosts: [MAC],
        });
        useDashboardStore.setState({ createSession, deleteSession, sessionsLoaded: true });
        renderView();
        await screen.findByRole("button", { name: "dev, running on old-box" });
        // The newest control off the project's own host decides what is shown.
        expect(dd.dropdownValue(picker())).toBe("old-box");
        expect(document.querySelector(".dock-host-picker")?.getAttribute("title")).toBe(
          "logs and dev are running. Stop them to run them on another host.",
        );
      });
    });

    it("restarts each control on the host its own session runs on", async () => {
      const LOGS = { id: "logs", title: "logs", command: "tail -f log" };
      controls = [DEV, LOGS];
      const onMac = {
        ...dockSession(7, null, "npm run dev"),
        hostId: "mac",
        resolvedHostId: "mac",
      } as Session;
      const atHome = {
        ...dockSession(9, null, "tail -f log"),
        hostId: "local",
        resolvedHostId: "local",
      } as Session;
      resetStore({ projects: [spanning], sessions: [onMac, atHome], hosts: [MAC] });
      useDashboardStore.setState({ createSession, deleteSession, sessionsLoaded: true });
      renderView();

      // The group's default is where the newest other-host control runs.
      await userEvent.click(await screen.findByRole("button", { name: /^logs, running/ }));
      expect(
        dd.dropdownValue(screen.getByRole("combobox", { name: "Run dock controls on host" })),
      ).toBe("mac");
      // ...but Restart on `logs` leaves it at home.
      await userEvent.click(
        within(screen.getByRole("group", { name: "logs actions" })).getByRole("button", {
          name: "Restart",
        }),
      );
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      expect(createSession.mock.calls[0][2]).toEqual(
        expect.objectContaining({ dockControlId: "logs" }),
      );
      expect(createSession.mock.calls[0][2]).not.toHaveProperty("targetHostId");

      // And Restart on `dev` keeps it on the Mac.
      createSession.mockClear();
      await userEvent.click(screen.getByRole("button", { name: /^dev, running/ }));
      await userEvent.click(
        within(screen.getByRole("group", { name: "dev actions" })).getByRole("button", {
          name: "Restart",
        }),
      );
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      expect(createSession.mock.calls[0][2]).toEqual(
        expect.objectContaining({ dockControlId: "dev", targetHostId: "mac" }),
      );
    });

    it("starts on the project's own placement until a host is picked, then on that host", async () => {
      resetStore({ projects: [spanning], sessions: [], hosts: [MAC] });
      useDashboardStore.setState({ createSession, deleteSession, sessionsLoaded: true });
      renderView();
      await userEvent.click(await screen.findByRole("button", { name: /^dev, stopped/ }));
      const group = screen.getByRole("group", { name: "dev actions" });

      await userEvent.click(within(group).getByRole("button", { name: "Start" }));
      expect(createSession.mock.calls[0][2]).not.toHaveProperty("targetHostId");

      const picker = screen.getByRole("combobox", { name: "Run dock controls on host" });
      expect(dd.dropdownOptions(picker).map((o) => o.label)).toEqual(["this server", "Mac mini"]);
      dd.pickDropdownOption(picker, "mac");
      await userEvent.click(within(group).getByRole("button", { name: "Start" }));
      expect(createSession.mock.calls[1]).toEqual([
        1,
        "npm run dev",
        expect.objectContaining({ kind: "dock", targetHostId: "mac" }),
      ]);

      // Previews are on here, so there is nothing to warn about.
      expect(screen.queryByRole("note")).toBeNull();

      // Back to the project's own host: nothing is sent again.
      dd.pickDropdownOption(
        screen.getByRole("combobox", { name: "Run dock controls on host" }),
        "__own__",
      );
      await userEvent.click(within(group).getByRole("button", { name: "Start" }));
      expect(createSession.mock.calls[2][2]).not.toHaveProperty("targetHostId");
    });
  });

  it("warns when another host is chosen and previews are off", async () => {
    serverPreviewsEnabled = false;
    resetStore({
      projects: [makeProject({ id: 1, name: "aurora-web", hostCwds: { mac: "/Users/x/aurora" } })],
      sessions: [],
      hosts: [makeHost({ id: "mac", name: "Mac mini", health: "online" })],
    });
    useDashboardStore.setState({ createSession, deleteSession, sessionsLoaded: true });
    renderView();
    const picker = await screen.findByRole("combobox", { name: "Run dock controls on host" });
    expect(screen.queryByRole("note")).toBeNull();
    dd.pickDropdownOption(picker, "mac");
    expect(await screen.findByRole("note")).toHaveTextContent(/PREVIEW_BASE_HOST/);
    dd.pickDropdownOption(
      screen.getByRole("combobox", { name: "Run dock controls on host" }),
      "__own__",
    );
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
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

  it("shows a port-in-use refusal with the holder's two actions", async () => {
    createSession.mockRejectedValueOnce(
      new ApiError("Port 5173 is in use by session 12", 409, "port_in_use", {
        port: 5173,
        holderSessionId: 12,
      }),
    );
    const requestOpenSession = vi.fn();
    useDashboardStore.setState({
      sessions: [makeSession({ id: 12, projectId: 1, command: "vite" })],
      requestOpenSession,
    });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^dev, stopped/ }));
    const group = screen.getByRole("group", { name: "dev actions" });
    await userEvent.click(within(group).getByRole("button", { name: "Start" }));
    expect(await within(group).findByRole("alert")).toHaveTextContent(
      "Port 5173 is in use by session 12",
    );
    await userEvent.click(within(group).getByRole("button", { name: "Open holder" }));
    expect(requestOpenSession).toHaveBeenCalledWith(12);
    await userEvent.click(within(group).getByRole("button", { name: "Stop holder and start" }));
    expect(deleteSession).toHaveBeenCalledWith(12);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
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

  it("gives the stack sheet's rows and the view's rows touch size (at least 48px)", () => {
    const minHeight = (selector: string) => {
      const rule = companionCss.match(
        new RegExp(`\\n${selector.replace(".", "\\.")} \\{([^}]*)\\}`),
      );
      return Number(/min-height: (\d+)px/.exec(rule?.[1] ?? "")?.[1]);
    };
    expect(minHeight(".dock-view-sheet-row")).toBeGreaterThanOrEqual(48);
    expect(minHeight(".dock-view-row")).toBeGreaterThanOrEqual(48);
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

  it("shows nothing of the previous project after a switch", async () => {
    const view = renderView();
    await screen.findByRole("region", { name: "Commands" });
    // Project 2's Dock has not loaded yet.
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    view.rerender(<DockSidebarView projectId={2} actions={actions} />);
    expect(screen.queryByRole("button", { name: /^dev/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Stack aurora-dev" })).toBeNull();
  });

  it("restarts an ended log stream when the selected service is tapped again", async () => {
    renderView();
    const row = await screen.findByRole("button", { name: /^api, running/ });
    await userEvent.click(row);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // The stream never shows up as running (it ended); a second tap retries.
    await userEvent.click(row);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
  });

  it("never carries an armed stack action into the next opening of the sheet", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "aurora-dev stack actions" }));
    let sheet = await screen.findByRole("dialog", { name: "aurora-dev stack actions" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Stop stack" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Close stack actions" }));
    await userEvent.click(screen.getByRole("button", { name: "aurora-prod stack actions" }));
    sheet = await screen.findByRole("dialog", { name: "aurora-prod stack actions" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Stop stack" }));
    // One tap only arms it: the other stack's armed Stop did not carry over.
    expect(calls).not.toContain("stack-stop");
  });

  it("does not start the row it selects by default", async () => {
    controls = [API];
    renderView();
    await screen.findByRole("region", { name: "Stack aurora-dev" });
    // The service is selected by default, but only a tap starts its log.
    expect(screen.getByRole("group", { name: "api actions" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(createSession).not.toHaveBeenCalled();
  });

  describe("Auto-attach Docker logs (#3031)", () => {
    const autoAttachOn = () =>
      useDashboardStore.setState({
        settings: {
          ...useDashboardStore.getState().settings,
          dock: { ...useDashboardStore.getState().settings.dock, autoAttachDockerLogs: true },
        },
      });
    const attachedApi = () =>
      createSession.mock.calls.filter(
        ([, , opts]) => (opts as { name?: string }).name === "docker-logs:aurora-dev-api-1",
      ).length;
    const renderBottomDock = () =>
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

    beforeEach(() => {
      controls = [API, WEB];
      autoAttachOn();
    });

    it("starts a running container's log once when the bottom Dock is absent", async () => {
      renderView();
      await waitFor(() => expect(attachedApi()).toBe(1));
      // WEB is exited: nothing to attach to.
      expect(createSession).toHaveBeenCalledTimes(1);
      // A later render (an unrelated store write) does not attach it again.
      act(() => useDashboardStore.setState({ sessions: [] }));
      await new Promise((r) => setTimeout(r, 0));
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it("never runs it while the bottom Dock is mounted for the project", async () => {
      // Mounted in one commit, the view first: it must not race the Dock.
      render(
        <>
          <DockSidebarView projectId={1} actions={actions} />
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />
        </>,
      );
      await waitFor(() => expect(attachedApi()).toBe(1));
      await new Promise((r) => setTimeout(r, 0));
      // One log session for the container, the bottom Dock's.
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it("leaves a failed attach to the surface that ran it", async () => {
      // Which surface ran the effect shows on its own row: the failure.
      createSession.mockRejectedValue(new Error("boom"));
      render(
        <>
          <DockSidebarView projectId={1} actions={actions} />
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />
        </>,
      );
      await waitFor(() => expect(attachedApi()).toBe(1));
      const bottomDock = document.querySelector(".dock") as HTMLElement;
      expect(await within(bottomDock).findByText("Auto-attach failed")).toBeInTheDocument();
      const group = screen.getByRole("group", { name: "api actions" });
      expect(within(group).queryByText("Auto-attach failed")).not.toBeInTheDocument();
    });

    it("reports a failed attach on the view's row when it ran it", async () => {
      createSession.mockRejectedValue(new Error("boom"));
      renderView();
      const group = await screen.findByRole("group", { name: "api actions" });
      expect(await within(group).findByText("Auto-attach failed")).toBeInTheDocument();
    });

    const bumpDockConfig = () =>
      act(() =>
        useDashboardStore.setState((st) => ({
          dockConfigRefreshTrigger: st.dockConfigRefreshTrigger + 1,
        })),
      );
    const WEB_RUNNING = { ...WEB, docker: { ...WEB.docker, state: "running" } };
    const attachedWeb = () =>
      createSession.mock.calls.filter(
        ([, , opts]) => (opts as { name?: string }).name === "docker-logs:aurora-prod-web-1",
      ).length;

    it("takes it over when the bottom Dock goes, without attaching a container twice", async () => {
      renderView();
      const dock = renderBottomDock();
      await waitFor(() => expect(attachedApi()).toBe(1));
      dock.unmount();
      await new Promise((r) => setTimeout(r, 0));
      // The view now owns the effect, and knows the container is attached.
      expect(createSession).toHaveBeenCalledTimes(1);
      // A container that starts running from here on is the view's to attach.
      controls = [API, WEB_RUNNING];
      bumpDockConfig();
      await waitFor(() => expect(attachedWeb()).toBe(1));
      expect(attachedApi()).toBe(1);
    });

    it("hands it to the bottom Dock when the Dock mounts beside the view", async () => {
      controls = [{ ...API, docker: { ...API.docker, state: "exited" } }];
      renderView();
      renderBottomDock();
      await screen.findByRole("region", { name: "Stack aurora-dev" });
      expect(createSession).not.toHaveBeenCalled();
      // The container starts; its attach fails, on the surface that ran it.
      createSession.mockRejectedValue(new Error("boom"));
      controls = [API];
      bumpDockConfig();
      await waitFor(() => expect(attachedApi()).toBe(1));
      const bottomDock = document.querySelector(".dock") as HTMLElement;
      expect(await within(bottomDock).findByText("Auto-attach failed")).toBeInTheDocument();
      const group = screen.getByRole("group", { name: "api actions" });
      expect(within(group).queryByText("Auto-attach failed")).not.toBeInTheDocument();
    });

    it("does nothing while the setting is off", async () => {
      useDashboardStore.setState({
        settings: {
          ...useDashboardStore.getState().settings,
          dock: { ...useDashboardStore.getState().settings.dock, autoAttachDockerLogs: false },
        },
      });
      renderView();
      await screen.findByRole("region", { name: "Stack aurora-dev" });
      await new Promise((r) => setTimeout(r, 0));
      expect(createSession).not.toHaveBeenCalled();
    });

    it("does not bring back a stream ended with Stop log after a failed poll", async () => {
      useDashboardStore.setState({
        settings: {
          ...useDashboardStore.getState().settings,
          sessions: { ...useDashboardStore.getState().settings.sessions, confirmBeforeKill: false },
        },
      });
      createSession.mockImplementation(async () => {
        useDashboardStore.setState({
          sessions: [dockSession(8, "docker-logs:aurora-dev-api-1", "docker compose logs -f api")],
        });
        return {} as Session;
      });
      deleteSession.mockImplementation(async (id: number) => {
        useDashboardStore.setState((st) => ({
          sessions: st.sessions.filter((x) => x.id !== id),
        }));
      });
      renderView();
      await waitFor(() => expect(attachedApi()).toBe(1));
      const group = await screen.findByRole("group", { name: "api actions" });
      await userEvent.click(await within(group).findByRole("button", { name: "Stop log" }));
      await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(8));
      // One poll fails (the list shows empty), the next one answers again.
      const failing = controls;
      controls = null;
      bumpDockConfig();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /^api, recreating/ })).toBeInTheDocument(),
      );
      controls = failing;
      bumpDockConfig();
      await screen.findByRole("button", { name: /^api, running/ });
      await new Promise((r) => setTimeout(r, 0));
      expect(attachedApi()).toBe(1);
    });

    it("does not bring back a stream ended with Stop log when the view remounts", async () => {
      useDashboardStore.setState({
        settings: {
          ...useDashboardStore.getState().settings,
          sessions: { ...useDashboardStore.getState().settings.sessions, confirmBeforeKill: false },
        },
      });
      createSession.mockImplementation(async () => {
        useDashboardStore.setState({
          sessions: [dockSession(8, "docker-logs:aurora-dev-api-1", "docker compose logs -f api")],
        });
        return {} as Session;
      });
      deleteSession.mockImplementation(async (id: number) => {
        useDashboardStore.setState((st) => ({
          sessions: st.sessions.filter((x) => x.id !== id),
        }));
      });
      const first = renderView();
      await waitFor(() => expect(attachedApi()).toBe(1));
      const group = await screen.findByRole("group", { name: "api actions" });
      await userEvent.click(await within(group).findByRole("button", { name: "Stop log" }));
      await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(8));
      first.unmount();
      renderView();
      await screen.findByRole("region", { name: "Stack aurora-dev" });
      await new Promise((r) => setTimeout(r, 0));
      expect(attachedApi()).toBe(1);
    });
  });

  it("stops a service's log stream with Stop log, leaving the container running", async () => {
    controls = [API];
    useDashboardStore.setState({
      sessions: [dockSession(8, "docker-logs:aurora-dev-api-1", "docker compose logs -f api")],
    });
    // A real end: the session leaves the store, as a delete does.
    deleteSession.mockImplementation(async (id: number) => {
      useDashboardStore.setState((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
    });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /^api, running/ }));
    const group = screen.getByRole("group", { name: "api actions" });
    expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-session-id", "8");
    // "Confirm before kill" is on by default: the first tap only arms.
    await userEvent.click(within(group).getByRole("button", { name: "Stop log" }));
    expect(deleteSession).not.toHaveBeenCalled();
    await userEvent.click(within(group).getByRole("button", { name: "Tap again to stop log" }));
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(8));
    expect(await screen.findByText("No log stream.")).toBeInTheDocument();
    // The container is untouched, and the stream does not come back on its own.
    expect(calls).not.toContain("service-stop");
    expect(within(group).queryByRole("button", { name: "Stop log" })).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(createSession).not.toHaveBeenCalled();
  });

  it("offers no Stop log while a service's log stream is off", async () => {
    controls = [API];
    renderView();
    await screen.findByRole("region", { name: "Stack aurora-dev" });
    const group = screen.getByRole("group", { name: "api actions" });
    expect(within(group).queryByRole("button", { name: "Stop log" })).not.toBeInTheDocument();
  });
});
