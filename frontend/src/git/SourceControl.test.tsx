// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitSidebarView } from "../right-sidebar/GitSidebarView.js";
import { HistorySidebarView } from "../right-sidebar/HistorySidebarView.js";
import { useDashboardStore } from "../store/index.js";
import { api } from "../api/index.js";
import type * as ApiModule from "../api/index.js";
import type {
  GitBranchDetail,
  GitBranchInfo,
  GitBranchPruneResult,
  GitBranchesResult,
  GitHubPROrWithChecks,
} from "../api/types.js";
import { makeHost, makeProject, makeSession, makeTask } from "../test/fixtures.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getProjectGitBranches: vi.fn(),
      getProjectGitBranch: vi.fn(),
      pruneProjectGitBranches: vi.fn(),
      deleteProjectGitBranch: vi.fn(),
      checkoutProjectGitBranch: vi.fn(),
      createProjectGitBranch: vi.fn(),
      rebaseProjectGitBranch: vi.fn(),
      removeProjectGitWorktree: vi.fn(),
      pruneProjectGitWorktrees: vi.fn(),
      getProjectGitStatus: vi.fn(),
      getProjectGitFileDiff: vi.fn(),
      getProjectGitLog: vi.fn(),
      postProjectGitFetch: vi.fn(),
      postProjectGitPull: vi.fn(),
      postProjectGitHealth: vi.fn(),
      postProjectGitRepair: vi.fn(),
      listProjectActions: vi.fn(),
      createProjectPreview: vi.fn(),
      createBranchPreview: vi.fn(),
      getServerInfo: vi.fn().mockResolvedValue({ previewsEnabled: false }),
    },
  };
});

const m = vi.mocked(api);
const actions = {
  onOpenGit: vi.fn(),
  onOpenFile: vi.fn(),
} as never;

const branch = (name: string, over: Partial<GitBranchInfo> = {}): GitBranchInfo => ({
  name,
  isCurrent: false,
  lastCommitRelative: "2 days ago",
  ...over,
});

const refs = (over: Partial<GitBranchesResult> = {}): GitBranchesResult => ({
  branches: [
    branch("main", { isCurrent: true, lastCommitRelative: "1 hour ago" }),
    branch("feat/open", { ahead: 2, lastCommitRelative: "3 hours ago" }),
    branch("mullion/task-7-x", { lastCommitRelative: "1 day ago" }),
    branch("old-done", { mergeState: "pr-merged", pr: { number: 5, state: "merged", url: "u" } }),
    branch("sq", { mergeState: "pr-merged", pr: { number: 6, state: "merged", url: "u" } }),
    branch("gone-one", { mergeState: "upstream-gone", behind: 4 }),
    branch("misc"),
  ],
  worktrees: [
    { path: "/repo", branch: "main", isMain: true },
    { path: "/repo/.wt/old-done", branch: "old-done", isMain: false },
    { path: "/repo/.wt/feat-open", branch: "feat/open", isMain: false },
    { path: "/repo/.mullion-worktrees/dock-preview-abc", branch: null, isMain: false },
  ],
  remoteBranches: [],
  defaultBranch: "origin/main",
  ...over,
});

const openPr: GitHubPROrWithChecks = {
  number: 11,
  title: "t",
  htmlUrl: "https://github.com/o/r/pull/11",
  author: null,
  headSha: "x",
  headBranch: "feat/open",
  baseBranch: "main",
  ciStatus: "failure",
  actionsRuns: [],
  prPhase: "ci_failing",
  reviewDecision: "REVIEW_REQUIRED",
};

const detail = (over: Partial<GitBranchDetail> = {}): GitBranchDetail => ({
  name: "feat/open",
  sha: "a".repeat(40),
  upstream: "origin/feat/open",
  upstreamAhead: 1,
  upstreamBehind: 0,
  base: "origin/main",
  baseAhead: 2,
  baseBehind: 4,
  uniqueCommits: [
    { sha: "b".repeat(40), time: 1_700_000_000, author: "me", subject: "do the thing" },
  ],
  uniqueTruncated: false,
  lastCommit: null,
  isCurrent: false,
  mergeState: null,
  pr: null,
  worktreePath: null,
  taskId: null,
  ...over,
});

function seed(over: Record<string, unknown> = {}) {
  useDashboardStore.setState({
    previews: [],
    openPreviewRequest: null,
    projects: [makeProject({ id: 1, name: "proj", cwd: "/repo" })],
    sessions: [],
    tasks: [],
    hosts: [],
    gitStatuses: {
      1: {
        branch: "main",
        hash: "abc1234",
        ahead: 0,
        behind: 3,
        files: [
          { path: "src/a.ts", status: "M" },
          { path: "new.txt", status: "?" },
        ],
        isClean: false,
        hasConflicts: false,
      },
    },
    gitProblems: {},
    prsByProject: {
      1: {
        prs: [openPr],
        prSummary: { total: 1, pass: 0, fail: 1, pending: 0, unknown: 0 },
      },
    },
    ...over,
  } as never);
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  m.getProjectGitBranches.mockResolvedValue(refs());
  m.getProjectGitStatus.mockResolvedValue(undefined);
  m.getProjectGitFileDiff.mockResolvedValue({ patch: "@@ -1 +1 @@\n-old\n+new" } as never);
  seed();
});
afterEach(() => vi.useRealTimers());

/** The branch list has rendered (names also appear in the worktree rows). */
const ready = () => screen.findByRole("group", { name: "Current" });

const renderView = () => render(<GitSidebarView projectId={1} actions={actions} />);

/** The row (SidebarRow root) a branch name sits in. */
const rowOf = (name: string) =>
  screen.getByRole("button", { name }).closest(".sb-row") as HTMLElement;

