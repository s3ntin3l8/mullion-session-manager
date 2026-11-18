import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PR_REVIEW_DEFAULTS } from "../helpers/pr-review-defaults.js";
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
  getTask,
  mockFinishedSessionIds,
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
const { reconcileTasks, DEFAULT_MAX_AUTO_RETURN_ROUNDS } =
  await import("../../src/services/task-reconciler.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { DEFAULT_SETTINGS } = await import("../../src/services/settings.js");
const { eq } = await import("drizzle-orm");
const { setRepoPRsStatus, invalidatePRsCache } = await import("../../src/services/github.js");

const {
  mockStopHermesRun,
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
} = reconcilerMocks;

describe("reconcileTasks — review round cap and re-arm", () => {
  setupReconcilerTestLifecycle("task-reconciler-review-rearm");
  // The round cap is a backstop (project override, else the install-wide
  // setting, 0 = unlimited) a loop that stops converging asks a human
  // before it ever reaches it.
  describe("round cap and stall guard", () => {
    // A worker spell stamps claimedAt after the verdict that sent it back.
    const WORKER_RETURNED_AFTER_VERDICT = {
      lastReviewVerdictAt: new Date(Date.now() - 60 * 60 * 1000),
      claimedAt: new Date(),
    };

    it("keeps the two sources of the default round cap in step", () => {
      expect(DEFAULT_SETTINGS.taskMaster.maxAutoReturnRounds).toBe(DEFAULT_MAX_AUTO_RETURN_ROUNDS);
    });

    const BLOCKER_JSON = JSON.stringify({
      verdict: "changes-requested",
      summary: "One blocker.",
      findings: [{ path: "a.ts", line: 1, severity: "critical", body: "fix this" }],
    });

    async function seedReviewing(
      app: Awaited<ReturnType<typeof buildApp>>,
      project: { maxAutoReturnRounds?: number | null },
      task: Partial<typeof tasks.$inferInsert>,
    ) {
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: `p-stall-${Math.random()}`,
          cwd: "/tmp",
        },
      });
      const projectId = created.json().id;
      if (project.maxAutoReturnRounds !== undefined) {
        app.db
          .update(projects)
          .set({ maxAutoReturnRounds: project.maxAutoReturnRounds })
          .where(eq(projects.id, projectId))
          .run();
      }
      const worker = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const review = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "stall guard",
          status: "reviewing",
          sessionId: worker.json().id,
          reviewSessionId: review.json().id,
          worktreePath: "/tmp",
          agentCommand: "claude",
          claimedAt: new Date(),
          ...task,
        })
        .returning()
        .all();
      mockFinishedSessionIds(app, review.json().id);
      return row;
    }

    // The install-wide cap lives in the file-wide settings row, so a test
    // that changes it must put it back or every later cap test inherits it.
    async function withInstallCap(
      app: Awaited<ReturnType<typeof buildApp>>,
      cap: number,
      run: () => Promise<void>,
    ) {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { maxAutoReturnRounds: cap } },
      });
      try {
        await run();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { maxAutoReturnRounds: 10 } },
        });
      }
    }

    it("never caps a project set to 0 (unlimited)", async () => {
      const app = await buildApp();
      const task = await seedReviewing(app, { maxAutoReturnRounds: 0 }, { autoReturnRounds: 50 });
      writeFindings(app, task.id, 50, BLOCKER_JSON);

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(51);
      expect(row.autoReturnCapAnnouncedAt).toBeNull();

      await app.close();
    });

    it("uses the install-wide cap when the project sets none, and parks at it with reason 'cap'", async () => {
      const app = await buildApp();
      await withInstallCap(app, 1, async () => {
        const task = await seedReviewing(app, {}, { autoReturnRounds: 1 });
        writeFindings(app, task.id, 1, BLOCKER_JSON);

        await reconcileTasks(app);

        const row = await getTask(app, task.id);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnCapAnnouncedAt).not.toBeNull();
        expect(row.needsHumanReason).toBe("cap");
      });

      await app.close();
    });

    it("treats an install-wide 0 as unlimited when the project sets none", async () => {
      const app = await buildApp();
      await withInstallCap(app, 0, async () => {
        const task = await seedReviewing(app, {}, { autoReturnRounds: 30 });
        writeFindings(app, task.id, 30, BLOCKER_JSON);

        await reconcileTasks(app);

        expect((await getTask(app, task.id)).status).toBe("in_progress");
      });

      await app.close();
    });

    it("a project's own cap overrides the install-wide one", async () => {
      const app = await buildApp();
      await withInstallCap(app, 0, async () => {
        const task = await seedReviewing(app, { maxAutoReturnRounds: 1 }, { autoReturnRounds: 1 });
        writeFindings(app, task.id, 1, BLOCKER_JSON);

        await reconcileTasks(app);

        const row = await getTask(app, task.id);
        expect(row.status).toBe("reviewing");
        expect(row.needsHumanReason).toBe("cap");
      });

      await app.close();
    });

    it("parks the task with 'finding-persisted' when the same earlier finding is still open two rounds running", async () => {
      const app = await buildApp();
      const task = await seedReviewing(
        app,
        {},
        {
          autoReturnRounds: 1,
          ...WORKER_RETURNED_AFTER_VERDICT,
          lastAutoReturnReason: "review",
          lastReviewVerdict: "changes-requested",
          reviewFindings:
            "## Round 2\n\n**Verdict:** changes requested — s\n\n### Earlier findings\n- **a.ts:1** — still-open: probe fails",
        },
      );
      writeFindings(
        app,
        task.id,
        1,
        JSON.stringify({
          verdict: "changes-requested",
          summary: "Still broken.",
          previous: [{ ref: "a.ts:1", status: "still-open", evidence: "probe fails" }],
        }),
      );

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.needsHumanReason).toBe("finding-persisted");
      expect(row.autoReturnCapAnnouncedAt).not.toBeNull();

      await app.close();
    });

    it("does not park a repeated still-open ref when no worker ran since the last verdict (a human-push re-arm)", async () => {
      const app = await buildApp();
      const task = await seedReviewing(
        app,
        {},
        {
          autoReturnRounds: 1,
          claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          lastReviewVerdictAt: new Date(Date.now() - 60 * 60 * 1000),
          lastAutoReturnReason: "review",
          lastReviewVerdict: "changes-requested",
          reviewFindings:
            "## Round 2\n\n**Verdict:** changes requested — s\n\n### Earlier findings\n- **a.ts:1** — still-open: probe fails",
        },
      );
      writeFindings(
        app,
        task.id,
        1,
        JSON.stringify({
          verdict: "changes-requested",
          summary: "Still broken after the human's push.",
          previous: [{ ref: "a.ts:1", status: "still-open", evidence: "probe fails" }],
        }),
      );

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("in_progress");
      expect(row.needsHumanReason).toBeNull();

      await app.close();
    });

    it("does not park a finding that was only just reported still-open for the first time", async () => {
      const app = await buildApp();
      const task = await seedReviewing(
        app,
        {},
        {
          autoReturnRounds: 1,
          lastAutoReturnReason: "review",
          lastReviewVerdict: "changes-requested",
          reviewFindings: "## Round 1\n\n**Verdict:** changes requested — s",
        },
      );
      writeFindings(
        app,
        task.id,
        1,
        JSON.stringify({
          verdict: "changes-requested",
          summary: "Not fixed.",
          previous: [{ ref: "a.ts:1", status: "still-open", evidence: "probe fails" }],
        }),
      );

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("in_progress");
      expect(row.needsHumanReason).toBeNull();

      await app.close();
    });

    describe("no-progress", () => {
      async function seedNoProgress(
        app: Awaited<ReturnType<typeof buildApp>>,
        liveHeadSha: string,
      ) {
        mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
        mockResolveGitHubToken.mockResolvedValue("tok");
        mockGetPullRequestByNumber.mockResolvedValue({
          number: 9,
          htmlUrl: "https://github.com/o/r/pull/9",
          nodeId: "PR_node9",
          draft: false,
          headSha: liveHeadSha,
        });
        const task = await seedReviewing(
          app,
          {},
          {
            autoReturnRounds: 1,
            prNumber: 9,
            ...WORKER_RETURNED_AFTER_VERDICT,
            lastAutoReturnReason: "review",
            lastReviewVerdict: "changes-requested",
            lastReviewedHeadSha: "sha-reviewed",
          },
        );
        writeFindings(app, task.id, 1, BLOCKER_JSON);
        return task;
      }

      it("parks the task when the worker came back and the PR head is the commit last reviewed", async () => {
        const app = await buildApp();
        const task = await seedNoProgress(app, "sha-reviewed");

        await reconcileTasks(app);

        const row = await getTask(app, task.id);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(1);
        expect(row.needsHumanReason).toBe("no-progress");
        expect(row.autoReturnCapAnnouncedAt).not.toBeNull();

        await app.close();
      });

      it("returns the task as usual when the worker did push", async () => {
        const app = await buildApp();
        const task = await seedNoProgress(app, "sha-moved-on");

        await reconcileTasks(app);

        const row = await getTask(app, task.id);
        expect(row.status).toBe("in_progress");
        expect(row.autoReturnRounds).toBe(2);

        await app.close();
      });

      it("does not read the first review after a human-push re-arm as no-progress — no worker ran", async () => {
        const app = await buildApp();
        const task = await seedNoProgress(app, "sha-reviewed");
        // The re-arm leaves the last verdict NEWER than the last worker spell.
        app.db
          .update(tasks)
          .set({
            claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
            lastReviewVerdictAt: new Date(Date.now() - 60 * 60 * 1000),
          })
          .where(eq(tasks.id, task.id))
          .run();

        await reconcileTasks(app);

        const row = await getTask(app, task.id);
        expect(row.status).toBe("in_progress");
        expect(row.needsHumanReason).toBeNull();

        await app.close();
      });

      it("fails open when the PR head can't be read", async () => {
        const app = await buildApp();
        const task = await seedNoProgress(app, "sha-reviewed");
        mockGetPullRequestByNumber.mockRejectedValue(new Error("GitHub is down"));

        await reconcileTasks(app);

        expect((await getTask(app, task.id)).status).toBe("in_progress");

        await app.close();
      });
    });
  });

  // An APPROVED review that left only suggestions: the worker applies them
  // once, the task does NOT spend a round the worker's return skips the
  // review — the nit loop this verdict exists to end.

  // Issue #1039 — the follow-up half of #1038's fix: a capped, parked task
  // ("needs a human") genuinely never gets touched again today unless a
  // human clicks Reject in the UI. This covers reannounceCappedTasksAfter
  // HumanPush, which re-arms exactly one more review when a human instead
  // pushes a fix directly to the PR branch — without spending a round.
  describe("capped-task re-arm after a human push (reannounceCappedTasksAfterHumanPush)", () => {
    function prStatus(prNumber: number, headSha: string) {
      return {
        prs: [
          {
            number: prNumber,
            title: "test pr",
            htmlUrl: `https://github.com/o/r/pull/${prNumber}`,
            author: "dev",
            ...PR_REVIEW_DEFAULTS,
            headSha,
            headBranch: "feature",
            baseBranch: "main",
            ciStatus: null,
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 0, fail: 0, pending: 0, unknown: 1 },
      };
    }

    async function createCappedAnnouncedTask(
      app: Awaited<ReturnType<typeof buildApp>>,
      overrides: Partial<typeof tasks.$inferInsert> = {},
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: `p-rearm-${Date.now()}-${Math.random()}`,
          cwd: "/tmp",
        },
      });
      const workerSession = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.json().id, command: "bash" },
      });
      const reviewSession = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.json().id, command: "bash" },
      });
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId: project.json().id,
          title: "capped and announced, awaiting a human",
          status: "reviewing",
          sessionId: workerSession.json().id,
          reviewSessionId: reviewSession.json().id,
          reviewFindingsIngestedSessionId: reviewSession.json().id,
          autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
          autoReturnCapAnnouncedAt: new Date(Date.now() - 60_000),
          lastReviewedHeadSha: "sha-old",
          // A real parked-capped task carries this: spawnReviewAgentNow's
          // own success write never clears the claim it set before
          // spawning — only the `in_progress -> reviewing` transition and a
          // FAILED spawn do — so it's still non-null from the round that
          // produced this parked state. Seeded fresh (not stale) here so a
          // regression that drops the clear on re-arm can't hide behind
          // REVIEW_SPAWN_CLAIM_STALE_MS aging it out on its own.
          reviewSpawnClaimedAt: new Date(),
          worktreePath: "/tmp",
          agentCommand: "claude",
          prNumber: 9,
          claimedAt: new Date(),
          ...overrides,
        })
        .returning()
        .all();
      return { project: project.json(), task };
    }

    beforeEach(() => {
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    });

    afterEach(() => {
      restorePassThroughMocks();
      // The PR-status cache (github.ts) is a module-level singleton shared
      // across this whole test file, keyed on the same "o"/"r" pair many
      // other describe blocks use — clear it so a cache entry set by one
      // of this block's tests can't leak into an unrelated later test.
      invalidatePRsCache("o", "r");
    });

    it("re-arms a capped, announced task once the PR's head SHA has moved past what was last reviewed", async () => {
      const app = await buildApp();
      const { task } = await createCappedAnnouncedTask(app);
      setRepoPRsStatus("o", "r", prStatus(9, "sha-new"));

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.autoReturnCapAnnouncedAt).toBeNull();
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSeedDelivered).toBeNull();
      // The bug this regression guards: a successful spawn never clears its
      // own claim (spawnReviewAgentNow), so it's still set from the round
      // that produced this parked state. Left non-null, processPendingReview
      // Spawns' own claim CAS would refuse to spawn the fresh review this
      // re-arm exists to earn — a silent, hard-to-notice no-op rather than
      // an outright failure.
      expect(row.reviewSpawnClaimedAt).toBeNull();
      // The re-arm write itself establishes the new baseline (not just the
      // next ingest) — otherwise a triggered review that happens to ingest
      // while the poller's cache is cold would leave this null again
      // the next sweep tick would re-arm a SECOND time with no further
      // human push. See this function's own doc comment.
      expect(row.lastReviewedHeadSha).toBe("sha-new");
      // Not spent — the human did the work, not the worker.
      expect(row.autoReturnRounds).toBe(DEFAULT_MAX_AUTO_RETURN_ROUNDS);
      expect(row.status).toBe("reviewing");
      // The stall guard's premise: no worker spell started, so claimedAt must
      // stay older than the verdict that parked the task (detectReviewStall
      // only runs when claimedAt is NEWER than lastReviewVerdictAt). A re-arm
      // that refreshed it would silently re-enable no-progress false parks.
      expect(row.claimedAt?.getTime()).toBe(task.claimedAt?.getTime());

      await app.close();
    });

    it("clears an external reviewer's run too when it re-arms (#2369)", async () => {
      const app = await buildApp();
      const { task } = await createCappedAnnouncedTask(app, {
        reviewSessionId: null,
        reviewFindingsIngestedSessionId: null,
        reviewRunId: "run_capped",
        reviewRunDispatchedAt: new Date(Date.now() - 60 * 60_000),
        reviewRunHeadSha: "sha-old",
        reviewRunIngestedId: "run_capped",
      });
      setRepoPRsStatus("o", "r", prStatus(9, "sha-new"));

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.autoReturnCapAnnouncedAt).toBeNull();
      expect(row.reviewRunId).toBeNull();
      expect(row.reviewRunDispatchedAt).toBeNull();
      expect(row.reviewRunHeadSha).toBeNull();
      expect(row.reviewRunIngestedId).toBeNull();
      expect(row.lastReviewedHeadSha).toBe("sha-new");

      await app.close();
    });

    it("does not re-arm when the PR's head SHA matches what was last reviewed", async () => {
      const app = await buildApp();
      const { task } = await createCappedAnnouncedTask(app);
      setRepoPRsStatus("o", "r", prStatus(9, "sha-old"));

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.autoReturnCapAnnouncedAt).not.toBeNull();
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.reviewSpawnClaimedAt).not.toBeNull();
      expect(row.autoReturnRounds).toBe(DEFAULT_MAX_AUTO_RETURN_ROUNDS);

      await app.close();
    });

    it("does not touch a capped task that hasn't been announced yet", async () => {
      const app = await buildApp();
      const { task } = await createCappedAnnouncedTask(app, { autoReturnCapAnnouncedAt: null });
      setRepoPRsStatus("o", "r", prStatus(9, "sha-new"));

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.autoReturnCapAnnouncedAt).toBeNull();
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.lastReviewedHeadSha).toBe("sha-old");

      await app.close();
    });

    // A null baseline means the poller's cache was cold at the last ingest
    // — genuinely unknown, not "unchanged". Silently backfilling it here
    // would risk recording a SHA that's already the human's fix (cache
    // warmed up AFTER the push, not before it), permanently losing the
    // exact push this feature exists to detect. Re-arming once is the
    // safer direction to be wrong in: it costs one advisory review that
    // simply re-parks if there was nothing new to find.
    it("re-arms (rather than silently backfilling) when there's no prior baseline", async () => {
      const app = await buildApp();
      const { task } = await createCappedAnnouncedTask(app, { lastReviewedHeadSha: null });
      setRepoPRsStatus("o", "r", prStatus(9, "sha-first-seen"));

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.autoReturnCapAnnouncedAt).toBeNull();
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull();
      // The baseline is established by THIS write, not left for the next
      // ingest to backfill — otherwise a cold-cache ingest after the
      // triggered review would leave it null again and re-arm a second
      // time on its own, no human push required.
      expect(row.lastReviewedHeadSha).toBe("sha-first-seen");

      await app.close();
    });

    it("does nothing when the PR isn't in the poller's cache yet", async () => {
      const app = await buildApp();
      const { task } = await createCappedAnnouncedTask(app);
      // Deliberately no setRepoPRsStatus call — cold cache.

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.autoReturnCapAnnouncedAt).not.toBeNull();
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.lastReviewedHeadSha).toBe("sha-old");

      await app.close();
    });
  });

  // Task 409707 — a review agent that goes silently idle mid-review (no
  // reported errorState/errorDetail at all, so isRateLimitGraceActive never
  // engages) gets ingested as `lastReviewVerdict = "inconclusive"` by
  // processReviewingTasks reviewFindingsIngestedSessionId then latches
  // permanently against that stalled session with no automatic way back —
  // unlike a capped task, an inconclusive verdict never calls // so autoReturnRounds never reaches the cap and
  // reannounceCappedTasksAfterHumanPush never fires either.
  describe("inconclusive-review re-arm after a grace period (reannounceInconclusiveReviewsAfterGrace)", () => {
    async function createStalledInconclusiveTask(
      app: Awaited<ReturnType<typeof buildApp>>,
      overrides: Partial<typeof tasks.$inferInsert> = {},
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: `p-inconclusive-rearm-${Date.now()}-${Math.random()}`,
          cwd: "/tmp",
        },
      });
      const workerSession = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.json().id, command: "bash" },
      });
      const reviewSession = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.json().id, command: "bash" },
      });
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId: project.json().id,
          title: "silently-stalled review, awaiting an automatic re-arm",
          status: "reviewing",
          sessionId: workerSession.json().id,
          reviewSessionId: reviewSession.json().id,
          reviewFindingsIngestedSessionId: reviewSession.json().id,
          lastReviewVerdict: "inconclusive",
          lastReviewVerdictAt: new Date(Date.now() - 61 * 60_000),
          inconclusiveReviewRearmCount: 0,
          autoReturnRounds: 0,
          autoReturnCapAnnouncedAt: null,
          worktreePath: "/tmp",
          agentCommand: "claude",
          claimedAt: new Date(),
          ...overrides,
        })
        .returning()
        .all();
      return { project: project.json(), task, reviewSessionId: reviewSession.json().id as number };
    }

    it("re-arms a silently-stalled inconclusive review once the grace period has elapsed", async () => {
      const app = await buildApp();
      const { task, reviewSessionId } = await createStalledInconclusiveTask(app);
      const sessionsModule = await import("../../src/services/session-lifecycle.js");
      const killSpy = vi.spyOn(sessionsModule, "killSession").mockResolvedValue(null);

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.reviewSessionId).toBeNull();
      expect(row.reviewFindingsIngestedSessionId).toBeNull();
      expect(row.reviewSeedDelivered).toBeNull();
      expect(row.reviewSpawnClaimedAt).toBeNull();
      expect(row.inconclusiveReviewRearmCount).toBe(1);
      expect(row.status).toBe("reviewing");
      // Not spent — this is a fresh review attempt, not a worker round.
      expect(row.autoReturnRounds).toBe(0);
      // Left as-is: the board still shows what the stalled round found (or
      // didn't) until the fresh review round ingests its own verdict.
      expect(row.lastReviewVerdict).toBe("inconclusive");
      expect(killSpy).toHaveBeenCalledWith(app, reviewSessionId);

      killSpy.mockRestore();
      await app.close();
    });

    describe("an external reviewer's run (#2369)", () => {
      // A review by an external reviewer: a run, with no review session.
      const stalledRun = {
        reviewSessionId: null,
        reviewFindingsIngestedSessionId: null,
        reviewRunId: "run_stalled",
        reviewRunDispatchedAt: new Date(Date.now() - 2 * 60 * 60_000),
        reviewRunHeadSha: "sha-1",
        reviewRunIngestedId: "run_stalled",
      } as const;

      it("re-arms a stalled inconclusive run once the grace period has elapsed, clearing every run column", async () => {
        const app = await buildApp();
        const { task } = await createStalledInconclusiveTask(app, stalledRun);
        const sessionsModule = await import("../../src/services/session-lifecycle.js");
        const killSpy = vi.spyOn(sessionsModule, "killSession").mockResolvedValue(null);

        mockStopHermesRun.mockClear();
        await reconcileTasks(app);

        const row = await getTask(app, task.id);
        expect(row.reviewRunId).toBeNull();
        expect(row.reviewRunDispatchedAt).toBeNull();
        expect(row.reviewRunHeadSha).toBeNull();
        expect(row.reviewRunIngestedId).toBeNull();
        expect(mockStopHermesRun).toHaveBeenCalledWith(expect.anything(), "run_stalled");
        expect(row.inconclusiveReviewRearmCount).toBe(1);
        expect(row.status).toBe("reviewing");
        expect(row.autoReturnRounds).toBe(0);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        // There is no review session to kill.
        expect(killSpy).not.toHaveBeenCalled();

        killSpy.mockRestore();
        await app.close();
      });

      it("does not re-arm a run whose verdict has not been ingested yet", async () => {
        // The verdict column still holds the previous round's "inconclusive"
        // while the fresh run is out — re-arming now would stop a healthy run.
        const app = await buildApp();
        const { task } = await createStalledInconclusiveTask(app, {
          ...stalledRun,
          reviewRunIngestedId: null,
        });

        await reconcileTasks(app);

        const row = await getTask(app, task.id);
        expect(row.reviewRunId).toBe("run_stalled");
        expect(row.inconclusiveReviewRearmCount).toBe(0);

        await app.close();
      });

      it("does not re-arm a run within the grace period", async () => {
        const app = await buildApp();
        const { task } = await createStalledInconclusiveTask(app, {
          ...stalledRun,
          lastReviewVerdictAt: new Date(Date.now() - 60_000),
        });

        await reconcileTasks(app);

        const row = await getTask(app, task.id);
        expect(row.reviewRunId).toBe("run_stalled");
        expect(row.inconclusiveReviewRearmCount).toBe(0);

        await app.close();
      });
    });

    // Same reasoning as the in_progress -> reviewing transition's own kill
    // failure test above — a failed kill must not roll back or block the
    // re-arm write itself (already durable), just warn.
    it("still re-arms even when killing the stalled review session fails", async () => {
      const app = await buildApp();
      const { task, reviewSessionId } = await createStalledInconclusiveTask(app);
      const sessionsModule = await import("../../src/services/session-lifecycle.js");
      const killSpy = vi
        .spyOn(sessionsModule, "killSession")
        .mockRejectedValueOnce(new Error("boom"));
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.reviewSessionId).toBeNull();
      expect(row.inconclusiveReviewRearmCount).toBe(1);
      // Fire-and-forget — flush microtasks before asserting the warn fired.
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, reviewSessionId }),
        "task reconcile: failed to kill the stalled review session",
      );

      killSpy.mockRestore();
      await app.close();
    });

    it("does not re-arm while still within the grace period", async () => {
      const app = await buildApp();
      const { task } = await createStalledInconclusiveTask(app, {
        lastReviewVerdictAt: new Date(Date.now() - 60_000),
      });

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.inconclusiveReviewRearmCount).toBe(0);

      await app.close();
    });

    it("does not re-arm once the automatic re-arm budget is already spent", async () => {
      const app = await buildApp();
      const { task } = await createStalledInconclusiveTask(app, {
        inconclusiveReviewRearmCount: 1,
      });

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.inconclusiveReviewRearmCount).toBe(1);

      await app.close();
    });

    it("does not re-arm a task that has already spent its auto-return round budget", async () => {
      const app = await buildApp();
      const { task } = await createStalledInconclusiveTask(app, {
        autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
      });

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.inconclusiveReviewRearmCount).toBe(0);

      await app.close();
    });

    // A capped, announced task is reannounceCappedTasksAfterHumanPush's own
    // territory (requires an actual human push, not a timer) — the two
    // sweeps must never both touch the same row.
    it("does not re-arm a capped, announced task", async () => {
      const app = await buildApp();
      const { task } = await createStalledInconclusiveTask(app, {
        autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
        autoReturnCapAnnouncedAt: new Date(Date.now() - 60_000),
      });

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.inconclusiveReviewRearmCount).toBe(0);
      expect(row.autoReturnCapAnnouncedAt).not.toBeNull();

      await app.close();
    });

    it("does not re-arm a task whose most recent verdict isn't inconclusive", async () => {
      const app = await buildApp();
      const { task } = await createStalledInconclusiveTask(app, { lastReviewVerdict: "clean" });

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.inconclusiveReviewRearmCount).toBe(0);

      await app.close();
    });

    it("does nothing while Task Master is disabled", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        const { task } = await createStalledInconclusiveTask(app);

        await reconcileTasks(app);

        const row = await getTask(app, task.id);
        expect(row.reviewSessionId).not.toBeNull();
        expect(row.inconclusiveReviewRearmCount).toBe(0);
      } finally {
        // "off" is a durable settings-row write, not per-app state — the
        // whole file shares one DB (test/setup.ts), so leaving it here would
        // silently disable Task Master for every later test in the file
        // (see the pre-existing "does not transition a finished task..."
        // test above for the same reset-in-finally convention).
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });
  });

  // #738 follow-up — the review-agent spawn moved out of the "→ reviewing"
  // transition into its own pass (processPendingReviewSpawns), gated on CI
  // reaching a terminal state for the task's PR head commit. These tests
  // exercise that pass directly rather than through the review-agent
  // describe block above, whose every existing test relies on there being
  // no PR (so resolveReviewCi short-circuits to `undefined` and the spawn
  // still fires in the same tick as the transition) — deliberately
  // unchanged behavior, not something this new pass needed to touch.
});
