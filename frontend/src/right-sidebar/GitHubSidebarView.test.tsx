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
};
const subscribe = vi.fn();
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.mocked(api.getProjectGitHub).mockResolvedValue(status());
  vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(prsStatus([pr(1)]));
  useDashboardStore.setState({
    prsByProject: {},
    prsRefreshTrigger: 0,
    subscribeToGitHubProject: subscribe,
    unsubscribeFromGitHubProject: unsubscribe,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const renderView = () => render(<GitHubSidebarView projectId={4} actions={actions} />);

describe("GitHubSidebarView", () => {
  it("embeds the real GitHub panel: repo, PR cards and issues", async () => {
    const { container } = renderView();

    const repo = await screen.findByRole("link", { name: "o/r" });
    expect(repo.getAttribute("href")).toBe("https://github.com/o/r");
    expect(await screen.findByText("PR title 1")).toBeTruthy();
    // Embedded: the drawer scrolls, not the panel.
    expect(container.querySelector(".github-panel.embedded")).toBeTruthy();
    expect(container.querySelector(".github-panel.cmux-scroll")).toBeNull();
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

  it("subscribes to live updates while mounted and unsubscribes on unmount", async () => {
    const { unmount } = renderView();
    await screen.findByRole("link", { name: "o/r" });

    expect(subscribe).toHaveBeenCalledWith(4);
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledWith(4);
  });
});
