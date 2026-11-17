import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  restorePassThroughMocks,
  fakeInfo,
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
const { reconcileTasks, autoReturnTask } = await import("../../src/services/task-reconciler.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const {
  mockStopHermesRun,
  mockPromoteTaskToPR,
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockUpdatePullRequestTitle,
  mockFetchRunsForHead,
  mockResumeTaskWorktree,
} = reconcilerMocks;

describe("reconcileTasks — auto-approve sweep", () => {
  setupReconcilerTestLifecycle("task-reconciler-auto-approve");
  describe("auto-approve sweep (processAutoApprovals)", () => {
    // Every field an auto-approve candidate needs already set — mirrors
    // exactly what processReviewingTasks' own ingestion write leaves
    // behind for a "clean" verdict. Individual tests override just the
    // field(s) they're testing.

    beforeEach(() => {
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
    });

    // Same reasoning as the merge sweep's own afterEach above — restore the
    // pass-through defaults so this block's fake values can't leak into an
    // unrelated later test.
    afterEach(() => {
      restorePassThroughMocks();
      // #1035 — same reasoning as the explicit reset in the outer
      // beforeEach: a leaked .mockResolvedValueOnce from one #1035 test
      // can't bleed forward into an unrelated auto-approve test.
      mockUpdatePullRequestTitle.mockReset().mockResolvedValue(undefined);
    });

    describe("a reviewing task whose PR ended (#2103)", () => {
      it("fails a task whose PR was closed without merging clears its rebase bookkeeping", async () => {
        const app = await buildApp();
        const { taskId } = await createAutoApproveCandidate(app);
        app.db
          .update(tasks)
          .set({
            rebaseStartedAt: new Date(),
            mergeError: "Conflicts with main — an auto-rebase attempt is in progress",
          })
          .where(eq(tasks.id, taskId))
          .run();
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ state: "closed", merged: false }));
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("failed");
        expect(row.failureReason).toBe("PR closed without merging");
        expect(row.rebaseStartedAt).toBeNull();
        expect(row.mergeError).toBeNull();
        await app.close();
      });

      it("marks a task done and merged when its PR was merged out of band", async () => {
        const app = await buildApp();
        const { taskId } = await createAutoApproveCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ state: "closed", merged: true }));
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("done");
        expect(row.mergedAt).not.toBeNull();
        expect(row.archivedAt).not.toBeNull();
        await app.close();
      });

      it("the slow sweep ends a closed PR in a project WITHOUT autoApprove", async () => {
        const app = await buildApp();
        const { taskId } = await createAutoApproveCandidate(app, { autoApprove: false });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ state: "closed", merged: false }));
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).status).toBe("failed");
        await app.close();
      });

      it("the slow sweep also covers a project whose autoApprove is NULL (the default)", async () => {
        const app = await buildApp();
        const { taskId, projectId } = await createAutoApproveCandidate(app, { autoApprove: false });
        app.db.update(projects).set({ autoApprove: null }).where(eq(projects.id, projectId)).run();
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ state: "closed", merged: false }));
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).status).toBe("failed");
        await app.close();
      });

      it("records the PR's own merge time, not the moment the sweep noticed", async () => {
        const app = await buildApp();
        const { taskId } = await createAutoApproveCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(
          mockPr({ state: "closed", merged: true, mergedAt: "2026-01-02T03:04:05Z" }),
        );
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergedAt?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
        expect(row.archivedAt?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
        await app.close();
      });

      it("the slow sweep re-reads an open PR at most once per interval", async () => {
        const app = await buildApp();
        const { taskId } = await createAutoApproveCandidate(app, { autoApprove: false });
        mockGetPullRequestByNumber.mockClear();
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

        await reconcileTasks(app);
        const afterFirst = mockGetPullRequestByNumber.mock.calls.length;
        await reconcileTasks(app);

        expect(afterFirst).toBeGreaterThan(0);
        // The sweep's own throttle: the second tick adds no PR read for this task.
        const callsForTask = mockGetPullRequestByNumber.mock.calls.length;
        expect(callsForTask).toBe(afterFirst);
        expect((await getTask(app, taskId)).status).toBe("reviewing");
        await app.close();
      });
    });

    it("auto-approves once the latest verdict is clean and CI reads success", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockPromoteTaskToPR.mockResolvedValueOnce({
        ok: true,
        prUrl: "https://github.com/o/r/pull/9",
        prNumber: 9,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("done");
      expect(row.prUrl).toBe("https://github.com/o/r/pull/9");

      await app.close();
    });

    it("records the transition via 'auto-approve', distinct from a human's 'approve'", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockPromoteTaskToPR.mockResolvedValueOnce({
        ok: true,
        prUrl: "https://github.com/o/r/pull/9",
        prNumber: 9,
      });
      const infoSpy = vi.spyOn(app.log, "info");

      await reconcileTasks(app);

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, via: "auto-approve" }),
        "task transition",
      );

      await app.close();
    });

    it("does not approve when the project's autoApprove is off", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app, { autoApprove: false });
      // The slow reviewing-PR-state sweep (#2103) may read the PR of any
      // reviewing task; what autoApprove-off must never do is approve it.
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      expect((await getTask(app, taskId)).status).toBe("reviewing");

      await app.close();
    });

    it("does not approve while Task Master is disabled", async () => {
      const app = await buildApp();
      try {
        await createAutoApproveCandidate(app);
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });

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

    // #755 — the CI fetch is now hoisted ABOVE these gates (so a red
    // REQUIRED check can return the task even when one of them would
    // otherwise block forever, see the dedicated describe block below), so
    // `getPullRequestByNumber` genuinely IS called now, unlike before #755.
    // CI is mocked to "success" here — `attemptReturnRedCiToWorker`'s own
    // very first check is `current.status !== "failure"`, so a passing CI
    // status makes it a no-op immediately and these tests still isolate
    // exactly the gate they're named for.
    it("does not approve when no review round has been ingested yet", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app, {
        reviewFindingsIngestedSessionId: null,
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    it("does not approve on a stale ingested verdict from an earlier review round", async () => {
      const app = await buildApp();
      const { taskId, projectId } = await createAutoApproveCandidate(app);
      // Simulates a fresh review round spawned after the ingested one —
      // reviewSessionId has moved on, but reviewFindingsIngestedSessionId
      // (and the "clean" verdict it produced) still point at the OLD round.
      const freshSession = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      app.db
        .update(tasks)
        .set({ reviewSessionId: freshSession.json().id })
        .where(eq(tasks.id, taskId))
        .run();
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    it.each(["changes-requested", "inconclusive"])(
      "does not approve on a '%s' verdict",
      async (verdict) => {
        const app = await buildApp();
        const { taskId } = await createAutoApproveCandidate(app, { lastReviewVerdict: verdict });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

        await reconcileTasks(app);

        expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");

        await app.close();
      },
    );

    it("waits (does not approve) while CI is still in progress", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue([
        {
          name: "CI",
          status: "in_progress",
          conclusion: null,
          htmlUrl: "https://x/1",
          headSha: "sha-head",
        },
      ]);

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    it("waits (does not approve) while CI status is red", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(ciRun("failure"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");

      await app.close();
    });

    // #1334 — `mergeable: null` ("unknown", GitHub still computing after a
    // push) must not be treated as "not blocked" just because it's `!==
    // false`. It also must not be recorded as a hard mergeError: this is a
    // common, transient window right after a push it resolves on its
    // own within a tick or two.
    it("waits (does not approve, records no error) while mergeable is unknown (null)", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: null, mergeableState: "unknown" }),
      );
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.mergeError).toBeNull();

      await app.close();
    });

    it("attempts auto-rebase when reviewing task has merge conflicts and autoApprove is enabled", async () => {
      const app = await buildApp();
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId, reviewSessionId } = await createAutoApproveCandidate(app, {
        branchName: "mullion/task-x",
        agentCommand: "claude",
      });
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: false, mergeableState: "dirty" }),
      );
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockResumeTaskWorktree.mockResolvedValue({
        path: "/tmp/.mullion-worktrees/mullion-task-x",
        branch: "mullion/task-x",
      });

      await reconcileTasks(app);

      expect(mockResumeTaskWorktree).toHaveBeenCalledWith("/tmp", "mullion/task-x");
      const row = await getTask(app, taskId);
      expect(row.rebaseAttempts).toBe(1);
      expect(row.rebaseStartedAt).not.toBeNull();
      expect(row.sessionId).not.toBeNull();
      expect(row.mergeError).toContain("in progress");

      const { sessions } = await import("../../src/db/schema.js");
      const [reviewSessionRow] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, reviewSessionId))
        .all();
      expect(reviewSessionRow.status).toBe("killed");
      expect(row.reviewSessionId).toBeNull();

      await app.close();
    });

    // #2369 — the auto-approve gate must see an external reviewer's run as an
    // ingested review (or it never reaches the conflict branch at all) the
    // rebase must clear the whole run handle so the next round dispatches fresh.
    it("auto-rebases a reviewing task whose approved review is an external run clears the run (#2369)", async () => {
      const app = await buildApp();
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createAutoApproveCandidate(app, {
        branchName: "mullion/task-x",
        agentCommand: "claude",
        reviewSessionId: null,
        reviewFindingsIngestedSessionId: null,
        reviewRunId: "run_approved",
        reviewRunDispatchedAt: new Date(Date.now() - 60 * 60_000),
        reviewRunHeadSha: "sha-1",
        reviewRunIngestedId: "run_approved",
      });
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: false, mergeableState: "dirty" }),
      );
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockResumeTaskWorktree.mockResolvedValue({
        path: "/tmp/.mullion-worktrees/mullion-task-x",
        branch: "mullion/task-x",
      });

      mockStopHermesRun.mockClear();
      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(mockStopHermesRun).toHaveBeenCalledWith(expect.anything(), "run_approved");
      expect(row.rebaseAttempts).toBe(1);
      expect(row.rebaseStartedAt).not.toBeNull();
      expect(row.reviewRunId).toBeNull();
      expect(row.reviewRunDispatchedAt).toBeNull();
      expect(row.reviewRunHeadSha).toBeNull();
      expect(row.reviewRunIngestedId).toBeNull();

      await app.close();
    });

    it("does not spawn reviewer while auto-rebase is in flight, then spawns reviewer once conflict is resolved", async () => {
      const app = await buildApp();
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createAutoApproveCandidate(app, {
        branchName: "mullion/task-x",
        agentCommand: "claude",
        reviewAgent: "claude",
      });
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: false, mergeableState: "dirty" }),
      );
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockResumeTaskWorktree.mockResolvedValue({
        path: "/tmp/.mullion-worktrees/mullion-task-x",
        branch: "mullion/task-x",
      });

      // First tick: auto-rebase worker is spawned, reviewSessionId is null rebaseStartedAt is set.
      await reconcileTasks(app);
      let row = await getTask(app, taskId);
      expect(row.rebaseStartedAt).not.toBeNull();
      expect(row.reviewSessionId).toBeNull();

      // Second tick with conflict still present: processPendingReviewSpawns must NOT spawn a reviewer.
      await reconcileTasks(app);
      row = await getTask(app, taskId);
      expect(row.reviewSessionId).toBeNull();

      // Third tick: GitHub returns mergeable:null (unknown — recomputing after push).
      // rebaseStartedAt must NOT be cleared: null is not yet confirmed clean.
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: null, mergeableState: "unknown" }),
      );
      await reconcileTasks(app);
      row = await getTask(app, taskId);
      expect(row.rebaseStartedAt).not.toBeNull();
      expect(row.reviewSessionId).toBeNull();

      // Fourth tick: PR is now confirmed cleanly mergeable (mergeable === true).
      // attemptAutoApprove clears mergeError and resets the backoff, but
      // deliberately leaves rebaseStartedAt set: GitHub can report
      // mergeable: true before the rebase worker's own session has actually
      // finished touching the worktree, so clearing it here would let
      // processPendingReviewSpawns spawn a second agent into the same
      // worktree while the worker might still be running. reviewSessionId
      // must stay null — no reviewer spawns on this tick.
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: true, mergeableState: "clean" }),
      );
      await reconcileTasks(app);
      row = await getTask(app, taskId);
      expect(row.rebaseStartedAt).not.toBeNull();
      expect(row.mergeError).toBeNull();
      expect(row.reviewSessionId).toBeNull();

      // Fifth tick: rebaseStartedAt has aged past REBASE_ATTEMPT_STALE_MS —
      // the same time-based staleness check every other in-flight-rebase
      // gate in this file trusts — so processPendingReviewSpawns now treats
      // the attempt as no longer in flight and spawns the fresh reviewer.
      const { tasks } = await import("../../src/db/schema.js");
      app.db
        .update(tasks)
        .set({ rebaseStartedAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(tasks.id, taskId))
        .run();
      await reconcileTasks(app);
      row = await getTask(app, taskId);
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });

    describe("ending the auto-rebase review hold-back early", () => {
      // Drives tick one (dirty PR → rebase worker spawned, rebaseStartedAt
      // set), then flips the PR to cleanly mergeable. Returns the task id.
      async function rebasedTask(app: Awaited<ReturnType<typeof buildApp>>) {
        vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
        const { taskId } = await createAutoApproveCandidate(app, {
          branchName: "mullion/task-x",
          agentCommand: "claude",
          reviewAgent: "claude",
        });
        mockGetPullRequestByNumber.mockResolvedValue(
          mockPr({ mergeable: false, mergeableState: "dirty" }),
        );
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockResumeTaskWorktree.mockResolvedValue({
          path: "/tmp/.mullion-worktrees/mullion-task-x",
          branch: "mullion/task-x",
        });
        await reconcileTasks(app);
        const row = await getTask(app, taskId);
        expect(row.rebaseStartedAt).not.toBeNull();
        mockGetPullRequestByNumber.mockResolvedValue(
          mockPr({ mergeable: true, mergeableState: "clean" }),
        );
        return taskId;
      }

      it("clears rebaseStartedAt and spawns the reviewer once the rebase worker's work finished", async () => {
        const app = await buildApp();
        const taskId = await rebasedTask(app);
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () =>
            fakeInfo({ lastTurnEndedAt: Date.now() + 1000, workFinishedAt: Date.now() + 1000 }),
        } as never);

        await reconcileTasks(app);
        let row = await getTask(app, taskId);
        expect(row.rebaseStartedAt).toBeNull();

        await reconcileTasks(app);
        row = await getTask(app, taskId);
        expect(row.reviewSessionId).not.toBeNull();
        await app.close();
      });

      it("keeps rebaseStartedAt when workFinishedAt predates the rebase", async () => {
        const app = await buildApp();
        const taskId = await rebasedTask(app);
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () =>
            fakeInfo({ lastTurnEndedAt: Date.now(), workFinishedAt: Date.now() - 60_000 }),
        } as never);

        await reconcileTasks(app);
        await reconcileTasks(app);
        const row = await getTask(app, taskId);
        expect(row.rebaseStartedAt).not.toBeNull();
        expect(row.reviewSessionId).toBeNull();
        await app.close();
      });

      it("keeps rebaseStartedAt while the PR is still dirty", async () => {
        const app = await buildApp();
        const taskId = await rebasedTask(app);
        mockGetPullRequestByNumber.mockResolvedValue(
          mockPr({ mergeable: false, mergeableState: "dirty" }),
        );
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () =>
            fakeInfo({ lastTurnEndedAt: Date.now() + 1000, workFinishedAt: Date.now() + 1000 }),
        } as never);

        await reconcileTasks(app);
        const row = await getTask(app, taskId);
        expect(row.rebaseStartedAt).not.toBeNull();
        expect(row.reviewSessionId).toBeNull();
        await app.close();
      });

      it("keeps rebaseStartedAt and does not throw when liveStatus rejects", async () => {
        const app = await buildApp();
        const taskId = await rebasedTask(app);
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const realResolveBackend = sessionBackendModule.resolveBackend;
        const warnSpy = vi.spyOn(app.log, "warn");
        vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation((appArg, hId) => {
          const real = realResolveBackend(appArg, hId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "liveStatus")
                return async () => Promise.reject(new Error("unreachable"));
              return Reflect.get(target, prop, receiver);
            },
          });
        });

        await expect(reconcileTasks(app)).resolves.not.toThrow();
        const row = await getTask(app, taskId);
        expect(row.rebaseStartedAt).not.toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ taskId }),
          "task reconcile: host unreachable, keeping the auto-rebase review hold-back",
        );
        vi.restoreAllMocks();
        await app.close();
      });

      it("keeps rebaseStartedAt while the derived status is not finished", async () => {
        const app = await buildApp();
        const taskId = await rebasedTask(app);
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () =>
            fakeInfo({
              lastTurnEndedAt: Date.now() + 1000,
              workFinishedAt: Date.now() + 1000,
              outstandingBackgroundTasks: ["bg-1"],
            }),
        } as never);

        await reconcileTasks(app);
        const row = await getTask(app, taskId);
        expect(row.rebaseStartedAt).not.toBeNull();
        expect(row.reviewSessionId).toBeNull();
        await app.close();
      });

      it("falls back to the 30-minute window when no finish signal exists", async () => {
        const app = await buildApp();
        const taskId = await rebasedTask(app);
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: null, workFinishedAt: null }),
        } as never);

        await reconcileTasks(app);
        let row = await getTask(app, taskId);
        expect(row.rebaseStartedAt).not.toBeNull();
        expect(row.reviewSessionId).toBeNull();

        const { tasks } = await import("../../src/db/schema.js");
        app.db
          .update(tasks)
          .set({ rebaseStartedAt: new Date(Date.now() - 31 * 60_000) })
          .where(eq(tasks.id, taskId))
          .run();
        await reconcileTasks(app);
        row = await getTask(app, taskId);
        expect(row.reviewSessionId).not.toBeNull();
        await app.close();
      });
    });

    it("aborts auto-rebase when terminating the active review session fails", async () => {
      const app = await buildApp();
      vi.spyOn(app.pty, "terminate").mockRejectedValueOnce(new Error("pty kill failed"));
      const warnSpy = vi.spyOn(app.log, "warn");
      const { taskId, reviewSessionId } = await createAutoApproveCandidate(app, {
        branchName: "mullion/task-x",
        agentCommand: "claude",
      });
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: false, mergeableState: "dirty" }),
      );
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockResumeTaskWorktree.mockResolvedValue({
        path: "/tmp/.mullion-worktrees/mullion-task-x",
        branch: "mullion/task-x",
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.rebaseAttempts).toBe(0);
      expect(row.rebaseStartedAt).toBeNull();
      expect(row.mergeError).toContain(
        "active review session appears stuck and could not be stopped",
      );
      expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, reviewSessionId }),
        "task auto-rebase: active review session appears stuck and could not be stopped, leaving it for a later tick",
      );

      await app.close();
    });

    it("clears reviewSessionId when resumeTaskWorktree fails during auto-rebase of a reviewing task", async () => {
      const app = await buildApp();
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createAutoApproveCandidate(app, {
        branchName: "mullion/task-x",
        agentCommand: "claude",
      });
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: false, mergeableState: "dirty" }),
      );
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
      mockResumeTaskWorktree.mockResolvedValue(null);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.reviewSessionId).toBeNull();
      expect(row.mergeError).toContain("could not recreate the worktree");

      await app.close();
    });

    describe("retry backoff is per review round", () => {
      function inProgressRun() {
        return [
          {
            name: "CI",
            status: "in_progress" as const,
            conclusion: null,
            htmlUrl: "https://x/1",
            headSha: "sha-head",
          },
        ];
      }

      it("keeps backing off across repeated CI-pending attempts within one round", async () => {
        const app = await buildApp();
        const { taskId } = await createAutoApproveCandidate(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(inProgressRun());

        await reconcileTasks(app);
        const callsAfterFirst = mockFetchRunsForHead.mock.calls.length;
        expect(callsAfterFirst).toBeGreaterThan(0);

        // Second tick inside the 1-minute window: skipped, no new CI lookup.
        await reconcileTasks(app);
        expect(mockFetchRunsForHead.mock.calls.length).toBe(callsAfterFirst);
        expect((await getTask(app, taskId)).status).toBe("reviewing");

        await app.close();
      });

      it("starts the next reviewing stint from zero attempts after autoReturnTask", async () => {
        const app = await buildApp();
        const { taskId, reviewSessionId } = await createAutoApproveCandidate(app, {
          worktreePath: "/tmp",
          agentCommand: "claude",
        });
        const workerSession = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId: (await getTask(app, taskId)).projectId, command: "bash" },
        });
        app.db
          .update(tasks)
          .set({ sessionId: workerSession.json().id })
          .where(eq(tasks.id, taskId))
          .run();
        mockGetPullRequestByNumber.mockResolvedValue(mockPr());
        mockFetchRunsForHead.mockResolvedValue(inProgressRun());

        // Tick 1 records an attempt (CI pending), so the task is now backed off.
        await reconcileTasks(app);
        const callsAfterFirst = mockFetchRunsForHead.mock.calls.length;

        // Bounce through the worker, then straight back to reviewing.
        const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
        const [project] = app.db
          .select()
          .from(projects)
          .where(eq(projects.id, row.projectId))
          .all();
        const returned = await autoReturnTask(app, row, project, {
          reason: "suggestions",
          seedPrompt: "apply the nits",
        });
        expect(returned.ok).toBe(true);
        app.db
          .update(tasks)
          .set({
            status: "reviewing",
            reviewSessionId,
            reviewFindingsIngestedSessionId: reviewSessionId,
            lastReviewVerdict: "clean",
          })
          .where(eq(tasks.id, taskId))
          .run();
        mockFetchRunsForHead.mockResolvedValue(ciRun("success"));
        mockPromoteTaskToPR.mockResolvedValueOnce({
          ok: true,
          prUrl: "https://github.com/o/r/pull/9",
          prNumber: 9,
        });

        await reconcileTasks(app);

        expect(mockFetchRunsForHead.mock.calls.length).toBeGreaterThan(callsAfterFirst);
        expect((await getTask(app, taskId)).status).toBe("done");

        await app.close();
      });
    });

    it("records mergeError when reviewing task has merge conflicts and rebaseAttempts has reached maximum", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app, {
        branchName: "mullion/task-x",
        agentCommand: "claude",
        rebaseAttempts: 2,
      });
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: false, mergeableState: "dirty" }),
      );
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

      await reconcileTasks(app);

      expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.rebaseAttempts).toBe(2);
      expect(row.mergeError).toContain("needs manual resolution");

      await app.close();
    });

    it("does not auto-rebase a reviewing task while its review is still in progress", async () => {
      const app = await buildApp();
      const { taskId } = await createAutoApproveCandidate(app, {
        branchName: "mullion/task-x",
        agentCommand: "claude",
        reviewFindingsIngestedSessionId: null,
      });
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeable: false, mergeableState: "dirty" }),
      );
      mockFetchRunsForHead.mockResolvedValue(ciRun("success"));

      await reconcileTasks(app);

      expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.rebaseStartedAt).toBeNull();

      await app.close();
    });

    // #755 — a red REQUIRED check returns the task to its worker for one
    // automatic round, the same mechanism a "changes-requested" review uses.
    // Fresh-review finding on an earlier version of this PR: the required
    // set (`required_status_checks.contexts`) and `fetchRunsForHead` live in
    // two DIFFERENT GitHub API namespaces — Workflow Run names (`"CI/CD"`,
    // `"CodeQL"`) vs. per-job Check Run names (`"test-node /
    // lint-and-test"`) — verified live against this repo's own protected
    // branch. Every test below deliberately uses DISTINCT, non-matching
    // names for the two, exactly like this repo's real CI, so a regression
    // back to comparing the wrong namespace fails loudly instead of passing
    // by coincidence the way the original (buggy) version of these tests did.
  });
});
