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
  runsLookup,
  getTask,
  createAutoApproveCandidate,
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
const {
  reconcileTasks,
  DEFAULT_MAX_AUTO_RETURN_ROUNDS,
  resetUnstableRunsUnreadableWarningsForTests,
} = await import("../../src/services/task-reconciler.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const {
  mockPromoteTaskToPR,
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockUpdatePullRequestTitle,
  mockFetchRunsForHead,
  mockFetchCheckRunsForHead,
  mockCreatePullRequestReview,
} = reconcilerMocks;

describe("reconcileTasks — auto-approve red required CI (#755)", () => {
  setupReconcilerTestLifecycle("task-reconciler-auto-approve-ci");
  beforeEach(() => {
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
  });

  describe("red required CI returns the task to the worker (#755)", () => {
    async function createRedCiCandidate(
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

    // The Workflow Run layer — only used for the coarse "is anything red
    // at all" pre-filter (`current.status !== "failure"`), never compared
    // against check names directly.
    function workflowRun(name: string, conclusion: "success" | "failure") {
      return [
        {
          name,
          status: "completed" as const,
          conclusion,
          htmlUrl: "https://x/1",
          headSha: "sha-head",
        },
      ];
    }

    // The Check Run layer — THIS is what the red-CI return reads.
    function checkRun(name: string, conclusion: "success" | "failure") {
      return [{ name, conclusion }];
    }

    it("carries an approving verdict through a red-CI fix: the round is spent, the re-review is not", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app, { lastReviewVerdict: "approved" });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("test-node / lint-and-test", "failure"));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.lastAutoReturnReason).toBe("ci");
      expect(row.approvalCarriedAt).not.toBeNull();

      await app.close();
    });

    it("does not carry a verdict that isn't an approval through a red-CI fix", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app, {
        lastReviewVerdict: "changes-requested",
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("test-node / lint-and-test", "failure"));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.approvalCarriedAt).toBeNull();

      await app.close();
    });

    it("returns the task when a REQUIRED check fails", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("test-node / lint-and-test", "failure"));

      await reconcileTasks(app);

      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.lastAutoReturnReason).toBe("ci");

      await app.close();
    });

    it("returns the task for a red check that is NOT in the required set (this repo's own test-e2e) — a red check is work to fix", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue([
        { name: "test-node / lint-and-test", conclusion: "success" },
        { name: "test-e2e", conclusion: "failure" },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.lastAutoReturnReason).toBe("ci");

      await app.close();
    });

    it("returns the task for a red non-Actions check seen only through an `unstable` merge state (codecov/patch)", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app);
      // Every Actions run is green, so the coarse status is not "failure":
      // only GitHub's own `unstable` says something else is not passing.
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "success"));
      mockFetchCheckRunsForHead.mockResolvedValue([
        { name: "test-node / lint-and-test", conclusion: "success" },
        {
          name: "codecov/patch",
          conclusion: "failure",
          detail: "66.66% of diff hit (target 75.00%)",
        },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.lastAutoReturnReason).toBe("ci");

      await app.close();
    });

    it("does not return the worker for an `unstable` red check while the Actions runs are still in progress", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
      mockFetchRunsForHead.mockResolvedValue([
        {
          name: "CI/CD",
          status: "in_progress" as const,
          conclusion: null,
          htmlUrl: "https://x/1",
          headSha: "sha-head",
        },
      ]);
      mockFetchCheckRunsForHead.mockResolvedValue([
        { name: "codecov/patch", conclusion: "failure" },
      ]);

      await reconcileTasks(app);

      // A push mid-run would cancel and restart the head's Actions runs.
      expect(mockFetchCheckRunsForHead).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);

      await app.close();
    });

    it("does not return the worker for an `unstable` red check when the Actions lookup itself failed", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
      // A failed lookup degrades to "no runs" -> status null; without
      // runsAnswered that reads as idle and would push mid-run.
      runsLookup.failed = true;
      resetUnstableRunsUnreadableWarningsForTests();
      const warnSpy = vi.spyOn(app.log, "warn");
      mockFetchCheckRunsForHead.mockResolvedValue([
        { name: "codecov/patch", conclusion: "failure" },
      ]);

      try {
        await reconcileTasks(app);
        // The gate stands down loudly, once: a repo whose /actions/runs
        // never answers must be diagnosable, but not warned about every tick.
        await reconcileTasks(app);
      } finally {
        runsLookup.failed = false;
      }
      const standDownWarnings = warnSpy.mock.calls.filter(
        ([ctx, msg]) =>
          (ctx as { taskId?: number }).taskId === taskId &&
          String(msg).includes("red-CI return stands down"),
      );
      expect(standDownWarnings).toHaveLength(1);

      expect(mockFetchCheckRunsForHead).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);

      await app.close();
    });

    it("still returns the worker for an `unstable` red check when Actions has no runs at all (answered, empty)", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
      mockFetchRunsForHead.mockResolvedValue([]);
      mockFetchCheckRunsForHead.mockResolvedValue([
        { name: "codecov/patch", conclusion: "failure" },
      ]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.lastAutoReturnReason).toBe("ci");

      await app.close();
    });

    it("leaves the task alone when the merge state is unstable but no check run is actually red (only pending)", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "success"));
      mockFetchCheckRunsForHead.mockResolvedValue([{ name: "codecov/patch", conclusion: null }]);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);

      await app.close();
    });

    it("does not fetch check runs at all when the coarse Workflow Run status isn't red (avoids an extra GitHub call on the common green path)", async () => {
      const app = await buildApp();
      await createRedCiCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "success"));

      await reconcileTasks(app);

      expect(mockFetchCheckRunsForHead).not.toHaveBeenCalled();

      await app.close();
    });

    it("returns the task even with no review agent configured (gate 2 would otherwise never pass)", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app, {
        reviewFindingsIngestedSessionId: null,
        lastReviewVerdict: null,
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("test-node / lint-and-test", "failure"));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.lastAutoReturnReason).toBe("ci");

      await app.close();
    });

    it("returns the task even when the verdict is inconclusive (gate 3 would otherwise never pass)", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app, { lastReviewVerdict: "inconclusive" });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("test-node / lint-and-test", "failure"));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.lastAutoReturnReason).toBe("ci");

      await app.close();
    });

    it("posts a cap-reached comment and stays in 'reviewing' once the round budget is spent", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app, {
        autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS,
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("test-node / lint-and-test", "failure"));

      await reconcileTasks(app);

      expect(mockCreatePullRequestReview).toHaveBeenCalledWith(
        "tok",
        "o",
        "r",
        9,
        expect.objectContaining({
          body: expect.stringContaining(
            `(test-node / lint-and-test), but it has already reached its automatic round cap (${DEFAULT_MAX_AUTO_RETURN_ROUNDS})`,
          ),
        }),
      );
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(DEFAULT_MAX_AUTO_RETURN_ROUNDS);
      // Issue #1038 — this trigger has no other durable write to
      // piggyback the announcement on, so it needs its own; assert it
      // actually landed.
      expect(row.autoReturnCapAnnouncedAt).not.toBeNull();

      await app.close();
    });

    // Note: `ciCapCommentedRounds`'s dedup ALSO covers a LATER tick, once
    // `autoApproveRetryState`'s own ~30s-to-30min backoff has elapsed and
    // this task becomes eligible for another attempt — that direction
    // isn't meaningfully exercisable here without fake timers, which this
    // file deliberately never uses (time here is faked via backdated DB
    // timestamps, not `vi.useFakeTimers` there's no DB-backed clock
    // for an in-memory `Map`). The test below covers what CAN be tested
    // with this file's existing tooling: the dedup is keyed per-task, not
    // shared/global — a mis-keying bug (e.g. accidentally keying on the
    // round number alone) would under-post across different tasks in the
    // very same tick, which needs no elapsed time to observe.
    it("keys the cap-reached dedup per task, not globally — two different capped tasks in the same tick both get a comment", async () => {
      const app = await buildApp();
      await createRedCiCandidate(app, { autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS });
      await createRedCiCandidate(app, { autoReturnRounds: DEFAULT_MAX_AUTO_RETURN_ROUNDS });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("test-node / lint-and-test", "failure"));

      await reconcileTasks(app);

      expect(mockCreatePullRequestReview).toHaveBeenCalledTimes(2);

      await app.close();
    });

    it("does not return the task when the project's autoApprove is off", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app, { autoApprove: false });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("test-node / lint-and-test", "failure"));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);

      await app.close();
    });

    // #1035 — a red REQUIRED title-lint check (e.g.
    // `wagoid/commitlint-github-action`) used to fall straight into the
    // #755 red-required-CI-return path: the worker is forbidden by
    // buildTaskMasterPreamble from editing the PR itself (task-prompt.ts),
    // so returning them burns one of a small, non-renewing number of
    // auto-return rounds on a fix the worker can't actually make. The
    // self-heal here derives a Conventional Commits title via
    // resolvePrTitle (#761/#1037) and PATCHes the PR's title — same
    // helper #782's re-sync sites use — no round consumed, no worker
    // needed. Picked over `lint-pr-title` (the wagoid action's default
    // job name) deliberately: wagoid is the most-deployed action today,
    // but the choice of job name is configurable, so the matching list
    // is small + curated rather than a single name.
    it("self-heals a red REQUIRED title-lint check by re-deriving the PR title (no round consumed)", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app, {
        // Non-conventional issue title — what the PR title currently
        // still shows, before the self-heal. `resolvePrTitle` falls
        // through this to `task.prTitle` (the conventional title the
        // worker's `taskCommitTitlePath` file ingested at the "-> reviewing"
        // transition), so the self-heal re-derives that one.
        title: "Add a thing",
        prTitle: "feat: add a thing",
      });
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ title: "Add a thing" }));
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("lint-pr-title", "failure"));

      await reconcileTasks(app);

      // Self-heal short-circuits BEFORE auto-return: task stays in
      // reviewing, no round consumed, no lastAutoReturnReason written,
      // and updatePullRequestTitle was called with a Conventional
      // Commits title that resolves the failing check.
      expect(mockPromoteTaskToPR).not.toHaveBeenCalled();
      expect(mockUpdatePullRequestTitle).toHaveBeenCalledWith(
        "tok",
        "o",
        "r",
        9,
        "feat: add a thing",
      );
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.lastAutoReturnReason).toBeNull();

      await app.close();
    });

    // Companion direction: a red REQUIRED check that ISN'T a title-lint
    // one must still auto-return — the existing #755 contract is
    // untouched for everything except the title-lint names. Without this
    // guard, a bug that matched too liberally (e.g. substring instead of
    // exact match) would silently swallow every required-CI failure and
    // strands the task in "reviewing" forever instead.
    it("still auto-returns the worker for a red REQUIRED check that isn't a title-lint check (#1035 regression guard)", async () => {
      const app = await buildApp();
      const { taskId } = await createRedCiCandidate(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr());
      mockFetchRunsForHead.mockResolvedValue(workflowRun("CI/CD", "failure"));
      mockFetchCheckRunsForHead.mockResolvedValue(checkRun("test-node / lint-and-test", "failure"));

      await reconcileTasks(app);

      // No self-heal attempted (check name not in the title-lint set),
      // so the original #755 contract fires: auto-return, status ->
      // in_progress, round incremented.
      expect(mockUpdatePullRequestTitle).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.lastAutoReturnReason).toBe("ci");

      await app.close();
    });
  });

  // #757 — new GitHub PR review comments on unresolved threads (excluding
  // Mullion's own review bot) send a "reviewing" task back to its worker
  // for one automatic round, same mechanism/cap as #755's red-CI-return.
});
