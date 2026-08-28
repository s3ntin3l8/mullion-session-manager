// @vitest-environment jsdom
// A single dock monitor's own header — split out of the former monolithic
// Dock.test.tsx (PR 28, Wave 5 of .claude/plans/can-we-do-a-warm-cocke.md),
// owns every test that exercises DockMonitor.tsx's own region: the plain
// start/kill toggle, the worktree/branch selector (including the U5/U8/
// Hermes-round-1 relaunch-race regressions and its own keyboard nav), P10's
// keyboard accessibility, and the Docker Compose kebab/check-update/
// pull-restart surface. Still mounts the full `<Dock>` (same reasoning as
// session-row/Header.test.tsx's own header comment) — DockMonitor's own
// props are computed inside DockColumn's map loop from a lot of column-level
// state, so a full render through a fake in-memory backend is the simplest
// way to exercise the real wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "../Dock.js";
import { useDashboardStore } from "../store/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { GitBranchesResult, Session } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";

// xterm.js's Terminal.open() reaches for browser APIs jsdom doesn't
// implement (e.g. matchMedia on the owner window) — TerminalPane itself is
// covered elsewhere; here we only need to know DockColumn decided to mount
// it (i.e. a monitor is "running"), not exercise the real terminal.
vi.mock("../TerminalPane.js", () => ({
  TerminalPane: ({ params }: { params: { sessionId: number } }) => (
    <div data-testid="terminal-pane" data-session-id={params.sessionId} />
  ),
}));

const PROJECT = makeProject({ id: 1, name: "mullion", cwd: "/home/x/mullion" });

let dockByProject: Record<number, unknown> = {};
let checkUpdateByProject: Record<number, unknown> = {};
let updateByProject: Record<number, unknown> = {};
let rebuildByProject: Record<number, unknown> = {};
let serviceActionResult: { success: boolean } = { success: true };
let stackActionByProject: Record<number, unknown> = {};

