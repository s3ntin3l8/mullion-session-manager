// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  it("shows repo, default-branch CI, issue count and PRs with their CI state", async () => {
    vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(
      prsStatus([pr(1), pr(2, { ciStatus: "failure" }), pr(3, { ciStatus: null })]),
    );
    const { container } = renderView();

    const repo = await screen.findByRole("link", { name: "o/r" });
    expect(repo.getAttribute("href")).toBe("https://github.com/o/r");
    expect(screen.getByText("3 issues")).toBeTruthy();
    expect(container.querySelector('[title="Default branch CI: failure"]')?.className).toContain(
      "bad",
    );

    const rows = await screen.findAllByRole("link", { name: /PR title/ });
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector(".github-panel-ci-dot.good")).toBeTruthy();
    expect(rows[1].querySelector(".github-panel-ci-dot.bad")).toBeTruthy();
    // A PR with no CI status shows no dot at all.
    expect(rows[2].querySelector(".github-panel-ci-dot")).toBeNull();
    expect(rows[0].getAttribute("href")).toBe("https://github.com/o/r/pull/1");
  });

  it("uses the singular for exactly one issue", async () => {
    vi.mocked(api.getProjectGitHub).mockResolvedValue(status({ openIssues: 1, ciStatus: null }));
    const { container } = renderView();

    expect(await screen.findByText("1 issue")).toBeTruthy();
    // No Actions runs: no CI dot at all, not a neutral one.
    expect(container.querySelector(".source-control-branch-row .github-panel-ci-dot")).toBeNull();
  });

  it("prefers live PRs from the store over the fetched snapshot", async () => {
    useDashboardStore.setState({ prsByProject: { 4: prsStatus([pr(99, { title: "Live PR" })]) } });
    renderView();

    expect(await screen.findByText("Live PR")).toBeTruthy();
    await waitFor(() => expect(api.getProjectGitHubPRs).toHaveBeenCalled());
    expect(screen.queryByText("PR title 1")).toBeNull();
  });

  it("caps the list and points at the rest", async () => {
    vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(
      prsStatus(Array.from({ length: 11 }, (_, i) => pr(i + 1))),
    );
    renderView();

    expect(await screen.findAllByRole("link", { name: /PR title/ })).toHaveLength(8);
    expect(screen.getByText("+3 more")).toBeTruthy();
  });

  it("says so when there are no open PRs", async () => {
    vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(prsStatus([]));
    renderView();

    expect(await screen.findByText("No open pull requests")).toBeTruthy();
  });

  it("degrades to a note (still offering the full panel) when GitHub has nothing to show", async () => {
    vi.mocked(api.getProjectGitHub).mockResolvedValue(null as unknown as GitHubStatus);
    vi.mocked(api.getProjectGitHubPRs).mockResolvedValue(null as unknown as GitHubPRsStatus);
    const user = userEvent.setup();
    renderView();

    expect(await screen.findByText(/No GitHub status/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open GitHub Panel" }));
    expect(actions.onOpenGitHub).toHaveBeenCalledWith(4);
  });

  it("opens the full panel for this project", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByRole("button", { name: "Open GitHub Panel" }));
    expect(actions.onOpenGitHub).toHaveBeenCalledWith(4);
  });

  it("subscribes to live updates while mounted and unsubscribes on unmount", async () => {
    const { unmount } = renderView();
    await screen.findByRole("button", { name: "Open GitHub Panel" });

    expect(subscribe).toHaveBeenCalledWith(4);
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledWith(4);
  });
});
