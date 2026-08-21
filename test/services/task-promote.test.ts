import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { GitHubApiError } from "../../src/services/github.js";
import type * as GithubWrite from "../../src/services/github-write.js";
import type * as HostGit from "../../src/services/host-git.js";
import type { tasks, projects } from "../../src/db/schema.js";

const mockGetToken = vi.fn();
const mockResolveRepoRef = vi.fn();
const mockCreatePullRequest = vi.fn();
const mockFindPullRequestByHead = vi.fn();
const mockGetPullRequestByNumber = vi.fn();
const mockMarkPullRequestReadyForReview = vi.fn();
const mockClosePullRequest = vi.fn();
const mockUpdatePullRequestTitle = vi.fn();
const mockRecordGithubSyncError = vi.fn();
const mockClearGithubSyncError = vi.fn();
const mockGetRemoteHostClient = vi.fn();

vi.mock("../../src/services/github-integration.js", () => ({
  resolveGitHubToken: mockGetToken,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubWrite>();
  return {
    ...actual,
    createPullRequest: mockCreatePullRequest,
    findPullRequestByHead: mockFindPullRequestByHead,
    getPullRequestByNumber: mockGetPullRequestByNumber,
    markPullRequestReadyForReview: mockMarkPullRequestReadyForReview,
    closePullRequest: mockClosePullRequest,
    updatePullRequestTitle: mockUpdatePullRequestTitle,
  };
});
// #485 — recordGithubSyncError/clearGithubSyncError touch app.db, which
// this file's fake `app` (`{ config: {} } as never`) doesn't have; mocked
// here the same way the other collaborators above are, so every existing
// test in this file keeps working without a real DB.
vi.mock("../../src/services/task-github-sync.js", () => ({
  recordGithubSyncError: mockRecordGithubSyncError,
  clearGithubSyncError: mockClearGithubSyncError,
}));
// host-git.ts's own resolveHostGitStatus/resolveHostBaseRef/pushHostBranch
// stay real (task-promote.ts imports all four of host-git.ts's exports
// from this one module) — only resolveRepoRef is swapped for the mock, via
// `importOriginal`, now that it lives here (moved from github-webhook.ts).
vi.mock("../../src/services/host-git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HostGit>();
  return {
    ...actual,
    resolveRepoRef: mockResolveRepoRef,
  };
});
// #484 — host-git.ts's remote branch (for a project whose hostId isn't
// "local") resolves a real client via getRemoteHostClient(app, hostId),
// which needs a registered `hosts` row this file's fake `app` doesn't
// have. Mocked here, exactly like every other collaborator above, so a
// "remote-hosted project" test controls what that client returns rather
// than hitting a real DB lookup. Every non-remote test in this file never
// reaches this branch at all (host-git.ts's local path uses the real
// getGitStatus/resolveDefaultBaseRef/pushBranch, unaffected).
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: mockGetRemoteHostClient,
  HostRequestError: class extends Error {
    statusCode: number;
    constructor(hostId: string, statusCode: number, body: string) {
      super(`Host ${hostId} rejected the request: HTTP ${statusCode}${body ? ` — ${body}` : ""}`);
      this.name = "HostRequestError";
      this.statusCode = statusCode;
    }
  },
  HostUnreachableError: class extends Error {
    constructor(hostId: string, cause: unknown) {
      super(
        `Host ${hostId} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      this.name = "HostUnreachableError";
    }
  },
}));

const { promoteTaskToPR, openDraftPRForTask, closeDraftPRForTask } =
  await import("../../src/services/task-promote.js");
const { HostRequestError, HostUnreachableError } =
  await import("../../src/services/remote-host-client.js");

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
    reviewSeedDelivered: null,
    worktreePath: null,
    branchName: null,
    agentCommand: null,
    prUrl: null,
    prNumber: null,
    prTitle: null,
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

  it("#484 — promotes a remote-hosted task through the remote host proxy", async () => {
    const mockClient = {
      resolveGitStatus: vi.fn().mockResolvedValue({
        isRepo: true,
        status: {
          branch: "mullion/task-1",
          hash: "abc123",
          ahead: 0,
          behind: 0,
          files: [],
          isClean: true,
          hasConflicts: false,
        },
      }),
      resolveHostBaseRef: vi.fn().mockResolvedValue({ baseRef: "main", sha: null }),
      resolvePushBranch: vi.fn().mockResolvedValue({ ok: true }),
    };
    mockGetRemoteHostClient.mockReturnValue(mockClient);

    const result = await promoteTaskToPR(
      { config: {} } as never,
      baseTask({
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-1",
        branchName: "mullion/task-1",
      }),
      baseProject({ hostId: "remote-host-1", cwd: "/remote/project" }),
    );

    expect(result).toMatchObject({ ok: true, prNumber: 9 });
    expect(mockClient.resolveGitStatus).toHaveBeenCalledWith(
      "/remote/project/.mullion-worktrees/mullion-task-1",
      { fresh: true },
    );
    expect(mockClient.resolveHostBaseRef).toHaveBeenCalledWith("/remote/project");
    expect(mockClient.resolvePushBranch).toHaveBeenCalledWith(
      "/remote/project/.mullion-worktrees/mullion-task-1",
      "mullion/task-1",
      "ghp_token",
    );
    expect(mockCreatePullRequest).toHaveBeenCalled();
  });

  it("#484 — surfaces remote-not-supported (not a generic failure) when the host's agent build predates the promotion proxy routes", async () => {
    mockGetRemoteHostClient.mockReturnValue({
      resolveGitStatus: vi.fn().mockRejectedValue(new HostRequestError("remote-host-1", 404, "")),
    });

    const result = await promoteTaskToPR(
      { config: {} } as never,
      baseTask({
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-1",
        branchName: "mullion/task-1",
      }),
      baseProject({ hostId: "remote-host-1", cwd: "/remote/project" }),
    );

    expect(result).toMatchObject({ ok: false, reason: "remote-not-supported" });
    // Never even reaches token resolution/PR creation — the version-skew
    // failure is caught at the very first host-git.ts call.
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it("#484 — surfaces a retryable push-failed (not remote-not-supported) when the host is merely unreachable", async () => {
    mockGetRemoteHostClient.mockReturnValue({
      resolveGitStatus: vi
        .fn()
        .mockRejectedValue(new HostUnreachableError("remote-host-1", new Error("ECONNREFUSED"))),
    });

    const result = await promoteTaskToPR(
      { config: {} } as never,
      baseTask({
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-1",
        branchName: "mullion/task-1",
      }),
      baseProject({ hostId: "remote-host-1", cwd: "/remote/project" }),
    );

    // "no-worktree" (-> 502 badGateway, retryable), not the durable-sounding
    // "remote-not-supported" — see preparePromotion's own comment on why
    // these two failure reasons are kept distinct.
    expect(result).toMatchObject({ ok: false, reason: "no-worktree" });
  });

  // Independent review, PR #590 — every prior remote-hosted push test in
  // this file mocks resolvePushBranch as a success (or fails earlier, at
  // resolveGitStatus/resolveHostBaseRef); pushForPromotion's own transport-
  // failure branches (host-git.ts's pushHostBranch returning ok:false, as
  // opposed to a git-level push failure) had no coverage until now.
  it("#484 — surfaces push-failed when the push itself hits an unreachable host, after status/base-ref both succeeded", async () => {
    mockGetRemoteHostClient.mockReturnValue({
      resolveGitStatus: vi.fn().mockResolvedValue({
        isRepo: true,
        status: {
          branch: "mullion/task-1",
          hash: "abc123",
          ahead: 0,
          behind: 0,
          files: [],
          isClean: true,
          hasConflicts: false,
        },
      }),
      resolveHostBaseRef: vi.fn().mockResolvedValue({ baseRef: "main", sha: null }),
      resolvePushBranch: vi
        .fn()
        .mockRejectedValue(new HostUnreachableError("remote-host-1", new Error("ECONNREFUSED"))),
    });

    const result = await promoteTaskToPR(
      { config: {} } as never,
      baseTask({
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-1",
        branchName: "mullion/task-1",
      }),
      baseProject({ hostId: "remote-host-1", cwd: "/remote/project" }),
    );

    expect(result).toMatchObject({ ok: false, reason: "push-failed" });
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockRecordGithubSyncError).toHaveBeenCalledWith(
      expect.anything(),
      1,
      expect.stringContaining("Could not reach the task's host"),
    );
  });

  it("#484 — surfaces push-failed (not remote-not-supported) when the push route itself is version-skewed", async () => {
    mockGetRemoteHostClient.mockReturnValue({
      resolveGitStatus: vi.fn().mockResolvedValue({
        isRepo: true,
        status: {
          branch: "mullion/task-1",
          hash: "abc123",
          ahead: 0,
          behind: 0,
          files: [],
          isClean: true,
          hasConflicts: false,
        },
      }),
      resolveHostBaseRef: vi.fn().mockResolvedValue({ baseRef: "main", sha: null }),
      resolvePushBranch: vi.fn().mockRejectedValue(new HostRequestError("remote-host-1", 404, "")),
    });

    const result = await promoteTaskToPR(
      { config: {} } as never,
      baseTask({
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-1",
        branchName: "mullion/task-1",
      }),
      baseProject({ hostId: "remote-host-1", cwd: "/remote/project" }),
    );

    // The version-skew reason is only meaningful for the FIRST call
    // (preparePromotion's own status check) — by the time push runs, the
    // status/base-ref calls already succeeded against this same host, so a
    // 404 here is surfaced as push-failed, not a re-diagnosed
    // remote-not-supported.
    expect(result).toMatchObject({ ok: false, reason: "push-failed" });
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
    // #485 — a promotion failure that reaches (or fails to reach) GitHub
    // now durably records githubSyncError, not just the transient HTTP
    // response the caller returns.
    expect(mockRecordGithubSyncError).toHaveBeenCalledWith(
      expect.anything(),
      task.id,
      expect.stringContaining("No GitHub token"),
    );

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
    // #495 Hermes review, second pass — this is a purely local git
    // resolution failure, not a GitHub write/scope problem; recording it
    // as a "GitHub sync" error would misdirect a user toward re-checking
    // their token.
    expect(mockRecordGithubSyncError).not.toHaveBeenCalled();

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

    expect(result).toEqual({
      ok: true,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
      prNumber: 9,
    });
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      expect.objectContaining({
        title: "Fix the thing",
        head: "mullion/task-1",
        base: "main",
        body: expect.stringContaining("Detailed description"),
        // approve's own fallback create (no draft already open) opens
        // ready-for-review directly — there's nothing left to wait on.
        draft: false,
      }),
    );
    // Landed in the remote — the push actually happened, not just claimed.
    const branches = git(remote, ["branch", "--list", "mullion/task-1"]);
    expect(branches).toContain("mullion/task-1");
    // #485 — a successful promotion clears any stale sync error.
    expect(mockClearGithubSyncError).toHaveBeenCalledWith(expect.anything(), task.id);

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // #761 — the agent-supplied Conventional Commits title, when present,
  // wins over the raw task title.
  it("uses task.prTitle for the PR title when it's set", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);

    const task = baseTask({
      title: "Fix the thing",
      prTitle: "fix(widget): stop it exploding on Tuesdays",
      worktreePath: cwd,
      branchName: "mullion/task-1",
    });
    await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      expect.objectContaining({ title: "fix(widget): stop it exploding on Tuesdays" }),
    );

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // Absent (feature off, or a malformed/unreadable write that
  // task-reconciler.ts's ingest step already rejected) falls back to the
  // raw task title — never blocks promotion on this.
  it("falls back to the raw task title when task.prTitle is null", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);

    const task = baseTask({
      title: "Fix the thing",
      prTitle: null,
      worktreePath: cwd,
      branchName: "mullion/task-1",
    });
    await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      expect.objectContaining({ title: "Fix the thing" }),
    );

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
    // #485 — durably recorded, not just returned in this HTTP response.
    expect(mockRecordGithubSyncError).toHaveBeenCalledWith(
      expect.anything(),
      task.id,
      expect.stringContaining("insufficient scope"),
    );

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("#486 — resolves a createPullRequest 422 (PR already exists) to the existing PR instead of failing, without a second push/create", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    mockCreatePullRequest.mockRejectedValue(
      new GitHubApiError(
        "A pull request already exists for test-owner:mullion/task-1 (HTTP 422)",
        422,
      ),
    );
    mockFindPullRequestByHead.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
      nodeId: "PR_node9",
      draft: false,
    });

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toEqual({
      ok: true,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
      prNumber: 9,
    });
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    expect(mockFindPullRequestByHead).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      "test-owner:mullion/task-1",
    );
    expect(mockMarkPullRequestReadyForReview).not.toHaveBeenCalled();

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // Hermes review, PR #574 (finding #1) — approve's 422-recovery can resolve
  // to openDraftPRForTask's own draft PR for the same head branch (a race
  // between the reconciler's best-effort draft-open and approve's fallback
  // create). Approve wants draft: false, so recovering a still-draft PR must
  // mark it ready before returning ok:true — otherwise the task flips to
  // "done" with a PR hermes.yml's draft gate will never let Hermes review.
  it("#486/#574 — a 422-recovered PR that's still a draft gets marked ready when the caller wanted draft: false", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    mockCreatePullRequest.mockRejectedValue(
      new GitHubApiError(
        "A pull request already exists for test-owner:mullion/task-1 (HTTP 422)",
        422,
      ),
    );
    mockFindPullRequestByHead.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
      nodeId: "PR_node9",
      draft: true,
    });
    mockMarkPullRequestReadyForReview.mockResolvedValue(undefined);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toEqual({
      ok: true,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
      prNumber: 9,
    });
    expect(mockMarkPullRequestReadyForReview).toHaveBeenCalledWith("ghp_token", "PR_node9");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("#486/#574 — a mark-ready failure during 422-recovery surfaces as pr-create-failed instead of a false ok:true", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    mockCreatePullRequest.mockRejectedValue(
      new GitHubApiError(
        "A pull request already exists for test-owner:mullion/task-1 (HTTP 422)",
        422,
      ),
    );
    mockFindPullRequestByHead.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
      nodeId: "PR_node9",
      draft: true,
    });
    mockMarkPullRequestReadyForReview.mockRejectedValue(new Error("HTTP 403 — insufficient scope"));

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toMatchObject({ ok: false, reason: "pr-create-failed" });
    expect(mockRecordGithubSyncError).toHaveBeenCalledWith(
      expect.anything(),
      task.id,
      expect.stringContaining("insufficient scope"),
    );

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("#486 — a 422 that findPullRequestByHead can't resolve to an existing PR still falls back to pr-create-failed", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    mockCreatePullRequest.mockRejectedValue(
      new GitHubApiError("A pull request already exists (HTTP 422)", 422),
    );
    mockFindPullRequestByHead.mockResolvedValue(null);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toMatchObject({ ok: false, reason: "pr-create-failed" });

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  describe("when a draft PR is already open (task.prNumber set)", () => {
    beforeEach(() => {
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
        nodeId: "PR_node9",
        draft: true,
      });
      mockMarkPullRequestReadyForReview.mockResolvedValue(undefined);
      mockUpdatePullRequestTitle.mockResolvedValue(undefined);
    });

    it("pushes new commits, then marks the existing PR ready — never calls createPullRequest", async () => {
      const remote = createBareRemote();
      const cwd = createGitRepoWithRemote(remote);
      git(cwd, ["checkout", "-b", "mullion/task-1"]);
      fs.writeFileSync(path.join(cwd, "round2.txt"), "round 2 fix");
      git(cwd, ["add", "-A"]);
      git(cwd, ["commit", "-m", "address review", "--no-verify"]);

      const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1", prNumber: 9 });
      const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

      expect(result).toEqual({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/9",
        prNumber: 9,
      });
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(mockGetPullRequestByNumber).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        9,
      );
      expect(mockMarkPullRequestReadyForReview).toHaveBeenCalledWith("ghp_token", "PR_node9");
      // The round-2 commit actually reached the remote — mark-ready alone
      // (a GraphQL mutation) never pushes anything.
      const log = git(remote, ["log", "mullion/task-1", "--oneline"]);
      expect(log).toContain("address review");

      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("surfaces a mark-ready failure as pr-create-failed after the push already landed", async () => {
      const remote = createBareRemote();
      const cwd = createGitRepoWithRemote(remote);
      git(cwd, ["checkout", "-b", "mullion/task-1"]);
      mockMarkPullRequestReadyForReview.mockRejectedValue(
        new Error("HTTP 403 — insufficient scope"),
      );

      const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1", prNumber: 9 });
      const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

      expect(result).toMatchObject({ ok: false, reason: "pr-create-failed" });
      expect(mockRecordGithubSyncError).toHaveBeenCalledWith(
        expect.anything(),
        task.id,
        expect.stringContaining("insufficient scope"),
      );

      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    // Hermes review, PR #574 — task.prNumber can point at an already
    // ready-for-review PR (a prior approve attempt's mark-ready succeeded
    // but crashed before returning, or a 422-recovery elsewhere resolved to
    // a non-draft). Calling the mutation again errors on GitHub's side.
    it("skips the mark-ready mutation entirely when the PR is already ready for review", async () => {
      const remote = createBareRemote();
      const cwd = createGitRepoWithRemote(remote);
      git(cwd, ["checkout", "-b", "mullion/task-1"]);
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
        nodeId: "PR_node9",
        draft: false,
      });

      const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1", prNumber: 9 });
      const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

      expect(result).toEqual({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/9",
        prNumber: 9,
      });
      expect(mockMarkPullRequestReadyForReview).not.toHaveBeenCalled();

      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    // #782 — a later auto-return round can rewrite tasks.prTitle with a
    // changed Conventional Commits type; nothing previously re-synced that
    // to the live GitHub PR title (and therefore the eventual squash-merge
    // commit message). This describe block already fetches `pr` via
    // getPullRequestByNumber, so the fix compares against `pr.title` — zero
    // extra API calls in the common (unchanged) case.
    it("PATCHes the PR title when tasks.prTitle differs from the live GitHub title (#782)", async () => {
      const remote = createBareRemote();
      const cwd = createGitRepoWithRemote(remote);
      git(cwd, ["checkout", "-b", "mullion/task-1"]);
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
        nodeId: "PR_node9",
        draft: true,
        title: "docs: old title",
      });

      const task = baseTask({
        worktreePath: cwd,
        branchName: "mullion/task-1",
        prNumber: 9,
        prTitle: "feat: new title",
      });
      const result = await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

      expect(result.ok).toBe(true);
      expect(mockUpdatePullRequestTitle).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        9,
        "feat: new title",
      );

      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("does NOT PATCH the title when tasks.prTitle already matches the live GitHub title (#782)", async () => {
      const remote = createBareRemote();
      const cwd = createGitRepoWithRemote(remote);
      git(cwd, ["checkout", "-b", "mullion/task-1"]);
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
        nodeId: "PR_node9",
        draft: true,
        title: "feat: same title",
      });

      const task = baseTask({
        worktreePath: cwd,
        branchName: "mullion/task-1",
        prNumber: 9,
        prTitle: "feat: same title",
      });
      await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

      expect(mockUpdatePullRequestTitle).not.toHaveBeenCalled();

      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("does NOT PATCH the title when tasks.prTitle is null (#782)", async () => {
      const remote = createBareRemote();
      const cwd = createGitRepoWithRemote(remote);
      git(cwd, ["checkout", "-b", "mullion/task-1"]);
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
        nodeId: "PR_node9",
        draft: true,
        title: "raw task title",
      });

      const task = baseTask({
        worktreePath: cwd,
        branchName: "mullion/task-1",
        prNumber: 9,
        prTitle: null,
      });
      await promoteTaskToPR({ config: {} } as never, task, baseProject({ cwd }));

      expect(mockUpdatePullRequestTitle).not.toHaveBeenCalled();

      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("a title-PATCH failure doesn't fail the promotion (#782)", async () => {
      const remote = createBareRemote();
      const cwd = createGitRepoWithRemote(remote);
      git(cwd, ["checkout", "-b", "mullion/task-1"]);
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
        nodeId: "PR_node9",
        draft: true,
        title: "docs: old title",
      });
      mockUpdatePullRequestTitle.mockRejectedValue(new Error("HTTP 403 — insufficient scope"));

      const task = baseTask({
        worktreePath: cwd,
        branchName: "mullion/task-1",
        prNumber: 9,
        prTitle: "feat: new title",
      });
      const result = await promoteTaskToPR(
        { config: {}, log: { warn: vi.fn() } } as never,
        task,
        baseProject({ cwd }),
      );

      expect(result).toEqual({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/9",
        prNumber: 9,
      });

      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  });
});

describe("openDraftPRForTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockReturnValue("ghp_token");
    mockResolveRepoRef.mockResolvedValue({ owner: "test-owner", repo: "test-repo" });
    mockCreatePullRequest.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
    });
    mockUpdatePullRequestTitle.mockResolvedValue(undefined);
  });

  it("opens a draft PR when the task has no prNumber yet", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await openDraftPRForTask({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toEqual({
      ok: true,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
      prNumber: 9,
    });
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      expect.objectContaining({ draft: true }),
    );

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("on re-entry (prNumber already set), only pushes — never calls createPullRequest again", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    fs.writeFileSync(path.join(cwd, "round2.txt"), "round 2 fix");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "address review", "--no-verify"]);

    const task = baseTask({
      worktreePath: cwd,
      branchName: "mullion/task-1",
      prNumber: 9,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
    });
    const result = await openDraftPRForTask({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toEqual({
      ok: true,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
      prNumber: 9,
    });
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    const log = git(remote, ["log", "mullion/task-1", "--oneline"]);
    expect(log).toContain("address review");

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // #782 — this branch makes no other GitHub call (it returns
  // task.prUrl/prNumber straight from the DB row), so it takes a bare
  // PATCH rather than a GET-then-compare like promoteTaskToPR's own branch.
  it("PATCHes the title on re-entry when tasks.prTitle is set (#782)", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);

    const task = baseTask({
      worktreePath: cwd,
      branchName: "mullion/task-1",
      prNumber: 9,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
      prTitle: "feat: new title",
    });
    const result = await openDraftPRForTask({ config: {} } as never, task, baseProject({ cwd }));

    expect(result.ok).toBe(true);
    expect(mockUpdatePullRequestTitle).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      9,
      "feat: new title",
    );

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("does NOT PATCH the title on re-entry when tasks.prTitle is null (#782)", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);

    const task = baseTask({
      worktreePath: cwd,
      branchName: "mullion/task-1",
      prNumber: 9,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
      prTitle: null,
    });
    await openDraftPRForTask({ config: {} } as never, task, baseProject({ cwd }));

    expect(mockUpdatePullRequestTitle).not.toHaveBeenCalled();

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("a title-PATCH failure on re-entry doesn't fail the promotion (#782)", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    git(cwd, ["checkout", "-b", "mullion/task-1"]);
    mockUpdatePullRequestTitle.mockRejectedValue(new Error("HTTP 403 — insufficient scope"));

    const task = baseTask({
      worktreePath: cwd,
      branchName: "mullion/task-1",
      prNumber: 9,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
      prTitle: "feat: new title",
    });
    const result = await openDraftPRForTask(
      { config: {}, log: { warn: vi.fn() } } as never,
      task,
      baseProject({ cwd }),
    );

    expect(result).toEqual({
      ok: true,
      prUrl: "https://github.com/test-owner/test-repo/pull/9",
      prNumber: 9,
    });

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("#484 — opens a draft PR for a remote-hosted task through the remote host proxy", async () => {
    const mockClient = {
      resolveGitStatus: vi.fn().mockResolvedValue({
        isRepo: true,
        status: {
          branch: "mullion/task-1",
          hash: "abc123",
          ahead: 0,
          behind: 0,
          files: [],
          isClean: true,
          hasConflicts: false,
        },
      }),
      resolveHostBaseRef: vi.fn().mockResolvedValue({ baseRef: "main", sha: null }),
      resolvePushBranch: vi.fn().mockResolvedValue({ ok: true }),
    };
    mockGetRemoteHostClient.mockReturnValue(mockClient);

    const result = await openDraftPRForTask(
      { config: {} } as never,
      baseTask({
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-1",
        branchName: "mullion/task-1",
      }),
      baseProject({ hostId: "remote-host-1", cwd: "/remote/project" }),
    );

    expect(result).toMatchObject({ ok: true, prNumber: 9 });
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      expect.objectContaining({ draft: true }),
    );
  });

  it("#484 — surfaces remote-not-supported without recording a sync error, when the host's agent build predates the proxy routes (version skew, not a real sync problem)", async () => {
    mockGetRemoteHostClient.mockReturnValue({
      resolveGitStatus: vi.fn().mockRejectedValue(new HostRequestError("remote-host-1", 404, "")),
    });

    const result = await openDraftPRForTask(
      { config: {} } as never,
      baseTask({
        worktreePath: "/remote/project/.mullion-worktrees/mullion-task-1",
        branchName: "mullion/task-1",
      }),
      baseProject({ hostId: "remote-host-1", cwd: "/remote/project" }),
    );
    expect(result).toMatchObject({ ok: false, reason: "remote-not-supported" });
    expect(mockRecordGithubSyncError).not.toHaveBeenCalled();
  });

  it("skips the PR (dirty-tree) rather than failing when the worktree has uncommitted changes", async () => {
    const remote = createBareRemote();
    const cwd = createGitRepoWithRemote(remote);
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "uncommitted");

    const task = baseTask({ worktreePath: cwd, branchName: "mullion/task-1" });
    const result = await openDraftPRForTask({ config: {} } as never, task, baseProject({ cwd }));

    expect(result).toMatchObject({ ok: false, reason: "dirty-tree" });
    expect(mockCreatePullRequest).not.toHaveBeenCalled();

    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("closeDraftPRForTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockReturnValue("ghp_token");
    mockResolveRepoRef.mockResolvedValue({ owner: "test-owner", repo: "test-repo" });
    mockClosePullRequest.mockResolvedValue(undefined);
  });

  it("closes the PR when the task has a recorded prNumber", async () => {
    const task = baseTask({ prNumber: 9 });
    await closeDraftPRForTask({ config: {} } as never, task, baseProject());

    expect(mockClosePullRequest).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 9);
    expect(mockClearGithubSyncError).toHaveBeenCalledWith(expect.anything(), task.id);
  });

  it("no-ops when the task never got a PR", async () => {
    const task = baseTask({ prNumber: null });
    await closeDraftPRForTask({ config: {} } as never, task, baseProject());

    expect(mockClosePullRequest).not.toHaveBeenCalled();
  });

  it("#484 — closes the PR for a remote-hosted project too (a pure GitHub API write, no host guard)", async () => {
    const task = baseTask({ prNumber: 9 });
    await closeDraftPRForTask(
      { config: {} } as never,
      task,
      baseProject({ hostId: "remote-host-1" }),
    );

    expect(mockClosePullRequest).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 9);
  });

  it("records a sync error, rather than throwing, when the close write fails", async () => {
    mockClosePullRequest.mockRejectedValue(new Error("HTTP 403 — insufficient scope"));
    const task = baseTask({ prNumber: 9 });

    await expect(
      closeDraftPRForTask({ config: {} } as never, task, baseProject()),
    ).resolves.toBeUndefined();
    expect(mockRecordGithubSyncError).toHaveBeenCalledWith(
      expect.anything(),
      task.id,
      expect.stringContaining("insufficient scope"),
    );
  });
});
