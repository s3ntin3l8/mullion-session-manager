// @vitest-environment jsdom
// Issue #3068 — a branch row's Pull (fast-forward only, any branch), the
// current row's Rebase told apart from it, and the rebase's toasts/refusals.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BranchesSection } from "./BranchesSection.js";
import { useDashboardStore } from "../store/index.js";
import { api } from "../api/index.js";
import type * as ApiModule from "../api/index.js";
import type * as SourceControlModule from "./useSourceControl.js";
import type { GitBranchInfo, GitWorktreeInfo } from "../api/types.js";
import type { MullionLinks } from "../hooks/useMullionLinks.js";
import { makeProject } from "../test/fixtures.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      pullProjectGitBranch: vi.fn(),
      postProjectGitPull: vi.fn(),
      rebaseProjectGitBranch: vi.fn(),
      checkoutProjectGitBranch: vi.fn(),
      deleteProjectGitBranch: vi.fn(),
    },
  };
});

// A successful operation refreshes every git surface through real fetches;
// what is asserted here is the row, not that refresh.
vi.mock("./useSourceControl.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlModule>()),
  refreshGitEverywhere: vi.fn(),
}));

const m = vi.mocked(api);

const links: MullionLinks = {
  byBranch: new Map(),
  byWorktree: new Map(),
  byPr: new Map(),
  byIssue: new Map(),
};

const branch = (name: string, over: Partial<GitBranchInfo> = {}): GitBranchInfo => ({
  name,
  isCurrent: false,
  lastCommitRelative: "1 day ago",
  ...over,
});

const worktrees: GitWorktreeInfo[] = [
  { path: "/repo", branch: "main", isMain: true },
  { path: "/repo/.wt/in-wt", branch: "in-wt", isMain: false },
];

const pushToast = vi.fn();
const onReload = vi.fn();

function renderSection(branches: GitBranchInfo[]) {
  return render(
    <BranchesSection
      projectId={1}
      branches={branches}
      worktrees={worktrees}
      defaultBranch="origin/main"
      links={links}
      onOpenBranch={vi.fn()}
      onPrune={vi.fn()}
      onReload={onReload}
    />,
  );
}

const rowOf = (name: string) =>
  screen.getByRole("button", { name }).closest(".sb-row") as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  useDashboardStore.setState({
    projects: [makeProject({ id: 1, name: "proj", cwd: "/repo" })],
    sessions: [],
    previews: [],
    prsByProject: {},
    pushToast,
  } as never);
});

