import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const mockGetToken = vi.fn();
const mockGetIntegration = vi.fn();
const mockResolveRepoRef = vi.fn();
const mockAddLabels = vi.fn();
const mockRemoveLabel = vi.fn();
const mockCreateComment = vi.fn();
const mockSetAssignees = vi.fn();
const mockCloseIssue = vi.fn();
const mockGetIssueState = vi.fn();
const mockGetRemoteHostClient = vi.fn();
const mockGetPullRequestByNumber = vi.fn();
const mockCreatePullRequestReview = vi.fn();

vi.mock("../../src/services/github-integration.js", () => ({
  resolveGitHubToken: mockGetToken,
  getIntegration: mockGetIntegration,
}));
vi.mock("../../src/services/host-git.js", () => ({
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-write.js", () => ({
  addLabels: mockAddLabels,
  removeLabel: mockRemoveLabel,
  createComment: mockCreateComment,
  setAssignees: mockSetAssignees,
  closeIssue: mockCloseIssue,
  getIssueState: mockGetIssueState,
  getPullRequestByNumber: mockGetPullRequestByNumber,
  createPullRequestReview: mockCreatePullRequestReview,
}));
// #484 — computeTaskDiffStat's remote-hosted branch dispatches to
// getRemoteHostClient(app, hostId).resolveGitDiffStats(...); mocked so
// those tests don't need a registered host row.
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: mockGetRemoteHostClient,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const {
  syncTaskTransition,
  syncClosedIssueToLocal,
  syncUnlabeledIssueToLocal,
  resetProgressThrottleForTests,
  recordGithubSyncError,
  clearGithubSyncError,
  computeTaskDiffStat,
  postReviewFindingsComment,
  LABEL_CLAIMED,
  LABEL_REVIEWING,
  LABEL_DONE,
} = await import("../../src/services/task-github-sync.js");
const { eq } = await import("drizzle-orm");
const { execFileSync } = await import("node:child_process");
const { gitEnv } = await import("../../src/services/git-env.js");

const tmpDb = path.join(os.tmpdir(), `task-github-sync-test-${process.pid}.db`);
const project = { cwd: "/tmp/not-used", hostId: "local" };
const repoRef = { owner: "test-owner", repo: "test-repo" };

function baseTask(overrides: Partial<typeof tasks.$inferSelect> = {}) {
  return {
    id: 1,
    projectId: 1,
    issueNumber: 5,
    title: "Some task",
    body: null,
    htmlUrl: null,
    status: "claimed",
    boardOrder: 0,
    sessionId: null,
    reviewSessionId: null,
    reviewSeedDelivered: null,
    worktreePath: null,
    branchName: null,
    baseSha: null,
    agentCommand: null,
    prUrl: null,
    prNumber: null,
    assignee: null,
    failureReason: null,
    githubSyncError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    claimedAt: new Date(),
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
    ...overrides,
  } as typeof tasks.$inferSelect;
}

