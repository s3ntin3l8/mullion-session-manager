import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reconcilerMocks,
  mockPushDeliveryFactory,
  mockHermesIntegrationFactory,
  mockHermesTaskReviewFactory,
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  mockTaskReseedFactory,
  mockHostGitFactory,
  mockGitWorktreeFactory,
  mockGithubIntegrationFactory,
  mockGithubWriteFactory,
  mockGithubFactory,
  setupReconcilerTestLifecycle,
  getTask,
  createAutoApproveCandidate,
  mockPr,
  ciRun,
} from "../helpers/task-reconciler-harness.js";

vi.mock("../../src/services/push-delivery.js", (io) => mockPushDeliveryFactory(io));
vi.mock("../../src/services/hermes-integration.js", (io) => mockHermesIntegrationFactory(io));
vi.mock("../../src/services/hermes-task-review.js", (io) => mockHermesTaskReviewFactory(io));
vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", (io) => mockTaskPromoteFactory(io));
vi.mock("../../src/services/task-reseed.js", (io) => mockTaskReseedFactory(io));
vi.mock("../../src/services/host-git.js", (io) => mockHostGitFactory(io));
vi.mock("../../src/services/git-worktree.js", (io) => mockGitWorktreeFactory(io));
vi.mock("../../src/services/github-integration.js", (io) => mockGithubIntegrationFactory(io));
vi.mock("../../src/services/github-write.js", (io) => mockGithubWriteFactory(io));
vi.mock("../../src/services/github.js", (io) => mockGithubFactory(io));

