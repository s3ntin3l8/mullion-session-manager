import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { repoRefMocks } from "../helpers/pr-review-defaults.js";

// postReviewFindingsComment's 422 fallback ladder for a gating (APPROVE /
// REQUEST_CHANGES) review: a 422 on an anchored attempt first retries as the
// reviewer App with the same verdict and no anchors (PR #3354 — a stale anchor
// must not demote the verdict to a COMMENT from the PR author), and only drops
// to a plain COMMENT from the primary identity when that also 422s.
const mockGetToken = vi.fn();
const mockResolveReviewerToken = vi.fn();
const mockResolveRepoRef = vi.fn();
const mockCreateComment = vi.fn();
const mockGetPullRequestByNumber = vi.fn();
const mockCreatePullRequestReview = vi.fn();

vi.mock("../../src/services/github-integration.js", () => ({
  resolveGitHubToken: mockGetToken,
  resolveReviewerToken: mockResolveReviewerToken,
  getIntegration: vi.fn(),
}));
vi.mock("../../src/services/host-git.js", () => repoRefMocks(mockResolveRepoRef));
vi.mock("../../src/services/github-write.js", () => ({
  createComment: mockCreateComment,
  getPullRequestByNumber: mockGetPullRequestByNumber,
  createPullRequestReview: mockCreatePullRequestReview,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const { postReviewFindingsComment } = await import("../../src/services/task-github-sync.js");
const { GitHubApiError } = await import("../../src/services/github.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-github-sync-422-test-${process.pid}.db`);
const project = { cwd: "/tmp/not-used", hostId: "local" };
const repoRef = { owner: "test-owner", repo: "test-repo" };

describe("postReviewFindingsComment 422 fallback for gating reviews", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-github-sync-422-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "sync-422-project", cwd },
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
    // clearAllMocks keeps queued mockXOnce values; a leftover would leak into the next test.
    mockCreatePullRequestReview.mockReset();
    mockResolveReviewerToken.mockReset();
    mockGetToken.mockReturnValue("ghp_token");
    mockResolveRepoRef.mockResolvedValue(repoRef);
    mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: true,
      headSha: "abc123",
    });
    mockCreatePullRequestReview.mockResolvedValue({ id: 555, htmlUrl: "https://x/pull/9#r-555" });
  });

  // A real, uniquely-inserted row per test, with or without a linked issue.
  let nextIssue = 100;
  function insertTask(linkedIssue: boolean) {
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: linkedIssue ? nextIssue++ : null,
        prNumber: 9,
        title: "t",
        status: "reviewing",
      })
      .returning()
      .all();
    return row;
  }

  it("keeps the reviewer identity and verdict when a 422 on an anchored gating attempt is a stale anchor (PR #3354)", async () => {
    mockCreatePullRequestReview
      .mockRejectedValueOnce(new GitHubApiError("Validation Failed", 422))
      .mockResolvedValueOnce({ id: 556, htmlUrl: "https://github.com/o/r/pull/9#review-556" });
    const task = insertTask(true);

    await postReviewFindingsComment(app, task, project, {
      body: "## Round 1\n\nOne finding.\n\n- **a.go:42** — x",
      reviewSummary: "## Round 1\n\nOne finding.",
      findings: [{ path: "a.go", line: 42, side: "RIGHT", severity: null, body: "x" }],
      verdict: "approved",
    });

    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(2);
    // First attempt: the reviewer identity, gating event, anchors.
    expect(mockCreatePullRequestReview).toHaveBeenNthCalledWith(
      1,
      "reviewer_tok",
      repoRef.owner,
      repoRef.repo,
      9,
      expect.objectContaining({ event: "APPROVE" }),
    );
    // Retry: SAME reviewer identity and event, anchors dropped, findings in the body.
    expect(mockCreatePullRequestReview).toHaveBeenNthCalledWith(
      2,
      "reviewer_tok",
      repoRef.owner,
      repoRef.repo,
      9,
      {
        body: "## Round 1\n\nOne finding.\n\n- **a.go:42** — x",
        commitId: "abc123",
        event: "APPROVE",
      },
    );
  });

  it("downgrades to COMMENT from the primary identity only when the anchor-less gating retry also 422s", async () => {
    mockCreatePullRequestReview
      .mockRejectedValueOnce(new GitHubApiError("Validation Failed", 422))
      .mockRejectedValueOnce(new GitHubApiError("Validation Failed", 422))
      .mockResolvedValueOnce({ id: 558, htmlUrl: "https://github.com/o/r/pull/9#review-558" });
    const task = insertTask(true);

    await postReviewFindingsComment(app, task, project, {
      body: "## Round 1\n\nOne finding.\n\n- **a.go:42** — x",
      reviewSummary: "## Round 1\n\nOne finding.",
      findings: [{ path: "a.go", line: 42, side: "RIGHT", severity: null, body: "x" }],
      verdict: "approved",
    });

    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(3);
    expect(mockCreatePullRequestReview).toHaveBeenNthCalledWith(
      2,
      "reviewer_tok",
      repoRef.owner,
      repoRef.repo,
      9,
      expect.objectContaining({ event: "APPROVE" }),
    );
    expect(mockCreatePullRequestReview).toHaveBeenNthCalledWith(
      3,
      "ghp_token",
      repoRef.owner,
      repoRef.repo,
      9,
      {
        body: "## Round 1\n\nOne finding.\n\n- **a.go:42** — x",
        commitId: "abc123",
      },
    );
  });

  it("keeps REQUEST_CHANGES on the reviewer-App retry, and rethrows a non-422 failure of it instead of masking it as a COMMENT", async () => {
    mockCreatePullRequestReview
      .mockRejectedValueOnce(new GitHubApiError("Validation Failed", 422))
      .mockRejectedValueOnce(new GitHubApiError("Server Error", 502));
    const task = insertTask(false);

    const outcome = await postReviewFindingsComment(app, task, project, {
      body: "## Round 1\n\nOne finding.\n\n- **a.go:42** — x",
      reviewSummary: "## Round 1\n\nOne finding.",
      findings: [{ path: "a.go", line: 42, side: "RIGHT", severity: null, body: "x" }],
      verdict: "changes-requested",
    });

    // The retry is the reviewer App with the same gating event; had it been
    // skipped, call 2 would be the primary-identity COMMENT.
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(2);
    expect(mockCreatePullRequestReview).toHaveBeenNthCalledWith(
      2,
      "reviewer_tok",
      repoRef.owner,
      repoRef.repo,
      9,
      expect.objectContaining({ event: "REQUEST_CHANGES" }),
    );
    // The 502 is surfaced (retryable, recorded), not swallowed as "posted".
    expect(outcome).toBe("retry");
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(row.githubSyncError).toContain("Server Error");
  });

  // Independent review, PR #827: the retry above was gated on
  // `anchored.length > 0`, which a `clean` verdict never satisfies (a
  // clean review has no findings to anchor) — so a gating APPROVE that
  // 422s for a reason OTHER than a bad anchor (a misconfigured reviewer
  // App, say) used to skip the retry entirely and rethrow. For a task
  // with a PR but no linked issue, that meant the round landed nowhere
  // on GitHub at all — worse than the pre-#737 always-succeeds-as-
  // COMMENT behavior this mechanism is supposed to preserve.
  it("downgrades a 422 on a gating attempt with NO findings to anchor (a clean verdict) — the anchor-less case", async () => {
    mockCreatePullRequestReview
      .mockRejectedValueOnce(new GitHubApiError("Validation Failed", 422))
      .mockResolvedValueOnce({ id: 557, htmlUrl: "https://github.com/o/r/pull/9#review-557" });
    const task = insertTask(false);

    await postReviewFindingsComment(app, task, project, {
      body: "## Round 1\n\nClean.",
      verdict: "approved",
    });

    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(2);
    expect(mockCreatePullRequestReview).toHaveBeenNthCalledWith(
      1,
      "reviewer_tok",
      repoRef.owner,
      repoRef.repo,
      9,
      expect.objectContaining({ event: "APPROVE", comments: undefined }),
    );
    expect(mockCreatePullRequestReview).toHaveBeenNthCalledWith(
      2,
      "ghp_token",
      repoRef.owner,
      repoRef.repo,
      9,
      {
        body: "## Round 1\n\nClean.",
        commitId: "abc123",
      },
    );
    // No linked issue to fall back to — the retry above is the ONLY
    // thing standing between this and a silently-lost round.
    expect(mockCreateComment).not.toHaveBeenCalled();
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(row.githubSyncError).toBeNull();
  });
});
