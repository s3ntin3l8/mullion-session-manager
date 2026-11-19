import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
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
  createSessionAndTaskWithReviewAgent,
  mockFinishedSessionIds,
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
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { taskReviewFindingsPath } = await import("../../src/services/task-prompt.js");

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockFetchRunsForHead,
} = reconcilerMocks;

describe("reconcileTasks — CI-gated review spawn", () => {
  setupReconcilerTestLifecycle("task-reconciler-review-spawn");
  describe("CI-gated review spawn (processPendingReviewSpawns)", () => {
    // Local copy of the review-findings-loop describe block's own helper
    // above (not shared scope) — same "only the given ids are finished"
    // reasoning.

    async function claimWithPR(app: Awaited<ReturnType<typeof buildApp>>) {
      // "in_progress", not "claimed" — see claimIntoReviewing's own comment
      // above (task-claim queueing, rate-limit-storm fix removed the
      // claimed -> reviewing edge this helper relies on to reach "reviewing").
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "in_progress",
        "codex",
      );
      app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
      // Targeted, not a blanket "every session is finished" mock (matching
      // mockFinishedSessionIds' own reasoning above): once a review session
      // spawns, a blanket mock would make IT look "finished" too on the
      // very next tick, dragging processReviewingTasks into ingesting it —
      // and since these tests' GitHub mocks resolve a real-looking repo/PR,
      // that pass would then attempt a REAL createPullRequestReview network
      // call. Only the worker session's id is ever "finished" here.
      mockFinishedSessionIds(app, workerSessionId);
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://x/pull/9",
        nodeId: "n",
        draft: true,
        headSha: "sha1",
      });
      return { taskId, workerSessionId };
    }

    // Hermes review, PR #742 — a null status (no runs) waits exactly like
    // "in_progress" rather than spawning immediately. `openDraftPRForTask`
    // and this pass run in the SAME reconcile tick as the → reviewing
    // transition, so the very first lookup here lands within moments of the
    // push that created the head commit — GitHub's Actions runs for a
    // just-pushed commit routinely aren't registered yet, indistinguishable
    // at lookup time from "this repo has no CI at all." Spawning
    // immediately on that null would reproduce the exact #213782 incident
    // this whole change exists to prevent.
    it("waits when CI resolves to null (no runs yet) and before the deadline, then spawns once it's terminal on a later tick", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([]);

      await reconcileTasks(app);

      let row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull();

      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      await reconcileTasks(app);

      row = await getTask(app, taskId);
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    it("spawns anyway once reviewCiWaitMinutes is exceeded, even while CI still resolves to null (no runs)", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: 0 } },
        });
        const { taskId } = await claimWithPR(app);
        mockFetchRunsForHead.mockResolvedValueOnce([]);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).not.toBeNull();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: -1 } },
        });
        await app.close();
      }
    });

    it("spawns in the same tick as the transition once CI is already terminal (failure)", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "failure",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    // A dirty PR is no longer spawned for after the wait deadline: it goes to
    // the rebase flow instead (task-reconciler-review-conflict.test.ts, #3339).

    // Task Master trial 220921 / PR #743 — `unlinkFindingsFileIfPresent` used
    // to run only at INGEST time, so a leftover from a prior same-round
    // attempt (round-suffixed, not per-attempt — see
    // `taskReviewFindingsPath`'s own doc comment on why round-suffixing
    // alone doesn't cover this) would sit on disk until the NEXT review
    // agent's own turn ends, at which point it would be read as if it were
    // this fresh attempt's real output. `spawnReviewAgentNow` now unlinks it
    // before the fresh agent even starts, closing that window entirely.
    it("unlinks a stale round-N findings file at spawn time, before the fresh review agent writes anything", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      const sessionsDir = path.dirname(app.pty.hookSocketPath);
      const findingsPath = taskReviewFindingsPath(sessionsDir, taskId, 0);
      fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
      fs.writeFileSync(
        findingsPath,
        JSON.stringify({
          verdict: "clean",
          summary: "STALE — left over from a prior attempt at this same round.",
        }),
      );
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();
      expect(fs.existsSync(findingsPath)).toBe(false);

      await app.close();
    });

    it("waits while CI is in_progress and before the deadline, then spawns once it's terminal on a later tick", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        { name: "CI", status: "queued", conclusion: null, htmlUrl: "https://x/1", headSha: "sha1" },
      ]);

      await reconcileTasks(app);

      let row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull(); // never claimed — nothing to wait for is not the same as failed

      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      await reconcileTasks(app);

      row = await getTask(app, taskId);
      expect(row.reviewSessionId).not.toBeNull();
      // The worker session itself is untouched by any of this — only the
      // review AGENT'S spawn was gated, not the worker's own completion.
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    it("spawns anyway once reviewCiWaitMinutes is exceeded, even while CI is still in_progress", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: 0 } },
        });
        const { taskId } = await claimWithPR(app);
        mockFetchRunsForHead.mockResolvedValueOnce([
          {
            name: "CI",
            status: "queued",
            conclusion: null,
            htmlUrl: "https://x/1",
            headSha: "sha1",
          },
        ]);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        // waitMinutes: 0 means "never wait" — `now - reviewingAt` is always
        // `>= 0`, so the deadline is already past on the very first check.
        expect(row.reviewSessionId).not.toBeNull();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: -1 } },
        });
        await app.close();
      }
    });

    // Hermes review, PR #742 (second pass) — a thrown lookup waits up to
    // the deadline exactly like `in_progress`/`null`, rather than spawning
    // without CI on the very first failure: a transient network blip or
    // GitHub not yet being consistent on the brand-new PR, in the exact
    // just-pushed window, is indistinguishable from "will succeed next
    // tick," and spawning immediately would reintroduce the #213782 gap.
    it("waits when the CI lookup itself throws and before the deadline, then spawns once it succeeds on a later tick", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockRejectedValueOnce(new Error("GitHub is down"));
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      let row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
        expect.stringContaining("CI lookup for review spawn failed — waiting to retry"),
      );

      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      await reconcileTasks(app);

      row = await getTask(app, taskId);
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    it("spawns without CI context once a persistently throwing CI lookup passes the wait deadline", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: 0 } },
        });
        const { taskId } = await claimWithPR(app);
        mockFetchRunsForHead.mockRejectedValueOnce(new Error("GitHub is down"));
        const warnSpy = vi.spyOn(app.log, "warn");

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).not.toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ taskId }),
          expect.stringContaining("still failing past the wait deadline"),
        );
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { reviewCiWaitMinutes: -1 } },
        });
        await app.close();
      }
    });

    // The regression guard for the concurrency hazard splitting the spawn
    // out of the transition's own CAS introduced: a CI lookup is genuine
    // async work (unlike the old inline spawn, which ran inside the same
    // CAS'd write as the transition itself), so a human's Reject/Give-up/
    // Approve can land on this exact task while the lookup is still in
    // flight. The claim write's own CAS (re-checking status = "reviewing"
    // AND reviewSessionId/reviewSpawnClaimedAt IS NULL) must refuse rather
    // than spawn a reviewer for a task that's already moved on.
    it("refuses to spawn when a concurrent reject flips the task away from reviewing mid-CI-lookup", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockImplementationOnce(async () => {
        // Simulates a human's Reject landing on this exact task WHILE this
        // lookup is in flight — the same write routes/tasks.ts's own
        // reject handler makes, just fired synchronously here instead of
        // via a real concurrent request.
        app.db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, taskId)).run();
        return [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            htmlUrl: "https://x/1",
            headSha: "sha1",
          },
        ];
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress"); // the concurrent reject wins
      expect(row.reviewSessionId).toBeNull(); // no reviewer spawned for it

      await app.close();
    });

    it("clears the spawn claim on a failed spawn so the next tick retries, rather than leaving the task with no reviewer forever", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      // Scope the one-time failure to this test's project id and delegate
      // every other call to the real implementation.
      const projectId = (await getTask(app, taskId)).projectId;
      const sessionsModule = await import("../../src/services/session-lifecycle.js");
      const actualCreateSessionRecord = sessionsModule.createSessionRecord;
      let failedOnce = false;
      vi.spyOn(sessionsModule, "createSessionRecord").mockImplementation(async (a, opts) => {
        if (!failedOnce && opts.projectId === projectId) {
          failedOnce = true;
          return { ok: false, reason: "spawn-failed" };
        }
        return actualCreateSessionRecord(a, opts);
      });

      await reconcileTasks(app);

      let row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull();

      // Second tick — createSessionRecord runs for real this time.
      await reconcileTasks(app);

      row = await getTask(app, taskId);
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    // Regression guard — spawning a review agent used to be gated on
    // "enabled" only transitively, by riding along inside the (gated) →
    // reviewing transition's own write. Splitting the spawn into this
    // separate pass lost that transitive coverage; must be re-checked
    // explicitly, same posture as retryStrandedDraftPRs' own "does not
    // retry while Task Master is disabled" test above.
    it("does not spawn a review agent while Task Master is disabled, even for a task already in 'reviewing'", async () => {
      const app = await buildApp();
      try {
        const { taskId } = await claimWithPR(app);
        mockFetchRunsForHead.mockResolvedValueOnce([
          {
            name: "CI",
            status: "queued",
            conclusion: null,
            htmlUrl: "https://x/1",
            headSha: "sha1",
          },
        ]);
        await reconcileTasks(app); // -> reviewing; CI still in_progress, so nothing spawns yet either way

        let row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).toBeNull();

        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });

        await reconcileTasks(app);

        row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).toBeNull();
        // The gate must fire before any CI resolution work, not just before
        // the eventual spawn.
        expect(mockFetchRunsForHead).toHaveBeenCalledTimes(1);
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    // Regression guard for the gap the claim CAS alone doesn't close: it
    // protects the WRITE that claims the slot, but createSessionRecord
    // itself (a real spawn, possibly a network round-trip) is real async
    // work after that claim lands, during which Reject/Give-up/Approve can
    // still land — they CAS on `status` alone and know nothing of this
    // claim. The final write must re-check `status = "reviewing"` and
    // discard (kill) the now-orphaned session rather than recording it onto
    // a task that has moved on.
    it("kills the orphaned session when the task leaves 'reviewing' while its review agent is still spawning", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);

      const projectId = (await getTask(app, taskId)).projectId;
      const sessionsModule = await import("../../src/services/session-lifecycle.js");
      const actualCreateSessionRecord = sessionsModule.createSessionRecord;
      vi.spyOn(sessionsModule, "createSessionRecord").mockImplementation(async (a, opts) => {
        if (opts.projectId === projectId) {
          // Simulates a human's Reject landing on this exact task WHILE
          // this spawn's own I/O is in flight — the same write
          // routes/tasks.ts's own reject handler makes, just fired
          // synchronously here instead of via a real concurrent request.
          app.db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, taskId)).run();
        }
        return actualCreateSessionRecord(a, opts);
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress"); // the concurrent reject wins
      expect(row.reviewSessionId).toBeNull(); // never recorded onto a task that moved on
      expect(terminateSpy).toHaveBeenCalledWith(expect.any(String));
      // killSession, not a bare backend.terminate — the orphaned session's
      // own row must flip to "killed" too, or the exited-session reconciler
      // would later surface it as a crashed session with no task behind it.
      const [orphanedSession] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, Number(terminateSpy.mock.calls[0]?.[0])))
        .all();
      expect(orphanedSession?.status).toBe("killed");

      await app.close();
    });

    // Regression guard for the gap the `changes === 0` branch above doesn't
    // cover: a throw AFTER createSessionRecord already succeeded (a DB
    // error on the CAS update, or resolveSeedDelivered itself throwing)
    // used to fall into the generic `catch`, which only cleared the claim —
    // `result` was scoped inside the `try`, unreachable from there, so the
    // already-spawned session was never killed (Hermes review, PR #742).
    it("kills the orphaned session when a later step throws after createSessionRecord already succeeded", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);

      const taskAgentResolveModule = await import("../../src/services/task-agent-resolve.js");
      const resolveSeedDeliveredSpy = vi
        .spyOn(taskAgentResolveModule, "resolveSeedDelivered")
        .mockImplementation(() => {
          throw new Error("boom");
        });

      try {
        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).toBeNull(); // the throw happened before this write
        expect(row.reviewSpawnClaimedAt).toBeNull(); // cleared by the catch block
        expect(terminateSpy).toHaveBeenCalledWith(expect.any(String));
        const [orphanedSession] = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, Number(terminateSpy.mock.calls[0]?.[0])))
          .all();
        expect(orphanedSession?.status).toBe("killed");
      } finally {
        resolveSeedDeliveredSpy.mockRestore();
        await app.close();
      }
    });

    // Regression guard for a claim abandoned by a process crash/redeploy
    // between the claim write and either outcome — nothing else ever clears
    // reviewSpawnClaimedAt in that case, so without a staleness reclaim the
    // task would lose its reviewer forever.
    it("reclaims a review-spawn claim abandoned by a crashed prior attempt once it's stale", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        { name: "CI", status: "queued", conclusion: null, htmlUrl: "https://x/1", headSha: "sha1" },
      ]);
      // -> reviewing; CI still in_progress, so this tick never claims —
      // reviewSpawnClaimedAt starts genuinely null, not just unset.
      await reconcileTasks(app);
      expect((await getTask(app, taskId)).reviewSpawnClaimedAt).toBeNull();

      // Simulates a prior attempt's process dying right after claiming the
      // slot but before spawning or clearing it.
      app.db
        .update(tasks)
        .set({ reviewSpawnClaimedAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(tasks.id, taskId))
        .run();
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    it("does not reclaim a review-spawn claim that's still within the staleness window", async () => {
      const app = await buildApp();
      const { taskId } = await claimWithPR(app);
      mockFetchRunsForHead.mockResolvedValueOnce([
        { name: "CI", status: "queued", conclusion: null, htmlUrl: "https://x/1", headSha: "sha1" },
      ]);
      await reconcileTasks(app); // -> reviewing, waits on CI, never claimed

      app.db
        .update(tasks)
        .set({ reviewSpawnClaimedAt: new Date(Date.now() - 60_000) })
        .where(eq(tasks.id, taskId))
        .run();
      mockFetchRunsForHead.mockResolvedValueOnce([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();

      await app.close();
    });
  });
});
