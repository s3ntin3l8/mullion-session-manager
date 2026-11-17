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
  createDoneTaskWithPendingMerge,
  mockPr,
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
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { recordGitHubRateLimit, resetGitHubRateLimitForTests } =
  await import("../../src/services/github-fetch.js");

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockResolveReviewerToken,
  mockResolveMullionReviewLogins,
  mockGetPullRequestByNumber,
  mockMergePullRequest,
  mockCreatePullRequestReview,
  mockGetPullRequestReviewDecision,
  mockFetchPullRequestReviewThreads,
  mockResolveReviewThread,
} = reconcilerMocks;

describe("reconcileTasks — merge blocked review decision (#737)", () => {
  setupReconcilerTestLifecycle("task-reconciler-merge-decision");
  beforeEach(() => {
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
  });

  // #737 — "blocked" collapses several distinct reasons; these pin the
  // review-decision-aware message and the re-assert path.
  describe("blocked -> review decision (#737)", () => {
    it("reports a missing required review distinctly from a red/pending check", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeError).toContain("Waiting on a required approving review");

      await app.close();
    });

    it("reports changes-requested distinctly, without re-asserting (no reviewer App configured)", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      mockGetPullRequestReviewDecision.mockResolvedValue("CHANGES_REQUESTED");
      mockResolveReviewerToken.mockResolvedValue(null);

      await reconcileTasks(app);

      expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeError).toContain("Changes were requested on the PR");

      await app.close();
    });

    it("falls back to the generic checks message when the review-decision read itself fails", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      mockGetPullRequestReviewDecision.mockRejectedValue(new Error("GraphQL error"));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.mergeError).toContain("Required checks");

      await app.close();
    });

    // D1/D3 — a live dry run (2026-08-27) confirmed this exact deadlock:
    // a "blocked" PR with no required-approval rule (`reviewDecision:
    // null`) and green CI was still misdiagnosed as "Required checks are
    // red or still pending" when the real, sole cause was an unresolved
    // review conversation. These derive the cause from OBSERVED threads
    // (branch protection's own `required_conversation_resolution` flag
    // isn't readable without the `administration` scope this App
    // deliberately doesn't have).
    describe("blocked -> unresolved review conversations (D1/D3)", () => {
      it("reports the unresolved-conversation count instead of the generic message", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [
            {
              id: "thread-human",
              isResolved: false,
              comments: [
                {
                  author: "octocat",
                  createdAt: "2026-08-20T10:00:00Z",
                  path: "src/foo.ts",
                  line: 1,
                  body: "Just a suggestion.",
                },
              ],
            },
            // Already resolved — must not count toward the total.
            {
              id: "thread-resolved",
              isResolved: true,
              comments: [
                {
                  author: "octocat",
                  createdAt: "2026-08-19T10:00:00Z",
                  path: "src/bar.ts",
                  line: 1,
                  body: "Already handled.",
                },
              ],
            },
          ],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeError).toBe("Blocked on 1 unresolved review conversation");
        // The unresolved thread is a human's — never a candidate to auto-resolve.
        expect(mockResolveReviewThread).not.toHaveBeenCalled();

        await app.close();
      });

      it("self-heals by resolving Mullion's own stale thread when its last ingested verdict was clean", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        // Simulates round 2 already coming back clean, but the
        // verdict-time resolve attempt (processReviewingTasks) itself
        // failing (fetch error, truncation, mint failure) — the merge
        // sweep is the backstop that retries it.
        app.db.update(tasks).set({ lastReviewVerdict: "clean" }).where(eq(tasks.id, taskId)).run();
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
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
        });
        mockResolveMullionReviewLogins.mockResolvedValue(
          new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
        );

        await reconcileTasks(app);

        expect(mockResolveReviewThread).toHaveBeenCalledExactlyOnceWith("tok", "thread-own");
        // Independent review, round 3 — the diagnostic message below must
        // reuse the self-heal's own fetch rather than paying for a
        // second GraphQL round trip in the same tick.
        expect(mockFetchPullRequestReviewThreads).toHaveBeenCalledOnce();

        await app.close();
      });

      // Independent review, round 2 — the defect this test guards against:
      // `POST .../approve` and the closed-issue sync path both promote
      // "reviewing" straight to "done" on `canTransition` alone, never
      // consulting `lastReviewVerdict`. A human (or a closed issue) can
      // therefore reach "done" with a standing "changes-requested"
      // verdict still on the row. Self-healing in that case would
      // silently resolve Mullion's own unaddressed finding with zero
      // corroboration it was ever fixed — exactly the failure mode the
      // "clean verdict" gate exists to prevent.
      it("does NOT self-heal when the task's last ingested verdict was changes-requested", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        app.db
          .update(tasks)
          .set({ lastReviewVerdict: "changes-requested" })
          .where(eq(tasks.id, taskId))
          .run();
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
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
        });
        mockResolveMullionReviewLogins.mockResolvedValue(
          new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
        );

        await reconcileTasks(app);

        expect(mockResolveReviewThread).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.mergeError).toBe("Blocked on 1 unresolved review conversation");

        await app.close();
      });

      // Independent review, round 3 — a repo requiring BOTH an approval
      // AND conversation resolution can be "blocked" with the approval
      // requirement already satisfied (reviewDecision: "APPROVED") while
      // a stale conversation is the sole remaining cause. Treating
      // "APPROVED" as already-explained (the old behavior) would leave
      // exactly this combination on the generic, misleading message
      // forever.
      it("reports the unresolved-conversation cause even when reviewDecision is APPROVED", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockGetPullRequestReviewDecision.mockResolvedValue("APPROVED");
        mockResolveReviewerToken.mockResolvedValue(null);
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [
            {
              id: "thread-human",
              isResolved: false,
              comments: [
                {
                  author: "octocat",
                  createdAt: "2026-08-20T10:00:00Z",
                  path: "src/foo.ts",
                  line: 1,
                  body: "Please also fix this.",
                },
              ],
            },
          ],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeError).toBe("Blocked on 1 unresolved review conversation");

        await app.close();
      });

      it("keeps the generic message when there are no unresolved threads at all", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [],
          truncated: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeError).toBe("Required checks are red or still pending");
        // Independent review, round 2 — with zero unresolved threads,
        // resolveMullionOwnThreadsIfClean's own cheap pre-filter must
        // skip the reviewer-identity lookup entirely, not just skip
        // resolving anything after paying for it.
        expect(mockResolveMullionReviewLogins).not.toHaveBeenCalled();

        await app.close();
      });

      it("fails closed (keeps the generic message) rather than trusting a truncated thread enumeration", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [],
          truncated: true,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeError).toBe(
          "Blocked on the PR, but its review threads couldn't be fully enumerated",
        );
        expect(mockResolveReviewThread).not.toHaveBeenCalled();

        await app.close();
      });

      it("keeps the generic message when the thread fetch itself fails", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
        mockFetchPullRequestReviewThreads.mockRejectedValue(new Error("GitHub is down"));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeError).toBe("Required checks are red or still pending");

        await app.close();
      });
    });

    // Re-assert: `attemptMerge` only ever runs for `status: "done"` tasks
    // (this suite's own createDoneTaskWithPendingMerge), so every case
    // below already satisfies that half of the gate implicitly.
    it("re-asserts an APPROVE from the reviewer identity when a prior approval was dismissed", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");
      mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
      mockCreatePullRequestReview.mockResolvedValue({
        id: 999,
        htmlUrl: "https://github.com/o/r/pull/9#pullrequestreview-999",
      });

      await reconcileTasks(app);

      expect(mockCreatePullRequestReview).toHaveBeenCalledWith("reviewer_tok", "o", "r", 9, {
        body: expect.any(String),
        commitId: "sha-head",
        event: "APPROVE",
      });
      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      // No error recorded — the sweep re-classifies fresh state next tick
      // rather than surfacing a message this tick already knows is stale.
      expect(row.mergeError).toBeNull();

      await app.close();
    });

    // Hermes review, PR #827 (round 3): the round-2 memoization
    // (`lastReassertedSha`) was silently defeated by `processMergeRequests`
    // unconditionally overwriting the WHOLE `mergeRetryState` entry
    // (without spreading the prior one) immediately before every
    // `attemptMerge` call — so the re-assert-once-per-SHA guard never
    // actually survived past the tick that set it. This file otherwise
    // avoids `vi.useFakeTimers` (see the red-CI dedup describe block's own
    // comment on why), but that precedent is about *DB-backed* timestamps
    // having no fake-timer equivalent — this is a plain in-memory Map read
    // via `Date.now()`, which fake timers control directly. Scoped tightly
    // to this one test.
    it("does not repost the re-assert APPROVE on the next tick for an unchanged head SHA", async () => {
      const app = await buildApp();
      await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");
      mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
      mockCreatePullRequestReview.mockResolvedValue({ id: 999, htmlUrl: "https://x" });

      // Date only: the in-flight task sweep may probe a leftover exited session (#2602) a fully faked clock stalls that probe.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await reconcileTasks(app);
        expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);

        // Past MERGE_RETRY_TTL_MS's own per-task backoff, so this second
        // tick actually reaches attemptMerge again rather than being
        // skipped by the unrelated rate limiter — isolating the
        // memoization itself as what's under test.
        vi.setSystemTime(Date.now() + 61_000);
        await reconcileTasks(app);
      } finally {
        vi.useRealTimers();
      }

      // Still exactly once: the same head SHA (mockGetPullRequestByNumber
      // never changes it) must have been recognized as already
      // re-asserted, surviving processMergeRequests' own state write
      // between the two ticks.
      expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);

      await app.close();
    });

    // Hermes review, PR #827: re-assert used to also fire on
    // CHANGES_REQUESTED, which would silently override a review posted
    // AFTER the task's own approval (a human on GitHub, or a later
    // review-agent round) — exactly the "manufacture an approval nobody
    // made" failure mode this mechanism must never become. Pins that a
    // configured, working reviewer App does NOT change this outcome —
    // the earlier "no reviewer App configured" case above already
    // covered the message; this covers that the identity being available
    // doesn't matter for CHANGES_REQUESTED specifically.
    it("never re-asserts over CHANGES_REQUESTED even when a reviewer App is configured and working", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      mockGetPullRequestReviewDecision.mockResolvedValue("CHANGES_REQUESTED");
      mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
      mockCreatePullRequestReview.mockResolvedValue({ id: 999, htmlUrl: "https://x" });

      await reconcileTasks(app);

      expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeError).toContain("Changes were requested on the PR");

      await app.close();
    });

    it("does not re-assert when GitHub already reports APPROVED (no spin)", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      mockGetPullRequestReviewDecision.mockResolvedValue("APPROVED");
      mockResolveReviewerToken.mockResolvedValue("reviewer_tok");

      await reconcileTasks(app);

      expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      // Still "blocked" on GitHub's mergeable_state despite an APPROVED
      // review decision (e.g. a required CHECK, not a review, is what's
      // actually red) — falls through to the generic checks message.
      expect(row.mergeError).toContain("Required checks");

      await app.close();
    });

    it("does not re-assert, and reports the specific message, when no reviewer App is configured", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");
      mockResolveReviewerToken.mockResolvedValue(null);

      await reconcileTasks(app);

      expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeError).toContain("Waiting on a required approving review");

      await app.close();
    });

    it("falls back to recording the message when the re-assert attempt itself fails", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));
      mockGetPullRequestReviewDecision.mockResolvedValue("REVIEW_REQUIRED");
      mockResolveReviewerToken.mockResolvedValue("reviewer_tok");
      mockCreatePullRequestReview.mockRejectedValueOnce(new Error("HTTP 422"));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.mergeError).toContain("Waiting on a required approving review");

      await app.close();
    });
  });

  it("waits with no error recorded while GitHub is still computing mergeability (mergeable: null)", async () => {
    const app = await buildApp();
    const { taskId } = await createDoneTaskWithPendingMerge(app);
    mockGetPullRequestByNumber.mockResolvedValue(
      mockPr({ mergeable: null, mergeableState: "unknown" }),
    );

    await reconcileTasks(app);

    expect(mockMergePullRequest).not.toHaveBeenCalled();
    const row = await getTask(app, taskId);
    expect(row.mergeRequestedAt).not.toBeNull();
    expect(row.mergeError).toBeNull();

    await app.close();
  });

  it("clears the merge flag idempotently when the PR was already merged out of band", async () => {
    const app = await buildApp();
    const { taskId } = await createDoneTaskWithPendingMerge(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ merged: true, state: "closed" }));

    await reconcileTasks(app);

    expect(mockMergePullRequest).not.toHaveBeenCalled();
    const row = await getTask(app, taskId);
    expect(row.mergeRequestedAt).toBeNull();
    expect(row.mergeError).toBeNull();

    await app.close();
  });

  // Hermes review, PR #763 — clearMergeState must drop the task's
  // mergeRetryState entry, not just the DB flag. Proved indirectly: a
  // fresh merge request for the SAME task right after resolution is
  // attempted on the very next tick rather than being suppressed by a
  // leftover backoff entry from the resolved attempt.
  it("re-attempts a fresh merge request immediately after a prior resolution, not backed off by a stale entry", async () => {
    const app = await buildApp();
    const { taskId } = await createDoneTaskWithPendingMerge(app);
    mockGetPullRequestByNumber.mockResolvedValueOnce(mockPr({ merged: true, state: "closed" }));

    await reconcileTasks(app);
    let row = await getTask(app, taskId);
    expect(row.mergeRequestedAt).toBeNull();

    // mergedAt cleared too: a merged task never records a merge error
    // (recordMergeError's mergedAt guard), so this re-arm models a fresh,
    // unmerged request rather than a merged one.
    app.db
      .update(tasks)
      .set({ mergeRequestedAt: new Date(), mergedAt: null })
      .where(eq(tasks.id, taskId))
      .run();
    mockGetPullRequestByNumber.mockResolvedValueOnce(mockPr({ mergeableState: "dirty" }));

    await reconcileTasks(app);

    expect(mockGetPullRequestByNumber).toHaveBeenCalledTimes(2);
    row = await getTask(app, taskId);
    expect(row.mergeError).toContain("Conflicts with main");

    await app.close();
  });

  it("clears the merge flag and flags a human when the PR was closed (not merged) out of band (#2865)", async () => {
    const app = await buildApp();
    const { taskId } = await createDoneTaskWithPendingMerge(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ merged: false, state: "closed" }));

    await reconcileTasks(app);

    expect(mockMergePullRequest).not.toHaveBeenCalled();
    const row = await getTask(app, taskId);
    expect(row.mergeRequestedAt).toBeNull();
    expect(row.mergeError).toContain("closed without merging");

    await app.close();
  });

  it("records the failure and keeps retrying when the merge call itself throws (e.g. a 409 head-sha race)", async () => {
    const app = await buildApp();
    const { taskId } = await createDoneTaskWithPendingMerge(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
    mockMergePullRequest.mockRejectedValue(
      new Error("GitHub API error (HTTP 409): Head branch was modified"),
    );

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.mergeRequestedAt).not.toBeNull();
    expect(row.mergeError).toContain("409");

    await app.close();
  });

  it("backs off after an attempt instead of retrying on every tick", async () => {
    const app = await buildApp();
    await createDoneTaskWithPendingMerge(app);
    mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

    await reconcileTasks(app);
    await reconcileTasks(app);

    // Second tick lands well inside the 1-minute TTL — no second lookup.
    expect(mockGetPullRequestByNumber).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not attempt a merge while Task Master is disabled", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "off" } },
      });
      await createDoneTaskWithPendingMerge(app);

      await reconcileTasks(app);

      expect(mockGetPullRequestByNumber).not.toHaveBeenCalled();
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "inherit" } },
      });
      await app.close();
    }
  });

  it("does not touch a done task with no merge requested", async () => {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: `p-no-merge-${Math.random()}`,
        cwd: "/tmp",
      },
    });
    app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "done, no merge requested",
        status: "done",
        claimedAt: new Date(),
        completedAt: new Date(),
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
      })
      .run();

    await reconcileTasks(app);

    expect(mockGetPullRequestByNumber).not.toHaveBeenCalled();
    await app.close();
  });

  it("#759 — does not attempt a merge while the install-wide GitHub rate-limit budget is in effect", async () => {
    const app = await buildApp();
    try {
      await createDoneTaskWithPendingMerge(app);
      recordGitHubRateLimit(Date.now() + 60_000);

      await reconcileTasks(app);

      expect(mockGetPullRequestByNumber).not.toHaveBeenCalled();
    } finally {
      resetGitHubRateLimitForTests();
      await app.close();
    }
  });
});
