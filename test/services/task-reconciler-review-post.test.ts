// #2749 — a review post lost to a transient GitHub failure is retried at the
// reconciler tick, and an approving verdict is not acted on until it lands.
// Its own file: the reconciler's test file is at its file-size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const {
  mockResolveRepoRef,
  mockResolveRepoRefResult,
  mockMergePullRequest,
  mockResolveGitHubToken,
  mockResolveReviewerToken,
  mockResolveMullionReviewLogins,
  mockGetPullRequestByNumber,
  mockCreatePullRequestReview,
  mockListPullRequestReviews,
  mockFetchPullRequestReviewThreads,
  mockResolveReviewThread,
  mockFetchRunsForHead,
  mockPromoteTaskToPR,
} = vi.hoisted(() => ({
  mockResolveRepoRef: vi.fn(),
  mockResolveRepoRefResult: vi.fn(),
  mockMergePullRequest: vi.fn(),
  mockResolveGitHubToken: vi.fn(),
  mockResolveReviewerToken: vi.fn(),
  mockResolveMullionReviewLogins: vi.fn(),
  mockGetPullRequestByNumber: vi.fn(),
  mockCreatePullRequestReview: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockFetchPullRequestReviewThreads: vi.fn(),
  mockResolveReviewThread: vi.fn(),
  mockFetchRunsForHead: vi.fn(),
  mockPromoteTaskToPR: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRepoRef: mockResolveRepoRef,
  resolveRepoRefResult: mockResolveRepoRefResult,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
  resolveReviewerToken: mockResolveReviewerToken,
  resolveMullionReviewLogins: mockResolveMullionReviewLogins,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
  createPullRequestReview: mockCreatePullRequestReview,
  listPullRequestReviews: mockListPullRequestReviews,
  fetchPullRequestReviewThreads: mockFetchPullRequestReviewThreads,
  resolveReviewThread: mockResolveReviewThread,
  mergePullRequest: mockMergePullRequest,
}));
vi.mock("../../src/services/github.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchRunsForHead: mockFetchRunsForHead,
    fetchRunsForHeadChecked: async (...args: unknown[]) => ({
      ok: true,
      runs: await mockFetchRunsForHead(...args),
    }),
  };
});
vi.mock("../../src/services/task-promote.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  promoteTaskToPR: mockPromoteTaskToPR,
}));
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { GitHubRateLimitError } = await import("../../src/services/github-fetch.js");
const { GitHubApiError } = await import("../../src/services/github.js");
const { taskReviewFindingsPath } = await import("../../src/services/task-prompt.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-review-post-${process.pid}.db`);
const rateLimit = () => new GitHubRateLimitError("rate limit in effect", 403, 60_000);
const OWN_THREAD = {
  viewerLogin: "mullion-bot[bot]",
  threads: [
    {
      id: "thread-own",
      isResolved: false,
      comments: [
        {
          author: "mullion-reviewer[bot]",
          createdAt: "2026-08-20T10:00:00Z",
          path: "src/foo.ts",
          line: 1,
          body: "Fix this.",
        },
      ],
    },
  ],
  truncated: false,
};

// The fields of a live session's info the reconciler reads; only the turn end matters here.
function finishedInfo() {
  return {
    activity: "idle",
    attention: false,
    attentionKind: null,
    permissionState: "idle",
    planState: "idle",
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    elicitationState: "idle",
    elicitationServer: null,
    questionState: "idle",
    questionHeader: null,
    errorState: "idle",
    errorDetail: null,
    endedReason: null,
    exitCode: null,
    compactState: "idle",
    subagentCount: 0,
    lastTurnEndedAt: Date.now(),
    workFinishedAt: Date.now(),
    outstandingBackgroundTasks: [],
  };
}

describe("a review post lost to a transient GitHub failure (#2749)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // A reviewing task on an auto-approving project whose review session has
  // finished and written an approving verdict that the next tick ingests.
  async function setup(name: string) {
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveRepoRefResult
      .mockReset()
      .mockResolvedValue({ ok: true, value: { owner: "o", repo: "r" } });
    mockMergePullRequest.mockReset().mockResolvedValue({ merged: true, sha: "abc" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
    mockResolveMullionReviewLogins.mockResolvedValue(new Set(["mullion-reviewer[bot]"]));
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha: "sha-head",
      headRef: "mullion/task-x",
      baseRef: "main",
      title: "feat: do the thing",
      state: "open",
      merged: false,
      mergeable: true,
      mergeableState: "clean",
    });
    mockCreatePullRequestReview.mockReset().mockResolvedValue({ id: 1, htmlUrl: "https://x" });
    mockListPullRequestReviews.mockReset().mockResolvedValue([]);
    mockFetchPullRequestReviewThreads
      .mockReset()
      .mockResolvedValue({ viewerLogin: "mullion-bot[bot]", threads: [], truncated: false });
    mockResolveReviewThread.mockReset().mockResolvedValue(undefined);
    mockFetchRunsForHead.mockResolvedValue([
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://x/1",
        headSha: "sha-head",
      },
    ]);
    mockPromoteTaskToPR.mockReset().mockResolvedValue({
      ok: true,
      prUrl: "https://github.com/o/r/pull/9",
      prNumber: 9,
    });

    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name, cwd: "/tmp" },
    });
    const projectId = created.json().id as number;
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { autoApprove: true, defaultReviewAgent: "codex" },
    });
    const [review] = app.db
      .insert(sessions)
      .values({ projectId, command: "codex", cwd: "/tmp", status: "active" })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "reviewed task",
        status: "reviewing",
        claimedAt: new Date(),
        startedAt: new Date(),
        worktreePath: "/tmp",
        agentCommand: "codex",
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        reviewSessionId: review.id,
      })
      .returning()
      .all();
    vi.spyOn(app.pty, "get").mockImplementation(
      (id: string) =>
        ({
          toInfo: () => (String(id) === String(review.id) ? finishedInfo() : null),
        }) as never,
    );
    fs.writeFileSync(
      taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), task.id, 0),
      JSON.stringify({ verdict: "clean", summary: "All good." }),
    );
    const read = () => app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    return { app, task, read };
  }

  it("retries the post with backoff until it lands, and holds auto-approve until then", async () => {
    const { app, read } = await setup("p-post-retry");
    mockCreatePullRequestReview.mockRejectedValueOnce(rateLimit());

    // Date only: a fully faked clock stalls the leftover-session probe (#2602).
    vi.useFakeTimers({ toFake: ["Date"] });
    await reconcileTasks(app);

    // Ingested, post lost — and the approving verdict is NOT acted on in the same tick.
    let row = read();
    expect(row.lastReviewVerdict).toBe("approved");
    expect(row.reviewPostPending).not.toBeNull();
    expect(row.status).toBe("reviewing");
    expect(row.githubSyncError).toBeNull();
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    expect(mockPromoteTaskToPR).not.toHaveBeenCalled();

    // Inside the backoff window: no retry, still held.
    await reconcileTasks(app);
    expect(read().status).toBe("reviewing");
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);

    // Past it: the retry lands, and auto-approve proceeds in the same tick.
    vi.setSystemTime(Date.now() + 61_000);
    await reconcileTasks(app);
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(2);
    const [token, , , , sent] = mockCreatePullRequestReview.mock.calls[1] as [
      string,
      string,
      string,
      number,
      { body: string; event?: string },
    ];
    expect(token).toBe("reviewer_tok");
    expect(sent.event).toBe("APPROVE");
    expect(sent.body).toMatch(/^<!-- mullion-review-post:\d+-\d+ -->\n/);
    row = read();
    expect(row.reviewPostPending).toBeNull();
    expect(row.status).toBe("done");
    await app.close();
  });

  it("does not post again when the first post landed but its response was lost", async () => {
    const { app, read } = await setup("p-post-dedupe");
    mockCreatePullRequestReview.mockRejectedValueOnce(new GitHubApiError("socket hang up", 0));

    vi.useFakeTimers({ toFake: ["Date"] });
    await reconcileTasks(app);
    expect(read().reviewPostPending).not.toBeNull();

    // GitHub did record the review the first call sent.
    const sent = mockCreatePullRequestReview.mock.calls[0]?.[4] as { body: string };
    mockListPullRequestReviews.mockResolvedValue([{ author: "mullion-reviewer", body: sent.body }]);
    vi.setSystemTime(Date.now() + 61_000);
    await reconcileTasks(app);

    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    expect(read().reviewPostPending).toBeNull();
    await app.close();
  });

  it("clears the marker and records githubSyncError on a permanent failure, without retrying", async () => {
    const { app, read } = await setup("p-post-permanent");
    mockCreatePullRequestReview.mockRejectedValue(new GitHubApiError("Not Found", 404));

    vi.useFakeTimers({ toFake: ["Date"] });
    await reconcileTasks(app);

    const row = read();
    expect(row.reviewPostPending).toBeNull();
    expect(row.githubSyncError).toContain("Not Found");

    vi.setSystemTime(Date.now() + 3_600_000);
    await reconcileTasks(app);
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("retries a rate-limited own-thread resolution without re-posting the review", async () => {
    const { app, read } = await setup("p-post-threads");
    mockFetchPullRequestReviewThreads
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue(OWN_THREAD);

    vi.useFakeTimers({ toFake: ["Date"] });
    await reconcileTasks(app);

    // The review landed; the thread resolution did not — the round is not finished.
    let row = read();
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    expect(mockResolveReviewThread).not.toHaveBeenCalled();
    expect(JSON.parse(row.reviewPostPending!).posted).toBe(true);

    vi.setSystemTime(Date.now() + 61_000);
    await reconcileTasks(app);

    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    expect(mockResolveReviewThread).toHaveBeenCalledWith("tok", "thread-own");
    row = read();
    expect(row.reviewPostPending).toBeNull();
    await app.close();
  });

  it("retries when the repo ref cannot be resolved because the host is unreachable", async () => {
    const { app, read } = await setup("p-post-host");
    mockResolveRepoRefResult.mockResolvedValueOnce({
      ok: false,
      reason: "unreachable",
      detail: "host down",
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    await reconcileTasks(app);

    // Not "posted": the marker survives and nothing was sent.
    expect(read().reviewPostPending).not.toBeNull();
    expect(read().status).toBe("reviewing");
    expect(mockCreatePullRequestReview).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 61_000);
    await reconcileTasks(app);
    expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
    expect(read().reviewPostPending).toBeNull();
    await app.close();
  });

  it("does not merge an approved done task while its review post is pending", async () => {
    const { app, task, read } = await setup("p-post-merge");
    const marker = JSON.stringify({
      key: "1-1",
      body: "<!-- mullion-review-post:1-1 -->\nbody",
      verdict: "approved",
      posted: false,
      createdAt: Date.now(),
    });
    app.db
      .update(tasks)
      .set({
        status: "done",
        mergeRequestedAt: new Date(),
        lastReviewVerdict: "approved",
        reviewPostPending: marker,
        reviewSessionId: null,
      })
      .where(eq(tasks.id, task.id))
      .run();
    mockCreatePullRequestReview.mockRejectedValue(rateLimit());

    vi.useFakeTimers({ toFake: ["Date"] });
    await reconcileTasks(app);
    expect(read().reviewPostPending).not.toBeNull();
    expect(mockMergePullRequest).not.toHaveBeenCalled();

    mockCreatePullRequestReview.mockReset().mockResolvedValue({ id: 2, htmlUrl: "https://x" });
    vi.setSystemTime(Date.now() + 3_600_000);
    await reconcileTasks(app);
    expect(read().reviewPostPending).toBeNull();
    await reconcileTasks(app);
    expect(mockMergePullRequest).toHaveBeenCalled();
    await app.close();
  });

  it("gives up on a marker older than a day, and drops one the task no longer owes", async () => {
    const { app, task, read } = await setup("p-post-expiry");
    mockCreatePullRequestReview.mockRejectedValue(rateLimit());

    vi.useFakeTimers({ toFake: ["Date"] });
    await reconcileTasks(app);
    expect(read().reviewPostPending).not.toBeNull();

    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    await reconcileTasks(app);
    const row = read();
    expect(row.reviewPostPending).toBeNull();
    expect(row.githubSyncError).toContain("Gave up posting");

    app.db
      .update(tasks)
      .set({ status: "failed", reviewPostPending: JSON.stringify({ key: "k", body: "b" }) })
      .where(eq(tasks.id, task.id))
      .run();
    await reconcileTasks(app);
    expect(read().reviewPostPending).toBeNull();
    await app.close();
  });
});
