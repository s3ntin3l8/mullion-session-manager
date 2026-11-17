import { describe, it, expect, vi } from "vitest";
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
  fakeInfo,
  getTask,
  createSessionAndTaskWithBase,
  gitStatus,
  claimIntoReviewing,
  writeFindings,
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

const {
  mockPromoteTaskToPR,
  mockResolveHostGitStatus,
  mockCommitHostWipChanges,
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockFetchRunsForHead,
} = reconcilerMocks;

describe("reconcileTasks — rate-limit grace (#1015)", () => {
  setupReconcilerTestLifecycle("task-reconciler-rate-limit-grace");
  describe("worker path", () => {
    // #1015 follow-up — rate_limit stop_failure on an in_progress task with
    // no commits past base used to fall straight into checkReviewingGate and
    // fail immediately. The grace window holds the task in_progress while
    // the agent's subscription quota cools down, with no commits getting
    // failed/salvaged for the configured graceMinutes.
    //
    // Hermes review, round 2 (PR #1027) — the rate_limit classification
    // now lives on the task row (`lastRateLimitAt`), not just the
    // session's in-memory `errorState`/`errorDetail` (which is TTL-cleared
    // by `PtyManager.clearStaleErrorIfOlderThan` at `staleErrorSeconds`,
    // default 30min). The reconciler's `recordRateLimitEvent` capture
    // happens the moment a `rate_limit` is observed persists across
    // the TTL — the only way the long-grace case (multi-day quota
    // cooldowns) actually works. Each test pre-seeds or trusts the
    // capture as appropriate.
    it("keeps an in_progress task with api_error + rate_limit + no commits alive during the grace window", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 5 } },
      });
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () =>
          fakeInfo({
            lastTurnEndedAt: Date.now(),
            errorState: "api_error",
            errorAt: Date.now() - 60_000,
            errorDetail: "rate_limit",
          }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      // Grace skips the gate entirely — no WIP salvage, no terminate.
      expect(mockCommitHostWipChanges).not.toHaveBeenCalled();
      // The capture MUST have written lastRateLimitAt to the task row
      // (Hermes review, round 2) — otherwise a session-level errorState
      // TTL clear would strand the task in_progress on the next tick.
      expect(row.lastRateLimitAt).not.toBeNull();

      await app.close();
    });

    it("fails the task with a rate_limit-prefixed reason once the grace window expires", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 5 } },
      });
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      // Pre-seed the durable column to 6 minutes ago — past the 5-minute
      // grace window. The session is configured with `errorDetail:
      // "overloaded"` (NOT "rate_limit") so the reconciler's capture
      // (recordRateLimitEvent) doesn't overwrite the pre-seed with
      // `now` — every observed rate_limit restarts the window, so the
      // only way to test "grace expired" is to keep the live session
      // mis-classified while the durable column is past the window.
      // `errorState: "api_error"` is still set so the outer gate
      // (api_error branch) fires; only the classification differs.
      const sixMinAgo = new Date(Date.now() - 6 * 60_000);
      app.db.update(tasks).set({ lastRateLimitAt: sixMinAgo }).where(eq(tasks.id, taskId)).run();
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () =>
          fakeInfo({
            lastTurnEndedAt: Date.now(),
            errorState: "api_error",
            errorAt: Date.now() - 6 * 60_000,
            errorDetail: "overloaded",
          }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));
      mockCommitHostWipChanges.mockResolvedValue({ ok: true, value: { committed: true } });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("rate_limit");
      expect(row.failureReason).toContain("no commits");

      await app.close();
    });

    it("does not grace a non-rate_limit errorDetail (e.g. overloaded) — fails immediately", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 5 } },
      });
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () =>
          fakeInfo({
            lastTurnEndedAt: Date.now(),
            errorState: "api_error",
            errorAt: Date.now() - 60_000,
            errorDetail: "overloaded",
          }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));
      mockCommitHostWipChanges.mockResolvedValue({ ok: true, value: { committed: true } });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).not.toContain("rate_limit");
      // Capture is gated on `errorDetail === "rate_limit"`, so a
      // different classification never writes the column.
      expect(row.lastRateLimitAt).toBeNull();

      await app.close();
    });

    it("lets the task advance to reviewing once the agent recovers (errorState clears) within the grace window", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 5 } },
      });
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      const getSpy = vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () =>
          fakeInfo({
            lastTurnEndedAt: Date.now(),
            errorState: "api_error",
            errorAt: Date.now() - 60_000,
            errorDetail: "rate_limit",
          }),
      } as never);
      // First reconcile — grace active, task stays in_progress.
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));
      await reconcileTasks(app);
      const afterTick1 = await getTask(app, taskId);
      expect(afterTick1.status).toBe("in_progress");
      // Capture wrote lastRateLimitAt
      expect(afterTick1.lastRateLimitAt).not.toBeNull();

      // Simulate recovery: agent's Stop hook fired again with no error, so
      // errorState is now "idle" AND the worker made commits before
      // hitting the rate-limit error.
      getSpy.mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

      await reconcileTasks(app);

      expect((await getTask(app, taskId)).status).toBe("reviewing");
      await app.close();
    });

    // Hermes review, round 2 (PR #1027) — TTL-clear regression guard.
    // The rate_limit signal lives on the task row, not just the session's
    // in-memory errorState. Once `PtyManager.clearStaleErrorIfOlderThan`
    // clears the session's errorState at `staleErrorSeconds` (default
    // 30min), the durable lastRateLimitAt must still keep the task in
    // the grace branch — the outer gate widens to include
    // `(finished || api_error || in_grace)` to make this work.
    it("keeps an in_progress task in grace after the session's errorState is TTL-cleared (durable lastRateLimitAt only)", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 5 } },
      });
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      // Pre-seed the durable column — this represents "the rate_limit
      // happened on an earlier tick and the session's errorState has
      // since been TTL-cleared" (post-30-min scenario).
      const oneMinAgo = new Date(Date.now() - 60_000);
      app.db.update(tasks).set({ lastRateLimitAt: oneMinAgo }).where(eq(tasks.id, taskId)).run();
      // Session now reports idle/empty — what a TTL-cleared session looks
      // like. `derived.status` will be `idle`, NOT `api_error`. The
      // outer-gate widening (in_grace branch) is what keeps this tick
      // engaged.
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo(),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      // Grace active — task stays in_progress, no WIP salvage, no terminate.
      expect(row.status).toBe("in_progress");
      expect(mockCommitHostWipChanges).not.toHaveBeenCalled();

      // Clean up: see the matching comment in the "keeps an in_progress
      // task alive" test above. The durable lastRateLimitAt on this
      // task would otherwise haunt a later test's worker loop the same
      // way.
      app.db
        .update(tasks)
        .set({ status: "failed", failureReason: "test cleanup" })
        .where(eq(tasks.id, taskId))
        .run();

      await app.close();
    });

    // Hermes review, round 3 (PR #1027) — a task that captured a
    // rate_limit (durable lastRateLimitAt is recent) and then within the
    // grace window hit a DIFFERENT api_error (`overloaded`,
    // `authentication_failed`, ...) must NOT be graced. The durable
    // continue is gated on `derived.status !== "api_error"` so a
    // fresh non-rate_limit error falls through to the no-commits gate
    // and fails. Without this guard, the documented scope ("graceful
    // survival is scoped EXCLUSIVELY to `rate_limit`") would be
    // violated by error-class cascades within the grace window.
    it("does NOT grace a non-rate_limit api_error that follows a rate_limit within the window (worker path)", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 60 } },
      });
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      // Pre-seed lastRateLimitAt to 1 minute ago (well within the 60-min
      // grace window) — represents a prior rate_limit that the durable
      // column captured. The current session is now `api_error` with
      // `errorDetail: "overloaded"` — a different error class.
      app.db
        .update(tasks)
        .set({ lastRateLimitAt: new Date(Date.now() - 60_000) })
        .where(eq(tasks.id, taskId))
        .run();
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () =>
          fakeInfo({
            lastTurnEndedAt: Date.now(),
            errorState: "api_error",
            errorAt: Date.now() - 30_000,
            errorDetail: "overloaded",
          }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));
      mockCommitHostWipChanges.mockResolvedValue({ ok: true, value: { committed: true } });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      // Non-rate_limit error on a live api_error session must NOT be
      // graced — the documented scope is exclusive to `rate_limit`.
      // The task fails via checkReviewingGate (no commits past base).
      // The failure reason may carry a "rate_limit" prefix because
      // checkReviewingGate's persistedRateLimit heuristic adds one
      // whenever the durable column is recent (Hermes review, round
      // 3, suggested-noting: "informational and acknowledged in the
      // comment; fine to leave") — what matters here is the task IS
      // failed (not stuck in grace) despite the durable column.
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("no commits");

      await app.close();
    });
  });

  describe("review-agent path", () => {
    // #1015 follow-up — rate_limit stop_failure on the review-agent path. The
    // worker side's #1015 grace window protects an in_progress task from
    // being failed by a stuck-on-quota agent; the review side does the same
    // for a reviewing task. Without this, a review agent that ran out of
    // subscription quota mid-review posts an inconclusive verdict and strands
    // the task in `reviewing` indefinitely (wantsAutoReturn requires
    // `derived.status === "finished"`, never true for `api_error`).
    //
    // Hermes review, round 2 — the rate_limit classification now lives on
    // the task row (`lastRateLimitAt`) and persists across the session's
    // errorState TTL clear. The capture happens in the reconciler the
    // moment it observes `errorDetail === "rate_limit"`.
    it("keeps a reviewing task alive while the review session's api_error + rate_limit grace window is active", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 5 } },
      });
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // Review session now reports api_error + rate_limit, no findings file
      // (claimIntoReviewing never writes one).
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({
                    errorState: "api_error",
                    errorAt: Date.now() - 60_000,
                    errorDetail: "rate_limit",
                  })
                : fakeInfo(),
          }) as never,
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      // Grace active — no comment posted, no auto-return, no failure
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toBeNull();
      expect(row.reviewFindingsIngestedSessionId).toBeNull();
      // Capture wrote lastRateLimitAt to the task row (Hermes round 2).
      expect(row.lastRateLimitAt).not.toBeNull();

      await app.close();
    });

    it("ingests the review session as inconclusive once the rate_limit grace window expires (no findings file, agent never recovered)", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 5 } },
      });
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // Pre-seed lastRateLimitAt to 6 minutes ago (past the 5-min grace
      // window) — simulates "the rate_limit happened some time ago, the
      // session's errorState has since TTL-cleared, but the durable
      // column still carries the signal." The session is configured
      // with `errorDetail: "overloaded"` so the capture doesn't
      // overwrite the pre-seed with `now` (every observed rate_limit
      // restarts the window — see the matching worker test for the
      // full reasoning).
      app.db
        .update(tasks)
        .set({ lastRateLimitAt: new Date(Date.now() - 6 * 60_000) })
        .where(eq(tasks.id, taskId))
        .run();
      // Age the session past REVIEW_FINDINGS_GRACE_MS (30 min) so the
      // existing isUsableSignal path accepts the api_error verdict.
      const { sessions } = await import("../../src/db/schema.js");
      await app.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(sessions.id, reviewSessionId));
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({
                    errorState: "api_error",
                    errorAt: Date.now() - 6 * 60_000,
                    errorDetail: "overloaded",
                  })
                : fakeInfo(),
          }) as never,
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      // Grace expired — falls through to the existing inconclusive path.
      // `api_error` derives to "produced no findings file within the
      // expected time" (not "ended without" — that's the exited wording).
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toContain("Review agent produced no findings file");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);

      await app.close();
    });

    it("does NOT grace a non-rate_limit review-session errorDetail (e.g. overloaded) — falls through immediately", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 5 } },
      });
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // Age the session past REVIEW_FINDINGS_GRACE_MS so the existing
      // isUsableSignal path accepts the api_error verdict.
      const { sessions } = await import("../../src/db/schema.js");
      await app.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(sessions.id, reviewSessionId));
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({
                    errorState: "api_error",
                    errorAt: Date.now() - 60_000,
                    errorDetail: "overloaded",
                  })
                : fakeInfo(),
          }) as never,
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      // Wrong errorDetail — grace skipped, inconclusive comment posted
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      // Capture is gated on `errorDetail === "rate_limit"`, so a
      // different classification never writes the column.
      expect(row.lastRateLimitAt).toBeNull();

      await app.close();
    });

    it("auto-approves on the very next sweep after an approving verdict is ingested, not after the backoff built up while waiting", async () => {
      const app = await buildApp();
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      const [row0] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${row0.projectId}`,
        payload: { autoApprove: true },
      });
      app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
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
      mockFetchRunsForHead.mockResolvedValue([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha-head",
        },
      ]);
      mockPromoteTaskToPR.mockResolvedValueOnce({
        ok: true,
        prUrl: "https://github.com/o/r/pull/9",
        prNumber: 9,
      });
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({ lastTurnEndedAt: Date.now() })
                : fakeInfo(),
          }) as never,
      );

      // Tick 1: no findings file yet, so the sweep visits the task, records
      // an attempt and bails out (verdict not ingested) — a 1-minute backoff.
      await reconcileTasks(app);
      expect((await getTask(app, taskId)).status).toBe("reviewing");

      // Tick 2: the approving verdict lands and ingestion must reset the
      // backoff so the same tick's sweep approves.
      writeFindings(app, taskId, 0, JSON.stringify({ verdict: "clean", summary: "All good." }));
      await reconcileTasks(app);

      expect((await getTask(app, taskId)).status).toBe("done");

      await app.close();
    });

    it("ignores the grace window when a findings file already exists (real review advances normally)", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 5 } },
      });
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // Real findings file already on disk
      writeFindings(
        app,
        taskId,
        0,
        JSON.stringify({
          verdict: "clean",
          summary: "Reviewed the diff; no issues.",
        }),
      );
      // Review session reports `finished` (not api_error) — exercises the
      // happy path: real review with a real file. The grace check is
      // `parsed === null && ...`, so a parsed findings file bypasses it
      // entirely. The `finished` status also lets the existing
      // isUsableSignal path ingest normally.
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({ lastTurnEndedAt: Date.now() })
                : fakeInfo(),
          }) as never,
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      // Clean verdict — stays in reviewing (no auto-return), but ingested
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toContain("Reviewed the diff; no issues.");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);

      await app.close();
    });

    // Hermes review, round 3 (PR #1027) — the review-agent path
    // needed the same durable-column fallback the worker path got in
    // round 2. Without this, a review agent with
    // `rateLimitGraceMinutes > 30` (the documented 1440 cap for
    // weekly/monthly cooldowns) would fall through to the
    // `isUsableSignal` inconclusive path once the session's
    // `errorState` TTLs at `staleErrorSeconds` (default 30 min). The
    // durable `lastRateLimitAt` is the only signal that survives the
    // TTL — this test pre-seeds it and confirms the review task stays
    // in grace (no inconclusive comment, no auto-return) even though
    // the review session reports idle/post-TTL.
    it("keeps a reviewing task alive via the durable lastRateLimitAt after the review session's errorState is TTL-cleared", async () => {
      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { rateLimitGraceMinutes: 60 } },
      });
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // Pre-seed lastRateLimitAt to 1 minute ago (well within the 60-min
      // grace). No findings file written — simulates a review agent
      // that hit a quota mid-review and then the session's error
      // state TTL-cleared, with the durable column carrying the
      // signal.
      app.db
        .update(tasks)
        .set({ lastRateLimitAt: new Date(Date.now() - 60_000) })
        .where(eq(tasks.id, taskId))
        .run();
      // Review session now reports idle (post-TTL-clear state) — what
      // a session looks like after `staleErrorSeconds` cleared its
      // `errorState`/`errorDetail`. `derived.status` will be `idle`,
      // NOT `api_error`. Without the durable fallback the
      // reconciler would have posted an inconclusive verdict.
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () => (String(id) === String(reviewSessionId) ? fakeInfo() : fakeInfo()),
          }) as never,
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      // Durable grace — task stays in reviewing, no comment posted,
      // no auto-return, no failure.
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toBeNull();
      expect(row.reviewFindingsIngestedSessionId).toBeNull();

      await app.close();
    });
  });
});
