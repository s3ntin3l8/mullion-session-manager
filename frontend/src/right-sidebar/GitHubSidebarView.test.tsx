// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHubSidebarView } from "./GitHubSidebarView.js";
import { useDashboardStore } from "../store/index.js";
import { api } from "../api/index.js";
import type * as ApiModule from "../api/index.js";
import type {
  GitHubPROrWithChecks,
  GitHubPRsStatus,
  GitHubStatus,
  ProjectReleaseStatus,
} from "../api/index.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getProjectGitHub: vi.fn(),
      getProjectGitHubPRs: vi.fn(),
      getProjectRelease: vi.fn(),
      getProjectIssues: vi.fn(),
    },
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
  onOpenDevice: vi.fn(),
  onOpenRailBrowser: vi.fn(),
};
const subscribe = vi.fn();
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.mocked(api.getProjectGitHub).mockResolvedValue(status());
  vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(prsStatus([pr(1)]));
  vi.mocked(api.getProjectRelease).mockResolvedValue(null as unknown as ProjectReleaseStatus);
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
  it("toolbar Refresh button calls refreshGithubProject for the selected project", async () => {
    const refresh = vi.fn();
    useDashboardStore.setState({ refreshGithubProject: refresh });
    renderView(4);
    await screen.findByText("PR title 1");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledWith(4);
  });

  it("embeds the real GitHub panel: repo, PR cards and issues", async () => {
    const { container } = renderView();

    // The header's ⋯ menu owns the GitHub link; the panel's own header does not repeat it.
    expect(await screen.findByText("PR title 1")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Open repository on GitHub" })).toBeTruthy();
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
    // The count lives in the header strip, once, not in a repo card.
    expect(screen.getAllByText("1 open PR")).toHaveLength(1);
    expect(container.querySelector(".sb-strip")).toHaveTextContent("GitHub1 open PR");
    const header = screen.getByText("Pull requests").closest("button, div")!;
    expect(header.textContent).toContain("1");
  });

  it("counts the PRs the panel lists, leaving the release PR to the Release section", async () => {
    vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(prsStatus([pr(1), pr(2)]));
    vi.mocked(api.getProjectRelease).mockResolvedValue({
      detection: { kind: "not-configured" },
      pr: { number: 2, title: "chore: release", htmlUrl: "https://github.com/o/r/pull/2" },
      conventionalTitlesWarning: false,
    } as unknown as ProjectReleaseStatus);
    const { container } = renderView();
    await screen.findByText("PR title 1");
    await vi.waitFor(() =>
      expect(container.querySelector(".sb-strip")).toHaveTextContent("GitHub1 open PR"),
    );
    expect(screen.queryByText("2 open PRs")).toBeNull();
  });

  it("returns focus to the row that opened a PR when it closes", async () => {
    useDashboardStore.setState({ githubOpenPrByProject: { 4: 1 } });
    renderView();
    // The detail (not the loading skeleton) is up, and nothing in it is the row.
    await screen.findByRole("button", { name: "Back" });
    expect(screen.queryByText("PR title 1")).toBeNull();
    act(() => useDashboardStore.getState().setGithubOpenPr(4, null));
    const title = await screen.findByText("PR title 1");
    expect(document.activeElement).toBe(title.closest("button"));
    expect(document.activeElement).toHaveAttribute("data-row-key", "pr:1");
  });

  it("returns focus to the row that opened an issue when it closes", async () => {
    vi.mocked(api.getProjectIssues).mockResolvedValue({
      issues: [
        {
          number: 7,
          title: "Crash on start",
          htmlUrl: "https://github.com/o/r/issues/7",
          author: "x",
          labels: [],
          assignees: [],
          commentCount: 0,
          milestone: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
      page: 1,
      hasMore: false,
      labels: [],
      taskMasterEnabled: false,
      taskLabel: "mullion-task",
    } as unknown as Awaited<ReturnType<typeof api.getProjectIssues>>);
    useDashboardStore.setState({ githubOpenIssueByProject: { 4: 7 } });
    renderView();
    await screen.findByRole("button", { name: "Back" });
    act(() => useDashboardStore.getState().setGithubOpenIssue(4, null));
    const title = await screen.findByText("Crash on start");
    expect(document.activeElement).toBe(title.closest("button"));
    expect(document.activeElement).toHaveAttribute("data-row-key", "issue:7");
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

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Open GitHub panel" }));
    expect(actions.onOpenGitHub).toHaveBeenCalledWith(4);
  });

  it("the ⋯ menu opens the repo on GitHub", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    renderView();

    await screen.findByText("PR title 1");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Open repository on GitHub" }));
    expect(open).toHaveBeenCalledWith("https://github.com/o/r", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("subscribes to live updates while mounted and unsubscribes on unmount", async () => {
    const { unmount } = renderView();
    await screen.findByText("PR title 1");

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

  it("filters PRs by who is working them, only while Task Master is on", async () => {
    vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(
      prsStatus([pr(1), pr(2, { taskId: 7, taskStatus: "reviewing" } as never)]),
    );
    useDashboardStore.setState({ taskMasterEnabled: true });
    const user = userEvent.setup();
    const { unmount } = renderView();
    await screen.findByText("PR title 1");
    expect(screen.getByText("PR title 2")).toBeTruthy();

    const prFilter = screen.getByRole("group", { name: "Filter pull requests" });
    await user.click(within(prFilter).getByRole("button", { name: "Task Master" }));
    expect(screen.queryByText("PR title 1")).toBeNull();
    expect(screen.getByText("PR title 2")).toBeTruthy();

    // Manual is "not Task Master's": the human PR stays with no live session on it.
    await user.click(within(prFilter).getByRole("button", { name: "Manual" }));
    expect(screen.getByText("PR title 1")).toBeTruthy();
    expect(screen.queryByText("PR title 2")).toBeNull();
    unmount();

    // Turning Task Master off removes the control and must drop the filter with it.
    useDashboardStore.setState({ taskMasterEnabled: false });
    renderView();
    await screen.findByText("PR title 1");
    expect(screen.queryByRole("group", { name: "Filter pull requests" })).toBeNull();
    expect(screen.getByText("PR title 2")).toBeTruthy();
  });

  it("marks a PR that needs attention and a Task Master PR by their row edges", async () => {
    vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(
      prsStatus([
        pr(1, { prPhase: "ci_failing" } as never),
        pr(2, { taskId: 7, taskStatus: "reviewing" } as never),
      ]),
    );
    renderView();
    await screen.findByText("PR title 1");
    const rows = Array.from(document.querySelectorAll(".sb-row"));
    const row = (title: string) => rows.find((r) => r.textContent?.includes(title));
    expect(row("PR title 1")?.className).toContain("sb-row--attn");
    expect(row("PR title 2")?.className).toContain("sb-row--tm");
  });
});

describe("GitHubSidebarView Refresh feedback", () => {
  const realRefresh = useDashboardStore.getState().refreshGithubProject;
  const realInFlight = useDashboardStore.getState().githubInFlight;

  beforeEach(() => {
    vi.useFakeTimers();
    useDashboardStore.setState({
      refreshGithubProject: realRefresh,
      githubInFlight: realInFlight,
      githubCache: {},
    });
  });
  afterEach(() => vi.useRealTimers());

  const button = () => screen.getByRole("button", { name: "Refresh" });
  const mount = async () => {
    renderView(4);
    await act(async () => {});
  };

  it("spins until the project's in-flight requests settle, then clears", async () => {
    let finish: () => void = () => {};
    const request = new Promise<void>((resolve) => (finish = resolve));
    let inFlight = [request as Promise<unknown>];
    useDashboardStore.setState({
      refreshGithubProject: vi.fn(),
      githubInFlight: () => inFlight,
    });
    await mount();
    expect(button()).not.toHaveAttribute("aria-busy");

    fireEvent.click(button());
    expect(button()).toHaveAttribute("aria-busy", "true");
    expect(button()).toHaveAttribute("aria-disabled", "true");

    // Past the minimum but the request is still in flight: stays busy.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(button()).toHaveAttribute("aria-busy", "true");

    inFlight = [];
    await act(async () => {
      finish();
    });
    expect(button()).not.toHaveAttribute("aria-busy");
  });

  it("ignores a click while busy and keeps focus on the button", async () => {
    const refresh = vi.fn();
    useDashboardStore.setState({
      refreshGithubProject: refresh,
      githubInFlight: () => [new Promise<unknown>(() => {})],
    });
    await mount();
    button().focus();
    fireEvent.click(button());
    fireEvent.click(button());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(button()).toBe(document.activeElement);
  });

  it("is not held by a stale key nothing consumes (a hover-prefetched PR)", async () => {
    // Real refreshGithubProject marks every key stale; 4:pr:12 has no mounted consumer.
    useDashboardStore.setState({
      githubCache: { "4:pr:12": { data: null, fetchedAt: 1, error: null } },
    });
    await mount();
    fireEvent.click(button());
    expect(button()).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(button()).not.toHaveAttribute("aria-busy");
  });

  it("never sticks: clears after the cap when a request never settles", async () => {
    useDashboardStore.setState({
      refreshGithubProject: vi.fn(),
      githubInFlight: () => [new Promise<unknown>(() => {})],
    });
    await mount();
    fireEvent.click(button());
    expect(button()).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(button()).not.toHaveAttribute("aria-busy");
  });

  it("shows busy for a minimum moment even when nothing is in flight", async () => {
    useDashboardStore.setState({ refreshGithubProject: vi.fn(), githubInFlight: () => [] });
    await mount();
    fireEvent.click(button());
    expect(button()).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(button()).not.toHaveAttribute("aria-busy");
  });
});