describe("Source Control header", () => {
  it("shows branch, ahead/behind, changes and the repo link", async () => {
    renderView();
    await ready();
    const strip = document.querySelector(".sb-strip") as HTMLElement;
    expect(within(strip).getByText("Source Control")).toBeInTheDocument();
    expect(strip).toHaveTextContent("main");
    expect(strip).toHaveTextContent("↓3");
    expect(strip).toHaveTextContent("2 changed");
    // The repo link sits behind the header's ⋯ menu.
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Open repository on GitHub" }));
    expect(open).toHaveBeenCalledWith("https://github.com/o/r", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("fetches, then pulls, refreshing the status", async () => {
    m.postProjectGitFetch.mockResolvedValue({ success: true });
    m.postProjectGitPull.mockResolvedValue({ pulled: true } as never);
    m.getProjectGitStatus.mockResolvedValue({
      branch: "main",
      hash: "x",
      ahead: 0,
      behind: 0,
      files: [],
      isClean: true,
      hasConflicts: false,
    });
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /^Pull/ }));
    await waitFor(() => expect(m.postProjectGitPull).toHaveBeenCalledWith(1));
    await waitFor(() => expect(m.getProjectGitStatus).toHaveBeenCalledWith(1, { fresh: true }));
    await userEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(m.postProjectGitFetch).toHaveBeenCalledWith(1));
  });

  it("explains a refused pull and a failed fetch", async () => {
    m.postProjectGitFetch.mockRejectedValue(new Error("offline"));
    m.postProjectGitPull.mockResolvedValue({ pulled: false, reason: "dirty-tree" } as never);
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /^Pull/ }));
    expect(await screen.findByText(/uncommitted changes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fetch" }));
    expect(await screen.findByText("offline")).toBeInTheDocument();
  });

  it("toggles auto-fetch and resets an override", async () => {
    const toggleAutoFetch = vi.fn(async () => undefined);
    seed({
      projects: [makeProject({ id: 1, name: "proj", cwd: "/repo", autoFetch: true })],
      toggleAutoFetch,
    });
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(toggleAutoFetch).toHaveBeenCalledWith(1, null);
    await userEvent.click(screen.getByRole("button", { name: "Auto-fetch", pressed: true }));
    expect(toggleAutoFetch).toHaveBeenCalledWith(1, false);
  });
});

describe("Changes", () => {
  it("lists files, expands an inline diff and opens the editor", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "a.ts" }));
    expect(await screen.findByText("+new")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit src/a.ts" }));
    expect((actions as { onOpenFile: ReturnType<typeof vi.fn> }).onOpenFile).toHaveBeenCalledWith(
      1,
      "src/a.ts",
    );
  });

  it("says when the tree is clean or the project is not a repo", async () => {
    seed({
      gitStatuses: {
        1: {
          branch: "main",
          hash: null,
          ahead: 0,
          behind: 0,
          files: [],
          isClean: true,
          hasConflicts: false,
        },
      },
    });
    const { unmount } = renderView();
    expect(await screen.findByText("Working tree clean")).toBeInTheDocument();
    unmount();
    seed({ gitStatuses: { 1: null } });
    renderView();
    expect(await screen.findByText("Not a git repository.")).toBeInTheDocument();
  });
});

