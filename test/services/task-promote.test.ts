import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import type * as GithubWrite from "../../src/services/github-write.js";
import type { tasks, projects } from "../../src/db/schema.js";

const mockGetToken = vi.fn();
const mockResolveRepoRef = vi.fn();
const mockCreatePullRequest = vi.fn();

vi.mock("../../src/services/github-integration.js", () => ({
  getToken: mockGetToken,
}));
vi.mock("../../src/services/github-webhook.js", () => ({
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubWrite>();
  return {
    ...actual,
    createPullRequest: mockCreatePullRequest,
  };
});

const { promoteTaskToPR } = await import("../../src/services/task-promote.js");

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString();
}

// Pushes `main` to the remote as part of setup (plain `git push`, no
// pushBranch/auth involved) — resolveDefaultBaseRef needs `origin/main`
// to already exist on the remote to resolve a real default branch, same
// as a genuine GitHub repo always has one before any task branch exists.
function createGitRepoWithRemote(remotePath: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-promote-test-work-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  git(cwd, ["remote", "add", "origin", remotePath]);
  git(cwd, ["push", "origin", "main"]);
  return cwd;
}

function createBareRemote(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-promote-test-remote-"));
  git(dir, ["init", "--bare", "-b", "main"]);
  return dir;
}

function baseTask(overrides: Partial<typeof tasks.$inferSelect> = {}) {
  return {
    id: 1,
    projectId: 1,
    issueNumber: null,
    title: "Some task",
    body: "task body",
    htmlUrl: null,
    status: "reviewing",
    boardOrder: 0,
    sessionId: null,
    reviewSessionId: null,
    worktreePath: null,
    branchName: null,
    agentCommand: null,
    prUrl: null,
    assignee: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    claimedAt: new Date(),
    startedAt: null,
    reviewingAt: new Date(),
    completedAt: null,
    ...overrides,
  } as typeof tasks.$inferSelect;
}

function baseProject(overrides: Partial<typeof projects.$inferSelect> = {}) {
  return {
    id: 1,
    hostId: "local",
    cwd: "/tmp/does-not-matter",
    ...overrides,
  } as typeof projects.$inferSelect;
}

describe("promoteTaskToPR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockReturnValue("ghp_token");
    mockResolveRepoRef.mockResolvedValue({ owner: "test-owner", repo: "test-repo" });
    mockCreatePullRequest.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
    });
  });

  it("refuses when the task has no recorded worktree/branch", async () => {
    const result = await promoteTaskToPR({ config: {} } as never, baseTask(), baseProject());
    expect(result).toMatchObject({ ok: false, reason: "no-worktree" });
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it("refuses when the worktree has uncommitted changes", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "uncommitted");

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toMatchObject({ ok: false, reason: "dirty-tree" });
    expect(mockCreatePullRequest).not.toHaveBeenCalled();

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses when no GitHub token is connected", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    mockGetToken.mockReturnValue(null);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toMatchObject({ ok: false, reason: "no-token" });

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses when the project's GitHub repo can't be resolved", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    mockResolveRepoRef.mockResolvedValue(null);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toMatchObject({ ok: false, reason: "no-repo" });

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses when the push fails (e.g. an unreachable/misconfigured remote)", async () => {
    // Base-ref resolution now runs BEFORE the push (Hermes review, PR
    // #475), and resolveDefaultBaseRef can succeed off the LOCAL
    // origin/main tracking ref alone (it only best-effort-fetches, then
    // falls back to whatever's already resolvable locally) — so this test
    // establishes a real remote-tracking ref first via
    // createGitRepoWithRemote's own `git push origin main`, THEN breaks
    // the remote, so resolveDefaultBaseRef still succeeds locally while
    // the actual pushBranch call fails against the now-unreachable origin.
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    git(cwd, ["remote", "set-url", "origin", "/nonexistent/remote/path.git"]);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toMatchObject({ ok: false, reason: "push-failed" });
    expect(mockCreatePullRequest).not.toHaveBeenCalled();

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses cleanly when the default base branch can't be determined at all — nothing pushed yet", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-promote-test-nobase-"));
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.email", "test@example.com"]);
    git(cwd, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "initial", "--no-verify"]);
    git(cwd, ["remote", "add", "origin", "/nonexistent/remote/path.git"]);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toMatchObject({ ok: false, reason: "pr-create-failed" });
    expect(mockCreatePullRequest).not.toHaveBeenCalled();

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("pushes, creates the PR against the repo's current default branch, and returns its url", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    fs.writeFileSync(path.join(cwd, "b.txt"), "b");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "work", "--no-verify"]);

    const task = baseTask({
      id: 42,
      title: "Fix the thing",
      body: "Detailed description",
      worktreePath: cwd,
      branchName: "mullion/task-1",
    });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toEqual({ ok: true, prUrl: "https://github.com/test-owner/test-repo/pull/9" });
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      expect.objectContaining({
        title: "Fix the thing",
        head: "mullion/task-1",
        base: "main",
        body: expect.stringContaining("Detailed description"),
      }),
    );
    // Landed in the remote — the push actually happened, not just claimed.
    const branches = git(remote, ["branch", "--list", "mullion/task-1"]);
    expect(branches).toContain("mullion/task-1");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("includes 'Closes #N' in the PR body for an issue-linked task, and omits it for a local task", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1", issueNumber: 42 });
    await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      expect.objectContaining({ body: expect.stringContaining("Closes #42") }),
    );

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("still promotes a local task (no linked issue) — it just gets a PR with no 'Closes #N'", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1", issueNumber: null });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result.ok).toBe(true);
    const [, , , params] = mockCreatePullRequest.mock.calls[0];
    expect(params.body).not.toContain("Closes #");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("surfaces a PR-creation failure (e.g. GitHubWriteScopeError) as pr-create-failed after the branch has already been pushed", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    mockCreatePullRequest.mockRejectedValue(new Error("HTTP 403 — insufficient scope"));

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toMatchObject({ ok: false, reason: "pr-create-failed" });
    expect((result as { detail?: string }).detail).toContain("insufficient scope");
    // The push already landed even though PR creation failed — approve
    // stays retryable rather than the branch getting silently lost.
    const branches = git(remote, ["branch", "--list", "mullion/task-1"]);
    expect(branches).toContain("mullion/task-1");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
