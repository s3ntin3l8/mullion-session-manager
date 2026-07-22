// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "./Dock.js";
import { useDashboardStore } from "./store.js";
import type { GitHubStatus, Project, Session } from "./api.js";

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
  name: "tessera",
  cwd: "/home/x/tessera",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
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

describe("Dock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    dockByProject = {};
    githubByProject = {};
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const match = /^\/api\/projects\/(\d+)\/(dock|github)$/.exec(url);
      if (match && method === "GET") {
        const id = Number(match[1]);
        if (match[2] === "dock") {
          return Promise.resolve(jsonResponse(200, dockByProject[id] ?? []));
        }
        const respond = githubByProject[id];
        return Promise.resolve(respond ? respond() : new Response(null, { status: 204 }));
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

    it("shows a browser-preview row when the project has a devServerUrl, and opens it on click", async () => {
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

    it("hides the browser-preview row when the project has no devServerUrl", async () => {
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

      expect(await screen.findByText("tessera")).toBeInTheDocument();
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

      expect(await screen.findByText("tessera")).toBeInTheDocument();
      expect(screen.getByText("No monitors configured for this project")).toBeInTheDocument();
    });

    it("adds a manual project column via the add-column select and persists it", async () => {
      useDashboardStore.setState({ projects: [PROJECT, PROJECT_2], sessions: [] });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("tessera")).toBeInTheDocument();
      expect(
        screen.queryByText("widgets", { selector: ".dock-column-name" }),
      ).not.toBeInTheDocument();

      const select = document.querySelector(".dock-add-select") as HTMLSelectElement;
      await user.selectOptions(select, "2");

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
        name: null,
        nameLocked: false,
        command: "npm run dev",
        cwd: null,
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
});
