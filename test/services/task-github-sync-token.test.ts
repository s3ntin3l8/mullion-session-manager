import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { repoRefMocks } from "../helpers/pr-review-defaults.js";

// postReviewFindingsComment when the primary GitHub token cannot be resolved:
// a missing integration is permanent, a transient App mint failure is a retry.
const mockGetToken = vi.fn();
const mockHasTransientMintFailure = vi.fn();
const mockResolveRepoRef = vi.fn();
const mockCreatePullRequestReview = vi.fn();

vi.mock("../../src/services/github-integration.js", () => ({
  resolveGitHubToken: mockGetToken,
  resolveReviewerToken: vi.fn(),
  hasTransientMintFailure: mockHasTransientMintFailure,
  getIntegration: vi.fn(),
}));
vi.mock("../../src/services/host-git.js", () => repoRefMocks(mockResolveRepoRef));
vi.mock("../../src/services/github-write.js", () => ({
  createComment: vi.fn(),
  getPullRequestByNumber: vi.fn(),
  createPullRequestReview: mockCreatePullRequestReview,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const { postReviewFindingsComment } = await import("../../src/services/task-github-sync.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-github-sync-token-test-${process.pid}.db`);
const project = { cwd: "/tmp/not-used", hostId: "local" };

describe("postReviewFindingsComment without a resolvable token", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-github-sync-token-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "token-test-project", cwd },
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
    mockResolveRepoRef.mockResolvedValue({ owner: "test-owner", repo: "test-repo" });
    mockGetToken.mockReturnValue(null);
    mockHasTransientMintFailure.mockReturnValue(false);
  });

  function insertTask(issueNumber: number) {
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber, prNumber: 9, title: "t", status: "reviewing" })
      .returning()
      .all();
    return row;
  }
  const syncError = (id: number) =>
    app.db.select({ e: tasks.githubSyncError }).from(tasks).where(eq(tasks.id, id)).get()?.e;

  it("reports permanent and records githubSyncError when no GitHub token is connected", async () => {
    const task = insertTask(5);
    const out = await postReviewFindingsComment(app, task, project, { body: "## Round 1" });
    expect(out).toBe("permanent");
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
    expect(syncError(task.id)).toBe("No GitHub token connected");
  });

  it("reports retry and records nothing after a transient App mint failure", async () => {
    mockHasTransientMintFailure.mockReturnValue(true);
    const task = insertTask(6);
    const out = await postReviewFindingsComment(app, task, project, { body: "## Round 1" });
    expect(out).toBe("retry");
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
    expect(syncError(task.id)).toBeNull();
  });
});