describe("Branches", () => {
  it("groups Current · With open PR · Task branches · Prunable · Other", async () => {
    renderView();
    await ready();
    const titles = screen
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-label"))
      .filter(Boolean);
    expect(titles.slice(0, 5)).toEqual([
      "Current",
      "With open PR",
      "Task branches",
      "Prunable",
      "Other",
    ]);
    expect(
      within(screen.getByRole("group", { name: "Current" })).getByText("main"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "With open PR" })).getByText("feat/open"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Task branches" })).getByText("mullion/task-7-x"),
    ).toBeInTheDocument();
    const prunable = screen.getByRole("group", { name: "Prunable" });
    expect(within(prunable).getByText("sq")).toBeInTheDocument();
    // Checked out in a worktree: the prune would skip it, so it is not offered.
    expect(within(prunable).queryByText("old-done")).toBeNull();
    expect(within(prunable).getByText("squash-merged")).toBeInTheDocument();
    expect(within(prunable).getByText("upstream gone")).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Other" })).getByText("misc"),
    ).toBeInTheDocument();
  });

  it("shows the PR chip with its phase, and opens the PR in the GitHub view", async () => {
    const openRightSidebarPr = vi.fn();
    seed({ openRightSidebarPr });
    renderView();
    await ready();
    await userEvent.click(within(rowOf("feat/open")).getByRole("button", { name: /#11/ }));
    expect(openRightSidebarPr).toHaveBeenCalledWith(1, 11);
  });

  it("filters by name and says when nothing matches", async () => {
    renderView();
    await ready();
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter branches" }), "misc");
    expect(screen.queryByRole("button", { name: "feat/open" })).toBeNull();
    expect(screen.getByText("misc")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Filter branches" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter branches" }), "zzz");
    expect(screen.getByText("No branch matches the filter.")).toBeInTheDocument();
  });

  it("lets a task branch be deleted, naming the task whose Retry it breaks", async () => {
    m.deleteProjectGitBranch.mockResolvedValue({ deleted: true });
    seed({
      tasks: [
        makeTask({ id: 7, projectId: 1, branchName: "mullion/task-7-x", status: "in_progress" }),
      ],
    });
    renderView();
    await ready();
    const row = rowOf("mullion/task-7-x");
    expect(within(row).getByText(/#7 · /)).toBeInTheDocument();
    const del = within(row).getByRole("button", { name: /owned by task #7; its Retry will break/ });
    expect(del).toBeEnabled();
    await userEvent.click(del);
    await userEvent.click(within(row).getByRole("button", { name: /click again to confirm/ }));
    await waitFor(() =>
      expect(m.deleteProjectGitBranch).toHaveBeenCalledWith(1, "mullion/task-7-x", true),
    );
  });

  it("renders session pills with status and opens the session", async () => {
    const requestOpenSession = vi.fn();
    seed({
      requestOpenSession,
      sessions: [
        makeSession({
          id: 3,
          projectId: 1,
          name: "worker",
          liveBranch: "feat/open",
          sessionStatusSeverity: "blocked",
          sessionStatusAttentionRequired: true,
        }),
      ],
    });
    renderView();
    await ready();
    const pills = within(rowOf("feat/open")).getByRole("list", { name: "Sessions" });
    expect(within(pills).getByRole("img", { name: "needs attention" })).toBeInTheDocument();
    await userEvent.click(within(pills).getByRole("button", { name: /worker/ }));
    expect(requestOpenSession).toHaveBeenCalledWith(3);
  });

  it("deletes a branch on confirmation and refreshes", async () => {
    m.deleteProjectGitBranch.mockResolvedValue({ deleted: true });
    renderView();
    await ready();
    const del = within(rowOf("misc")).getByRole("button", { name: /^Delete branch/ });
    // Not known to be merged: the tooltip (and so the armed state) says so.
    expect(del).toHaveAttribute("title", expect.stringContaining("may have unmerged commits"));
    await userEvent.click(del);
    expect(m.deleteProjectGitBranch).not.toHaveBeenCalled();
    await userEvent.click(
      within(rowOf("misc")).getByRole("button", { name: /click again to confirm/ }),
    );
    await waitFor(() => expect(m.deleteProjectGitBranch).toHaveBeenCalledWith(1, "misc", true));
    await waitFor(() => expect(m.getProjectGitBranches.mock.calls.length).toBeGreaterThan(1));
  });

  it("explains a refusal inline, with no Force: the delete is already forced", async () => {
    m.deleteProjectGitBranch.mockResolvedValue({
      deleted: false,
      reason: "checked-out",
      detail: "/repo/.wt/misc",
    });
    renderView();
    await ready();
    await userEvent.click(within(rowOf("misc")).getByRole("button", { name: /^Delete branch/ }));
    await userEvent.click(
      within(rowOf("misc")).getByRole("button", { name: /click again to confirm/ }),
    );
    expect(await screen.findByText(/Checked out in another worktree/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force" })).toBeNull();
  });

  it("reports a thrown delete failure on the row", async () => {
    m.deleteProjectGitBranch.mockRejectedValue(new Error("503 unreachable"));
    renderView();
    await ready();
    await userEvent.click(within(rowOf("misc")).getByRole("button", { name: /^Delete branch/ }));
    await userEvent.click(
      within(rowOf("misc")).getByRole("button", { name: /click again to confirm/ }),
    );
    expect(await screen.findByText("503 unreachable")).toBeInTheDocument();
  });

  it("disables delete for the current branch and a worktree branch, with the reason", async () => {
    renderView();
    await ready();
    expect(
      within(rowOf("main")).getByRole("button", { name: "Cannot delete the current branch" }),
    ).toBeDisabled();
    expect(
      within(rowOf("feat/open")).getByRole("button", { name: /Checked out in feat-open/ }),
    ).toBeDisabled();
  });

  // Issue #1672 — guarded checkout / rebase from the row, New branch from the header.
  it("checks out a branch and refreshes; a refusal shows inline with no Force", async () => {
    m.checkoutProjectGitBranch
      .mockResolvedValueOnce({ ok: false, reason: "sessions-active", detail: "4" })
      .mockResolvedValueOnce({ ok: true });
    renderView();
    await ready();
    await userEvent.click(within(rowOf("misc")).getByRole("button", { name: "Check out" }));
    expect(await screen.findByText(/Active session: 4\. .*stop it first/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force" })).toBeNull();

    const loads = m.getProjectGitBranches.mock.calls.length;
    await userEvent.click(within(rowOf("misc")).getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(m.checkoutProjectGitBranch).toHaveBeenLastCalledWith(1, "misc"));
    await waitFor(() => expect(m.getProjectGitBranches.mock.calls.length).toBeGreaterThan(loads));
    expect(screen.queryByText(/stop it first/)).toBeNull();
  });

  it("offers Rebase on the current branch only, and reports an aborted conflict", async () => {
    m.rebaseProjectGitBranch.mockResolvedValue({
      ok: false,
      reason: "conflicts",
      detail: "origin/main",
      conflicts: ["src/a.ts"],
    });
    renderView();
    await ready();
    // The current branch rebases; it has no Check out. A worktree's branch
    // cannot be checked out here.
    expect(within(rowOf("main")).queryByRole("button", { name: "Check out" })).toBeNull();
    expect(
      within(rowOf("feat/open")).getByRole("button", { name: /in use by feat-open/ }),
    ).toBeDisabled();
    await userEvent.click(within(rowOf("main")).getByRole("button", { name: /Rebase onto/ }));
    expect(m.rebaseProjectGitBranch).not.toHaveBeenCalled();
    // Armed, the icon-sized button announces the confirm step in its title.
    await userEvent.click(
      within(rowOf("main")).getByRole("button", { name: /click again to confirm/ }),
    );
    expect(
      await screen.findByText(/onto origin\/main conflicts in src\/a\.ts — aborted/),
    ).toBeInTheDocument();
    expect(m.rebaseProjectGitBranch).toHaveBeenCalledWith(1);
  });

  it("creates a branch from the header form, from the default base", async () => {
    m.createProjectGitBranch
      .mockResolvedValueOnce({ ok: false, reason: "dirty-tree" })
      .mockResolvedValueOnce({ ok: true });
    const pushToast = vi.fn();
    seed({ pushToast });
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "New branch" }));
    const form = screen.getByRole("form", { name: "New branch" });
    expect(within(form).getByLabelText("Start point")).toHaveValue("origin/main");
    expect(within(form).getByRole("button", { name: "Create" })).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("New branch name"), "topic");
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    expect(await within(form).findByText(/uncommitted changes/)).toBeInTheDocument();
    expect(m.createProjectGitBranch).toHaveBeenCalledWith(1, {
      name: "topic",
      from: "origin/main",
      checkout: true,
    });

    await userEvent.click(within(form).getByRole("checkbox", { name: "Switch to it" }));
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New branch" })).toBeNull());
    expect(m.createProjectGitBranch).toHaveBeenLastCalledWith(1, {
      name: "topic",
      from: "origin/main",
      checkout: false,
    });
    expect(pushToast).toHaveBeenCalledWith({ message: "Created topic.", kind: "success" });
  });

  it("cancels the New branch form, and reports a thrown failure", async () => {
    m.createProjectGitBranch.mockRejectedValue(new Error("503 unreachable"));
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "New branch" }));
    const form = screen.getByRole("form", { name: "New branch" });
    await userEvent.type(within(form).getByLabelText("New branch name"), "x");
    await userEvent.click(within(form).getByRole("button", { name: "Create" }));
    expect(await within(form).findByText("503 unreachable")).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New branch" })).toBeNull();
  });

  it("opens a session on the branch, or reports why it can't", async () => {
    const createSession = vi.fn(async () => makeSession({ id: 9 }));
    const requestOpenSession = vi.fn();
    seed({ createSession, requestOpenSession });
    m.listProjectActions.mockResolvedValue([{ id: "agent:claude", command: "claude" }] as never);
    renderView();
    await ready();
    await userEvent.click(
      within(rowOf("misc")).getByRole("button", { name: "Open session on branch" }),
    );
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(1, "claude", { worktree: { branch: "misc" } }),
    );
    expect(requestOpenSession).toHaveBeenCalledWith(9);
    m.listProjectActions.mockResolvedValue([]);
    await userEvent.click(
      within(rowOf("misc")).getByRole("button", { name: "Open session on branch" }),
    );
    expect(
      await screen.findByText("No launcher is configured for this project."),
    ).toBeInTheDocument();
  });

  it("opens History scoped to the branch", async () => {
    renderView();
    await ready();
    await userEvent.click(within(rowOf("misc")).getByRole("button", { name: "View in History" }));
    expect(useDashboardStore.getState().rightSidebarView).toBe("history");
    expect(useDashboardStore.getState().rightSidebarHistoryRequest).toMatchObject({
      projectId: 1,
      scope: "branch:misc",
    });
  });

  it("previews the current branch through the project's checkout preview", async () => {
    seed({ projects: [makeProject({ id: 1, name: "proj", cwd: "/repo", devServerUrl: "5173" })] });
    m.createProjectPreview.mockResolvedValue({ slug: "s1" } as never);
    renderView();
    await ready();
    await userEvent.click(
      within(rowOf("main")).getByRole("button", { name: "Preview this branch" }),
    );
    await waitFor(() =>
      expect(useDashboardStore.getState().openPreviewRequest).toMatchObject({
        projectId: 1,
        slug: "s1",
        branch: "main",
      }),
    );
    expect(m.createBranchPreview).not.toHaveBeenCalled();
  });

  it("starts a branch preview for any other branch, and opens an existing one (#2016)", async () => {
    m.createBranchPreview.mockResolvedValue({ slug: "b1", branch: "feat/open" } as never);
    renderView();
    await ready();
    await userEvent.click(
      within(rowOf("feat/open")).getByRole("button", { name: "Preview this branch" }),
    );
    await waitFor(() => expect(m.createBranchPreview).toHaveBeenCalledWith(1, "feat/open"));
    await waitFor(() =>
      expect(useDashboardStore.getState().openPreviewRequest).toMatchObject({ slug: "b1" }),
    );

    // A known branch preview is asked for again (the call restarts a dead
    // one); a checkout preview that serves the branch just opens.
    act(() =>
      useDashboardStore.setState({
        previews: [
          {
            slug: "b1",
            kind: "project",
            projectId: 1,
            externalUrl: null,
            createdAt: "",
            branch: "feat/open",
            upstreamPort: 4000,
          },
        ],
        openPreviewRequest: null,
      }),
    );
    await userEvent.click(within(rowOf("feat/open")).getByRole("button", { name: "Open preview" }));
    await waitFor(() => expect(m.createBranchPreview).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(useDashboardStore.getState().openPreviewRequest).toMatchObject({ slug: "b1" }),
    );

    act(() =>
      useDashboardStore.setState({
        previews: [
          {
            slug: "checkout",
            kind: "project",
            projectId: 1,
            externalUrl: null,
            createdAt: "",
            branch: "feat/open",
            upstreamPort: null,
          },
        ],
      }),
    );
    // Without a dev server the checkout row would only proxy to a 503: start
    // a branch preview instead.
    await userEvent.click(within(rowOf("feat/open")).getByRole("button", { name: "Open preview" }));
    await waitFor(() => expect(m.createBranchPreview).toHaveBeenCalledTimes(3));

    act(() =>
      useDashboardStore.setState({
        projects: [
          makeProject({ id: 1, name: "proj", cwd: "/repo", devServerUrl: "http://localhost:5173" }),
        ],
        openPreviewRequest: null,
      }),
    );
    await userEvent.click(within(rowOf("feat/open")).getByRole("button", { name: "Open preview" }));
    expect(useDashboardStore.getState().openPreviewRequest).toMatchObject({ slug: "checkout" });
    expect(m.createBranchPreview).toHaveBeenCalledTimes(3);
  });

  it("explains a refused branch preview", async () => {
    const { ApiError } = await import("../api/client.js");
    m.createBranchPreview.mockRejectedValue(new ApiError("no control", 409, "no_preview_control"));
    renderView();
    await ready();
    await userEvent.click(
      within(rowOf("feat/open")).getByRole("button", { name: "Preview this branch" }),
    );
    await waitFor(() =>
      expect(
        useDashboardStore
          .getState()
          .toasts.map((t) => t.message)
          .join(" "),
      ).toMatch(/mark one in Dock config/),
    );
  });
});