describe("BranchesSection — Pull (issue #3068)", () => {
  it("offers Pull only on rows behind a live upstream", () => {
    renderSection([
      branch("main", { isCurrent: true, upstream: "origin/main" }),
      branch("idle", { upstream: "origin/idle", behind: 2 }),
      branch("ahead-only", { upstream: "origin/ahead-only", ahead: 3 }),
      branch("gone", { upstream: "origin/gone", behind: 1, upstreamGone: true }),
      branch("local", { behind: 1 }),
    ]);
    expect(
      within(rowOf("idle")).getByRole("button", {
        name: "Pull — fast-forward 2 commits from origin/idle",
      }),
    ).toBeEnabled();
    for (const name of ["main", "ahead-only", "gone", "local"]) {
      expect(within(rowOf(name)).queryByRole("button", { name: /^Pull/ })).toBeNull();
    }
  });

  it("pulls a branch held by a linked worktree, which cannot be checked out", async () => {
    m.pullProjectGitBranch.mockResolvedValue({ ok: true });
    renderSection([branch("in-wt", { upstream: "origin/in-wt", behind: 1 })]);
    expect(within(rowOf("in-wt")).getByRole("button", { name: /in use by in-wt/ })).toBeDisabled();
    await userEvent.click(
      within(rowOf("in-wt")).getByRole("button", {
        name: "Pull — fast-forward 1 commit from origin/in-wt",
      }),
    );
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith({
        message: "Pulled in-wt from origin/in-wt.",
        kind: "success",
      }),
    );
    expect(m.pullProjectGitBranch).toHaveBeenCalledWith(1, "in-wt");
    expect(m.postProjectGitPull).not.toHaveBeenCalled();
    expect(onReload).toHaveBeenCalled();
  });

  it("shows a refusal inline on the row, with no Force", async () => {
    m.pullProjectGitBranch.mockResolvedValue({ ok: false, reason: "not-fast-forward" });
    renderSection([branch("idle", { upstream: "origin/idle", behind: 2, ahead: 1 })]);
    await userEvent.click(within(rowOf("idle")).getByRole("button", { name: /^Pull/ }));
    expect(
      await within(rowOf("idle")).findByText(
        "Branch has diverged from upstream (cannot fast-forward).",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force" })).toBeNull();
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("words a worktree in use and a missing upstream", async () => {
    m.pullProjectGitBranch
      .mockResolvedValueOnce({ ok: false, reason: "sessions-active", detail: "7" })
      .mockResolvedValueOnce({
        ok: false,
        reason: "no-upstream",
        detail: "The upstream origin/idle no longer exists",
      });
    renderSection([branch("idle", { upstream: "origin/idle", behind: 2 })]);
    const pullButton = () => within(rowOf("idle")).getByRole("button", { name: /^Pull/ });
    await userEvent.click(pullButton());
    expect(await screen.findByText(/Active session: 7\./)).toBeInTheDocument();
    await userEvent.click(pullButton());
    expect(
      await screen.findByText("The upstream origin/idle no longer exists — nothing to pull from."),
    ).toBeInTheDocument();
  });

  it("pulls the current branch through the header's own Pull", async () => {
    m.postProjectGitPull
      .mockResolvedValueOnce({ pulled: false, reason: "dirty-tree" })
      .mockResolvedValueOnce({ pulled: true });
    renderSection([branch("main", { isCurrent: true, upstream: "origin/main", behind: 3 })]);
    const pullButton = () => within(rowOf("main")).getByRole("button", { name: /^Pull/ });
    await userEvent.click(pullButton());
    expect(
      await screen.findByText("Working tree has uncommitted changes or conflicts."),
    ).toBeInTheDocument();
    await userEvent.click(pullButton());
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith({
        message: "Pulled main from origin/main.",
        kind: "success",
      }),
    );
    expect(m.postProjectGitPull).toHaveBeenCalledWith(1);
    expect(m.pullProjectGitBranch).not.toHaveBeenCalled();
  });

  it("reports a current branch that was already up to date, and a transport failure", async () => {
    m.postProjectGitPull
      .mockResolvedValueOnce({ pulled: true, reason: "already-up-to-date" })
      .mockRejectedValueOnce(new Error("network down"));
    renderSection([branch("main", { isCurrent: true, upstream: "origin/main", behind: 1 })]);
    const pullButton = () => within(rowOf("main")).getByRole("button", { name: /^Pull/ });
    await userEvent.click(pullButton());
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith({ message: "Already up to date.", kind: "success" }),
    );
    await userEvent.click(pullButton());
    expect(await within(rowOf("main")).findByRole("alert")).toBeInTheDocument();
  });
});

describe("BranchesSection — Rebase is not Pull (issue #3068)", () => {
  const rebaseButton = (name: string) =>
    within(rowOf(name)).getByRole("button", { name: /^Rebase — replay local commits/ });

  async function confirmRebase(name: string) {
    await userEvent.click(rebaseButton(name));
    await userEvent.click(
      within(rowOf(name)).getByRole("button", { name: /click again to confirm/ }),
    );
  }

  it("toasts 'Already up to date with <target>.' rather than 'Rebased onto'", async () => {
    m.rebaseProjectGitBranch.mockResolvedValue({
      ok: true,
      reason: "already-up-to-date",
      detail: "origin/main",
    });
    renderSection([branch("main", { isCurrent: true, upstream: "origin/main" })]);
    await confirmRebase("main");
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith({
        message: "Already up to date with origin/main.",
        kind: "success",
      }),
    );
  });

  it("still toasts a real rebase", async () => {
    m.rebaseProjectGitBranch.mockResolvedValue({ ok: true, detail: "origin/main" });
    renderSection([branch("main", { isCurrent: true, upstream: "origin/main", ahead: 1 })]);
    await confirmRebase("main");
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith({
        message: "Rebased onto origin/main.",
        kind: "success",
      }),
    );
  });

  it("points to Pull when sessions block a rebase a fast-forward would do", async () => {
    m.rebaseProjectGitBranch.mockResolvedValue({
      ok: false,
      reason: "sessions-active",
      detail: "3,4",
    });
    renderSection([branch("main", { isCurrent: true, upstream: "origin/main", behind: 2 })]);
    await confirmRebase("main");
    expect(
      await screen.findByText("Sessions are working in this checkout. Use Pull to fast-forward."),
    ).toBeInTheDocument();
  });

  it("keeps the plain session refusal when local commits need a real rebase", async () => {
    m.rebaseProjectGitBranch.mockResolvedValue({
      ok: false,
      reason: "sessions-active",
      detail: "3",
    });
    renderSection([
      branch("main", { isCurrent: true, upstream: "origin/main", behind: 2, ahead: 1 }),
    ]);
    await confirmRebase("main");
    expect(await screen.findByText(/Active session: 3\. .*stop it first/)).toBeInTheDocument();
  });
});
