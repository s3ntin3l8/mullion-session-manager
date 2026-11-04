// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitSidebarView } from "../right-sidebar/GitSidebarView.js";
import { useDashboardStore } from "../store/index.js";
import { api } from "../api/index.js";
import type * as ApiModule from "../api/index.js";
import { makeHost, makeProject, makeSession } from "../test/fixtures.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getProjectGitBranches: vi.fn(),
      getProjectGitStatus: vi.fn(),
      getProjectGitFileDiff: vi.fn(),
      postProjectGitFetch: vi.fn(),
      postProjectGitPull: vi.fn(),
      postProjectGitHealth: vi.fn(),
    },
  };
});

const m = vi.mocked(api);
const onOpenFile = vi.fn();
const actions = { onOpenGit: vi.fn(), onOpenFile } as never;

const status = (branch: string, behind = 0, paths: string[] = []) => ({
  branch,
  hash: "abc1234",
  ahead: 0,
  behind,
  files: paths.map((path) => ({ path, status: "M" as const })),
  isClean: paths.length === 0,
  hasConflicts: false,
});

function seed() {
  useDashboardStore.setState({
    previews: [],
    projects: [makeProject({ id: 1, name: "proj", cwd: "/repo", hostId: "local" })],
    // Same path as the project's, but on another host.
    sessions: [
      makeSession({ id: 9, projectId: 1, cwd: "/repo", resolvedHostId: "mac" }),
      makeSession({ id: 10, projectId: 1, cwd: "/repo/.mullion-worktrees/feat-x" }),
    ],
    tasks: [],
    hosts: [makeHost({ id: "local", name: "Primary" }), makeHost({ id: "mac", name: "Mac mini" })],
    gitStatuses: { 1: status("main", 0, ["project-only.ts"]) },
    sessionGitStatuses: {
      9: status("feat/remote", 2, ["remote-only.ts"]),
      10: status("feat/x", 0, ["worktree-only.ts"]),
    },
    gitProblems: {},
    prsByProject: {},
  } as never);
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  m.getProjectGitBranches.mockResolvedValue(undefined);
  m.getProjectGitFileDiff.mockResolvedValue({ patch: "@@ -1 +1 @@\n-old\n+new" } as never);
  seed();
});
afterEach(() => vi.useRealTimers());

// A changed file's name is both the row title and the start of its path.
const file = (name: string) => screen.findAllByText(name);

const view = (sessionId: number | null) => (
  <GitSidebarView projectId={1} checkoutSessionId={sessionId} actions={actions} />
);

describe("Source Control follows the session checkout", () => {
  it("shows the session's changes, host and branch rather than the project's", async () => {
    render(view(9));
    await file("remote-only.ts");
    expect(screen.queryAllByText("project-only.ts")).toHaveLength(0);
    expect(screen.getByText("Mac mini · repo · feat/remote")).toBeInTheDocument();
  });

  it("switches between two checkouts that share a path", async () => {
    const { rerender } = render(view(9));
    await file("remote-only.ts");
    rerender(view(null));
    await file("project-only.ts");
    expect(screen.queryAllByText("remote-only.ts")).toHaveLength(0);
    rerender(view(10));
    await file("worktree-only.ts");
    expect(screen.getByText("Primary · feat-x · feat/x")).toBeInTheDocument();
  });

  it("diffs and edits files in the session's checkout", async () => {
    render(view(9));
    await userEvent.click(await screen.findByRole("button", { name: "remote-only.ts" }));
    await waitFor(() =>
      expect(m.getProjectGitFileDiff).toHaveBeenCalledWith(1, "remote-only.ts", 9),
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit remote-only.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith(1, "remote-only.ts", 9);
  });

  it("fetches and pulls on the session's host, writing only its status", async () => {
    m.postProjectGitFetch.mockResolvedValue({ success: true });
    m.postProjectGitPull.mockResolvedValue({ pulled: true } as never);
    m.getProjectGitStatus.mockResolvedValue(status("feat/remote", 2, ["after.ts"]));
    render(view(9));
    await file("remote-only.ts");
    await userEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(m.postProjectGitFetch).toHaveBeenCalledWith(1, 9));
    await userEvent.click(screen.getByRole("button", { name: /^Pull/ }));
    await waitFor(() => expect(m.postProjectGitPull).toHaveBeenCalledWith(1, 9));
    expect(m.getProjectGitStatus).toHaveBeenCalledWith(1, { fresh: true, sessionId: 9 });
    await file("after.ts");
    expect(useDashboardStore.getState().gitStatuses[1]?.branch).toBe("main");
    expect(useDashboardStore.getState().sessionGitStatuses[9]?.files[0]?.path).toBe("after.ts");
  });

  it("never redirects a pending pull to the checkout focused meanwhile", async () => {
    let finish!: (v: { pulled: false; reason: "dirty-tree" }) => void;
    m.postProjectGitPull.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r as typeof finish;
        }),
    );
    const { rerender } = render(view(9));
    await file("remote-only.ts");
    await userEvent.click(screen.getByRole("button", { name: /^Pull/ }));
    expect(m.postProjectGitPull).toHaveBeenCalledWith(1, 9);
    // Focus moves to the project's checkout: no pending state, no pull there.
    rerender(view(null));
    await file("project-only.ts");
    expect(m.postProjectGitPull).toHaveBeenCalledTimes(1);
    await act(async () => finish({ pulled: false, reason: "dirty-tree" }));
    // Session 9's refusal is not shown on the project's checkout...
    expect(screen.queryByText(/uncommitted changes/)).toBeNull();
    // ...but is still there when the user returns to it.
    rerender(view(9));
    expect(await screen.findByText(/uncommitted changes/)).toBeInTheDocument();
  });

  it("labels the project-level sections as the project's repository", async () => {
    render(view(9));
    await file("remote-only.ts");
    expect(screen.getByText(/Branches, worktrees and auto-fetch below are/)).toBeInTheDocument();
  });
});