describe("Worktrees", () => {
  it("marks dock-preview worktrees auto and merged .wt/ worktrees safe to remove", async () => {
    renderView();
    await ready();
    const section = screen
      .getByRole("button", { name: /^Worktrees/ })
      .closest("section") as HTMLElement;
    expect(within(section).getByText("auto")).toBeInTheDocument();
    const dev = within(section).getByRole("group", { name: "Developer worktrees" });
    expect(within(dev).getByText("safe to remove")).toBeInTheDocument();
    // The open-PR worktree is not merged, so it is not offered for removal.
    expect(within(dev).getAllByText("safe to remove")).toHaveLength(1);
  });

  it("shows the PR phase and live session pills on a worktree", async () => {
    seed({
      sessions: [
        makeSession({
          id: 4,
          projectId: 1,
          name: "wt-sess",
          liveCwd: "/repo/.wt/feat-open",
          liveBranch: "feat/open",
        }),
      ],
    });
    renderView();
    await ready();
    const section = screen
      .getByRole("button", { name: /^Worktrees/ })
      .closest("section") as HTMLElement;
    expect(within(section).getByRole("button", { name: /#11/ })).toBeInTheDocument();
    expect(within(section).getByText("wt-sess")).toBeInTheDocument();
  });

  it("opens a session here, once per click in flight", async () => {
    let resolve!: () => void;
    const createSession = vi.fn(
      () => new Promise((r) => (resolve = () => r(makeSession({ id: 9 })))),
    );
    const requestOpenSession = vi.fn();
    seed({ createSession, requestOpenSession });
    m.listProjectActions.mockResolvedValue([{ id: "agent:claude", command: "claude" }] as never);
    renderView();
    await ready();
    const section = screen
      .getByRole("button", { name: /^Worktrees/ })
      .closest("section") as HTMLElement;
    const here = within(section).getAllByRole("button", {
      name: "Open session here",
    })[2] as HTMLElement;
    await userEvent.click(here);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledWith(1, "claude", { cwd: "/repo/.wt/old-done" });
    await act(async () => resolve());
    await waitFor(() => expect(requestOpenSession).toHaveBeenCalledWith(9));
  });

  it("removes a worktree and force-removes after a dirty refusal", async () => {
    m.removeProjectGitWorktree
      .mockResolvedValueOnce({ removed: false, reason: "dirty" })
      .mockResolvedValueOnce({ removed: true });
    renderView();
    await ready();
    const section = screen
      .getByRole("button", { name: /^Worktrees/ })
      .closest("section") as HTMLElement;
    await userEvent.click(
      within(section).getAllByRole("button", { name: "Remove worktree" })[1] as HTMLElement,
    );
    await userEvent.click(within(section).getByRole("button", { name: /click again to confirm/ }));
    expect(await screen.findByText(/uncommitted changes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Force" }));
    await userEvent.click(screen.getByRole("button", { name: "Force remove" }));
    await waitFor(() =>
      expect(m.removeProjectGitWorktree).toHaveBeenLastCalledWith(1, "/repo/.wt/old-done", true),
    );
  });

  it("prunes stale worktree metadata, and shows a failure", async () => {
    m.pruneProjectGitWorktrees
      .mockResolvedValueOnce({ pruned: true })
      .mockRejectedValueOnce(new Error("prune boom"));
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Prune stale" }));
    await waitFor(() => expect(m.pruneProjectGitWorktrees).toHaveBeenCalledWith(1));
    await userEvent.click(screen.getByRole("button", { name: "Prune stale" }));
    expect(await screen.findByText("prune boom")).toBeInTheDocument();
  });
});

describe("Prune preview", () => {
  const plan = (over: Partial<GitBranchPruneResult> = {}): GitBranchPruneResult => ({
    dryRun: true,
    candidates: [
      { name: "old-done", reason: "pr-merged" },
      { name: "gone-one", reason: "upstream-gone" },
      { name: "anc", reason: "ancestor" },
    ],
    skipped: [
      { name: "feat/open", why: "worktree" },
      { name: "mullion/task-7-x", why: "task-claimed" },
    ],
    deleted: [],
    failed: [],
    ...over,
  });

  async function openPrune() {
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Prune…" }));
    await screen.findByText("Will delete");
  }

  it("lists candidates with reasons and the skipped branches with why", async () => {
    m.pruneProjectGitBranches.mockResolvedValue(plan());
    await openPrune();
    expect(m.pruneProjectGitBranches).toHaveBeenCalledWith(1, { dryRun: true });
    expect(screen.getByText("Prune merged branches")).toBeInTheDocument();
    expect(screen.getByText("Local only · remotes are never touched")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByText("checked out in a worktree")).toBeInTheDocument();
    expect(screen.getByText("owned by a Task Master task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete 3 branches" })).toBeEnabled();
  });

  it("deletes exactly the ticked names and reports failures", async () => {
    m.pruneProjectGitBranches.mockResolvedValueOnce(plan()).mockResolvedValueOnce(
      plan({
        dryRun: false,
        deleted: ["old-done"],
        failed: [{ name: "gone-one", why: "task-claimed" }],
      }),
    );
    await openPrune();
    await userEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByRole("button", { name: "Delete 0 branches" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /^anc/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete 2 branches" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete 2" }));
    await waitFor(() =>
      expect(m.pruneProjectGitBranches).toHaveBeenLastCalledWith(1, {
        confirm: true,
        names: ["old-done", "gone-one"],
      }),
    );
    expect(await screen.findByText("Deleted 1 branch locally.")).toBeInTheDocument();
    expect(screen.getByText("owned by a Task Master task")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Changes")).toBeInTheDocument();
  });

  it("cancels back to the list without deleting", async () => {
    m.pruneProjectGitBranches.mockResolvedValue(plan());
    await openPrune();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Changes")).toBeInTheDocument();
    expect(m.pruneProjectGitBranches).toHaveBeenCalledTimes(1);
  });

  it("handles nothing to prune, an unavailable host and a failed preview", async () => {
    m.pruneProjectGitBranches.mockResolvedValueOnce(plan({ candidates: [], skipped: [] }));
    await openPrune().catch(() => undefined);
    expect(await screen.findByText(/No local branch is merged/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to Source Control" }));

    m.pruneProjectGitBranches.mockResolvedValueOnce(undefined);
    await userEvent.click(await screen.findByRole("button", { name: "Prune…" }));
    expect(await screen.findByText(/only available for projects on this host/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to Source Control" }));

    m.pruneProjectGitBranches.mockRejectedValueOnce(new Error("nope"));
    await userEvent.click(await screen.findByRole("button", { name: "Prune…" }));
    expect(await screen.findByText("nope")).toBeInTheDocument();
  });

  it("shows a failed confirm instead of a success", async () => {
    m.pruneProjectGitBranches
      .mockResolvedValueOnce(plan())
      .mockRejectedValueOnce(new Error("rate limited"));
    await openPrune();
    await userEvent.click(screen.getByRole("button", { name: "Delete 3 branches" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete 3" }));
    expect(await screen.findByText("rate limited")).toBeInTheDocument();
  });
});

describe("Branch detail", () => {
  async function openDetail(name = "feat/open") {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name }));
    await screen.findByText("Commits only on this branch");
  }

  it("shows the status triad, Mullion card, details and unique commits", async () => {
    m.getProjectGitBranch.mockResolvedValue(detail({ worktreePath: "/repo/.wt/feat-open" }));
    seed({
      sessions: [makeSession({ id: 3, projectId: 1, name: "worker", liveBranch: "feat/open" })],
    });
    await openDetail();
    expect(m.getProjectGitBranch).toHaveBeenCalledWith(1, "feat/open");
    const triad = screen.getByRole("group", { name: "PR status" });
    expect(within(triad).getByText("CI failing")).toBeInTheDocument();
    expect(within(triad).getByText("Review required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open PR #11" })).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByText("origin/feat/open")).toBeInTheDocument();
    expect(screen.getByText("vs main")).toBeInTheDocument();
    expect(screen.getByText("do the thing")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open branch on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/o/r/tree/feat/open",
    );
  });

  it("opens the PR, History and goes back", async () => {
    m.getProjectGitBranch.mockResolvedValue(detail());
    const openRightSidebarPr = vi.fn();
    seed({ openRightSidebarPr });
    await openDetail();
    await userEvent.click(screen.getByRole("button", { name: "Open PR #11" }));
    expect(openRightSidebarPr).toHaveBeenCalledWith(1, 11);
    await userEvent.click(screen.getByRole("button", { name: /do the thing/ }));
    expect(useDashboardStore.getState().rightSidebarHistoryRequest?.scope).toBe("branch:feat/open");
    await userEvent.click(screen.getByRole("button", { name: "Back to Source Control" }));
    expect(await screen.findByText("Changes")).toBeInTheDocument();
  });

  it("deletes the branch and returns to the list", async () => {
    m.getProjectGitBranch.mockResolvedValue(detail({ name: "misc" }));
    m.deleteProjectGitBranch.mockResolvedValue({ deleted: true });
    await openDetail("misc");
    await userEvent.click(screen.getByRole("button", { name: /Delete…/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(m.deleteProjectGitBranch).toHaveBeenCalledWith(1, "misc", true));
    expect(await screen.findByText("Changes")).toBeInTheDocument();
  });

  it("checks the branch out, then reloads into its current-branch view with Rebase", async () => {
    m.getProjectGitBranch
      .mockResolvedValueOnce(detail({ name: "misc" }))
      .mockResolvedValue(detail({ name: "misc", isCurrent: true }));
    m.checkoutProjectGitBranch.mockResolvedValue({ ok: true });
    m.rebaseProjectGitBranch.mockResolvedValue({
      ok: true,
      reason: "already-up-to-date",
      detail: "origin/misc",
    });
    await openDetail("misc");
    await userEvent.click(screen.getByRole("button", { name: /Checkout/ }));
    expect(await screen.findByText("Checked out misc.")).toBeInTheDocument();
    expect(m.checkoutProjectGitBranch).toHaveBeenCalledWith(1, "misc");

    await userEvent.click(await screen.findByRole("button", { name: /Rebase…/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm rebase" }));
    expect(await screen.findByText("Already up to date with origin/misc.")).toBeInTheDocument();
  });

  it("shows a refused checkout inline, and disables it for a worktree's branch", async () => {
    m.getProjectGitBranch.mockResolvedValueOnce(detail({ name: "misc" }));
    m.checkoutProjectGitBranch.mockResolvedValue({ ok: false, reason: "dirty-tree" });
    await openDetail("misc");
    await userEvent.click(screen.getByRole("button", { name: /Checkout/ }));
    expect(await screen.findByText(/uncommitted changes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force" })).toBeNull();
  });

  it("disables Checkout for a branch another worktree holds", async () => {
    m.getProjectGitBranch.mockResolvedValue(detail({ worktreePath: "/repo/.wt/feat-open" }));
    await openDetail();
    expect(screen.getByRole("button", { name: /Checkout/ })).toBeDisabled();
  });

  it("lets a task-owned branch be deleted, with the owning task in the warning", async () => {
    m.getProjectGitBranch.mockResolvedValue(detail({ name: "mullion/task-7-x", taskId: 7 }));
    await openDetail("mullion/task-7-x");
    const del = screen.getByRole("button", { name: /Delete…/ });
    expect(del).toBeEnabled();
    expect(del).toHaveAttribute("title", expect.stringContaining("owned by task #7"));
    expect(screen.getAllByText(/#7 · /).length).toBeGreaterThan(0);
  });

  it("shows the merge-state reason and the squash PR", async () => {
    m.getProjectGitBranch.mockResolvedValue(
      detail({
        name: "old-done",
        mergeState: "pr-merged",
        pr: { number: 5, state: "merged", url: "u" },
        uniqueCommits: [],
      }),
    );
    await openDetail("old-done");
    expect(screen.getByText("squash-merged")).toBeInTheDocument();
    expect(screen.getByText("Nothing the base branch doesn’t have.")).toBeInTheDocument();
  });

  it("explains a branch that can't be loaded and a remote host", async () => {
    m.getProjectGitBranch.mockRejectedValueOnce(new Error("Branch not found"));
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "misc" }));
    expect(await screen.findByText("Branch not found")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to Source Control" }));
    m.getProjectGitBranch.mockResolvedValueOnce(undefined);
    await userEvent.click(await screen.findByRole("button", { name: "misc" }));
    expect(await screen.findByText(/only available for projects on this host/)).toBeInTheDocument();
  });

  it("reports a failed delete and session start", async () => {
    m.getProjectGitBranch.mockResolvedValue(detail({ name: "misc" }));
    m.deleteProjectGitBranch.mockResolvedValue({ deleted: false, reason: "delete-failed" });
    m.listProjectActions.mockResolvedValue([]);
    await openDetail("misc");
    await userEvent.click(screen.getByRole("button", { name: /Delete…/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/The operation failed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Open session/ }));
    expect(
      await screen.findByText("No launcher is configured for this project."),
    ).toBeInTheDocument();
  });
});

describe("Clone health and repair", () => {
  const damaged = {
    healthy: false,
    gitDir: "/repo/.git",
    timedOut: false,
    zeroByteObjects: ["a", "b"],
    otherZeroByteFiles: [],
    fsckErrors: ["e"],
  };
  const repairPlan = {
    actionable: true,
    quarantine: ["a", "b"],
    willFetch: true,
    indexesToRebuild: ["/repo/.git/index"],
    indexesToSkip: [],
  };

  it("reports a healthy clone", async () => {
    m.postProjectGitHealth.mockResolvedValue({
      healthy: true,
      gitDir: "/repo/.git",
      timedOut: false,
    } as never);
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /Check clone health/ }));
    expect(await screen.findByText("This repository is healthy.")).toBeInTheDocument();
  });

  it("shows the damage, the plan, and repairs only after a confirmed second click", async () => {
    m.postProjectGitHealth.mockResolvedValue(damaged as never);
    m.postProjectGitRepair.mockResolvedValueOnce(repairPlan as never).mockResolvedValueOnce({
      whole: true,
      quarantined: ["a", "b"],
      quarantine: "/q",
      refsRestored: true,
      indexesRebuilt: ["i"],
      indexesSkipped: [],
      recovered: [],
      unrecovered: [],
    } as never);
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /Check clone health/ }));
    expect(
      await screen.findByText(/looks damaged: 2 zero-byte object\(s\): 1 fsck error\(s\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Repair will quarantine 2 damaged object\(s\), fetch from origin/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Repair" }));
    expect(m.postProjectGitRepair).toHaveBeenCalledTimes(1); // only the plan
    await userEvent.click(screen.getByRole("button", { name: "Repair now" }));
    await waitFor(() =>
      expect(m.postProjectGitRepair).toHaveBeenLastCalledWith(1, { confirm: true }),
    );
    expect(await screen.findByText(/the clone is whole again/)).toBeInTheDocument();
    expect(
      screen.getByText(/2 damaged object\(s\) moved into \/q; refs restored/),
    ).toBeInTheDocument();
    // The outcome replaces the pre-repair banner.
    expect(screen.queryByText(/looks damaged/)).toBeNull();
  });

  it("reports a repair that left the clone broken, and a failed repair", async () => {
    m.postProjectGitHealth.mockResolvedValue(damaged as never);
    m.postProjectGitRepair
      .mockResolvedValueOnce({
        ...repairPlan,
        actionable: false,
        willFetch: false,
        indexesToSkip: [{ path: "/i", paths: ["x"] }],
      } as never)
      .mockRejectedValueOnce(new Error("repair exploded"));
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /Check clone health/ }));
    expect(await screen.findByText(/quarantine nothing/)).toBeInTheDocument();
    expect(
      screen.getByText(/left alone — staged content not in the working tree \(x\)/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Repair" }));
    await userEvent.click(screen.getByRole("button", { name: "Repair now" }));
    expect(await screen.findByText(/repair exploded/)).toBeInTheDocument();
  });

  it("says a timed-out check is not a verdict, and a non-repo has no clone", async () => {
    m.postProjectGitHealth
      .mockResolvedValueOnce({ healthy: false, gitDir: "/repo/.git", timedOut: true } as never)
      .mockResolvedValueOnce({ healthy: false, gitDir: null, timedOut: false } as never)
      .mockRejectedValueOnce(new Error("check failed"));
    renderView();
    await ready();
    const check = () => userEvent.click(screen.getByRole("button", { name: /Check clone health/ }));
    await check();
    expect(await screen.findByText(/did not finish/)).toBeInTheDocument();
    expect(screen.getByText(/did not finish/).closest("[role]")).toHaveAttribute("role", "status");
    await check();
    expect(
      await screen.findByText(/not a git repository, so there is no clone/),
    ).toBeInTheDocument();
    await check();
    expect(await screen.findByText(/check failed/)).toBeInTheDocument();
  });

  it("shows the repair-plan failure", async () => {
    m.postProjectGitHealth.mockResolvedValue(damaged as never);
    m.postProjectGitRepair.mockRejectedValue(new Error("plan failed"));
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /Check clone health/ }));
    expect(await screen.findByText(/plan failed/)).toBeInTheDocument();
  });
});

describe("Promote request and remote host", () => {
  it("shows a pending promote request that can be declined", async () => {
    const declinePromote = vi.fn(async () => undefined);
    seed({
      declinePromote,
      sessions: [makeSession({ id: 8, projectId: 1, name: "fix bundle", promoteState: "pending" })],
    });
    renderView();
    await ready();
    expect(screen.getByText("Promote requested")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(declinePromote).toHaveBeenCalledWith(8);
  });

  it("opens the promote dialog from Review…", async () => {
    seed({
      sessions: [makeSession({ id: 8, projectId: 1, name: "fix bundle", promoteState: "pending" })],
    });
    renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Review…" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("labels a remote project's host and shows unreachable instead of an empty list", async () => {
    seed({
      projects: [makeProject({ id: 1, name: "proj", cwd: "/repo", hostId: "h-1" })],
      hosts: [makeHost({ id: "h-1", name: "mac-mini" })],
    });
    m.getProjectGitBranches.mockRejectedValue(new Error("Host h-1 is unreachable"));
    renderView();
    expect(await screen.findByText("Host mac-mini is unreachable")).toBeInTheDocument();
    expect(document.querySelector(".sb-strip")).toHaveTextContent("on mac-mini");
    expect(screen.queryByText("No branches.")).toBeNull();
    m.getProjectGitBranches.mockResolvedValue(refs());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await ready()).toBeInTheDocument();
  });

  it("shows a plain error for a local failure, and not-a-repo for a 204", async () => {
    m.getProjectGitBranches.mockRejectedValueOnce(new Error("git exploded"));
    const { unmount } = renderView();
    expect(await screen.findByText("Could not load branches")).toBeInTheDocument();
    expect(screen.getByText("git exploded")).toBeInTheDocument();
    unmount();
    m.getProjectGitBranches.mockResolvedValue(undefined);
    renderView();
    expect(await screen.findAllByText("Not a git repository.")).not.toHaveLength(0);
  });

  it("never shows another project's page after a project switch", async () => {
    m.getProjectGitBranch.mockResolvedValue(detail({ name: "misc" }));
    seed({
      projects: [makeProject({ id: 1, cwd: "/repo" }), makeProject({ id: 2, cwd: "/other" })],
    });
    const { rerender } = renderView();
    await userEvent.click(await screen.findByRole("button", { name: "misc" }));
    await screen.findByText("Commits only on this branch");
    rerender(<GitSidebarView projectId={2} actions={actions} />);
    expect(screen.queryByText("Commits only on this branch")).toBeNull();
    expect(await screen.findByText("Source Control")).toBeInTheDocument();
  });
});

describe("View in History handoff", () => {
  it("applies the one-shot scope request in the History view, then clears it", async () => {
    m.getProjectGitLog.mockResolvedValue({ commits: [], hasMore: false } as never);
    useDashboardStore.getState().openRightSidebarHistory(1, "branch:misc");
    render(<HistorySidebarView projectId={1} actions={actions} />);
    await waitFor(() => expect(m.getProjectGitLog).toHaveBeenCalled());
    expect(m.getProjectGitLog.mock.calls[0]?.[1]).toMatchObject({ scope: "branch:misc" });
    await waitFor(() => expect(useDashboardStore.getState().rightSidebarHistoryRequest).toBeNull());
    fireEvent.click(document.body);
  });
});

describe("Branch detail on a remote host", () => {
  it("names the host", async () => {
    seed({
      projects: [makeProject({ id: 1, name: "proj", cwd: "/repo", hostId: "h-1" })],
      hosts: [makeHost({ id: "h-1", name: "mac-mini" })],
    });
    m.getProjectGitBranch.mockResolvedValue(detail({ name: "misc" }));
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "misc" }));
    expect(await screen.findByText("mac-mini")).toBeInTheDocument();
  });
});

describe("per-project and per-click state", () => {
  it("does not paint a late health verdict on another project", async () => {
    let settle!: (v: unknown) => void;
    m.postProjectGitHealth.mockImplementation(() => new Promise((r) => (settle = r)) as never);
    seed({
      projects: [makeProject({ id: 1, cwd: "/repo" }), makeProject({ id: 2, cwd: "/other" })],
    });
    const { rerender } = renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /Check clone health/ }));
    rerender(<GitSidebarView projectId={2} actions={actions} />);
    await ready();
    await act(async () => settle({ healthy: true, gitDir: "/x", timedOut: false }));
    expect(screen.queryByText("This repository is healthy.")).toBeNull();
  });

  it("starts one session per click in flight, on a branch row and in detail", async () => {
    let resolve!: () => void;
    const createSession = vi.fn(
      () => new Promise((r) => (resolve = () => r(makeSession({ id: 9 })))),
    );
    seed({ createSession });
    m.listProjectActions.mockResolvedValue([{ id: "agent:claude", command: "claude" }] as never);
    m.getProjectGitBranch.mockResolvedValue(detail({ name: "misc" }));
    renderView();
    await ready();
    const btn = within(rowOf("misc")).getByRole("button", { name: "Open session on branch" });
    await userEvent.click(btn);
    await userEvent.click(btn);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await act(async () => resolve());
    await userEvent.click(screen.getByRole("button", { name: "misc" }));
    await screen.findByText("Commits only on this branch");
    const open = screen.getByRole("button", { name: /Open session/ });
    await userEvent.click(open);
    await userEvent.click(open);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
  });

  it("a late health verdict for project A does not wipe project B's", async () => {
    const settle: Array<(v: unknown) => void> = [];
    m.postProjectGitHealth.mockImplementation(() => new Promise((r) => settle.push(r)) as never);
    seed({
      projects: [makeProject({ id: 1, cwd: "/repo" }), makeProject({ id: 2, cwd: "/other" })],
    });
    const { rerender } = renderView();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /Check clone health/ }));
    rerender(<GitSidebarView projectId={2} actions={actions} />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /Check clone health/ }));
    await act(async () => settle[1]?.({ healthy: true, gitDir: "/b", timedOut: false }));
    expect(await screen.findByText("This repository is healthy.")).toBeInTheDocument();
    await act(async () => settle[0]?.({ healthy: false, gitDir: null, timedOut: false }));
    expect(screen.getByText("This repository is healthy.")).toBeInTheDocument();
  });
});

