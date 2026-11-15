// @vitest-environment jsdom
// #3048 — the project actions the sidebar's project header and the launcher's
// Where row share.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitStatus, Project } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { deleteProjectAndEndSessions, gitPullState, pullProject } from "./projectActions.js";

function stubGit(pullResult: unknown) {
  const refreshGitStatuses = vi.fn().mockResolvedValue(undefined);
  const refreshGitRefs = vi.fn().mockResolvedValue(undefined);
  const pullProjectGit = vi.fn().mockResolvedValue(pullResult);
  useDashboardStore.setState({ refreshGitStatuses, refreshGitRefs, pullProjectGit });
  return { refreshGitStatuses, refreshGitRefs, pullProjectGit };
}

describe("projectActions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pulls and refreshes the git status and refs", async () => {
    const git = stubGit({ pulled: true });
    expect(await pullProject(5)).toBeNull();
    expect(git.pullProjectGit).toHaveBeenCalledWith(5);
    expect(git.refreshGitStatuses).toHaveBeenCalled();
    expect(git.refreshGitRefs).toHaveBeenCalledWith([5]);
  });

  it("refreshes after a refused pull too, and says why it was refused", async () => {
    const git = stubGit({ pulled: false, reason: "already-up-to-date" });
    expect(await pullProject(5)).toBe("Already up to date with tracking branch.");
    expect(git.refreshGitStatuses).toHaveBeenCalled();
    expect(git.refreshGitRefs).toHaveBeenCalledWith([5]);
  });

  it("turns a failed pull request into a message", async () => {
    useDashboardStore.setState({
      pullProjectGit: vi.fn().mockRejectedValue(new Error("Host is unreachable")),
    });
    expect(await pullProject(5)).toBe("Host is unreachable");
  });

  it("ends the project's sessions only after the delete succeeded", async () => {
    const sessions = [makeSession({ id: 1, projectId: 5 }), makeSession({ id: 2, projectId: 5 })];
    const onSessionEnded = vi.fn();
    useDashboardStore.setState({ deleteProject: vi.fn().mockResolvedValue(undefined) });
    expect(await deleteProjectAndEndSessions(5, sessions, onSessionEnded)).toBeNull();
    expect(onSessionEnded.mock.calls.map(([s]) => s.id)).toEqual([1, 2]);

    onSessionEnded.mockClear();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    useDashboardStore.setState({ deleteProject: vi.fn().mockRejectedValue(new Error("locked")) });
    expect(await deleteProjectAndEndSessions(5, sessions, onSessionEnded)).toBe("locked");
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it("enables Git pull only when the branch is behind", () => {
    const local: Project = makeProject({ hostId: "local" });
    const remote: Project = makeProject({ hostId: "remote-1" });
    expect(gitPullState(local, null)).toEqual({ disabled: true, title: "Not a git repository" });
    expect(gitPullState(remote, null).title).toBe(
      "Not a git repository, or the host is unreachable.",
    );
    const behind = { behind: 1 } as GitStatus;
    expect(gitPullState(local, behind)).toEqual({
      disabled: false,
      title: "Pull 1 commit from tracking branch",
    });
    expect(gitPullState(local, { behind: 0 } as GitStatus).disabled).toBe(true);
  });
});
