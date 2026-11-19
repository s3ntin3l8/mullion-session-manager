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
  createSessionAndTask,
  getTask,
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
// Pass through to the real resolvers unless a test pins the branch tip.
const gitRefsMocks = vi.hoisted(() => ({
  resolveCommitSha: vi.fn(),
  isAncestorOf: vi.fn(),
  real: {} as Record<string, (...args: never[]) => unknown>,
}));
vi.mock("../../src/services/git-refs.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  gitRefsMocks.real.resolveCommitSha = actual.resolveCommitSha as never;
  gitRefsMocks.real.isAncestorOf = actual.isAncestorOf as never;
  gitRefsMocks.resolveCommitSha.mockImplementation(actual.resolveCommitSha as never);
  gitRefsMocks.isAncestorOf.mockImplementation(actual.isAncestorOf as never);
  return {
    ...actual,
    resolveCommitSha: gitRefsMocks.resolveCommitSha,
    isAncestorOf: gitRefsMocks.isAncestorOf,
  };
});

const { buildApp } = await import("../../src/app.js");
const { reconcileTasks, resetDraftPrRetryBackoff } =
  await import("../../src/services/task-reconciler.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const {
  mockHermesUsable,
  mockDispatchTaskReview,
  mockPollTaskReview,
  mockStopHermesRun,
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockFetchRunsForHead,
  mockCreatePullRequestReview,
  mockOpenDraftPRForTask,
} = reconcilerMocks;