describe("Deep-link requests", () => {
  it("opens the branch detail when Reveal in Git queues a branch request", async () => {
    m.getProjectGitBranch.mockResolvedValue(detail());
    renderView();
    await ready();
    act(() => useDashboardStore.getState().openRightSidebarBranch(1, "feat/open"));
    await screen.findByText("Commits only on this branch");
    expect(m.getProjectGitBranch).toHaveBeenCalledWith(1, "feat/open");
    // One-shot: cleared once applied.
    expect(useDashboardStore.getState().rightSidebarBranchRequest).toBeNull();
  });

  it("opens the prune preview when the palette queues a prune request", async () => {
    m.pruneProjectGitBranches.mockResolvedValue({
      dryRun: true,
      candidates: [{ name: "old-done", reason: "pr-merged" }],
      skipped: [],
      deleted: [],
      failed: [],
    });
    renderView();
    await ready();
    act(() => useDashboardStore.getState().openRightSidebarPrune(1));
    await screen.findByText("Will delete");
    expect(useDashboardStore.getState().rightSidebarPruneRequest).toBeNull();
  });

  it("ignores a request for another project", async () => {
    renderView();
    await ready();
    act(() => useDashboardStore.getState().openRightSidebarBranch(99, "feat/open"));
    expect(screen.queryByText("Commits only on this branch")).toBeNull();
  });
});