describe("Dock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    dockByProject = {};
    checkUpdateByProject = {};
    updateByProject = {};
    rebuildByProject = {};
    serviceActionResult = { success: true };
    stackActionByProject = {};
    ({ fetchMock } = mockFetch({
      "GET /api/projects/:id/github/prs": () => jsonResponse(204),
      "GET /api/projects/:id/dock": ({ params }) =>
        jsonResponse(200, dockByProject[Number(params.id)] ?? []),
      "GET /api/projects/:id/github": () => jsonResponse(204),
      "POST /api/projects/:id/docker/check-update": ({ params }) =>
        jsonResponse(200, checkUpdateByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/update": ({ params }) =>
        jsonResponse(201, updateByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/stack/rebuild": ({ params }) =>
        jsonResponse(201, rebuildByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/service/restart": () => jsonResponse(200, serviceActionResult),
      "POST /api/projects/:id/docker/service/stop": () => jsonResponse(200, serviceActionResult),
      "POST /api/projects/:id/docker/service/start": () => jsonResponse(200, serviceActionResult),
      "POST /api/projects/:id/docker/stack/restart": ({ params }) =>
        jsonResponse(201, stackActionByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/stack/apply": ({ params }) =>
        jsonResponse(201, stackActionByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/stack/stop": ({ params }) =>
        jsonResponse(201, stackActionByProject[Number(params.id)] ?? {}),
    }));
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe("monitor toggle", () => {
    it("toggles a configured monitor on/off via createSession/deleteSession", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const user = userEvent.setup();
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [],
        createSession,
        deleteSession,
        // U8 — this test is about the plain toggle round-trip, not the new
        // arm-then-confirm gate on the kill half of that toggle (see the
        // dedicated "U8" describe block below), so confirmBeforeKill is
        // explicitly off here rather than left at DEFAULT_SETTINGS' own
        // `true`.
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const header = await screen.findByText("Dev server");
      expect(screen.getByText("off")).toBeInTheDocument();
      await user.click(header);

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: undefined,
        kind: "dock",
      });

      const runningSession: Session = makeSession({
        id: 99,
        command: "npm run dev",
        cwd: null,
        env: null,
        kind: "dock",
        activity: "idle",
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
      });
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [runningSession],
        createSession,
        deleteSession,
      });

      const runningHeader = await screen.findByText("Dev server");
      expect(screen.getByText("on")).toBeInTheDocument();
      await user.click(runningHeader);

      expect(deleteSession).toHaveBeenCalledWith(99);
    });
  });

  describe("Docker Compose services (issue #73)", () => {
    function dockerControl(overrides: Record<string, unknown> = {}) {
      return {
        id: "docker:sanctuary:web",
        title: "web",
        command:
          "docker compose -p 'sanctuary' --project-directory '/x/sanctuary' logs -f --tail=200 'web'",
        source: "docker",
        docker: {
          composeProject: "sanctuary",
          service: "web",
          containerName: "sanctuary-web",
          state: "running",
          status: "Up 6 days",
          imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
          imageId: "sha256:current",
          buildOnly: false,
        },
        ...overrides,
      };
    }

    it("renders a discovered control under a Docker group label, with a status dot, image pill, and kebab", async () => {
      dockByProject[1] = [
        { id: "dev", title: "Dev server", command: "npm run dev" },
        dockerControl(),
      ];
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("Dev server")).toBeInTheDocument();
      expect(screen.getByText("Docker")).toHaveClass("dock-group-label");
      expect(screen.getByText("web")).toBeInTheDocument();
      expect(screen.getByText("edge")).toBeInTheDocument();
      expect(document.querySelector(".kebab-trigger-btn")).toBeInTheDocument();
    });

    it("clicking the kebab trigger does not toggle the monitor on/off", async () => {
      dockByProject[1] = [dockerControl()];
      const createSession = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], createSession });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);

      expect(await screen.findByText("Check for update")).toBeInTheDocument();
      expect(createSession).not.toHaveBeenCalled();
    });

    // Previously uncovered (issue #73 follow-up plan) — every other test in
    // this describe block exercises the kebab menu, never the header click
    // that actually starts the log stream for a `source: "docker"` control.
    it("clicking the header starts the log-stream session for a discovered Docker control", async () => {
      dockByProject[1] = [dockerControl()];
      const createSession = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], createSession });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const header = await screen.findByText("web");
      expect(screen.getByText("off")).toBeInTheDocument();
      await user.click(header);

      expect(createSession).toHaveBeenCalledWith(1, dockerControl().command, {
        cwd: undefined,
        kind: "dock",
      });
    });

    it("'Check for update' calls the check-update endpoint and tints the image pill on an update", async () => {
      dockByProject[1] = [dockerControl()];
      checkUpdateByProject[1] = {
        updateAvailable: true,
        currentImageId: "sha256:current",
        latestImageId: "sha256:new",
        imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
        checkedAt: "2026-01-01T00:00:00.000Z",
      };
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Check for update"));

      await waitFor(() => {
        expect(screen.getByText("edge").closest(".dock-monitor-image")).toHaveClass(
          "dock-monitor-image-update",
        );
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/1/docker/check-update",
        expect.objectContaining({ method: "POST" }),
      );
    });

    // Hermes review — a pull-failed/up-to-date check result was stored but
    // never surfaced anywhere, so a slow or failed check read as "nothing
    // happened."
    it("shows a transient 'Up to date' status when no update is available", async () => {
      dockByProject[1] = [dockerControl()];
      checkUpdateByProject[1] = { updateAvailable: false };
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Check for update"));

      const status = await screen.findByText("Up to date");
      expect(status).toHaveClass("dock-monitor-check-status");
      expect(status).not.toHaveClass("error");
    });

    it("shows a transient error status when the check-update pull fails", async () => {
      dockByProject[1] = [dockerControl()];
      checkUpdateByProject[1] = { updateAvailable: false, reason: "pull-failed" };
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Check for update"));

      const status = await screen.findByText("Check failed — pull error");
      expect(status).toHaveClass("dock-monitor-check-status", "error");
    });

    it("does not mangle a digest image ref into the literal string 'sha256'", async () => {
      dockByProject[1] = [
        dockerControl({
          docker: {
            ...dockerControl().docker,
            imageRef:
              "ghcr.io/s3ntin3l8/sanctuary@sha256:c14dd0e39e89f0c15c2bf462d8a2e05fb17a3b89dc8fe59b60e9f7daa48d7837",
          },
        }),
      ];
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      expect(screen.queryByText("sha256")).not.toBeInTheDocument();
      expect(
        document.querySelector(".dock-monitor-image .dock-monitor-url-text")?.textContent,
      ).toMatch(/^sha256:[0-9a-f]{12}$/);
    });

    it("'Pull & restart stack' requires arming (two clicks) before it fires", async () => {
      dockByProject[1] = [dockerControl()];
      updateByProject[1] = {
        sessionId: 42,
        control: {
          id: "docker-update:sanctuary",
          title: "Update sanctuary",
          command:
            "docker compose -p 'sanctuary' ... pull && docker compose -p 'sanctuary' ... up -d",
          source: "docker",
        },
      };
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], refreshSessions });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);
      const item = await screen.findByText("Pull & restart stack");

      await user.click(item);
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/projects/1/docker/update",
        expect.anything(),
      );
      expect(await screen.findByText("Click again — restarts the whole stack")).toBeInTheDocument();

      await user.click(screen.getByText("Click again — restarts the whole stack"));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/update",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(refreshSessions).toHaveBeenCalled();
    });

    it("a build-only service disables Check for update but offers an enabled Rebuild & restart, not a disabled Pull & restart", async () => {
      dockByProject[1] = [
        dockerControl({ docker: { ...dockerControl().docker, buildOnly: true } }),
      ];
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);

      await screen.findByText("Check for update");
      const checkBtn = screen.getByText("Check for update").closest("button");
      expect(checkBtn).toBeDisabled();

      // The bug this PR fixes: previously BOTH menu items were disabled for
      // a build-only stack, leaving no lifecycle action reachable at all.
      expect(screen.queryByText("Pull & restart stack")).not.toBeInTheDocument();
      const rebuildBtn = screen.getByText("Rebuild & restart stack").closest("button");
      expect(rebuildBtn).not.toBeDisabled();
    });

    it("'Rebuild & restart stack' requires arming before it fires the rebuild route", async () => {
      dockByProject[1] = [
        dockerControl({ docker: { ...dockerControl().docker, buildOnly: true } }),
      ];
      rebuildByProject[1] = {
        sessionId: 43,
        control: { id: "docker-rebuild:sanctuary", title: "Rebuild sanctuary", source: "docker" },
      };
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], refreshSessions });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Rebuild & restart stack"));

      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/projects/1/docker/stack/rebuild",
        expect.anything(),
      );
      await user.click(
        await screen.findByText("Click again — rebuilds and restarts the whole stack"),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/rebuild",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(refreshSessions).toHaveBeenCalled();
    });

    it("service Restart/Start fire immediately (no arming) and Stop requires arming", async () => {
      dockByProject[1] = [
        dockerControl({ docker: { ...dockerControl().docker, state: "exited" } }),
      ];
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);

      await user.click(await screen.findByText("Restart service"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/service/restart",
          expect.objectContaining({ method: "POST" }),
        );
      });

      await user.click(document.querySelector(".kebab-trigger-btn")!);
      // state:"exited" (≠ running) — "Start service" must be offered.
      await user.click(await screen.findByText("Start service"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/service/start",
          expect.objectContaining({ method: "POST" }),
        );
      });

      await user.click(document.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Stop service"));
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/projects/1/docker/service/stop",
        expect.anything(),
      );
      await user.click(await screen.findByText("Click again — stops this service"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/service/stop",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });

    it("does not offer 'Start service' when the container is already running", async () => {
      dockByProject[1] = [dockerControl()]; // default state: "running"
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const user = userEvent.setup();
      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);

      await screen.findByText("Restart service");
      expect(screen.queryByText("Start service")).not.toBeInTheDocument();
    });

    it("a failed service action shows a transient error status instead of silently no-op'ing", async () => {
      dockByProject[1] = [dockerControl()];
      serviceActionResult = { success: false };
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Restart service"));

      const status = await screen.findByText("Restart failed");
      expect(status).toHaveClass("dock-monitor-check-status", "error");
    });

    it("stack Restart/Apply fire immediately and Stop stack requires arming", async () => {
      dockByProject[1] = [dockerControl()];
      stackActionByProject[1] = {
        sessionId: 44,
        control: { id: "docker-restart:sanctuary", title: "Restart sanctuary", source: "docker" },
      };
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], refreshSessions });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Restart stack"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/restart",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(refreshSessions).toHaveBeenCalled();

      await user.click(document.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Apply config"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/apply",
          expect.objectContaining({ method: "POST" }),
        );
      });

      await user.click(document.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Stop stack"));
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/projects/1/docker/stack/stop",
        expect.anything(),
      );
      await user.click(await screen.findByText("Click again — stops the whole stack"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/stop",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });

    it("a manual dock.json control (no `docker` field) never renders a kebab", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("Dev server");
      expect(document.querySelector(".kebab-trigger-btn")).not.toBeInTheDocument();
      expect(screen.queryByText("Docker")).not.toBeInTheDocument();
    });
  });

  // Helpers for interacting with CustomSelect in tests.
  async function selectWorktreeOption(
    u: ReturnType<typeof userEvent.setup>,
    c: HTMLElement,
    value: string,
  ) {
    const wrapper = c.querySelector(".dock-monitor-worktree-select") as HTMLElement;
    await u.click(wrapper.querySelector(".custom-select-trigger")!);
    await waitFor(() => {
      expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();
    });
    const items = document.querySelectorAll(".custom-select-item");
    const target = Array.from(items).find((el) => el.getAttribute("data-value") === value);
    if (target) await u.click(target);
  }

  function getSelectedWorktreeValue(c: HTMLElement): string | null {
    const wrapper = c.querySelector(".dock-monitor-worktree-select") as HTMLElement;
    return (
      wrapper.querySelector(".custom-select-trigger")?.getAttribute("data-selected-value") ?? null
    );
  }

  function getWorktreeOptionValues(): string[] {
    const items = document.querySelectorAll(".custom-select-item");
    return Array.from(items).map((el) => el.getAttribute("data-value")!);
  }

  describe("worktree selector", () => {
    const MAIN_WORKTREE: GitBranchesResult = {
      branches: [{ name: "main", isCurrent: true }],
      worktrees: [{ path: "/home/x/mullion", branch: "main", isMain: true }],
      remoteBranches: [],
    };

    const MULTI_WORKTREE: GitBranchesResult = {
      branches: [
        { name: "main", isCurrent: false },
        { name: "feature-x", isCurrent: true },
      ],
      worktrees: [
        { path: "/home/x/mullion", branch: "main", isMain: true },
        {
          path: "/home/x/mullion/.mullion-worktrees/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ],
      remoteBranches: [],
    };

    function setupStore(overrides: Partial<Parameters<typeof useDashboardStore.setState>[0]> = {}) {
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [],
        createSession: vi.fn().mockResolvedValue({}),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      });
    }

    it("shows no worktree selector when gitBranchesByProject is undefined (not yet fetched)", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: {} });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");
      expect(container.querySelector(".dock-monitor-worktree-select")).not.toBeInTheDocument();
    });

    it("shows no worktree selector when project has only the main checkout", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: { 1: MAIN_WORKTREE } });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");
      expect(container.querySelector(".dock-monitor-worktree-select")).not.toBeInTheDocument();
    });

    it("shows a worktree selector when project has multiple worktrees", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      expect(container.querySelector(".dock-monitor-worktree-select")).toBeInTheDocument();
    });

    it("lists all worktree branches in the selector", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
      (wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement).focus();
      await user.keyboard("{ArrowDown}");
      await waitFor(() => {
        expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();
      });
      const options = getWorktreeOptionValues();
      expect(options).toContain("/home/x/mullion");
      expect(options).toContain("/home/x/mullion/.mullion-worktrees/feature-x");
    });

    it("defaults to the main checkout worktree", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      expect(getSelectedWorktreeValue(container)).toBe("/home/x/mullion");
    });

    it("passes the default worktree path as cwd when toggling on (first use)", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      setupStore({ createSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const header = (await screen.findByText("Dev server")).closest(".dock-monitor-header")!;
      await user.click(header);

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion",
        kind: "dock",
      });
    });

    it("passes the selected worktree path as cwd when toggling on", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      setupStore({ createSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");
      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");

      const header = screen.getByText("Dev server").closest(".dock-monitor-header")!;
      await user.click(header);

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion/.mullion-worktrees/feature-x",
        kind: "dock",
      });
    });

    it("shows the worktree selector even when running, reflecting the session's cwd", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      setupStore({ createSession, deleteSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      const runningSession: Session = makeSession({
        id: 99,
        command: "npm run dev",
        cwd: "/home/x/mullion/.mullion-worktrees/feature-x",
        kind: "dock",
        activity: "idle",
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
      });
      useDashboardStore.setState({
        sessions: [runningSession],
        gitBranchesByProject: { 1: MULTI_WORKTREE },
      });

      // The select is still visible when running
      await waitFor(() => {
        expect(container.querySelector(".dock-monitor-worktree-select")).toBeInTheDocument();
      });
      // And it reflects the running session's worktree path
      expect(getSelectedWorktreeValue(container)).toBe(
        "/home/x/mullion/.mullion-worktrees/feature-x",
      );
      expect(screen.getByText("on")).toBeInTheDocument();
    });

    it("kills and restarts the session when worktree selection changes while running", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      setupStore({ createSession, deleteSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      const runningSession: Session = makeSession({
        id: 99,
        command: "npm run dev",
        cwd: "/home/x/mullion",
        kind: "dock",
        activity: "idle",
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
      });
      useDashboardStore.setState({
        sessions: [runningSession],
        gitBranchesByProject: { 1: MULTI_WORKTREE },
      });

      // Wait for the component to re-render with the running session
      await waitFor(() => {
        expect(screen.getByText("on")).toBeInTheDocument();
      });

      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");

      expect(deleteSession).toHaveBeenCalledWith(99);
      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion/.mullion-worktrees/feature-x",
        kind: "dock",
      });
    });

    function makeRunningDockSession(overrides: Partial<Session> = {}): Session {
      return {
        id: 99,
        projectId: 1,
        parentSessionId: null,
        name: null,
        nameLocked: false,
        command: "npm run dev",
        cwd: "/home/x/mullion",
        env: null,
        liveCwd: null,
        previewBranch: null,
        kind: "dock",
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
        ...overrides,
      };
    }

    // U5 regression — the original bug: Dock.tsx's switch handler decided
    // whether to relaunch by re-reading `sessions` off the store AFTER
    // awaiting `deleteSession`, but the REAL `store.deleteSession`
    // (store.ts) itself awaits `refreshSessions()` before resolving — so by
    // the time that check ran, the just-deleted row already read "killed"
    // and the relaunch branch was unreachable. Every OTHER test in this
    // file mocks `deleteSession` as a bare `vi.fn().mockResolvedValue(...)`
    // that never touches `sessions` at all, which can't catch this — it
    // would pass identically whether the fix was in place or not. This one
    // mocks `deleteSession` to actually mutate `sessions` to "killed" the
    // same way the real store action does, so it fails against the
    // original code and passes against the fix.
    it("U5 — relaunches at the new worktree even though the just-deleted row already reads 'killed' by the time the check runs", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn(async (id: number) => {
        useDashboardStore.setState((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === id ? { ...sess, status: "killed" as const } : sess,
          ),
        }));
      });
      setupStore({ createSession, deleteSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");

      useDashboardStore.setState({
        sessions: [makeRunningDockSession()],
        gitBranchesByProject: { 1: MULTI_WORKTREE },
      });
      await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");

      await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(99));
      await waitFor(() =>
        expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
          cwd: "/home/x/mullion/.mullion-worktrees/feature-x",
          kind: "dock",
        }),
      );
    });

    // U5 nuance — the ORIGINAL code's live-state re-check existed to avoid
    // relaunching a monitor the user manually toggled off during the async
    // delete-then-relaunch window. The fix preserves that with a
    // toggleGenRef bumped only by an explicit header click, not by
    // re-deriving from session status. This proves the preserved intent:
    // clicking the header (which, with confirmBeforeKill off, kills
    // immediately) WHILE the worktree-switch's own delete is in flight must
    // suppress that switch's pending relaunch.
    it("U5 nuance — a manual header click during the in-flight switch suppresses the pending relaunch", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      let deleteCalls = 0;
      let resolveSwitchDelete: (() => void) | undefined;
      const markKilled = (id: number) =>
        useDashboardStore.setState((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === id ? { ...sess, status: "killed" as const } : sess,
          ),
        }));
      const deleteSession = vi.fn((id: number) => {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          // The switch's own delete — deliberately stays pending (not
          // mutating `sessions` yet) until resolveSwitchDelete() fires
          // below, the same "sessions still reads active mid-flight" window
          // the real store.deleteSession has during its own network round
          // trip, before its refreshSessions() call lands.
          return new Promise<void>((resolve) => {
            resolveSwitchDelete = () => {
              markKilled(id);
              resolve();
            };
          });
        }
        // The header's own manual kill (this test's second deleteSession
        // call) — resolves immediately, same as this file's other mocks.
        markKilled(id);
        return Promise.resolve();
      });
      setupStore({
        createSession,
        deleteSession,
        gitBranchesByProject: { 1: MULTI_WORKTREE },
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");

      useDashboardStore.setState({
        sessions: [makeRunningDockSession()],
        gitBranchesByProject: { 1: MULTI_WORKTREE },
      });
      await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

      // Kicks off the switch's own deleteSession call, which hangs (still
      // "on" in the UI) until resolveSwitchDelete() fires below.
      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");
      await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(1));
      expect(screen.getByText("on")).toBeInTheDocument();

      // The user manually clicks the header (still reads "running" — the
      // switch's own delete hasn't resolved yet) while that switch is in
      // flight — confirmBeforeKill is off, so this kills immediately.
      const header = screen.getByText("Dev server").closest(".dock-monitor-header")!;
      await user.click(header);
      expect(deleteSession).toHaveBeenCalledTimes(2);

      // Now let the switch's own delete resolve.
      resolveSwitchDelete?.();
      await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));

      // Neither the manual click (a kill, not a start) nor the switch's own
      // now-superseded relaunch should ever call createSession.
      await new Promise((r) => setTimeout(r, 0));
      expect(createSession).not.toHaveBeenCalled();
    });

    describe("U8 — confirm before killing a running dock monitor from its header", () => {
      it("arms on the first click instead of killing immediately, then kills on a second click", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        const createSession = vi.fn().mockResolvedValue({});
        const deleteSession = vi.fn().mockResolvedValue(undefined);
        setupStore({
          createSession,
          deleteSession,
          settings: {
            ...DEFAULT_SETTINGS,
            sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: true },
          },
        });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        await screen.findByText("Dev server");

        useDashboardStore.setState({ sessions: [makeRunningDockSession()] });
        await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

        const header = screen.getByText("Dev server").closest(".dock-monitor-header")!;
        await user.click(header);

        // Armed, not killed — the tag flips to "confirm?" and deleteSession
        // must not have fired yet.
        expect(await screen.findByText("confirm?")).toBeInTheDocument();
        expect(deleteSession).not.toHaveBeenCalled();

        await user.click(header);

        expect(deleteSession).toHaveBeenCalledWith(99);
      });

      it("start (nothing running) always fires immediately regardless of confirmBeforeKill", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        const createSession = vi.fn().mockResolvedValue({});
        setupStore({
          createSession,
          // Explicit, not inherited — earlier tests in this describe block
          // set gitBranchesByProject on the shared store singleton, and
          // setupStore's own defaults don't reset it, so leaving this out
          // would non-deterministically resolve a mainCheckoutPath from
          // whichever test happened to run before this one.
          gitBranchesByProject: {},
          settings: {
            ...DEFAULT_SETTINGS,
            sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: true },
          },
        });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        const header = await screen.findByText("Dev server");

        await user.click(header);

        expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
          kind: "dock",
        });
      });

      // Hermes review round 1 — the header's start affordance used to
      // discard launchForValue's promise with a bare `void`, so a failed
      // createSession (dead remote host, a bad worktree path, ...) was an
      // unhandled rejection with nothing shown — the exact P9 silent-
      // failure class this PR fixes everywhere else.
      it("surfaces an inline error when starting a monitor fails, instead of an unhandled rejection", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        const createSession = vi.fn().mockRejectedValue(new Error("Host is unreachable"));
        setupStore({ createSession, gitBranchesByProject: {} });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        const header = await screen.findByText("Dev server");

        await user.click(header);

        expect(await screen.findByText("Failed to start — try again")).toBeInTheDocument();
      });
    });

    // Hermes review round 1 (suggestion) — the toggleGenRef generation
    // counter previously only advanced on an explicit header click, so two
    // rapid worktree switches on the same control could race: each starts
    // its own delete-then-relaunch IIFE, and if both deletes resolved, the
    // FIRST switch's relaunch could still fire (at its own, now-stale
    // path) after the SECOND switch had already moved the select on to a
    // newer one. The fix bumps the counter at the START of every switch
    // too, not just on a manual header toggle.
    it("Hermes review round 1 — a second, newer worktree switch invalidates a still in-flight first switch's relaunch", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const resolvers: Array<() => void> = [];
      const deleteSession = vi.fn((id: number) => {
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            useDashboardStore.setState((s) => ({
              sessions: s.sessions.map((sess) =>
                sess.id === id ? { ...sess, status: "killed" as const } : sess,
              ),
            }));
            resolve();
          });
        });
      });
      const THREE_WORKTREE: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: false },
          { name: "feature-x", isCurrent: false },
          { name: "feature-y", isCurrent: true },
        ],
        worktrees: [
          { path: "/home/x/mullion", branch: "main", isMain: true },
          {
            path: "/home/x/mullion/.mullion-worktrees/feature-x",
            branch: "feature-x",
            isMain: false,
          },
          {
            path: "/home/x/mullion/.mullion-worktrees/feature-y",
            branch: "feature-y",
            isMain: false,
          },
        ],
        remoteBranches: [],
      };
      setupStore({ createSession, deleteSession, gitBranchesByProject: { 1: THREE_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");

      useDashboardStore.setState({
        sessions: [makeRunningDockSession()],
        gitBranchesByProject: { 1: THREE_WORKTREE },
      });
      await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

      // First switch — its own deleteSession call stays pending.
      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");
      await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(1));

      // Before the first switch's delete resolves, a second, newer switch
      // starts — its own deleteSession call also stays pending. Both
      // target the same still-running session id (99): the first switch
      // hasn't mutated `sessions` yet (its own delete is still in flight),
      // so the select still reads this session as running.
      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-y");
      await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));

      // Resolve the FIRST switch's delete now — its relaunch must be
      // suppressed (superseded by the second switch), not fire at the
      // stale feature-x path.
      resolvers[0]!();
      await waitFor(() => expect(createSession).not.toHaveBeenCalled());

      // Resolve the SECOND (newer) switch's delete — its relaunch, at
      // feature-y, is the only one that should ever fire.
      resolvers[1]!();
      await waitFor(() =>
        expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
          cwd: "/home/x/mullion/.mullion-worktrees/feature-y",
          kind: "dock",
        }),
      );
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    // PR #341 review: preview worktrees are checked out with a detached
    // HEAD (git-worktree.ts's checkoutBranchWorktree), so listWorktrees
    // reports `branch: null` for one — it must be filtered out of the
    // worktree options (else it'd show up a second time, labeled by its raw
    // path) while its "<branch> (preview)" option stays available. A
    // running preview session's `cwd` is therefore never an option value,
    // so the select must resolve through the session's `previewBranch`
    // field instead — with a non-blank fallback when that's null.
    describe("preview worktrees (detached HEAD)", () => {
      const PREVIEW_WORKTREE_PATH =
        "/home/x/mullion/.mullion-worktrees/dock-preview-feature-y-abc123";

      const WITH_PREVIEW: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "feature-y", isCurrent: false },
        ],
        worktrees: [
          { path: "/home/x/mullion", branch: "main", isMain: true },
          { path: PREVIEW_WORKTREE_PATH, branch: null, isMain: false },
        ],
        remoteBranches: [],
      };

      function makeRunningSession(overrides: Partial<Session>): Session {
        return {
          id: 99,
          projectId: 1,
          parentSessionId: null,
          name: null,
          nameLocked: false,
          command: "npm run dev",
          cwd: null,
          env: null,
          liveCwd: null,
          previewBranch: null,
          kind: "dock",
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
          sessionStatus: "idle",
          sessionStatusSeverity: "dormant",
          sessionStatusDetail: null,
          hookEmits: [],
          pendingDevServerPort: null,
          outstandingBackgroundTasks: [],
          sessionStatusAttentionRequired: false,
          stateRestored: true,
          staleHooks: false,
          restoredVersion: null,
          ...overrides,
        };
      }

      it("excludes the preview worktree's raw path from the select options, keeping the branch option", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        setupStore({ gitBranchesByProject: { 1: WITH_PREVIEW } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );

        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        (wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement).focus();
        await user.keyboard("{ArrowDown}");
        await waitFor(() => {
          expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();
        });
        const options = getWorktreeOptionValues();

        expect(options).toContain("/home/x/mullion");
        expect(options).toContain("branch:feature-y");
        expect(options).not.toContain(PREVIEW_WORKTREE_PATH);
      });

      it("resolves a running preview session to its branch option via previewBranch", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        setupStore({ gitBranchesByProject: { 1: WITH_PREVIEW } });
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        useDashboardStore.setState({
          sessions: [
            makeRunningSession({ cwd: PREVIEW_WORKTREE_PATH, previewBranch: "feature-y" }),
          ],
          gitBranchesByProject: { 1: WITH_PREVIEW },
        });

        await waitFor(() => {
          expect(getSelectedWorktreeValue(container)).toBe("branch:feature-y");
        });
      });

      it("falls back to the main checkout, never blank, when a running preview session has no previewBranch (server restart)", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        setupStore({ gitBranchesByProject: { 1: WITH_PREVIEW } });
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        useDashboardStore.setState({
          sessions: [makeRunningSession({ cwd: PREVIEW_WORKTREE_PATH, previewBranch: null })],
          gitBranchesByProject: { 1: WITH_PREVIEW },
        });

        await waitFor(() => {
          expect(getSelectedWorktreeValue(container)).toBe("/home/x/mullion");
        });
      });
    });

    describe("keyboard navigation", () => {
      beforeEach(() => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      });

      it("opens the menu via ArrowDown and focuses the first option", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();
        await user.keyboard("{ArrowDown}");

        expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(document.querySelector(".custom-select-item.focused")).toBeInTheDocument();
        expect(trigger.getAttribute("aria-activedescendant")).toBe("custom-select-opt-0");
      });

      it("selects the focused option via Enter, updating the selected value", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();

        // ArrowDown twice navigates from main (index 0) to feature-x (index 1)
        await user.keyboard("{ArrowDown}{ArrowDown}");
        await user.keyboard("{Enter}");

        // Menu closes and the selected value updates
        expect(trigger.getAttribute("data-selected-value")).toBe(
          "/home/x/mullion/.mullion-worktrees/feature-x",
        );
      });

      it("closes the menu via Escape", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();
        await user.keyboard("{ArrowDown}");
        expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();

        await user.keyboard("{Escape}");
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
      });

      it("closes the menu via Tab", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();
        await user.keyboard("{ArrowDown}");
        expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();

        await user.keyboard("{Tab}");
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
      });

      it("navigates up and down through options via arrow keys", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();
        await user.keyboard("{ArrowDown}");

        // Down moves from main (0) to feature-x (1)
        await user.keyboard("{ArrowDown}");
        let focused = document.querySelectorAll(".custom-select-item.focused");
        expect(focused).toHaveLength(1);
        expect(trigger.getAttribute("aria-activedescendant")).toBe("custom-select-opt-1");

        // Up moves back to main (0)
        await user.keyboard("{ArrowUp}");
        focused = document.querySelectorAll(".custom-select-item.focused");
        expect(focused).toHaveLength(1);
        expect(trigger.getAttribute("aria-activedescendant")).toBe("custom-select-opt-0");

        // Up wraps around to last option
        await user.keyboard("{ArrowUp}");
        focused = document.querySelectorAll(".custom-select-item.focused");
        expect(focused).toHaveLength(1);
        expect(trigger.getAttribute("aria-activedescendant")).toBe("custom-select-opt-1");
      });
    });
  });

  // P10 — the monitor header was a bare <div onClick> with no keyboard
  // support, on top of U8's separate "one unconfirmed click kills a running
  // dev server" finding. Same role="button"/tabIndex/Enter-Space pattern as
  // Sidebar.tsx's SessionRow/ProjectHeader.
  describe("P10 — keyboard accessibility", () => {
    // The single-worktree shape `resolveSelectedValue`'s `mainCheckout`
    // needs to resolve `control.cwd`-less launches against the project's
    // own checkout path — without it, `gitBranchesByProject` has no entry
    // for this project (the "not yet fetched" state) and the launched
    // session's cwd falls back to `control.cwd` (unset for these fixtures),
    // i.e. no `cwd` key at all. Explicit here (rather than relying on the
    // "worktree selector" describe block's own MULTI_WORKTREE/MAIN_WORKTREE
    // consts, out of scope from this describe block) since a previous
    // version of this suite let this leak in from whichever earlier test
    // happened to run first — a real cross-test isolation bug resetStore()
    // (test/resetStore.ts) now catches instead of silently passing.
    const SINGLE_WORKTREE: GitBranchesResult = {
      branches: [{ name: "main", isCurrent: true }],
      worktrees: [{ path: "/home/x/mullion", branch: "main", isMain: true }],
      remoteBranches: [],
    };

    it("is a focusable role=button that starts a monitor on Enter", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [],
        createSession,
        deleteSession: vi.fn().mockResolvedValue(undefined),
        gitBranchesByProject: { 1: SINGLE_WORKTREE },
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");
      const header = container.querySelector(".dock-monitor-header") as HTMLElement;
      expect(header).toHaveAttribute("role", "button");
      expect(header).toHaveAttribute("tabIndex", "0");

      header.focus();
      await user.keyboard("{Enter}");

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion",
        kind: "dock",
      });
    });

    it("starts a monitor on Space too", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [],
        createSession,
        deleteSession: vi.fn().mockResolvedValue(undefined),
        gitBranchesByProject: { 1: SINGLE_WORKTREE },
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");
      const header = container.querySelector(".dock-monitor-header") as HTMLElement;

      header.focus();
      await user.keyboard(" ");

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion",
        kind: "dock",
      });
    });

    it("does not double-fire the header's own action when the worktree selector's own trigger is clicked", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const MULTI: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: false },
          { name: "feature-x", isCurrent: true },
        ],
        worktrees: [
          { path: "/home/x/mullion", branch: "main", isMain: true },
          {
            path: "/home/x/mullion/.mullion-worktrees/feature-x",
            branch: "feature-x",
            isMain: false,
          },
        ],
        remoteBranches: [],
      };
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [
          makeSession({
            id: 99,
            command: "npm run dev",
            cwd: "/home/x/mullion",
            kind: "dock",
            activity: "idle",
            sessionStatus: "idle",
            sessionStatusSeverity: "dormant",
          }),
        ],
        createSession,
        deleteSession,
        gitBranchesByProject: { 1: MULTI },
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

      const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
      const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
      await user.click(trigger);

      // A click on the worktree picker's own trigger must not ALSO kill the
      // running monitor via the header's onClick.
      expect(deleteSession).not.toHaveBeenCalled();
    });
  });
});