describe("reconcileTasks — Hermes review agent (#2369)", () => {
  setupReconcilerTestLifecycle("task-reconciler-hermes-review");
  describe("re-entering reviewing with an external reviewer's run (#2369)", () => {
    const priorRun = {
      reviewRunId: "run_prior",
      reviewRunDispatchedAt: new Date(Date.now() - 60 * 60_000),
      reviewRunHeadSha: "sha-prior",
      reviewRunIngestedId: "run_prior",
    } as const;

    it("clears the prior round's run, marker included, so the next round dispatches a fresh one", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      app.db.update(tasks).set(priorRun).where(eq(tasks.id, taskId)).run();
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      mockStopHermesRun.mockClear();
      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewRunId).toBeNull();
      expect(mockStopHermesRun).toHaveBeenCalledWith(expect.anything(), "run_prior");
      expect(row.reviewRunDispatchedAt).toBeNull();
      expect(row.reviewRunHeadSha).toBeNull();
      expect(row.reviewRunIngestedId).toBeNull();

      await app.close();
    });

    it("keeps the run when the task's approval is carried through the worker's return", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      app.db
        .update(tasks)
        .set({
          ...priorRun,
          lastReviewVerdict: "approved-with-suggestions",
          lastReviewVerdictAt: new Date(Date.now() - 30 * 60_000),
          approvalCarriedAt: new Date(Date.now() - 20 * 60_000),
        })
        .where(eq(tasks.id, taskId))
        .run();
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      // The approval still stands for the same review, so the handle stays and
      // the auto-approve gate keeps seeing the verdict it already trusted.
      expect(row.reviewRunId).toBe("run_prior");
      expect(row.reviewRunIngestedId).toBe("run_prior");
      expect(row.approvalCarriedAt).not.toBeNull();

      await app.close();
    });
  });

  it("leaves in_progress alone while the session is still actively working", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ activity: "working" }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    await app.close();
  });

  it("does not finish a task whose Stop hook fired but a background task is still outstanding", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now(), outstandingBackgroundTasks: ["bg-1"] }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    await app.close();
  });

  // Issue #1735 — the reconciler's half of the turn-source rule.
  //
  // The gate opens on "the worker's WORK is done", which is
  // `workFinishedAt` being latched — NOT on `lastTurnEndedAt`, which only
  // says a turn ended. A machine-woken turn with a wakeup still pending
  // ends the turn but not the work, so a session that loops internally no
  // longer advances the task to "reviewing" MID-LOOP, with the review
  // agent judging an incomplete diff in the same worktree the worker was
  // still writing.
  it("does not advance a task whose work never finished", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: null, workFinishedAt: null }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    await app.close();
  });

  it("does not advance a task whose turn ended but whose work did not", async () => {
    // The mid-loop case: the turn ended (so lastTurnEndedAt is latched and
    // the session reads as `finished`), but the work did not — the agent
    // armed another wakeup and the session is about to be woken again.
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now(), workFinishedAt: null }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    await app.close();
  });

  it("skips a task whose session already exited — that's #282's job, not this pass's", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ endedReason: "crashed" }),
    } as never);
    // Flip the underlying session row itself to "exited" (independent of
    // liveness info) so dbStatus feeds "exited" into deriveSessionStatus —
    // the exact case reconcileTasks must not race #282 on.
    const { sessions } = await import("../../src/db/schema.js");
    const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, task.sessionId!)).run();

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("claimed");
    await app.close();
  });

  it("fails a task once its budget is exceeded and terminates its session", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    try {
      const app = await buildApp();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId, sessionId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ activity: "working" }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("budget exceeded");
      expect(row.completedAt).not.toBeNull();
      expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));
      // #772 — killSession, not a bare backend.terminate: the row itself
      // must flip to "killed".
      const { sessions } = await import("../../src/db/schema.js");
      const [sessionRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      expect(sessionRow.status).toBe("killed");

      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  // Independent review, PR #480 — proves the settings override actually
  // reaches task-reconciler.ts's deadline computation (task-config.ts's
  // resolver), not just that the pure resolver function returns the right
  // number. The env var stays generous (120) so only the settings override
  // could be responsible for the force-fail here.
  it("fails a task once its budget is exceeded per settings.taskMaster.budgetMinutes, overriding a generous env default", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    const app = await buildApp();
    try {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { budgetMinutes: 1 } },
      });
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId, sessionId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ activity: "working" }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("budget exceeded");
      expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { budgetMinutes: -1 } },
      });
      await app.close();
    }
  });

  it("cleans up the worktree once budget-failed (6.8/#283), but only when one was recorded", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    try {
      const app = await buildApp();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      app.db
        .update(tasks)
        .set({ worktreePath: "/tmp/.mullion-worktrees/mullion-task-1" })
        .where(eq(tasks.id, taskId))
        .run();
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ activity: "working" }),
      } as never);

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const removeWorktreeIfCleanMock = vi.fn().mockResolvedValue({ removed: true });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "removeWorktreeIfClean") return removeWorktreeIfCleanMock;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(removeWorktreeIfCleanMock).toHaveBeenCalledWith(
        "/tmp/.mullion-worktrees/mullion-task-1",
        "/tmp",
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  it("never fails a task on budget when MULLION_TASK_BUDGET_MINUTES is 0 (unlimited)", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "0";
    try {
      const app = await buildApp();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo(),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("claimed");

      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  it("does not advance an untracked session whose scope is gone (#2929)", async () => {
    // LocalBackend.liveStatus always sets a key for every requested id —
    // `app.pty.get(id)?.toInfo(...) ?? null` — so an untracked session
    // reads as `null`, not an omitted key. #2929 treats a local null as
    // "not adopted yet" and asks the scope: a dead one is not respawned,
    // and `defaultDeriveStatusInfo(null)` then supplies idle defaults,
    // which is what this test actually exercises. (A genuinely *omitted*
    // key is a remote-host-only possibility — reconcileTasks's own
    // `info === undefined` guard exists for that case, mirroring
    // session-reconciler.ts's `alive === undefined` rule, but isn't
    // reachable through a local-only test setup like this one.)
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("dead");

    await reconcileTasks(app);

    expect((await getTask(app, taskId)).status).toBe("claimed");
    await app.close();
  });

  describe("Hermes as the review agent (#2369)", () => {
    const HOUR = 60 * 60_000;

    beforeEach(() => {
      mockHermesUsable.mockReset().mockReturnValue(true);
      mockDispatchTaskReview.mockReset().mockResolvedValue({
        runId: "run_1",
        status: "queued",
        replayed: false,
        idempotencyKey: "k",
        sessionId: "s",
      });
      mockPollTaskReview.mockReset();
      mockStopHermesRun.mockReset();
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
      mockGetPullRequestByNumber.mockResolvedValue({
        number: 9,
        htmlUrl: "https://x/pull/9",
        nodeId: "n",
        draft: true,
        headSha: "sha1",
      });
      mockFetchRunsForHead.mockResolvedValue([
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://x/1",
          headSha: "sha1",
        },
      ]);
    });

    afterEach(() => {
      mockHermesUsable.mockReset().mockReturnValue(false);
      restorePassThroughMocks();
    });

    // A task already in `reviewing` whose project reviews with Hermes.
    async function createHermesTask(
      app: Awaited<ReturnType<typeof buildApp>>,
      overrides: Partial<typeof tasks.$inferInsert> = {},
    ): Promise<number> {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "p-hermes", cwd: "/tmp" },
      });
      const projectId = project.json().id as number;
      app.db
        .update(projects)
        .set({ defaultReviewAgent: "hermes" })
        .where(eq(projects.id, projectId))
        .run();
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "hermes reviewed",
          body: "some spec",
          status: "reviewing",
          reviewingAt: new Date(),
          prNumber: 9,
          worktreePath: "/tmp",
          agentCommand: "codex",
          ...overrides,
        })
        .returning()
        .all();
      return row.id;
    }

    // A task whose run is already dispatched.
    function createDispatchedTask(
      app: Awaited<ReturnType<typeof buildApp>>,
      overrides: Partial<typeof tasks.$inferInsert> = {},
    ): Promise<number> {
      return createHermesTask(app, {
        reviewRunId: "run_1",
        reviewRunDispatchedAt: new Date(),
        reviewRunHeadSha: "sha1",
        ...overrides,
      });
    }

    const cleanReply = JSON.stringify({ verdict: "clean", summary: "All good." });

    describe("dispatch", () => {
      it("starts one run for a reviewing task and records the run, not a session", async () => {
        const app = await buildApp();
        const taskId = await createHermesTask(app);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.reviewRunId).toBe("run_1");
        expect(row.reviewRunHeadSha).toBe("sha1");
        expect(row.reviewRunDispatchedAt).not.toBeNull();
        expect(row.reviewSessionId).toBeNull();
        expect(row.reviewSpawnClaimedAt).toBeNull();
        expect(mockDispatchTaskReview).toHaveBeenCalledTimes(1);
        const [, call] = mockDispatchTaskReview.mock.calls[0];
        expect(call.taskId).toBe(taskId);
        expect(call.target).toMatchObject({ owner: "o", repo: "r", prNumber: 9, headSha: "sha1" });
        expect(call.prompt).toContain("sha1");

        // The run now exists: a later tick does not dispatch another.
        mockPollTaskReview.mockResolvedValue({ status: "running", terminal: false, gone: false });
        await reconcileTasks(app);
        expect(mockDispatchTaskReview).toHaveBeenCalledTimes(1);
        await app.close();
      });

      describe("a branch tip the pull request does not carry yet", () => {
        // Each test uses its own tip: the hold's state is process-local and
        // task ids restart at 1 with every fresh test database.
        const BRANCH = "mullion/task-held";
        const heldTask = (app: Awaited<ReturnType<typeof buildApp>>) =>
          createHermesTask(app, { branchName: BRANCH });
        const pinTip = (tip: string | null, aheadOfPr: boolean) => {
          gitRefsMocks.resolveCommitSha.mockImplementation(((_cwd: string, ref: string) =>
            Promise.resolve(ref === `refs/heads/${BRANCH}` ? tip : null)) as never);
          gitRefsMocks.isAncestorOf.mockResolvedValue(aheadOfPr);
        };

        afterEach(() => {
          gitRefsMocks.resolveCommitSha
            .mockReset()
            .mockImplementation(gitRefsMocks.real.resolveCommitSha as never);
          gitRefsMocks.isAncestorOf
            .mockReset()
            .mockImplementation(gitRefsMocks.real.isAncestorOf as never);
          mockOpenDraftPRForTask.mockReset();
        });

        it("holds the review and retries the push instead of reviewing the old head", async () => {
          const app = await buildApp();
          const taskId = await heldTask(app);
          pinTip("tip-gated", true);
          mockOpenDraftPRForTask.mockResolvedValue({
            ok: false,
            reason: "workflow-approval-required",
            detail: "approve the workflow change to push it",
          });

          await reconcileTasks(app);

          expect(mockDispatchTaskReview).not.toHaveBeenCalled();
          expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
          const row = await getTask(app, taskId);
          expect(row.reviewRunId).toBeNull();
          expect(row.reviewSpawnClaimedAt).toBeNull();
          await app.close();
        });

        it("keeps holding for a human's workflow approval however many pushes it is refused", async () => {
          const app = await buildApp();
          const taskId = await heldTask(app);
          pinTip("tip-gated-long", true);
          mockOpenDraftPRForTask.mockResolvedValue({
            ok: false,
            reason: "workflow-approval-required",
            detail: "approve the workflow change to push it",
          });

          for (let i = 0; i < 6; i++) {
            resetDraftPrRetryBackoff(taskId);
            await reconcileTasks(app);
          }

          expect(mockOpenDraftPRForTask.mock.calls.length).toBeGreaterThan(3);
          expect(mockDispatchTaskReview).not.toHaveBeenCalled();
          await app.close();
        });

        it("dispatches on the next tick once the pull request carries the branch tip", async () => {
          const app = await buildApp();
          const taskId = await heldTask(app);
          pinTip("sha2", true);
          mockOpenDraftPRForTask.mockResolvedValue({
            ok: true,
            prUrl: "https://x/pull/9",
            prNumber: 9,
          });

          await reconcileTasks(app);
          expect(mockDispatchTaskReview).not.toHaveBeenCalled();

          // The push landed: the PR now shows the branch tip.
          mockGetPullRequestByNumber.mockResolvedValue({
            number: 9,
            htmlUrl: "https://x/pull/9",
            nodeId: "n",
            draft: true,
            headSha: "sha2",
          });
          mockFetchRunsForHead.mockResolvedValue([
            {
              name: "CI",
              status: "completed",
              conclusion: "success",
              htmlUrl: "https://x/1",
              headSha: "sha2",
            },
          ]);
          await reconcileTasks(app);

          expect(mockDispatchTaskReview).toHaveBeenCalledTimes(1);
          expect(mockDispatchTaskReview.mock.calls[0][1].target.headSha).toBe("sha2");
          expect((await getTask(app, taskId)).reviewRunHeadSha).toBe("sha2");
          await app.close();
        });

        it("reviews the pull request's head and never pushes when the PR is ahead of or diverged from the branch", async () => {
          const app = await buildApp();
          await heldTask(app);
          // The branch tip differs from the PR head but does not descend from it.
          pinTip("tip-behind", false);

          await reconcileTasks(app);

          expect(mockDispatchTaskReview).toHaveBeenCalledTimes(1);
          expect(mockDispatchTaskReview.mock.calls[0][1].target.headSha).toBe("sha1");
          expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
          await app.close();
        });

        it("gives up after three refused pushes and reviews the pull request's head", async () => {
          const app = await buildApp();
          const taskId = await heldTask(app);
          pinTip("tip-dirty", true);
          mockOpenDraftPRForTask.mockResolvedValue({
            ok: false,
            reason: "dirty-tree",
            detail: "uncommitted changes",
          });

          for (let i = 0; i < 3; i++) {
            resetDraftPrRetryBackoff(taskId);
            await reconcileTasks(app);
            expect(mockDispatchTaskReview).not.toHaveBeenCalled();
          }
          resetDraftPrRetryBackoff(taskId);
          await reconcileTasks(app);

          expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(3);
          expect((await getTask(app, taskId)).githubSyncError).toContain("could not be pushed");
          expect(mockDispatchTaskReview).toHaveBeenCalledTimes(1);
          expect(mockDispatchTaskReview.mock.calls[0][1].target.headSha).toBe("sha1");
          await app.close();
        });

        it("does not hold when the branch tip cannot be read", async () => {
          const app = await buildApp();
          await heldTask(app);
          pinTip(null, true);

          await reconcileTasks(app);

          expect(mockDispatchTaskReview).toHaveBeenCalledTimes(1);
          expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
          await app.close();
        });
      });

      it("keys a re-entry into reviewing at the same head differently, but a retry within one entry the same", async () => {
        const app = await buildApp();
        const t0 = new Date(Date.now() - 60_000);
        const taskId = await createHermesTask(app, { reviewingAt: t0 });
        mockDispatchTaskReview.mockRejectedValueOnce(new Error("connection refused"));

        await reconcileTasks(app); // fails, retried on the next tick
        await reconcileTasks(app);
        expect(mockDispatchTaskReview).toHaveBeenCalledTimes(2);
        const first = mockDispatchTaskReview.mock.calls[0][1];
        const retry = mockDispatchTaskReview.mock.calls[1][1];
        expect(retry.enteredAt).toBe(first.enteredAt);
        expect(first.enteredAt).toBe(Math.floor(t0.getTime() / 1000));

        // A human rejects and sends it straight back: same head, round and
        // rearms, but a fresh entry into `reviewing`.
        app.db
          .update(tasks)
          .set({
            reviewRunId: null,
            reviewRunDispatchedAt: null,
            reviewRunHeadSha: null,
            reviewingAt: new Date(t0.getTime() + HOUR),
          })
          .where(eq(tasks.id, taskId))
          .run();
        await reconcileTasks(app);
        expect(mockDispatchTaskReview).toHaveBeenCalledTimes(3);
        const again = mockDispatchTaskReview.mock.calls[2][1];
        expect(again.target.headSha).toBe(first.target.headSha);
        expect(again.round).toBe(first.round);
        expect(again.rearms).toBe(first.rearms);
        expect(again.enteredAt).not.toBe(first.enteredAt);
        await app.close();
      });

      it("does nothing when Hermes is not usable", async () => {
        mockHermesUsable.mockReturnValue(false);
        const app = await buildApp();
        const taskId = await createHermesTask(app);

        await reconcileTasks(app);

        expect(mockDispatchTaskReview).not.toHaveBeenCalled();
        expect((await getTask(app, taskId)).reviewRunId).toBeNull();
        await app.close();
      });

      it("waits for CI like the session spawn does", async () => {
        const app = await buildApp();
        const taskId = await createHermesTask(app);
        mockFetchRunsForHead.mockResolvedValue([
          { name: "CI", status: "in_progress", conclusion: null, htmlUrl: "", headSha: "sha1" },
        ]);

        await reconcileTasks(app);

        expect(mockDispatchTaskReview).not.toHaveBeenCalled();
        expect((await getTask(app, taskId)).reviewRunId).toBeNull();
        await app.close();
      });

      it("leaves a task with no pull request alone", async () => {
        const app = await buildApp();
        await createHermesTask(app, { prNumber: null });
        await reconcileTasks(app);
        expect(mockDispatchTaskReview).not.toHaveBeenCalled();
        await app.close();
      });

      it("holds back while an auto-rebase is in flight", async () => {
        const app = await buildApp();
        await createHermesTask(app, { rebaseStartedAt: new Date() });
        await reconcileTasks(app);
        expect(mockDispatchTaskReview).not.toHaveBeenCalled();
        await app.close();
      });

      it("never lets the session spawn pass take a Hermes task", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({ status: "running", terminal: false, gone: false });
        await reconcileTasks(app);
        expect((await getTask(app, taskId)).reviewSessionId).toBeNull();
        await app.close();
      });

      it("releases the claim and retries when Hermes is unreachable", async () => {
        const app = await buildApp();
        const taskId = await createHermesTask(app);
        mockDispatchTaskReview.mockRejectedValueOnce(new Error("connection refused"));

        await reconcileTasks(app);

        let row = await getTask(app, taskId);
        expect(row.reviewRunId).toBeNull();
        expect(row.reviewSpawnClaimedAt).toBeNull();
        expect(row.lastReviewVerdict).toBeNull();

        await reconcileTasks(app);
        row = await getTask(app, taskId);
        expect(row.reviewRunId).toBe("run_1");
        await app.close();
      });

      it("gives up after 30 minutes with an inconclusive review on a stand-in run id", async () => {
        const app = await buildApp();
        const taskId = await createHermesTask(app, {
          reviewingAt: new Date(Date.now() - 31 * 60_000),
        });
        mockDispatchTaskReview.mockRejectedValue(new Error("connection refused"));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.reviewRunId).toMatch(/^unsent:/);
        expect(row.reviewRunIngestedId).toBe(row.reviewRunId);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        expect(row.reviewFindings).toContain("Hermes could not be reached");

        // The stand-in is never polled or stopped.
        await reconcileTasks(app);
        expect(mockPollTaskReview).not.toHaveBeenCalled();
        expect(mockStopHermesRun).not.toHaveBeenCalled();
        await app.close();
      });

      it("stops the run it just started when the task left reviewing mid-dispatch", async () => {
        const app = await buildApp();
        const taskId = await createHermesTask(app);
        mockDispatchTaskReview.mockImplementationOnce(async () => {
          app.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId)).run();
          return { runId: "run_orphan", status: "queued", replayed: false };
        });

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).reviewRunId).toBeNull();
        expect(mockStopHermesRun).toHaveBeenCalledWith(expect.anything(), "run_orphan");
        await app.close();
      });
    });

    describe("polling and ingest", () => {
      it("keeps waiting while the run is in flight", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({ status: "running", terminal: false, gone: false });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.reviewRunIngestedId).toBeNull();
        expect(row.lastReviewVerdict).toBeNull();
        await app.close();
      });

      it("ingests a clean reply: verdict, marker, head and a posted review", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({
          status: "completed",
          output: cleanReply,
          terminal: true,
          gone: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("approved");
        expect(row.reviewRunIngestedId).toBe("run_1");
        expect(row.lastReviewedHeadSha).toBe("sha1");
        expect(row.reviewFindings).toContain("All good.");
        expect(mockCreatePullRequestReview).toHaveBeenCalled();

        // Ingested once: the next tick neither polls nor posts again.
        mockPollTaskReview.mockClear();
        mockCreatePullRequestReview.mockClear();
        await reconcileTasks(app);
        expect(mockPollTaskReview).not.toHaveBeenCalled();
        expect(mockCreatePullRequestReview).not.toHaveBeenCalled();
        await app.close();
      });

      it("reads the findings JSON out of a reply that wraps it in prose", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({
          status: "completed",
          output: `Here is my review:\n\n\`\`\`json\n${cleanReply}\n\`\`\``,
          terminal: true,
          gone: false,
        });

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).lastReviewVerdict).toBe("approved");
        await app.close();
      });

      it("returns the findings to the worker on changes-requested", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({
          status: "completed",
          output: JSON.stringify({
            verdict: "changes-requested",
            summary: "Needs work.",
            findings: [{ path: "src/foo.ts", line: 1, severity: "blocker", body: "Fix this." }],
          }),
          terminal: true,
          gone: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("changes-requested");
        expect(row.reviewFindings).toContain("Fix this.");
        await app.close();
      });

      it("treats a reply that is not the findings JSON as inconclusive, never changes-requested", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({
          status: "completed",
          output: "Looks fine to me, nice work!",
          terminal: true,
          gone: false,
          notFindingsReason: "The Hermes reply was not the findings JSON",
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        expect(row).toMatchObject({ reviewRunIngestedId: "run_1", status: "reviewing" });
        expect(row.reviewFindings).toContain("not the findings JSON");
        await app.close();
      });

      it("treats a failed run as inconclusive and names the error", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({
          status: "failed",
          error: "model overloaded",
          terminal: true,
          gone: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        expect(row.reviewFindings).toContain("model overloaded");
        await app.close();
      });

      it("ingests the findings JSON of a failed run (turn cap) as a normal verdict", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({
          status: "failed",
          error: "max_iterations_reached",
          output: cleanReply,
          terminal: true,
          gone: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("approved");
        expect(row.reviewFindings).toContain("All good.");
        await app.close();
      });

      it("notes an unfinished run on its verdict and does not auto-return it", async () => {
        process.env.MULLION_TASK_MASTER_ENABLED = "true";
        try {
          const app = await buildApp();
          const taskId = await createDispatchedTask(app);
          mockPollTaskReview.mockResolvedValue({
            status: "failed",
            error: "max_iterations_reached",
            output: JSON.stringify({
              verdict: "changes-requested",
              summary: "Needs work.",
              findings: [{ path: "src/foo.ts", line: 1, severity: "blocker", body: "Fix this." }],
            }),
            terminal: true,
            gone: false,
          });

          await reconcileTasks(app);

          const row = await getTask(app, taskId);
          expect(row.lastReviewVerdict).toBe("changes-requested");
          expect(row.reviewFindings).toContain("ran out of turns");
          // The note must also reach the review's own text, which is what lands
          // on the PR when a finding is anchored inline.
          const review = mockCreatePullRequestReview.mock.calls[0];
          expect(review?.[4]?.body).toContain("ran out of turns");
          expect(row.status).toBe("reviewing");
          expect(row.autoReturnRounds).toBe(0);
          await app.close();
        } finally {
          delete process.env.MULLION_TASK_MASTER_ENABLED;
        }
      });

      it("keeps a capped tail of an unparseable failed reply in the inconclusive note", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        const output = `HEAD_MARKER ${"x".repeat(5000)} TAIL_MARKER`;
        mockPollTaskReview.mockResolvedValue({
          status: "failed",
          error: "max_iterations_reached",
          output,
          terminal: true,
          gone: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        expect(row.reviewFindings).toContain("The Hermes review failed: max_iterations_reached");
        expect(row.reviewFindings).toContain("TAIL_MARKER");
        expect(row.reviewFindings).not.toContain("HEAD_MARKER");
        expect(row.reviewFindings!.length).toBeLessThan(3000);
        await app.close();
      });

      it("keeps the plain wording for a failed run with an empty reply", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({
          status: "failed",
          output: "  ",
          terminal: true,
          gone: false,
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        expect(row.reviewFindings).toContain("The Hermes review failed — treat");
        expect(row.reviewFindings).not.toContain("End of the reply");
        await app.close();
      });

      it("waits for three consecutive gone answers before giving up on a run", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app, { reviewRunId: "run_gone" });
        mockPollTaskReview.mockResolvedValue({ status: "not_found", terminal: false, gone: true });

        await reconcileTasks(app);
        await reconcileTasks(app);
        expect((await getTask(app, taskId)).lastReviewVerdict).toBeNull();

        await reconcileTasks(app);
        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        expect(row.reviewFindings).toContain("no longer knows");
        await app.close();
      });

      it("a live answer resets the gone count", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app, { reviewRunId: "run_blip" });
        const gone = { status: "not_found", terminal: false, gone: true };
        const live = { status: "running", terminal: false, gone: false };
        mockPollTaskReview
          .mockResolvedValueOnce(gone)
          .mockResolvedValueOnce(gone)
          .mockResolvedValueOnce(live)
          .mockResolvedValueOnce(gone)
          .mockResolvedValueOnce(gone);

        for (let i = 0; i < 5; i++) await reconcileTasks(app);

        expect((await getTask(app, taskId)).lastReviewVerdict).toBeNull();
        await app.close();
      });

      it("stops a run that is still going after 60 minutes and records it inconclusive", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app, {
          reviewRunDispatchedAt: new Date(Date.now() - HOUR - 60_000),
        });
        mockPollTaskReview.mockResolvedValue({ status: "running", terminal: false, gone: false });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        expect(row.reviewFindings).toContain("60 minutes");
        expect(mockStopHermesRun).toHaveBeenCalledWith(expect.anything(), "run_1");
        await app.close();
      });

      it("keeps waiting when Hermes cannot be read, until the 60-minute cap", async () => {
        const app = await buildApp();
        const fresh = await createDispatchedTask(app);
        mockPollTaskReview.mockRejectedValue(new Error("connection refused"));

        await reconcileTasks(app);
        expect((await getTask(app, fresh)).lastReviewVerdict).toBeNull();

        const stale = await createDispatchedTask(app, {
          reviewRunId: "run_old",
          reviewRunDispatchedAt: new Date(Date.now() - HOUR - 60_000),
        });
        await reconcileTasks(app);
        expect((await getTask(app, stale)).lastReviewVerdict).toBe("inconclusive");
        await app.close();
      });

      it("records one outcome per run when two passes ingest it at once", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({
          status: "completed",
          output: cleanReply,
          terminal: true,
          gone: false,
        });
        mockCreatePullRequestReview.mockClear();

        await Promise.all([reconcileTasks(app), reconcileTasks(app)]);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("approved");
        expect(row.reviewFindings?.match(/## Round/g)).toHaveLength(1);
        expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(1);
        await app.close();
      });

      it("resumes a run found in the database after a restart", async () => {
        const app = await buildApp();
        const taskId = await createDispatchedTask(app, { reviewRunId: "run_survivor" });
        mockPollTaskReview.mockResolvedValue({
          status: "completed",
          output: cleanReply,
          terminal: true,
          gone: false,
        });

        await reconcileTasks(app);

        expect(mockPollTaskReview).toHaveBeenCalledWith(expect.anything(), "run_survivor");
        expect((await getTask(app, taskId)).lastReviewVerdict).toBe("approved");
        await app.close();
      });

      it("still finishes a run when Hermes has since been switched off", async () => {
        mockHermesUsable.mockReturnValue(false);
        const app = await buildApp();
        const taskId = await createDispatchedTask(app);
        mockPollTaskReview.mockResolvedValue({
          status: "completed",
          output: cleanReply,
          terminal: true,
          gone: false,
        });

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).lastReviewVerdict).toBe("approved");
        await app.close();
      });
    });
  });
});
