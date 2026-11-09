// `done` means APPROVED, not merged: task-github-sync.ts leaves the issue open
// while a PR is waiting to merge, and closes it when the merge lands (so a
// `blocked_by` dependent stays blocked until the code is on the default
// branch). Split from task-github-sync.test.ts to keep that file under the
// size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { repoRefMocks } from "../helpers/pr-review-defaults.js";

const mockGetToken = vi.fn();
const mockGetIntegration = vi.fn();
const mockResolveRepoRef = vi.fn();
const mockCreateComment = vi.fn();
const mockCloseIssue = vi.fn();
const mockGetIssueState = vi.fn();

vi.mock("../../src/services/github-integration.js", () => ({
  resolveGitHubToken: mockGetToken,
  resolveReviewerToken: vi.fn(),
  getIntegration: mockGetIntegration,
}));
vi.mock("../../src/services/host-git.js", () => repoRefMocks(mockResolveRepoRef));
vi.mock("../../src/services/github-write.js", () => ({
  addLabels: vi.fn(),
  removeLabel: vi.fn(),
  createComment: mockCreateComment,
  setAssignees: vi.fn(),
  closeIssue: mockCloseIssue,
  getIssueState: mockGetIssueState,
  getMergedClosingPullRequest: vi.fn(),
  getPullRequestByNumber: vi.fn(),
  createPullRequestReview: vi.fn(),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { syncTaskTransition, closeIssueOnMerge } =
  await import("../../src/services/task-github-sync.js");
const { markTaskMerged } = await import("../../src/services/task-merged.js");
const taskApproveModule = await import("../../src/services/task-approve.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-github-sync-close-test-${process.pid}.db`);
const project = { cwd: "/tmp/not-used", hostId: "local" };
const repoRef = { owner: "test-owner", repo: "test-repo" };
const PR_URL = "https://github.com/test-owner/test-repo/pull/9";

describe("task-github-sync: closing the issue", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  function insertTask(overrides: Partial<typeof tasks.$inferInsert>) {
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber: 5, title: "t", status: "done", ...overrides })
      .returning()
      .all();
    return row;
  }

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-github-sync-close-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "sync-close-project", cwd },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetToken.mockReturnValue("ghp_token");
    mockGetIntegration.mockReturnValue({ login: "mullion-bot" });
    mockResolveRepoRef.mockResolvedValue(repoRef);
  });

  describe("the → done sync", () => {
    it("leaves the issue open and says so while the PR awaits its merge", async () => {
      const task = insertTask({ issueNumber: 5, prNumber: 9 });
      await syncTaskTransition(app, task, project, "done", { prUrl: PR_URL });
      expect(mockCreateComment).toHaveBeenCalledWith(
        "ghp_token",
        "test-owner",
        "test-repo",
        5,
        expect.stringContaining("closes when the pull request merges"),
      );
      expect(mockCloseIssue).not.toHaveBeenCalled();
    });

    it("treats a prUrl with no prNumber (a row promoted before prNumber existed) as awaiting the merge", async () => {
      const task = insertTask({ issueNumber: 10 });
      await syncTaskTransition(app, task, project, "done", { prUrl: PR_URL });
      expect(mockCloseIssue).not.toHaveBeenCalled();
    });

    it("closes the issue when the PR is already merged", async () => {
      const task = insertTask({ issueNumber: 6, prNumber: 9, mergedAt: new Date() });
      await syncTaskTransition(app, task, project, "done", { prUrl: PR_URL });
      expect(mockCloseIssue).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 6);
    });

    it("closes the issue when there is no PR to wait for", async () => {
      const task = insertTask({ issueNumber: 7 });
      await syncTaskTransition(app, task, project, "done", {});
      expect(mockCloseIssue).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 7);
    });
  });

  describe("closeIssueOnMerge", () => {
    it("closes an open issue, leaves a closed one alone, and swallows a GitHub failure", async () => {
      const task = insertTask({ issueNumber: 8, prNumber: 9 });

      mockGetIssueState.mockResolvedValueOnce({ state: "open", labels: [] });
      await closeIssueOnMerge(app, task, project);
      expect(mockCloseIssue).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 8);

      mockCloseIssue.mockClear();
      mockGetIssueState.mockResolvedValueOnce({ state: "closed", labels: [] });
      await closeIssueOnMerge(app, task, project);
      expect(mockCloseIssue).not.toHaveBeenCalled();

      mockGetIssueState.mockRejectedValueOnce(new Error("boom"));
      await expect(closeIssueOnMerge(app, task, project)).resolves.toBeUndefined();
      const row = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
      expect(row.githubSyncError).toContain("boom");
    });

    it("records a sync error instead of dropping silently when there is no token or repo", async () => {
      const noToken = insertTask({ issueNumber: 11, prNumber: 9 });
      mockGetToken.mockReturnValue(null);
      await closeIssueOnMerge(app, noToken, project);
      expect(mockCloseIssue).not.toHaveBeenCalled();
      const row = app.db.select().from(tasks).where(eq(tasks.id, noToken.id)).get()!;
      expect(row.githubSyncError).toContain("no GitHub token");

      const noRepo = insertTask({ issueNumber: 12, prNumber: 9 });
      mockGetToken.mockReturnValue("ghp_token");
      mockResolveRepoRef.mockResolvedValue(null);
      await closeIssueOnMerge(app, noRepo, project);
      const row2 = app.db.select().from(tasks).where(eq(tasks.id, noRepo.id)).get()!;
      expect(row2.githubSyncError).toContain("could not be resolved");
    });

    it("is a no-op for a task with no linked issue", async () => {
      await closeIssueOnMerge(app, insertTask({ issueNumber: null }), project);
      expect(mockGetIssueState).not.toHaveBeenCalled();
    });
  });

  it("markTaskMerged closes the still-open issue once the PR merges", async () => {
    // The entry point: the merge write — not the earlier approval — is what
    // releases the issue, and with it the task's `blocked_by` dependents.
    const branchSpy = vi
      .spyOn(taskApproveModule, "cleanupMergedTaskBranch")
      .mockImplementation(() => {});
    mockGetIssueState.mockResolvedValue({ state: "open", labels: [] });
    const task = insertTask({ issueNumber: 9, prNumber: 9 });
    const projectRow = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!;

    expect(markTaskMerged(app, task, projectRow, new Date())).toBe(true);

    await vi.waitFor(() =>
      expect(mockCloseIssue).toHaveBeenCalledWith("ghp_token", "test-owner", "test-repo", 9),
    );
    branchSpy.mockRestore();
  });
});
