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

vi.mock("../../src/services/github-integration.js", () => ({
  getToken: mockGetToken,
  getIntegration: mockGetIntegration,
}));
vi.mock("../../src/services/github-webhook.js", () => ({
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-write.js", () => ({
  addLabels: mockAddLabels,
  removeLabel: mockRemoveLabel,
  createComment: mockCreateComment,
  setAssignees: mockSetAssignees,
  closeIssue: mockCloseIssue,
  getIssueState: mockGetIssueState,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const {
  syncTaskTransition,
  syncClosedIssueToLocal,
  resetProgressThrottleForTests,
  LABEL_CLAIMED,
  LABEL_REVIEWING,
  LABEL_DONE,
} = await import("../../src/services/task-github-sync.js");
const { eq } = await import("drizzle-orm");

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
      payload: { name: "sync-test-project", cwd },
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
      mockGetToken.mockReturnValue(null);
      await syncTaskTransition(app, baseTask(), project, "claimed");
      expect(mockResolveRepoRef).not.toHaveBeenCalled();
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

    it("reviewing: swaps claimed->reviewing labels and comments without a diff summary", async () => {
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
      mockGetIssueState.mockResolvedValue("open");
      const task = insertTask("reviewing", 102);
      await syncClosedIssueToLocal(app, task, project);
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("reviewing");
    });

    it("flips a reviewing task to done when its issue is closed on GitHub", async () => {
      mockGetIssueState.mockResolvedValue("closed");
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
  });
});