const { buildApp } = await import("../../src/app.js");
const { reconcileTasks, DEFAULT_MAX_AUTO_RETURN_ROUNDS } =
  await import("../../src/services/task-reconciler.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { recordGitHubRateLimit, resetGitHubRateLimitForTests } =
  await import("../../src/services/github-fetch.js");

const {
  mockPromoteTaskToPR,
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockResolveMullionReviewLogins,
  mockGetPullRequestByNumber,
  mockFetchRunsForHead,
  mockCreatePullRequestReview,
  mockFetchPullRequestReviewThreads,
} = reconcilerMocks;

describe("reconcileTasks — auto-approve new PR review comments (#757)", () => {
  setupReconcilerTestLifecycle("task-reconciler-auto-approve-comments");
  beforeEach(() => {
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
  });

  describe("new PR review comments return the task to the worker (#757)", () => {
    async function createPrCommentCandidate(
      app: Awaited<ReturnType<typeof buildApp>>,
      overrides: Parameters<typeof createAutoApproveCandidate>[1] = {},
    ) {
      const candidate = await createAutoApproveCandidate(app, {
        worktreePath: "/tmp",
        agentCommand: "claude",
        ...overrides,
      });
      const workerSession = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: candidate.projectId, command: "bash" },
      });
      app.db
        .update(tasks)
        .set({ sessionId: workerSession.json().id })
        .where(eq(tasks.id, candidate.taskId))
        .run();
      return candidate;
    }

    function thread(
      isResolved: boolean,
      author: string | null,
      body: string,
      createdAt: string,
      path: string | null = "src/foo.ts",
      line: number | null = 42,
      reviewState: string | null = null,
    ) {
      return {
        isResolved,
        comments: [{ author, createdAt, path, line, body, reviewState }],
      };
    }

    it("returns the task when a new unresolved review comment arrives", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
        truncated: false,
      });

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.lastAutoReturnReason).toBe("pr-comment");
      expect(row.lastPrReviewCommentAt?.toISOString()).toBe("2026-08-20T10:00:00.000Z");

      await app.close();
    });

    describe("comments posted inside an approving review", () => {
      function mockThreads(...threads: ReturnType<typeof thread>[]) {
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads,
          truncated: false,
        });
      }
      const approvedThread = () =>
        thread(
          false,
          "reviewer[bot]",
          "Consider renaming x.",
          "2026-08-20T10:00:00Z",
          "src/foo.ts",
          42,
          "APPROVED",
        );

      it("applies them as a suggestions round: no round spent, the approval carried", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app, { lastReviewVerdict: "approved" });
        mockThreads(approvedThread());

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.autoReturnRounds).toBe(0);
        expect(row.lastAutoReturnReason).toBe("suggestions");
        expect(row.approvalCarriedAt).not.toBeNull();
        expect(row.lastPrReviewCommentAt?.toISOString()).toBe("2026-08-20T10:00:00.000Z");

        await app.close();
      });

      it("still applies them on a task that has used every round it had", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app, {
          lastReviewVerdict: "approved",
          autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
        });
        mockThreads(approvedThread());

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("in_progress");
        expect(row.autoReturnRounds).toBe(DEFAULT_MAX_AUTO_RETURN_ROUNDS);
        expect(mockCreatePullRequestReview).not.toHaveBeenCalled();

        await app.close();
      });

      it("is an ordinary round when Task Master's own verdict is not an approval — an external APPROVED review can't resume a changes-requested task past its cap", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app, {
          lastReviewVerdict: "changes-requested",
          autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
        });
        mockThreads(approvedThread());

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(DEFAULT_MAX_AUTO_RETURN_ROUNDS);
        expect(row.approvalCarriedAt).toBeNull();
        expect(row.needsHumanReason).toBe("cap");

        await app.close();
      });

      it("treats a batch that also holds an ordinary comment as a normal round", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app, { lastReviewVerdict: "approved" });
        mockThreads(
          approvedThread(),
          thread(false, "octocat", "Please fix this.", "2026-08-20T10:05:00Z"),
        );

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.autoReturnRounds).toBe(1);
        expect(row.lastAutoReturnReason).toBe("pr-comment");
        expect(row.approvalCarriedAt).toBeNull();

        await app.close();
      });

      it("treats a reply under an approval (its own COMMENTED review) as a normal round", async () => {
        const app = await buildApp();
        const { taskId } = await createPrCommentCandidate(app, { lastReviewVerdict: "approved" });
        mockThreads(
          thread(
            false,
            "octocat",
            "I disagree.",
            "2026-08-20T10:00:00Z",
            "src/foo.ts",
            42,
            "COMMENTED",
          ),
        );

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.autoReturnRounds).toBe(1);
        expect(row.lastAutoReturnReason).toBe("pr-comment");

        await app.close();
      });
    });

    it("does NOT return the task when the thread is resolved", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [thread(true, "octocat", "Already resolved.", "2026-08-20T10:00:00Z")],
        truncated: false,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);

      await app.close();
    });

    it("does NOT return the task for a comment already covered by the cursor", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app, {
        lastPrReviewCommentAt: new Date("2026-08-20T10:00:00Z"),
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        // Same timestamp as the cursor — not newer than it.
        threads: [thread(false, "octocat", "Already answered.", "2026-08-20T10:00:00Z")],
        truncated: false,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);

      await app.close();
    });

    it("filters out Mullion's own review comments (matching viewerLogin) — no round for its own output", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [thread(false, "mullion-bot[bot]", "My own findings.", "2026-08-20T10:00:00Z")],
        truncated: false,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);

      await app.close();
    });

    // D0 — a live dry run (2026-08-27) confirmed this exact gap: a
    // gating review round's own findings post from the REVIEWER App
    // (#737/#827), a distinct login from `viewerLogin` above (which is
    // the caller's own, primary-token identity). Before this fix, the
    // filter above missed comments authored by that second identity
    // entirely — Mullion re-ingested its own still-unresolved round-1
    // finding as if a human had posted it, burning an auto-return round
    // on the same tick a clean follow-up verdict landed.
    it("also filters out comments authored by the reviewer App's own login, not just the primary identity", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [
          thread(false, "mullion-reviewer[bot]", "My own gating finding.", "2026-08-20T10:00:00Z"),
        ],
        truncated: false,
      });
      mockResolveMullionReviewLogins.mockResolvedValue(
        new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.lastPrReviewCommentAt).toBeNull();

      await app.close();
    });

    // Round 2, self-review: the test above only proves the two-identity
    // set doesn't UNDER-filter (misses the reviewer App). This proves the
    // companion direction — a two-member `mullionLogins` set must not
    // OVER-filter a genuine human comment sitting alongside a bot one on
    // the same PR, which a mis-scoped `mullionLogins.has()` check could
    // plausibly do without any test catching it.
    it("still returns the task for a genuine human comment even when the reviewer App's own comment is also present", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [
          thread(false, "mullion-reviewer[bot]", "My own gating finding.", "2026-08-20T10:00:00Z"),
          thread(false, "octocat", "Please also fix this.", "2026-08-20T10:05:00Z"),
        ],
        truncated: false,
      });
      mockResolveMullionReviewLogins.mockResolvedValue(
        new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.lastAutoReturnReason).toBe("pr-comment");
      expect(row.lastPrReviewCommentAt).toEqual(new Date("2026-08-20T10:05:00Z"));

      await app.close();
    });

    it("returns the task even with no review agent configured (gate 2 would otherwise never pass)", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app, {
        reviewFindingsIngestedSessionId: null,
        lastReviewVerdict: null,
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
        truncated: false,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.lastAutoReturnReason).toBe("pr-comment");

      await app.close();
    });

    it("returns the task even when the verdict is inconclusive (gate 3 would otherwise never pass)", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app, {
        lastReviewVerdict: "inconclusive",
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
        truncated: false,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.lastAutoReturnReason).toBe("pr-comment");

      await app.close();
    });

    it("posts a cap-reached comment and stays in 'reviewing' once the round budget is spent", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app, {
        autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
        truncated: false,
      });

      await reconcileTasks(app);

      expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
        "tok",
        "o",
        "r",
        9,
        expect.objectContaining({
          body: expect.stringContaining(`round cap (${DEFAULT_MAX_AUTO_RETURN_ROUNDS})`),
        }),
      );
      // Issue #1038 — same reasoning as the red-CI cap test above: its
      // own CAS'd write, no other durable write to piggyback on.
      expect((await getTask(app, taskId)).autoReturnCapAnnouncedAt).not.toBeNull();

      // A second tick with the SAME (unchanged) comments must not post a
      // second cap-reached comment — deduped per round, same as #755's.
      await reconcileTasks(app);
      expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);

      await app.close();
    });

    // Fresh review, PR #784 — attemptReturnPrCommentsToWorker resolves
    // its own repoRef/token independently of attemptAutoApprove's own CI
    // lookup specifically so a REST-side failure (this repo's own
    // getPullRequestByNumber, a different rate-limit bucket than
    // GraphQL) doesn't also block PR-comment ingestion. Only a test that
    // combines BOTH a thrown CI lookup AND a pending new comment can
    // catch a regression back to the early `return` this fix removed.
    it("still returns the task for a new PR comment even when the CI lookup itself throws", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app);
      mockGetPullRequestByNumber.mockRejectedValue(new Error("network blip"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
        truncated: false,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.lastAutoReturnReason).toBe("pr-comment");

      await app.close();
    });

    // Fresh review, PR #784 — resolveGitHubToken must be called with the
    // SAME scope postReviewFindingsComment itself uses ("write", not
    // "read"): an installation predating the "read" scope's permissions
    // 422s a read-scoped mint specifically and falls back to the shared
    // PAT, while a write-scoped mint for that SAME installation still
    // succeeds against the App — so a read-scoped call here could
    // resolve `viewerLogin` to a genuinely different identity than the
    // one that actually posts Mullion's own review comments, silently
    // breaking the self-comment filter below. Pinned directly rather
    // than only via the filtering tests above, which can't distinguish
    // "the right scope was requested" from "the mock happened to return
    // a consistent viewerLogin regardless of scope."
    it("resolves the GitHub token with 'write' scope, matching postReviewFindingsComment's own", async () => {
      const app = await buildApp();
      await createPrCommentCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [thread(false, "octocat", "Fix this.", "2026-08-20T10:00:00Z")],
        truncated: false,
      });

      await reconcileTasks(app);

      expect(mockResolveGitHubToken).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "write",
      );

      await app.close();
    });

    it("filters a self-authored comment out of a result that also has a genuine human one still returns the task for the human comment", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        // The self-authored comment is the NEWER of the two, deliberately
        // — if the self-filter were broken (comparing the wrong field, or
        // applied after the newest-timestamp computation instead of
        // before it), the cursor would land on 11:00, not 10:00 this
        // assertion would actually catch it. Making the human comment the
        // newer one (as an earlier version of this test did) can't tell
        // "the filter worked" apart from "Math.max just picked the newer
        // of the two either way."
        threads: [
          thread(false, "mullion-bot[bot]", "My own findings.", "2026-08-20T11:00:00Z"),
          thread(false, "octocat", "A genuine human comment.", "2026-08-20T10:00:00Z"),
        ],
        truncated: false,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.lastAutoReturnReason).toBe("pr-comment");
      // The cursor reflects only the genuine (non-self) comment's
      // timestamp — proves the self comment was excluded before the
      // newest-timestamp computation, not just before the round-trigger
      // decision.
      expect(row.lastPrReviewCommentAt?.toISOString()).toBe("2026-08-20T10:00:00.000Z");

      await app.close();
    });

    it("advances the cursor to the NEWEST comment across multiple unresolved threads, not the first", async () => {
      const app = await buildApp();
      const { taskId } = await createPrCommentCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockFetchPullRequestReviewThreads.mockResolvedValue({
        viewerLogin: "mullion-bot[bot]",
        threads: [
          thread(false, "octocat", "Older comment.", "2026-08-20T08:00:00Z"),
          thread(false, "octocat", "Newest comment.", "2026-08-20T12:00:00Z"),
          thread(false, "octocat", "Middle comment.", "2026-08-20T10:00:00Z"),
        ],
        truncated: false,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.lastPrReviewCommentAt?.toISOString()).toBe("2026-08-20T12:00:00.000Z");

      await app.close();
    });
  });

  it("waits forever (no deadline) when no CI is found at all — unlike the review-spawn gate", async () => {
    const app = await buildApp();
    const { taskId } = await createAutoApproveCandidate(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr());
    mockFetchRunsForHead.mockResolvedValue([]);

    await reconcileTasks(app);

    expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");

    await app.close();
  });

  it("backs off and retries when the CI lookup itself throws", async () => {
    const app = await buildApp();
    await createAutoApproveCandidate(app);
    mockGetPullRequestByNumber.mockRejectedValue(new Error("network blip"));

    await reconcileTasks(app);

    expect(mockPromoteTaskToPR).not.toHaveBeenCalled();

    await app.close();
  });

  it("does not treat a concurrent human approve/reject (cas-lost) as an error", async () => {
    const app = await buildApp();
    const { taskId } = await createAutoApproveCandidate(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr());
    mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
    // Simulates a human's reject landing while promoteTaskToPR's own
    // network call is still in flight.
    mockPromoteTaskToPR.mockImplementationOnce(async () => {
      app.db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, taskId)).run();
      return { ok: true, prUrl: "https://github.com/o/r/pull/9", prNumber: 9 };
    });

    await expect(reconcileTasks(app)).resolves.toBeUndefined();

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");

    await app.close();
  });

  it("backs off after an attempt instead of re-checking CI on every tick", async () => {
    const app = await buildApp();
    await createAutoApproveCandidate(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr());
    mockFetchRunsForHead.mockResolvedValue(ciRun("failure"));

    await reconcileTasks(app);
    await reconcileTasks(app);

    // Second tick lands well inside the 1-minute TTL — no second lookup.
    expect(mockGetPullRequestByNumber).toHaveBeenCalledTimes(1);

    await app.close();
  });

  // Hermes review, PR #768 — attemptAutoApprove's switch on
  // ApproveOutcome's failure reasons originally omitted "no-worktree"
  // entirely (no case, no default), so it fell through silently: no log,
  // no named disposition, directly contradicting the function's own
  // "every reason needs a named disposition" contract. Proves the task
  // stays in "reviewing" (retried, not marked failed) and that the
  // disposition is now actually logged.
  it("backs off and logs on a 'no-worktree' promotion failure, instead of falling through silently", async () => {
    const app = await buildApp();
    const { taskId } = await createAutoApproveCandidate(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr());
    mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
    mockPromoteTaskToPR.mockResolvedValueOnce({
      ok: false,
      reason: "no-worktree",
      detail: "Task has no worktree to promote",
    });
    const warnSpy = vi.spyOn(app.log, "warn");

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, reason: "no-worktree" }),
      "task reconcile: auto-approve attempt failed — retrying",
    );

    await app.close();
  });

  it("a 403 push (push-forbidden) warns once and skips straight to the slowest retry cadence (#2104)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockPromoteTaskToPR.mockReset().mockResolvedValue({
        ok: false,
        reason: "push-forbidden",
        detail: "GitHub refused the push (403)",
      });
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);
      expect(mockPromoteTaskToPR).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
        expect.stringContaining("auto-approve push refused (403)"),
      );
      expect((await getTask(app, taskId)).status).toBe("reviewing");

      // The ordinary ramp would retry after a minute or two; the ceiling is 30 minutes.
      vi.setSystemTime(Date.now() + 10 * 60_000);
      await reconcileTasks(app);
      expect(mockPromoteTaskToPR).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 25 * 60_000);
      await reconcileTasks(app);
      expect(mockPromoteTaskToPR).toHaveBeenCalledTimes(2);

      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("#759 — does not attempt an auto-approve while the install-wide GitHub rate-limit budget is in effect", async () => {
    const app = await buildApp();
    try {
      await createAutoApproveCandidate(app);
      recordGitHubRateLimit(Date.now() + 60_000);

      await reconcileTasks(app);

      expect(mockFetchRunsForHead).not.toHaveBeenCalled();
    } finally {
      resetGitHubRateLimitForTests();
      await app.close();
    }
  });
});
