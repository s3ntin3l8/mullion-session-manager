import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import type * as GithubWrite from "../../src/services/github-write.js";
import type * as HostGit from "../../src/services/host-git.js";
import type * as WorkflowGate from "../../src/services/task-workflow-gate.js";
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
const mockResolveWorkflowWriteToken = vi.fn();
const mockEvaluateWorkflowGate = vi.fn();
const mockRecordWorkflowHold = vi.fn();
const mockClearWorkflowHold = vi.fn();
const mockBroadcastTaskEvent = vi.fn();
const mockNotifyTaskNeedsAttention = vi.fn();

vi.mock("../../src/services/github-integration.js", () => ({
  resolveGitHubToken: mockGetToken,
  resolveWorkflowWriteToken: mockResolveWorkflowWriteToken,
}));
// The gate reads the worktree's diff and head and writes the task row; mocked
// like every other collaborator here (its own behavior is covered in
// task-workflow-gate.test.ts). Defaults to "clear" in beforeEach.
vi.mock("../../src/services/task-workflow-gate.js", async (importOriginal) => {
  // Only the functions are swapped; the real WORKFLOW_UNVERIFIED_PREFIX stays,
  // so the banner-clearing contract is pinned to the production constant.
  const actual = await importOriginal<typeof WorkflowGate>();
  return {
    ...actual,
    evaluateWorkflowGate: mockEvaluateWorkflowGate,
    recordWorkflowHold: mockRecordWorkflowHold,
    clearWorkflowHold: mockClearWorkflowHold,
  };
});
vi.mock("../../src/services/task-events.js", () => ({
  broadcastTaskEvent: mockBroadcastTaskEvent,
}));
vi.mock("../../src/services/push-delivery.js", () => ({
  notifyTaskNeedsAttention: mockNotifyTaskNeedsAttention,
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
    // Real push, wrapped so a test can assert which token it was handed.
    pushHostBranch: vi.fn(actual.pushHostBranch),
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
    mockEvaluateWorkflowGate.mockResolvedValue({ kind: "clear" });
    mockGetToken.mockReturnValue("ghp_token");
    mockResolveRepoRef.mockResolvedValue({ owner: "test-owner", repo: "test-repo" });
    mockCreatePullRequest.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/test-owner/test-repo/pull/9",
    });
    mockUpdatePullRequestTitle.mockResolvedValue(undefined);
  });

  describe("a worktree left stale by an outside rebase", () => {
    // A task worktree on mullion/task-1 with one commit, whose branch ref is
    // then moved to a rebased tip from a second (detached) checkout. The task
    // worktree's HEAD follows the ref; its index and files stay at the old tip.
    function makeStale() {
      const remote = createBareRemote();
      const cwd = createGitRepoWithRemote(remote);
      const wt = path.join(cwd, ".mullion-worktrees", "mullion-task-1");
      git(cwd, ["worktree", "add", "-b", "mullion/task-1", wt, "main"]);
      fs.writeFileSync(path.join(wt, "b.txt"), "b");
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "-m", "task work", "--no-verify"]);
      // main moves on, then the branch is rebased onto it from elsewhere.
      fs.writeFileSync(path.join(cwd, "c.txt"), "c");
      git(cwd, ["add", "-A"]);
      git(cwd, ["commit", "-m", "main moves", "--no-verify"]);
      const other = path.join(cwd, ".wt-other");
      git(cwd, ["worktree", "add", "--detach", other, "mullion/task-1"]);
      git(other, ["rebase", "main"]);
      const rebased = git(other, ["rev-parse", "HEAD"]).trim();
      git(cwd, ["update-ref", "-m", "outside rebase", "refs/heads/mullion/task-1", rebased]);
      git(cwd, ["worktree", "remove", "--force", other]);
      const task = baseTask({ worktreePath: wt, branchName: "mullion/task-1" });
      const cleanup = () => {
        fs.rmSync(remote, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
      };
      return { cwd, wt, task, cleanup, rebased };
    }
    const appWithLog = (info = vi.fn()) => ({ config: {}, log: { info, warn: vi.fn() } }) as never;

    it("is really stale: staged changes, empty unstaged diff", () => {
      const { wt, cleanup } = makeStale();
      expect(git(wt, ["status", "--porcelain"]).trim()).not.toBe("");
      expect(git(wt, ["diff"]).trim()).toBe("");
      cleanup();
    });

    it("resyncs the worktree and continues approving", async () => {
      const { cwd, wt, task, cleanup, rebased } = makeStale();
      const info = vi.fn();
      const result = await promoteTaskToPR(appWithLog(info), task, baseProject({ cwd }));

      expect(result).toMatchObject({ ok: true, prNumber: 9 });
      expect(git(wt, ["status", "--porcelain"]).trim()).toBe("");
      expect(git(wt, ["rev-parse", "HEAD"]).trim()).toBe(rebased);
      expect(fs.existsSync(path.join(wt, "c.txt"))).toBe(true);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 1, staleTree: expect.any(String) }),
        expect.stringContaining("resynced"),
      );
      cleanup();
    });

    it("refuses and changes nothing when an unstaged edit sits on top of the stale index", async () => {
      const { cwd, wt, task, cleanup } = makeStale();
      fs.writeFileSync(path.join(wt, "a.txt"), "edited by hand");
      const before = git(wt, ["status", "--porcelain"]);
      const result = await promoteTaskToPR(appWithLog(), task, baseProject({ cwd }));

      expect(result).toMatchObject({
        ok: false,
        reason: "dirty-tree",
        detail: expect.stringContaining("uncommitted changes"),
      });
      expect(fs.readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("edited by hand");
      expect(git(wt, ["status", "--porcelain"])).toBe(before);
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      cleanup();
    });

    it("refuses a staged-only dirty tree that matches no earlier branch tip", async () => {
      const { cwd, wt, task, cleanup } = makeStale();
      git(wt, ["reset", "--hard", "HEAD"]);
      fs.writeFileSync(path.join(wt, "new.txt"), "staged by a human");
      git(wt, ["add", "new.txt"]);
      const result = await promoteTaskToPR(appWithLog(), task, baseProject({ cwd }));

      expect(result).toMatchObject({
        ok: false,
        reason: "dirty-tree",
        detail: expect.stringContaining("uncommitted changes"),
      });
      expect(fs.existsSync(path.join(wt, "new.txt"))).toBe(true);
      cleanup();
    });

    it.skipIf(process.getuid?.() === 0)(
      "refuses with a distinct detail when the resync itself fails",
      async () => {
        const { cwd, wt, task, cleanup } = makeStale();
        // A read-only worktree directory makes `git reset --hard` fail while the
        // pre-checks (which only write inside the git dir) still pass.
        fs.chmodSync(wt, 0o555);
        const result = await promoteTaskToPR(appWithLog(), task, baseProject({ cwd }));
        fs.chmodSync(wt, 0o755);

        expect(result).toMatchObject({
          ok: false,
          reason: "dirty-tree",
          detail: expect.stringContaining("out of date with its branch and could not be resynced"),
        });
        expect((result as { detail: string }).detail).not.toContain("uncommitted changes");
        cleanup();
      },
    );

    it("resyncs a remote-hosted worktree through the agent and re-reads the status", async () => {
      const dirty = {
        branch: "mullion/task-1",
        hash: "abc",
        ahead: 0,
        behind: 0,
        files: [{ path: "b.txt", status: "D" }],
        isClean: false,
        hasConflicts: false,
      };
      const clean = { ...dirty, files: [], isClean: true };
      const client = {
        resolveGitStatus: vi
          .fn()
          .mockResolvedValueOnce({ isRepo: true, status: dirty })
          .mockResolvedValueOnce({ isRepo: true, status: clean }),
        resolveResyncStaleWorktree: vi
          .fn()
          .mockResolvedValue({ outcome: "resynced", tree: "t", matchedCommit: "m", head: "h" }),
        resolveHostBaseRef: vi.fn().mockResolvedValue({ baseRef: "main", sha: null }),
        resolvePushBranch: vi.fn().mockResolvedValue({ ok: true }),
      };
      mockGetRemoteHostClient.mockReturnValue(client);
      const result = await promoteTaskToPR(
        appWithLog(),
        baseTask({ worktreePath: "/remote/wt", branchName: "mullion/task-1" }),
        baseProject({ hostId: "remote-host-1", cwd: "/remote/project" }),
      );

      expect(result).toMatchObject({ ok: true });
      expect(client.resolveResyncStaleWorktree).toHaveBeenCalledWith(
        "/remote/wt",
        "mullion/task-1",
      );
      expect(client.resolveGitStatus).toHaveBeenCalledTimes(2);
    });
  });
});