describe("task-github-sync", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_PROGRESS_COMMENT_MINUTES = "15";
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-github-sync-test-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "sync-test-project", cwd },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_PROGRESS_COMMENT_MINUTES;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetProgressThrottleForTests();
    mockGetToken.mockReturnValue("ghp_token");
    mockGetIntegration.mockReturnValue({ login: "mullion-bot" });
    mockResolveRepoRef.mockResolvedValue(repoRef);
  });

  describe("syncTaskTransition", () => {
    it("is a no-op for a local task (issueNumber null) — never even resolves the repo", async () => {
      await syncTaskTransition(app, baseTask({ issueNumber: null }), project, "claimed");
      expect(mockResolveRepoRef).not.toHaveBeenCalled();
      expect(mockAddLabels).not.toHaveBeenCalled();
    });

    it("is a no-op when no GitHub token is connected", async () => {
      // #489 — repoRef is resolved BEFORE the token now (resolveGitHubToken
      // needs the repo to decide whether a GitHub App installation covers
      // it), the reverse of the old getToken-first ordering — so this
      // asserts resolveRepoRef WAS called, and everything past the token
      // check wasn't.
      mockGetToken.mockReturnValue(null);
      await syncTaskTransition(app, baseTask(), project, "claimed");
      expect(mockResolveRepoRef).toHaveBeenCalled();
      expect(mockAddLabels).not.toHaveBeenCalled();
    });

    it("is a no-op when the project's repo can't be resolved", async () => {
      mockResolveRepoRef.mockResolvedValue(null);
      await syncTaskTransition(app, baseTask(), project, "claimed");
      expect(mockAddLabels).not.toHaveBeenCalled();
    });

    it("claimed: adds the label, comments, and assigns the connected login", async () => {
      await syncTaskTransition(app, baseTask(), project, "claimed");
      expect(mockAddLabels).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 5, [
        LABEL_CLAIMED,
      ]);
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        expect.stringContaining("claimed"),
      );
      expect(mockSetAssignees).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 5, [
        "mullion-bot",
      ]);
    });

    it("claimed: skips assignment when no login is known", async () => {
      mockGetIntegration.mockReturnValue({ login: null });
      await syncTaskTransition(app, baseTask(), project, "claimed");
      expect(mockSetAssignees).not.toHaveBeenCalled();
    });

    it("in_progress: posts a progress comment", async () => {
      await syncTaskTransition(app, baseTask({ status: "in_progress" }), project, "in_progress");
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    it("in_progress: throttles a second comment within MULLION_TASK_PROGRESS_COMMENT_MINUTES", async () => {
      const task = baseTask({ status: "in_progress" });
      await syncTaskTransition(app, task, project, "in_progress");
      await syncTaskTransition(app, task, project, "in_progress");
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
    });

    it("in_progress: never throttles when MULLION_TASK_PROGRESS_COMMENT_MINUTES=0", async () => {
      // Mutates the already-built app's config directly rather than
      // building a second app against the same DATABASE_URL — closeDb()
      // manages one process-wide singleton connection, so a second app's
      // .close() would tear down the shared connection out from under
      // every later test in this file.
      const original = app.config.MULLION_TASK_PROGRESS_COMMENT_MINUTES;
      app.config.MULLION_TASK_PROGRESS_COMMENT_MINUTES = 0;
      try {
        const task = baseTask({ status: "in_progress" });
        await syncTaskTransition(app, task, project, "in_progress");
        await syncTaskTransition(app, task, project, "in_progress");
        expect(mockCreateComment).toHaveBeenCalledTimes(2);
      } finally {
        app.config.MULLION_TASK_PROGRESS_COMMENT_MINUTES = original;
      }
    });

    // Independent review, PR #480 — proves the settings override actually
    // reaches this throttle check (task-config.ts's resolver), not just
    // that the pure resolver function returns the right number. The env
    // var stays at its default (15) so only the settings override could be
    // responsible for the lack of throttling here.
    it("in_progress: never throttles when settings.taskMaster.progressCommentMinutes overrides a nonzero env default to 0", async () => {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { progressCommentMinutes: 0 } },
      });
      try {
        const task = baseTask({ status: "in_progress" });
        await syncTaskTransition(app, task, project, "in_progress");
        await syncTaskTransition(app, task, project, "in_progress");
        expect(mockCreateComment).toHaveBeenCalledTimes(2);
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { progressCommentMinutes: -1 } },
        });
      }
    });

    it("reviewing: swaps claimed->reviewing labels and comments without a diff summary when none is passed", async () => {
      await syncTaskTransition(app, baseTask({ status: "reviewing" }), project, "reviewing");
      expect(mockRemoveLabel).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        LABEL_CLAIMED,
      );
      expect(mockAddLabels).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 5, [
        LABEL_REVIEWING,
      ]);
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        "Task ready for review.",
      );
    });

    it("reviewing: appends a diff-stat summary to the comment when one is passed (#491)", async () => {
      await syncTaskTransition(app, baseTask({ status: "reviewing" }), project, "reviewing", {
        diffStat: { filesChanged: 34, insertions: 2847, deletions: 1203 },
      });
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        "Task ready for review. (+2847/-1203 across 34 files)",
      );
    });

    it("reviewing: singularizes 'file' for a one-file diff-stat", async () => {
      await syncTaskTransition(app, baseTask({ status: "reviewing" }), project, "reviewing", {
        diffStat: { filesChanged: 1, insertions: 3, deletions: 0 },
      });
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        "Task ready for review. (+3/-0 across 1 file)",
      );
    });

    it("done: swaps reviewing->done labels, comments with the PR link when present, and closes", async () => {
      await syncTaskTransition(app, baseTask({ status: "done" }), project, "done", {
        prUrl: "https://github.com/test-owner/test-repo/pull/9",
      });
      expect(mockRemoveLabel).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        LABEL_REVIEWING,
      );
      expect(mockAddLabels).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 5, [
        LABEL_DONE,
      ]);
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        expect.stringContaining("https://github.com/test-owner/test-repo/pull/9"),
      );
      expect(mockCloseIssue).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 5);
    });

    it("done: comments without a PR link when none is set yet (pre-6.7)", async () => {
      await syncTaskTransition(app, baseTask({ status: "done" }), project, "done", {});
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        "Approved.",
      );
    });

    it("failed: removes both active labels and comments the failure reason", async () => {
      await syncTaskTransition(
        app,
        baseTask({ status: "failed", failureReason: "budget exceeded after 120 minutes" }),
        project,
        "failed",
      );
      expect(mockRemoveLabel).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        LABEL_CLAIMED,
      );
      expect(mockRemoveLabel).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        LABEL_REVIEWING,
      );
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        expect.stringContaining("budget exceeded after 120 minutes"),
      );
    });

    it("rejected: comments the feedback text when given, a generic message otherwise", async () => {
      await syncTaskTransition(app, baseTask({ status: "in_progress" }), project, "rejected", {
        feedback: "please add tests",
      });
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        expect.stringContaining("please add tests"),
      );
    });

    it("never throws when a write fails — logs and returns", async () => {
      mockAddLabels.mockRejectedValueOnce(new Error("GitHub is down"));
      await expect(
        syncTaskTransition(app, baseTask(), project, "claimed"),
      ).resolves.toBeUndefined();
    });

    // #485 — a write failure used to be logged and dropped with no durable
    // trace on the task itself. These use a real inserted row (unlike the
    // test above's un-inserted baseTask()) so the recording UPDATE has
    // something to match.
    function insertTaskForTransition(issueNumber: number) {
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber, title: "t", status: "claimed" })
        .returning()
        .all();
      return row;
    }

    it("records githubSyncError on the task row when a write fails", async () => {
      mockAddLabels.mockRejectedValueOnce(new Error("GitHub rejected this write (HTTP 403)"));
      const task = insertTaskForTransition(201);

      await syncTaskTransition(app, task, project, "claimed");

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.githubSyncError).toContain("HTTP 403");
    });

    it("clears a previously-recorded githubSyncError once a later sync succeeds", async () => {
      const task = insertTaskForTransition(202);
      app.db
        .update(tasks)
        .set({ githubSyncError: "stale error" })
        .where(eq(tasks.id, task.id))
        .run();

      await syncTaskTransition(app, task, project, "in_progress");

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.githubSyncError).toBeNull();
    });

    // #495 Hermes review — a throttled in_progress tick makes no GitHub
    // call at all; clearing githubSyncError for it would silently hide a
    // real, still-unresolved write failure recorded by an earlier
    // transition.
    it("does NOT clear a previously-recorded githubSyncError when the write is skipped by the progress-comment throttle", async () => {
      const task = insertTaskForTransition(203);
      app.db
        .update(tasks)
        .set({ githubSyncError: "stale error" })
        .where(eq(tasks.id, task.id))
        .run();

      // First call establishes the throttle timestamp (not itself
      // throttled), which also clears the error via a real write — reset
      // it afterward so the second, throttled call is the one under test.
      await syncTaskTransition(app, task, project, "in_progress");
      app.db
        .update(tasks)
        .set({ githubSyncError: "stale error" })
        .where(eq(tasks.id, task.id))
        .run();
      mockCreateComment.mockClear();

      await syncTaskTransition(app, task, project, "in_progress");

      expect(mockCreateComment).not.toHaveBeenCalled();
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.githubSyncError).toBe("stale error");
    });
  });

  describe("computeTaskDiffStat (#491)", () => {
    it("returns undefined when the task has no worktreePath", async () => {
      const result = await computeTaskDiffStat(
        app,
        baseTask({ worktreePath: null, baseSha: "abc" }),
        project,
      );
      expect(result).toBeUndefined();
    });

    it("returns undefined when the task has no baseSha", async () => {
      const result = await computeTaskDiffStat(
        app,
        baseTask({ worktreePath: "/tmp/x", baseSha: null }),
        project,
      );
      expect(result).toBeUndefined();
    });

    it("computes real diff stats against the pinned baseSha", async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-diff-stat-test-"));
      const git = (args: string[]) =>
        execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
      git(["init", "-b", "main"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      git(["add", "-A"]);
      git(["commit", "-m", "initial", "--no-verify"]);
      const baseSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { env: gitEnv() })
        .toString("utf8")
        .trim();
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\nb\nc\n");
      fs.writeFileSync(path.join(cwd, "d.txt"), "d\n");
      git(["add", "-A"]);
      git(["commit", "-m", "work", "--no-verify"]);

      const result = await computeTaskDiffStat(
        app,
        baseTask({ worktreePath: cwd, baseSha }),
        project,
      );

      expect(result).toEqual({ filesChanged: 2, insertions: 3, deletions: 0 });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("#484 — dispatches to the remote host's /internal/git-diff for a remote-hosted task", async () => {
      const remoteProject = { cwd: "/remote/project", hostId: "remote-host-1" };
      const mockResolveGitDiffStats = vi.fn().mockResolvedValue({
        isRepo: true,
        stats: { filesChanged: 1, insertions: 2, deletions: 0 },
      });
      mockGetRemoteHostClient.mockReturnValue({ resolveGitDiffStats: mockResolveGitDiffStats });

      const result = await computeTaskDiffStat(
        app,
        baseTask({
          worktreePath: "/remote/project/.mullion-worktrees/mullion-task-1",
          baseSha: "abc",
        }),
        remoteProject,
      );

      expect(mockResolveGitDiffStats).toHaveBeenCalledWith(
        "/remote/project/.mullion-worktrees/mullion-task-1",
        "abc",
      );
      expect(result).toEqual({ filesChanged: 1, insertions: 2, deletions: 0 });
    });

    it("#484 — returns undefined (not a throw) when the remote host is unreachable", async () => {
      const remoteProject = { cwd: "/remote/project", hostId: "remote-host-1" };
      mockGetRemoteHostClient.mockReturnValue({
        resolveGitDiffStats: vi.fn().mockRejectedValue(new Error("host unreachable")),
      });

      const result = await computeTaskDiffStat(
        app,
        baseTask({
          worktreePath: "/remote/project/.mullion-worktrees/mullion-task-1",
          baseSha: "abc",
        }),
        remoteProject,
      );

      expect(result).toBeUndefined();
    });
  });

  describe("syncClosedIssueToLocal", () => {
    function insertTask(status: string, issueNumber: number | null = 5) {
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber, title: "t", status })
        .returning()
        .all();
      return row;
    }

    it("is a no-op for a local task", async () => {
      const task = insertTask("reviewing", null);
      await syncClosedIssueToLocal(app, task, project);
      expect(mockGetIssueState).not.toHaveBeenCalled();
    });

    it("does not check GitHub when the task can't legally reach 'done' from its current status", async () => {
      const task = insertTask("claimed", 101);
      await syncClosedIssueToLocal(app, task, project);
      expect(mockGetIssueState).not.toHaveBeenCalled();
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("claimed");
    });

    it("leaves the task alone when the issue is still open", async () => {
      mockGetIssueState.mockResolvedValue({ state: "open", labels: ["mullion-reviewing"] });
      const task = insertTask("reviewing", 102);
      await syncClosedIssueToLocal(app, task, project);
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("reviewing");
    });

    it("flips a reviewing task to done when its issue is closed on GitHub", async () => {
      mockGetIssueState.mockResolvedValue({ state: "closed", labels: [] });
      const task = insertTask("reviewing", 103);
      await syncClosedIssueToLocal(app, task, project);
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("done");
      expect(row.completedAt).not.toBeNull();
    });

    it("never throws when the read-back check fails", async () => {
      mockGetIssueState.mockRejectedValueOnce(new Error("rate limited"));
      const task = insertTask("reviewing", 104);
      await expect(syncClosedIssueToLocal(app, task, project)).resolves.toBeUndefined();
    });

    // #495 Hermes review, second pass — githubSyncError's only clearing
    // path is a successful WRITE, so recording a transient read-back
    // failure here (a rate limit, a 5xx) would leave it stuck on the
    // banner until some unrelated write happened to fire, long after the
    // read-back problem itself resolved. Logged, not durably recorded.
    it("does NOT record githubSyncError when the read-back check fails — only writes are durably recorded", async () => {
      mockGetIssueState.mockRejectedValueOnce(new Error("rate limited"));
      const task = insertTask("reviewing", 105);

      await syncClosedIssueToLocal(app, task, project);

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.githubSyncError).toBeNull();
    });

    // #495 Hermes review — a successful READ proves only read connectivity,
    // not write scope, which is exactly the #485 failure mode (an
    // under-scoped token 403s writes but reads fine). Clearing here would
    // let this sweep silently hide a real write-403 recorded elsewhere.
    it("does NOT clear a previously-recorded githubSyncError on a successful read-back check — a read proves nothing about write scope", async () => {
      mockGetIssueState.mockResolvedValue({ state: "open", labels: ["mullion-reviewing"] });
      const task = insertTask("reviewing", 106);
      app.db
        .update(tasks)
        .set({ githubSyncError: "stale error" })
        .where(eq(tasks.id, task.id))
        .run();

      await syncClosedIssueToLocal(app, task, project);

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.githubSyncError).toBe("stale error");
    });
  });

  describe("syncUnlabeledIssueToLocal (#490a)", () => {
    function insertTask(status: string, issueNumber = 5) {
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber, title: "t", status })
        .returning()
        .all();
      return row;
    }

    it("fails a backlog task and syncs the failure to GitHub", async () => {
      const task = insertTask("backlog", 401);
      await syncUnlabeledIssueToLocal(app, task, project);

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("failed");
      expect(row.failureReason).toBe("GitHub issue lost its tracking label");
      expect(row.completedAt).not.toBeNull();
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        401,
        expect.stringContaining("GitHub issue lost its tracking label"),
      );
    });

    it("fails a ready task the same way", async () => {
      const task = insertTask("ready", 402);
      await syncUnlabeledIssueToLocal(app, task, project);

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("failed");
    });

    it.each<[string, number]>([
      ["claimed", 411],
      ["in_progress", 412],
      ["reviewing", 413],
    ])("leaves a %s task untouched — it has real work behind it", async (status, issueNumber) => {
      const task = insertTask(status, issueNumber);
      await syncUnlabeledIssueToLocal(app, task, project);

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe(status);
      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockRemoveLabel).not.toHaveBeenCalled();
    });

    it("is status-guarded against a concurrent write racing this one", async () => {
      const task = insertTask("ready", 420);
      // Simulate a status change landing between the caller's snapshot and
      // this function's own UPDATE (same guard syncClosedIssueToLocal uses).
      app.db.update(tasks).set({ status: "claimed" }).where(eq(tasks.id, task.id)).run();

      await syncUnlabeledIssueToLocal(app, task, project);

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("claimed");
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    // The poll loop's read-back (task-watcher.ts) is the one caller that can
    // tell "closed" and "unlabeled" apart — it passes the reason explicitly
    // once it has confirmed via getIssueState. Previously both shared one
    // string, which misreported every closed-issue failure as a label
    // problem and was indistinguishable from upsertIssueTask's own
    // relabel-resurrection check (task-watcher.ts).
    it("records a caller-supplied failure reason instead of the label-lost default", async () => {
      const task = insertTask("ready", 421);
      await syncUnlabeledIssueToLocal(app, task, project, "GitHub issue was closed");

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("failed");
      expect(row.failureReason).toBe("GitHub issue was closed");
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        421,
        expect.stringContaining("GitHub issue was closed"),
      );
    });
  });

  describe("postReviewFindingsComment", () => {
    beforeEach(() => {
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://github.com/o/r/pull/9",
        nodeId: "PR_node9",
        draft: true,
        headSha: "abc123",
      });
      mockCreatePullRequestReview.mockResolvedValue({
        id: 555,
        htmlUrl: "https://github.com/o/r/pull/9#pullrequestreview-555",
      });
    });

    it("posts an actual PR review, with each finding as an inline anchored comment, when a PR exists", async () => {
      const task = baseTask({ issueNumber: 5, prNumber: 9 });

      await postReviewFindingsComment(app, task, project, {
        body: "## Round 1\n\nOne errcheck failure.\n\n- **a.go:42** — unchecked error",
        reviewSummary: "## Round 1\n\nOne errcheck failure.",
        findings: [
          { path: "a.go", line: 42, side: "RIGHT", severity: "major", body: "unchecked error" },
        ],
      });

      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockGetPullRequestByNumber).toHaveBeenCalledWith(
        "ghp_token",
        repoRef.owner,
        repoRef.repo,
        9,
      );
      expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
        "ghp_token",
        repoRef.owner,
        repoRef.repo,
        9,
        {
          body: "## Round 1\n\nOne errcheck failure.",
          commitId: "abc123",
          comments: [{ path: "a.go", line: 42, side: "RIGHT", body: "[major] unchecked error" }],
        },
      );
    });

    it("posts the full body with no inline comments when there are no findings to anchor", async () => {
      const task = baseTask({ issueNumber: 5, prNumber: 9 });

      await postReviewFindingsComment(app, task, project, {
        body: "## Round 1\n\nReview agent finished but wrote no findings file — treat this review as inconclusive.",
      });

      expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
        "ghp_token",
        repoRef.owner,
        repoRef.repo,
        9,
        {
          body: "## Round 1\n\nReview agent finished but wrote no findings file — treat this review as inconclusive.",
          commitId: "abc123",
          comments: undefined,
        },
      );
    });

    it("retries with findings folded into the body when GitHub rejects the inline anchors (422)", async () => {
      const { GitHubApiError } = await import("../../src/services/github.js");
      mockCreatePullRequestReview
        .mockRejectedValueOnce(new GitHubApiError("Validation Failed", 422))
        .mockResolvedValueOnce({
          id: 556,
          htmlUrl: "https://github.com/o/r/pull/9#pullrequestreview-556",
        });
      const task = baseTask({ issueNumber: 5, prNumber: 9 });

      await postReviewFindingsComment(app, task, project, {
        body: "## Round 1\n\nOne errcheck failure.\n\n- **a.go:42** — unchecked error",
        reviewSummary: "## Round 1\n\nOne errcheck failure.",
        findings: [
          { path: "a.go", line: 42, side: "RIGHT", severity: null, body: "unchecked error" },
        ],
      });

      expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(2);
      expect(mockCreatePullRequestReview).toHaveBeenLastCalledWith(
        "ghp_token",
        repoRef.owner,
        repoRef.repo,
        9,
        {
          body: "## Round 1\n\nOne errcheck failure.\n\n- **a.go:42** — unchecked error",
          commitId: "abc123",
        },
      );
    });

    it("falls back to an issue comment when the task has no PR yet", async () => {
      mockCreateComment.mockResolvedValue({ id: 1, htmlUrl: "https://github.com/o/r/issues/5#c1" });
      const task = baseTask({ issueNumber: 5, prNumber: null });

      await postReviewFindingsComment(app, task, project, { body: "## Round 1\n\nfindings" });

      expect(mockGetPullRequestByNumber).not.toHaveBeenCalled();
      expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        repoRef.owner,
        repoRef.repo,
        5,
        "## Round 1\n\nfindings",
      );
    });

    it("is a no-op when the task has neither a PR nor a linked issue", async () => {
      const task = baseTask({ issueNumber: null, prNumber: null });

      await postReviewFindingsComment(app, task, project, { body: "## Round 1\n\nfindings" });

      expect(mockResolveRepoRef).not.toHaveBeenCalled();
      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
    });

    it("is a no-op when no GitHub token is connected", async () => {
      mockGetToken.mockReturnValue(null);
      const task = baseTask({ issueNumber: 5, prNumber: 9 });

      await postReviewFindingsComment(app, task, project, { body: "## Round 1\n\nfindings" });

      expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
    });

    it("falls back to an issue comment when posting the review fails but the task also has a linked issue", async () => {
      mockCreatePullRequestReview.mockRejectedValue(new Error("HTTP 403 — insufficient scope"));
      mockCreateComment.mockResolvedValue({
        id: 1,
        htmlUrl: "https://github.com/o/r/issues/910#c1",
      });
      const [row0] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber: 910, prNumber: 9, title: "t", status: "reviewing" })
        .returning()
        .all();

      await expect(
        postReviewFindingsComment(app, row0, project, { body: "## Round 1\n\nfindings" }),
      ).resolves.toBeUndefined();

      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        repoRef.owner,
        repoRef.repo,
        910,
        "## Round 1\n\nfindings",
      );
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, row0.id)).all();
      expect(row.githubSyncError).toBeNull();
    });

    it("records the fallback's own error when both the PR review and the issue-comment fallback fail", async () => {
      mockCreatePullRequestReview.mockRejectedValue(new Error("HTTP 403 — insufficient scope"));
      mockCreateComment.mockRejectedValue(new Error("issue comment also rejected"));
      const [row0] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber: 912, prNumber: 9, title: "t", status: "reviewing" })
        .returning()
        .all();

      await expect(
        postReviewFindingsComment(app, row0, project, { body: "## Round 1\n\nfindings" }),
      ).resolves.toBeUndefined();

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, row0.id)).all();
      expect(row.githubSyncError).toContain("issue comment also rejected");
    });

    it("records a sync error, never throws, when posting the review fails and there's no linked issue to fall back to", async () => {
      mockCreatePullRequestReview.mockRejectedValue(new Error("HTTP 403 — insufficient scope"));
      const [row0] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber: null, prNumber: 9, title: "t", status: "reviewing" })
        .returning()
        .all();

      await expect(
        postReviewFindingsComment(app, row0, project, { body: "## Round 1\n\nfindings" }),
      ).resolves.toBeUndefined();

      expect(mockCreateComment).not.toHaveBeenCalled();
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, row0.id)).all();
      expect(row.githubSyncError).toContain("insufficient scope");
    });

    // The review-subagent's finding on this PR: GitHubWriteScopeError
    // EXTENDS GitHubApiError, so `err instanceof GitHubApiError` alone
    // can't distinguish a 403 scope failure from a 422 anchor rejection —
    // only the `statusCode === 422` check does. This pins that a 403 never
    // triggers the drop-anchors-and-retry path (a second POST with the
    // same doomed token would just 403 again).
    it("does not retry a 403 the way it retries a 422 — a scope failure isn't an anchor problem", async () => {
      const { GitHubApiError } = await import("../../src/services/github.js");
      mockCreatePullRequestReview.mockRejectedValue(new GitHubApiError("insufficient scope", 403));
      const task = baseTask({ issueNumber: null, prNumber: 9 });

      await postReviewFindingsComment(app, task, project, {
        body: "## Round 1\n\nOne finding.",
        reviewSummary: "## Round 1\n\nOne finding.",
        findings: [{ path: "a.go", line: 42, side: "RIGHT", severity: null, body: "b" }],
      });

      expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    });

    it("clears a previously-recorded sync error on a successful post", async () => {
      const [row0] = app.db
        .insert(tasks)
        .values({
          projectId,
          issueNumber: 911,
          prNumber: 9,
          title: "t",
          status: "reviewing",
          githubSyncError: "stale error",
        })
        .returning()
        .all();

      await postReviewFindingsComment(app, row0, project, { body: "## Round 1\n\nfindings" });

      const [row] = app.db.select().from(tasks).where(eq(tasks.id, row0.id)).all();
      expect(row.githubSyncError).toBeNull();
    });
  });

  // #495 Hermes review, third pass — these helpers must never throw: an
  // unguarded DB write throwing (e.g. a locked DB) would otherwise escape
  // syncTaskTransition's own "never throws" contract, or mask the ORIGINAL
  // GitHub error a catch block was already handling.
  describe("recordGithubSyncError / clearGithubSyncError never throw", () => {
    function insertPlainTask(issueNumber: number) {
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber, title: "t", status: "claimed" })
        .returning()
        .all();
      return row;
    }

    it("recordGithubSyncError swallows a DB error and logs a warning instead of throwing", () => {
      const task = insertPlainTask(301);
      const updateSpy = vi.spyOn(app.db, "update").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });
      const warnSpy = vi.spyOn(app.log, "warn");

      expect(() => recordGithubSyncError(app, task.id, "some error")).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id }),
        expect.stringContaining("failed to record"),
      );

      updateSpy.mockRestore();
    });

    it("clearGithubSyncError swallows a DB error and logs a warning instead of throwing", () => {
      const task = insertPlainTask(302);
      const updateSpy = vi.spyOn(app.db, "update").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });
      const warnSpy = vi.spyOn(app.log, "warn");

      expect(() => clearGithubSyncError(app, task.id)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id }),
        expect.stringContaining("failed to clear"),
      );

      updateSpy.mockRestore();
    });
  });
});
