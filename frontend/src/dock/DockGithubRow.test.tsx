// @vitest-environment jsdom
// Dock's GitHub status glance row — split out of the former monolithic
// Dock.test.tsx (PR 28, Wave 5 of .claude/plans/can-we-do-a-warm-cocke.md),
// owns every test that exercises DockGithubRow.tsx's own region (and its
// dock/useDockGithubStatus.ts fetch/refetch). Still mounts the full
// `<Dock>` (same reasoning as session-row/Header.test.tsx's own header
// comment) — the row's content comes from a live fetch this file drives
// through a fake in-memory backend, same as the rest of Dock's own suite.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "../Dock.js";
import { useDashboardStore } from "../store/index.js";
import type { GitHubStatus } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject } from "../test/fixtures.js";
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

const STATUS: GitHubStatus = {
  repo: { owner: "acme", repo: "widgets", htmlUrl: "https://github.com/acme/widgets" },
  openIssues: 3,
  openPRs: 2,
  pulls: [],
  issues: [],
  actionsRuns: [],
  ciStatus: null,
};

let dockByProject: Record<number, unknown> = {};
let githubByProject: Record<number, () => Response> = {};
let githubPrsByProject: Record<number, () => Response> = {};

describe("Dock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    dockByProject = {};
    githubByProject = {};
    githubPrsByProject = {};
    ({ fetchMock } = mockFetch({
      "GET /api/projects/:id/github/prs": ({ params }) => {
        const respond = githubPrsByProject[Number(params.id)];
        return respond ? respond() : jsonResponse(204);
      },
      "GET /api/projects/:id/dock": ({ params }) =>
        jsonResponse(200, dockByProject[Number(params.id)] ?? []),
      "GET /api/projects/:id/github": ({ params }) => {
        const respond = githubByProject[Number(params.id)];
        return respond ? respond() : jsonResponse(204);
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ projects: [PROJECT], sessions: [] });
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

  // P12 — Dock.tsx's own GitHub widget used to fetch getProjectGitHub/
  // getProjectGitHubPRs once per projectId and never again, so it went
  // stale the instant a live `/ws/github` push updated the CI/PR counts
  // everywhere else (GitHubPanel.tsx already consumed prsRefreshTrigger for
  // exactly this reason — see that component's identical effect).
  describe("P12 — GitHub widget re-fetches on a live push (prsRefreshTrigger)", () => {
    const PR_SUMMARY_V1 = {
      prs: [],
      prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
    };
    const PR_SUMMARY_V2 = {
      prs: [],
      prSummary: { total: 1, pass: 0, fail: 1, pending: 0, unknown: 0 },
    };

    it("re-fetches getProjectGitHub/getProjectGitHubPRs when prsRefreshTrigger changes for this project", async () => {
      githubByProject[1] = () => jsonResponse(200, STATUS);
      let call = 0;
      githubPrsByProject[1] = () => jsonResponse(200, call++ === 0 ? PR_SUMMARY_V1 : PR_SUMMARY_V2);
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], prsRefreshTrigger: 0 });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      // Initial fetch reflects the V1 summary (1 pass, 0 fail).
      expect(await screen.findByText("1✅ 0❌ 0⏳")).toBeInTheDocument();

      // Simulate store.ts's connectGitHubWS bumping this counter on a live
      // `/ws/github` push for project 1.
      useDashboardStore.setState((s) => ({ prsRefreshTrigger: s.prsRefreshTrigger + 1 }));

      // The widget re-fetches and now reflects the V2 summary (0 pass, 1 fail)
      // — proving the effect actually re-ran rather than the badge simply
      // being stuck on its first render.
      expect(await screen.findByText("0✅ 1❌ 0⏳")).toBeInTheDocument();
    });
  });
});
