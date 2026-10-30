// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHubSidebarView } from "./GitHubSidebarView.js";
import { useDashboardStore } from "../store/index.js";
import { api } from "../api/index.js";
import type * as ApiModule from "../api/index.js";
import type { GitHubPROrWithChecks, GitHubPRsStatus, GitHubStatus } from "../api/index.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: { ...actual.api, getProjectGitHub: vi.fn(), getProjectGitHubPRs: vi.fn() },
  };
});

const pr = (n: number, over: Partial<GitHubPROrWithChecks> = {}): GitHubPROrWithChecks => ({
  number: n,
  title: `PR title ${n}`,
  htmlUrl: `https://github.com/o/r/pull/${n}`,
  author: "a",
  headSha: "sha",
  headBranch: "feat",
  baseBranch: "main",
  ciStatus: "success",
  actionsRuns: [],
  ...over,
});

const prsStatus = (prs: GitHubPROrWithChecks[]): GitHubPRsStatus => ({
  prs,
  prSummary: { total: prs.length, pass: prs.length, fail: 0, pending: 0, unknown: 0 },
});

const status = (over: Partial<GitHubStatus> = {}): GitHubStatus => ({
  repo: { owner: "o", repo: "r", htmlUrl: "https://github.com/o/r" },
  openIssues: 3,
  issuesHidden: false,
  openPRs: 1,
  pulls: [],
  issues: [],
  actionsRuns: [],
  ciStatus: "failure",
  ...over,
});

const actions = {
  onOpenGit: vi.fn(),
  onOpenGitHub: vi.fn(),
  onOpenFileEditor: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenAgentRules: vi.fn(),
  onOpenProjectBriefing: vi.fn(),
  onOpenProjectSetup: vi.fn(),
  onOpenDockConfig: vi.fn(),
  onOpenSkills: vi.fn(),
  onOpenTasks: vi.fn(),
};
const subscribe = vi.fn();
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.mocked(api.getProjectGitHub).mockResolvedValue(status());
  vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(prsStatus([pr(1)]));
  useDashboardStore.setState({
    prsByProject: {},
    prsRefreshTriggerByProject: {},
    subscribeToGitHubProject: subscribe,
    unsubscribeFromGitHubProject: unsubscribe,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const renderView = (projectId = 4) =>
  render(<GitHubSidebarView projectId={projectId} actions={actions} />);

describe("GitHubSidebarView", () => {
  it("embeds the real GitHub panel: repo, PR cards and issues", async () => {
    const { container } = renderView();

    // The toolbar owns the GitHub link; the panel's own header does not repeat it.
    const repo = await screen.findByRole("button", { name: "Open repository on GitHub" });
    expect(repo).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open repository on GitHub" })).toBeNull();
    expect(await screen.findByText("PR title 1")).toBeTruthy();
    // Embedded: the drawer scrolls, not the panel.
    expect(container.querySelector(".github-panel.embedded")).toBeTruthy();
    expect(container.querySelector(".github-panel.cmux-scroll")).toBeNull();
  });

  it("drops the repo card in the sidebar and keeps the open-PR count on the section", async () => {
    const { container } = renderView();
    await screen.findByText("PR title 1");
    expect(container.querySelector(".sb-vh")).toBeNull();
    expect(screen.queryByText("o/r")).toBeNull();
    expect(screen.queryByText("1 open PR")).toBeNull();
    const header = screen.getByText("Pull requests").closest("button, div")!;
    expect(header.textContent).toContain("1");
  });

  it("falls back to the live status' PRs when the PR cache is empty", async () => {
    vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(null as unknown as GitHubPRsStatus);
    vi.mocked(api.getProjectGitHub).mockResolvedValue(
      status({
        pulls: [
          {
            number: 7,
            title: "Fallback PR",
            htmlUrl: "https://github.com/o/r/pull/7",
            author: "a",
            headBranch: "f",
            baseBranch: "main",
          },
        ] as unknown as GitHubStatus["pulls"],
      }),
    );
    renderView();

    expect(await screen.findByText("Fallback PR")).toBeTruthy();
  });

  it("prefers live PRs from the store over the fetched snapshot", async () => {
    useDashboardStore.setState({ prsByProject: { 4: prsStatus([pr(99, { title: "Live PR" })]) } });
    renderView();

    expect(await screen.findByText("Live PR")).toBeTruthy();
    expect(screen.queryByText("PR title 1")).toBeNull();
  });

  it("the toolbar button opens the full panel for this project", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole("button", { name: "Open GitHub panel" }));
    expect(actions.onOpenGitHub).toHaveBeenCalledWith(4);
  });

  it("the GitHub toolbar button opens the repo, and a different glyph from pop-out", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    renderView();

    const gh = await screen.findByRole("button", { name: "Open repository on GitHub" });
    await user.click(gh);
    expect(open).toHaveBeenCalledWith("https://github.com/o/r", "_blank", "noopener,noreferrer");
    expect(gh.querySelector("svg")?.innerHTML).not.toEqual(
      screen.getByRole("button", { name: "Open GitHub panel" }).querySelector("svg")?.innerHTML,
    );
    open.mockRestore();
  });

  it("subscribes to live updates while mounted and unsubscribes on unmount", async () => {
    const { unmount } = renderView();
    await screen.findByRole("button", { name: "Open repository on GitHub" });

    expect(subscribe).toHaveBeenCalledWith(4);
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledWith(4);
  });

  it.each([
    ["the rail button", () => useDashboardStore.getState().toggleRightSidebarView("github")],
    ["the sidebar toggle", () => useDashboardStore.getState().toggleRightSidebar()],
    ["the close button", () => useDashboardStore.getState().closeRightSidebar()],
  ])(
    "closing the sidebar via %s ends the PR drill-in, so a reopen under project 5 shows its list",
    async (_gesture, close) => {
      useDashboardStore.setState({
        rightSidebarOpen: true,
        rightSidebarView: "github",
        githubOpenPrByProject: { 4: 1 },
        githubOpenIssueByProject: { 4: 2 },
      });
      close();

      expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
      expect(useDashboardStore.getState().githubOpenPrByProject).toEqual({});
      expect(useDashboardStore.getState().githubOpenIssueByProject).toEqual({});

      // Workspace switch: the sidebar is now rendered for project 5.
      useDashboardStore.getState().openRightSidebarView("github", 5);
      renderView(5);
      expect(await screen.findByText("PR title 1")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
    },
  );
});
