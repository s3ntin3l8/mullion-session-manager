// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../../api/index.js";
import type { Session } from "../../api/index.js";
import { useDashboardStore } from "../../store/index.js";
import { makeHost, makeProject, makeSession } from "../../test/fixtures.js";
import { KeptSessionWorktrees } from "./KeptSessionWorktrees.js";
import { keptSessionWorktrees } from "./keptSessionWorktreesFilter.js";

function kept(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: 7,
    projectId: 1,
    status: "exited",
    cwd: "/repo/.mullion-worktrees/mullion-session-7",
    resolvedHostId: "mac-mini",
    worktreeBranch: "mullion/session-7",
    worktreeRepoCwd: "/repo",
    worktreeKeptReason: "unpushed",
    worktreeLastAttemptAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    worktreeReclaimedAt: null,
    ...overrides,
  });
}

function seed(sessions: Session[]) {
  const refreshSessions = vi.fn().mockResolvedValue(undefined);
  useDashboardStore.setState({
    sessions,
    projects: [makeProject({ id: 1, name: "mullion" })],
    hosts: [makeHost({ id: "mac-mini", name: "Mac mini" })],
    refreshSessions,
  });
  return refreshSessions;
}

/** ConfirmButton arms on the first click and fires on the second. */
async function confirm(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("button", { name }));
  await user.click(screen.getByRole("button", { name: /confirm/i }));
}

describe("keptSessionWorktrees", () => {
  it("keeps only ended sessions that still own an unreclaimed worktree", () => {
    const rows = keptSessionWorktrees([
      kept({ id: 1 }),
      kept({ id: 2, status: "active" }),
      kept({ id: 3, worktreeBranch: null }),
      kept({ id: 4, worktreeReclaimedAt: new Date().toISOString() }),
      kept({ id: 5, worktreeBranch: undefined }),
      kept({ id: 6, status: "killed" }),
    ]);
    expect(rows.map((s) => s.id)).toEqual([1, 6]);
  });
});

describe("KeptSessionWorktrees", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    useDashboardStore.setState({ sessions: [], projects: [], hosts: [] });
  });

  it("renders nothing when no session worktree was kept", () => {
    seed([kept({ worktreeReclaimedAt: new Date().toISOString() })]);
    const { container } = render(<KeptSessionWorktrees />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the project, host, path, branch, reason and last attempt", () => {
    seed([kept()]);
    render(<KeptSessionWorktrees />);
    expect(screen.getByText("Kept session worktrees")).toBeInTheDocument();
    expect(screen.getByText(/mullion · Mac mini ·/)).toBeInTheDocument();
    expect(screen.getByText("/repo/.mullion-worktrees/mullion-session-7")).toBeInTheDocument();
    expect(screen.getByText(/Kept: branch not pushed · last tried 5m ago/)).toBeInTheDocument();
  });

  it("falls back to ids for an unknown project or host, and says when it was never tried", () => {
    seed([
      kept({
        projectId: 99,
        resolvedHostId: "gone-host",
        worktreeKeptReason: null,
        worktreeLastAttemptAt: null,
      }),
    ]);
    render(<KeptSessionWorktrees />);
    expect(screen.getByText(/project 99 · gone-host ·/)).toBeInTheDocument();
    expect(screen.getByText(/Kept: not tried yet · last tried not yet/)).toBeInTheDocument();
  });

  it("offers a copyable push -u for an unpushed branch", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    seed([kept()]);
    render(<KeptSessionWorktrees />);
    expect(screen.getByText("git push -u origin mullion/session-7")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("git push -u origin mullion/session-7");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it.each([
    ["dirty", /Commit the work/],
    ["conflicts", /Commit the work/],
    ["in-use", /once nothing is running in it/],
    ["still-running", /once nothing is running in it/],
  ] as const)("shows the remedy for %s", (reason, text) => {
    seed([kept({ worktreeKeptReason: reason })]);
    render(<KeptSessionWorktrees />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("removes through the session's own path and refreshes the list", async () => {
    const user = userEvent.setup();
    const refreshSessions = seed([kept({ worktreeKeptReason: "branch-missing" })]);
    const remove = vi.spyOn(api, "removeProjectGitWorktree").mockResolvedValue({ removed: true });
    render(<KeptSessionWorktrees />);

    await confirm(user, /Remove worktree/);
    await waitFor(() => expect(refreshSessions).toHaveBeenCalled());
    expect(remove).toHaveBeenCalledWith(1, "/repo/.mullion-worktrees/mullion-session-7", false, 7);
  });

  it("shows a refusal and offers a separately confirmed force remove", async () => {
    const user = userEvent.setup();
    const refreshSessions = seed([kept({ worktreeKeptReason: "dirty" })]);
    const remove = vi
      .spyOn(api, "removeProjectGitWorktree")
      .mockResolvedValueOnce({ removed: false, reason: "dirty" })
      .mockResolvedValueOnce({ removed: true });
    render(<KeptSessionWorktrees />);

    await confirm(user, /Remove worktree/);
    expect(await screen.findByText("This worktree has uncommitted changes.")).toBeInTheDocument();
    expect(refreshSessions).not.toHaveBeenCalled();

    const row = screen.getByText(/Kept: uncommitted changes/).closest(".kept-worktree-row");
    await user.click(within(row as HTMLElement).getByRole("button", { name: /Force remove/ }));
    await user.click(screen.getByRole("button", { name: /Confirm force remove/ }));
    await waitFor(() => expect(refreshSessions).toHaveBeenCalled());
    expect(remove).toHaveBeenLastCalledWith(
      1,
      "/repo/.mullion-worktrees/mullion-session-7",
      true,
      7,
    );
  });

  it.each([
    ["alive", "The session has ended but its process is still running in this worktree."],
    ["unknown", "Mullion can't confirm the session's process has exited."],
  ])("explains a still-running refusal (%s) and offers force", async (detail, text) => {
    const user = userEvent.setup();
    seed([kept({ worktreeKeptReason: "still-running" })]);
    vi.spyOn(api, "removeProjectGitWorktree").mockResolvedValue({
      removed: false,
      reason: "still-running",
      detail,
    });
    render(<KeptSessionWorktrees />);

    await confirm(user, /Remove worktree/);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Force remove/ })).toBeInTheDocument();
  });

  it("does not offer force for a refusal force cannot fix, and reports a failed request", async () => {
    const user = userEvent.setup();
    seed([kept()]);
    vi.spyOn(api, "removeProjectGitWorktree")
      .mockResolvedValueOnce({ removed: false, reason: "not-listed" })
      .mockRejectedValueOnce(new Error("Host mac-mini is unreachable"));
    render(<KeptSessionWorktrees />);

    await confirm(user, /Remove worktree/);
    expect(
      await screen.findByText("This worktree is no longer reported by git."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Force remove/ })).not.toBeInTheDocument();

    await confirm(user, /Remove worktree/);
    expect(await screen.findByText(/unreachable|try again/)).toBeInTheDocument();
  });
});
