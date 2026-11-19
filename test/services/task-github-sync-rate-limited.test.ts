import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { tasks } from "../../src/db/schema.js";
import { repoRefMocks } from "../helpers/pr-review-defaults.js";

const mockGetToken = vi.fn();
const mockResolveRepoRef = vi.fn();
const mockRemoveLabel = vi.fn();
const mockCreateComment = vi.fn();

vi.mock("../../src/services/github-integration.js", () => ({
  resolveGitHubToken: mockGetToken,
  resolveReviewerToken: vi.fn(),
  getIntegration: vi.fn(() => ({ login: "mullion-bot" })),
}));
vi.mock("../../src/services/host-git.js", () => repoRefMocks(mockResolveRepoRef));
vi.mock("../../src/services/github-write.js", () => ({
  addLabels: vi.fn(),
  removeLabel: mockRemoveLabel,
  createComment: mockCreateComment,
  setAssignees: vi.fn(),
  closeIssue: vi.fn(),
  getIssueState: vi.fn(),
  getMergedClosingPullRequest: vi.fn(),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { syncTaskTransition, LABEL_CLAIMED } =
  await import("../../src/services/task-github-sync.js");

const tmpDb = path.join(os.tmpdir(), `task-github-sync-rate-limited-${process.pid}.db`);

describe("task-github-sync rate_limited (#2940)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
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
    mockResolveRepoRef.mockResolvedValue({ owner: "test-owner", repo: "test-repo" });
  });

  const task = {
    id: 1,
    projectId: 1,
    issueNumber: 5,
    status: "ready",
  } as typeof tasks.$inferSelect;
  const project = { cwd: "/tmp/not-used", hostId: "local" };

  it("drops the claimed label and says when the task resumes", async () => {
    await syncTaskTransition(app, task, project, "rate_limited", {
      resumeAt: new Date("2026-11-16T23:38:00.000Z"),
    });
    expect(mockRemoveLabel).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      5,
      LABEL_CLAIMED,
    );
    expect(mockCreateComment).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      5,
      expect.stringContaining("2026-11-16T23:38:00Z"),
    );
  });

  it("still posts a pause notice when no reset time is known", async () => {
    await syncTaskTransition(app, task, project, "rate_limited");
    expect(mockCreateComment).toHaveBeenCalledWith(
      "ghp_token",
      "test-owner",
      "test-repo",
      5,
      expect.stringContaining("after the reset"),
    );
  });
});
