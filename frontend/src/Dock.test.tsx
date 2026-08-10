// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "./Dock.js";
import { useDashboardStore } from "./store.js";
import { DEFAULT_SETTINGS } from "./api.js";
import type { GitHubStatus, GitBranchesResult, Project, Session } from "./api.js";

// xterm.js's Terminal.open() reaches for browser APIs jsdom doesn't
// implement (e.g. matchMedia on the owner window) — TerminalPane itself is
// covered elsewhere; here we only need to know DockColumn decided to mount
// it (i.e. a monitor is "running"), not exercise the real terminal.
vi.mock("./TerminalPane.js", () => ({
  TerminalPane: ({ params }: { params: { sessionId: number } }) => (
    <div data-testid="terminal-pane" data-session-id={params.sessionId} />
  ),
}));

// Mirrors Settings.hosts.test.tsx's fake-in-memory-backend pattern — a
// mocked global fetch driving the real request()/store wiring (issue #27).

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT: Project = {
  id: 1,
  name: "mullion",
  cwd: "/home/x/mullion",
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

const PROJECT_2: Project = {
  id: 2,
  name: "widgets",
  cwd: "/home/x/widgets",
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

const STATUS: GitHubStatus = {
  repo: { owner: "acme", repo: "widgets", htmlUrl: "https://github.com/acme/widgets" },
  openIssues: 3,
  openPRs: 2,
  pulls: [],
  issues: [],
  actionsRuns: [],
  ciStatus: null,
};

// Per-project fixtures the fetch mock below serves, keyed by project id —
// defaults to an empty dock + a 204 (no GitHub integration) for any id not
// explicitly listed, so multi-column tests don't need to stub every id.
let dockByProject: Record<number, unknown> = {};
let githubByProject: Record<number, () => Response> = {};
// Issue #73 — POST .../docker/check-update and .../docker/update response
// fixtures, keyed by project id; consulted only by tests that actually
// click a kebab item, so most tests never need to set these.
let checkUpdateByProject: Record<number, unknown> = {};
let updateByProject: Record<number, unknown> = {};

describe("Dock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    dockByProject = {};
    githubByProject = {};
    checkUpdateByProject = {};
    updateByProject = {};
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const getMatch = /^\/api\/projects\/(\d+)\/(dock|github)$/.exec(url);
      if (getMatch && method === "GET") {
        const id = Number(getMatch[1]);
        if (getMatch[2] === "dock") {
          return Promise.resolve(jsonResponse(200, dockByProject[id] ?? []));
        }
        const respond = githubByProject[id];
        return Promise.resolve(respond ? respond() : new Response(null, { status: 204 }));
      }
      const dockerMatch = /^\/api\/projects\/(\d+)\/docker\/(check-update|update)$/.exec(url);
      if (dockerMatch && method === "POST") {
        const id = Number(dockerMatch[1]);
        const body =
          dockerMatch[2] === "check-update" ? checkUpdateByProject[id] : updateByProject[id];
        return Promise.resolve(jsonResponse(dockerMatch[2] === "update" ? 201 : 200, body ?? {}));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe("GitHub / browser widgets (single column)", () => {
    it("renders nothing when the endpoint 204s (no remote/no token configured)", async () => {
      githubByProject[1] = () => new Response(null, { status: 204 });
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/projects/1/github", expect.anything()),
      );
      expect(screen.queryByTitle(/Open GitHub panel/)).not.toBeInTheDocument();
    });

    it("shows the repo, issue count, and PR count once the status loads", async () => {
      githubByProject[1] = () => jsonResponse(200, STATUS);
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("acme/widgets")).toBeInTheDocument();
      expect(screen.getByText("3 issues")).toBeInTheDocument();
      expect(screen.getByText("2 PRs")).toBeInTheDocument();
    });

    it("opens the GitHub panel for the current project when clicked", async () => {
      githubByProject[1] = () => jsonResponse(200, STATUS);
      const onOpenGitHub = vi.fn();
      const user = userEvent.setup();
      render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={onOpenGitHub} onOpenBrowser={vi.fn()} />,
      );

      const row = await screen.findByText("acme/widgets");
      await user.click(row);

      expect(onOpenGitHub).toHaveBeenCalledWith(1);
    });

    it("shows the dev server URL when the project has a devServerUrl (no monitors), and opens it on click", async () => {
      githubByProject[1] = () => new Response(null, { status: 204 });
      useDashboardStore.setState({
        projects: [{ ...PROJECT, devServerUrl: "5173" }],
        sessions: [],
      });
      const onOpenBrowser = vi.fn();
      const user = userEvent.setup();
      render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={onOpenBrowser} />,
      );

      const row = await screen.findByText("5173");
      await user.click(row);

      expect(onOpenBrowser).toHaveBeenCalledWith(1);
    });

    it("shows the dev server URL inside each monitor header when configured", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      useDashboardStore.setState({
        projects: [{ ...PROJECT, devServerUrl: "5173" }],
        sessions: [],
      });
      const onOpenBrowser = vi.fn();
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={onOpenBrowser} />,
      );

      await screen.findByText("Dev server");

      const urlBadge = container.querySelector(".dock-monitor-url") as HTMLElement;
      expect(urlBadge).toBeInTheDocument();
      expect(urlBadge).toHaveTextContent("5173");
      expect(urlBadge.closest(".dock-monitor-header")).toBeInTheDocument();
      await user.click(urlBadge);
      expect(onOpenBrowser).toHaveBeenCalledWith(1);
    });

    it("hides the dev server URL when the project has no devServerUrl", async () => {
      githubByProject[1] = () => new Response(null, { status: 204 });
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/projects/1/github", expect.anything()),
      );
      expect(screen.queryByTitle(/Open browser preview/)).not.toBeInTheDocument();
    });

    it("shows no CI dot when ciStatus is null (Actions disabled/no runs)", async () => {
      githubByProject[1] = () => jsonResponse(200, STATUS);
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("acme/widgets");
      expect(document.querySelector(".github-panel-ci-dot")).not.toBeInTheDocument();
    });

    it("shows a CI dot reflecting ciStatus once Actions data is present", async () => {
      githubByProject[1] = () => jsonResponse(200, { ...STATUS, ciStatus: "failure" });
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("acme/widgets");
      const dot = document.querySelector(".github-panel-ci-dot");
      expect(dot).toBeInTheDocument();
      expect(dot).toHaveClass("bad");
      expect(dot).toHaveAttribute("title", "CI: failure");
    });
  });

  describe("columns", () => {
    it("renders one column per workspace project", async () => {
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      render(<Dock workspaceProjectIds={[1, 2]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("mullion")).toBeInTheDocument();
      expect(await screen.findByText("widgets")).toBeInTheDocument();
      expect(document.querySelectorAll(".dock-column")).toHaveLength(2);
    });

    it("shows the empty-workspace placeholder when no projects are tiled", () => {
      render(<Dock workspaceProjectIds={[]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(screen.getByText("No projects tiled in this workspace yet")).toBeInTheDocument();
      expect(document.querySelectorAll(".dock-column")).toHaveLength(0);
    });

    it("still shows a column (with its empty-monitors placeholder) for a project with no dock.json", async () => {
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("mullion")).toBeInTheDocument();
      expect(screen.getByText("No monitors configured for this project")).toBeInTheDocument();
    });

    it("adds a manual project column via the add-column select and persists it", async () => {
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("mullion")).toBeInTheDocument();
      expect(
        screen.queryByText("widgets", { selector: ".dock-column-name" }),
      ).not.toBeInTheDocument();

      const wrapper = document.querySelector(".dock-add-select") as HTMLElement;
      await user.click(wrapper.querySelector(".custom-select-trigger")!);
      await user.click(screen.getByText("widgets"));

      expect(
        await screen.findByText("widgets", { selector: ".dock-column-name" }),
      ).toBeInTheDocument();
      expect(localStorage.getItem("crs.dockManualProjects")).toBe("[2]");
    });

    it("dedupes a manually-added project that also enters the workspace, dropping its remove button", async () => {
      localStorage.setItem("crs.dockManualProjects", "[2]");
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      render(<Dock workspaceProjectIds={[1, 2]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("widgets", { selector: ".dock-column-name" });
      expect(document.querySelectorAll(".dock-column")).toHaveLength(2);
      expect(document.querySelector(".dock-column-remove")).not.toBeInTheDocument();
    });

    it("removes a manual-only column when its remove button is clicked", async () => {
      localStorage.setItem("crs.dockManualProjects", "[2]");
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("widgets", { selector: ".dock-column-name" });
      const removeBtn = document.querySelector(".dock-column-remove") as HTMLButtonElement;
      await user.click(removeBtn);

      await waitFor(() =>
        expect(
          screen.queryByText("widgets", { selector: ".dock-column-name" }),
        ).not.toBeInTheDocument(),
      );
      expect(localStorage.getItem("crs.dockManualProjects")).toBe("[]");
    });
  });

  describe("collapse", () => {
    it("hides the resize handle and columns while collapsed, and persists the flag", async () => {
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(document.querySelector(".dock-resize-handle")).toBeInTheDocument();

      await user.click(screen.getByTitle("Collapse dock"));

      expect(document.querySelector(".dock-resize-handle")).not.toBeInTheDocument();
      expect(document.querySelector(".dock-columns")).not.toBeInTheDocument();
      expect(localStorage.getItem("crs.dockCollapsed")).toBe("1");
    });
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

      const runningSession: Session = {
        id: 99,
        projectId: 1,
        parentSessionId: null,
        name: null,
        nameLocked: false,
        command: "npm run dev",
        cwd: null,
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
      };
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

    it("disables both kebab items for a build-only service", async () => {
      dockByProject[1] = [
        dockerControl({ docker: { ...dockerControl().docker, buildOnly: true } }),
      ];
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(document.querySelector(".kebab-trigger-btn")!);

      await screen.findByText("Check for update");
      const checkBtn = screen.getByText("Check for update").closest("button");
      const pullBtn = screen.getByText("Pull & restart stack").closest("button");
      expect(checkBtn).toBeDisabled();
      expect(pullBtn).toBeDisabled();
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

      const runningSession: Session = {
        id: 99,
        projectId: 1,
        parentSessionId: null,
        name: null,
        nameLocked: false,
        command: "npm run dev",
        cwd: "/home/x/mullion/.mullion-worktrees/feature-x",
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
      };
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

      const runningSession: Session = {
        id: 99,
        projectId: 1,
        parentSessionId: null,
        name: null,
        nameLocked: false,
        command: "npm run dev",
        cwd: "/home/x/mullion",
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
      };
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
});
