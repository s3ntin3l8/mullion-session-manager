import { describe, it, expect, vi, beforeEach } from "vitest";

const removeWorktreeIfClean = vi.fn();
const deleteBranch = vi.fn();
vi.mock("../../src/services/session-backend.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBackend: () => ({ removeWorktreeIfClean, deleteBranch }),
}));

// The worker's host, for the "project not mapped there" case.
const resolveTaskWorkerHost = vi.fn<(...args: unknown[]) => string>(() => "local");
vi.mock("../../src/services/session-live-info.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTaskWorkerHost: (...args: unknown[]) => resolveTaskWorkerHost(...args),
}));

const { cleanupMergedTaskBranch } = await import("../../src/services/task-approve.js");

const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
const app = { log } as never;
const project = { id: 1, cwd: "/repo", hostId: "local", hostCwds: null };
const task = { branchName: "mullion/task-1-x", worktreePath: "/repo/.mullion-worktrees/x" };

// The helper is fire-and-forget; let its async chain settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("cleanupMergedTaskBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeWorktreeIfClean.mockResolvedValue({ removed: true });
    deleteBranch.mockResolvedValue({ deleted: true });
  });

  it("removes the worktree, then force-deletes the branch", async () => {
    cleanupMergedTaskBranch(app, task, project);
    await settle();
    expect(removeWorktreeIfClean).toHaveBeenCalledWith(task.worktreePath, "/repo");
    expect(deleteBranch).toHaveBeenCalledWith("/repo", task.branchName, { force: true });
    expect(removeWorktreeIfClean.mock.invocationCallOrder[0]).toBeLessThan(
      deleteBranch.mock.invocationCallOrder[0],
    );
  });

  it("still deletes the branch when the worktree is already gone", async () => {
    removeWorktreeIfClean.mockResolvedValue({ removed: false, reason: "not-a-repo" });
    cleanupMergedTaskBranch(app, task, project);
    await settle();
    expect(deleteBranch).toHaveBeenCalledTimes(1);
  });

  it("keeps the branch when the worktree is dirty", async () => {
    removeWorktreeIfClean.mockResolvedValue({ removed: false, reason: "dirty" });
    cleanupMergedTaskBranch(app, task, project);
    await settle();
    expect(deleteBranch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });

  it("deletes the branch directly when there is no worktree", async () => {
    cleanupMergedTaskBranch(app, { ...task, worktreePath: null }, project);
    await settle();
    expect(removeWorktreeIfClean).not.toHaveBeenCalled();
    expect(deleteBranch).toHaveBeenCalledTimes(1);
  });

  it("only removes the worktree when the task has no branch", async () => {
    cleanupMergedTaskBranch(app, { ...task, branchName: null }, project);
    await settle();
    expect(removeWorktreeIfClean).toHaveBeenCalledTimes(1);
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("does nothing when the project is not mapped on the host", async () => {
    resolveTaskWorkerHost.mockReturnValueOnce("elsewhere");
    cleanupMergedTaskBranch(app, { ...task, sessionId: 5, projectId: 1 }, project);
    await settle();
    expect(removeWorktreeIfClean).not.toHaveBeenCalled();
    expect(deleteBranch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("logs a not-deleted result at debug", async () => {
    deleteBranch.mockResolvedValue({ deleted: false, reason: "no-such-branch" });
    cleanupMergedTaskBranch(app, task, project);
    await settle();
    expect(log.debug).toHaveBeenCalled();
  });

  it("swallows a backend failure", async () => {
    deleteBranch.mockRejectedValue(new Error("boom"));
    cleanupMergedTaskBranch(app, task, project);
    await settle();
    expect(log.warn).toHaveBeenCalled();
  });
});
