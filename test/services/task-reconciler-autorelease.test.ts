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

const { buildApp } = await import("../../src/app.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { tasks } = await import("../../src/db/schema.js");

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockMergePullRequest,
  mockDeleteRemoteBranch,
  mockFindReleasePullRequest,
  mockGetDefaultBranch,
  mockDetectReleaseWorkflow,
} = reconcilerMocks;

describe("reconcileTasks — autorelease sweep (#744)", () => {
  setupReconcilerTestLifecycle("task-reconciler-autorelease");
  describe("autorelease sweep (#744 — processReleaseRequests + attemptMerge's own arming)", () => {
    const FOUND_WORKFLOW = {
      kind: "found" as const,
      workflow: { id: 2, name: "Release Please", path: ".github/workflows/release-please.yml" },
    };
    const RELEASE_PR_SUMMARY = {
      number: 42,
      htmlUrl: "https://github.com/o/r/pull/42",
      headRef: "release-please--branches--main",
      title: "chore(main): release 1.2.3",
    };
    function releasePr(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        number: 42,
        htmlUrl: "https://github.com/o/r/pull/42",
        nodeId: "PR_release",
        draft: false,
        headSha: "release-sha",
        headRef: "release-please--branches--main",
        baseRef: "main",
        title: "chore(main): release 1.2.3",
        state: "open",
        merged: false,
        mergeable: true,
        mergeableState: "clean",
        ...overrides,
      };
    }

    async function createProject(
      app: Awaited<ReturnType<typeof buildApp>>,
      autoTagRelease: boolean,
    ): Promise<number> {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: `p-release-${Math.random()}`,
          cwd: "/tmp",
        },
      });
      const projectId = project.json().id as number;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { autoTagRelease },
      });
      return projectId;
    }

    async function createDoneTaskWithPendingMerge(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      prNumber: number,
    ) {
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: `task-${prNumber}`,
          status: "done",
          claimedAt: new Date(),
          completedAt: new Date(),
          prNumber,
          prUrl: `https://github.com/o/r/pull/${prNumber}`,
          mergeRequestedAt: new Date(),
        })
        .returning()
        .all();
      return row.id;
    }

    // A releaseRequestedAt far enough in the past to already have cleared
    // processReleaseRequests' own RELEASE_QUIET_MS (10 minutes) — every
    // "acts now" test below needs this; the "still quiet" test below uses
    // `new Date()` instead.
    const PAST_QUIET_WINDOW = new Date(Date.now() - 11 * 60_000);

    async function createDoneTaskWithReleaseRequested(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      overrides: Partial<{ releaseRequestedAt: Date; prNumber: number }> = {},
    ) {
      const prNumber = overrides.prNumber ?? 9;
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: `released-${prNumber}`,
          status: "done",
          claimedAt: new Date(),
          completedAt: new Date(),
          prNumber,
          prUrl: `https://github.com/o/r/pull/${prNumber}`,
          releaseRequestedAt: overrides.releaseRequestedAt ?? PAST_QUIET_WINDOW,
        })
        .returning()
        .all();
      return row.id;
    }

    beforeEach(() => {
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
    });

    afterEach(() => {
      restorePassThroughMocks();
    });

    describe('arming (attemptMerge\'s own case "clean")', () => {
      it("arms releaseRequestedAt once the task's own PR merges, when autoTagRelease is on", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithPendingMerge(app, projectId, 9);
        mockGetPullRequestByNumber.mockResolvedValue(
          releasePr({ number: 9, headSha: "sha-head", title: "feat: do the thing" }),
        );
        mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
        mockDeleteRemoteBranch.mockResolvedValue(undefined);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeRequestedAt).toBeNull();
        expect(row.releaseRequestedAt).not.toBeNull();

        await app.close();
      });

      it("does NOT arm when autoTagRelease is off (the default)", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, false);
        const taskId = await createDoneTaskWithPendingMerge(app, projectId, 9);
        mockGetPullRequestByNumber.mockResolvedValue(releasePr({ number: 9 }));
        mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
        mockDeleteRemoteBranch.mockResolvedValue(undefined);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeRequestedAt).toBeNull();
        expect(row.releaseRequestedAt).toBeNull();

        await app.close();
      });

      it("does NOT arm on a PR closed without merging (already-done, not clean)", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithPendingMerge(app, projectId, 9);
        // classifyMergeReadiness collapses `state: "closed"` into
        // "already-done" the same as an actual merge — attemptMerge must not
        // arm a release for this, only for the "clean" branch.
        mockGetPullRequestByNumber.mockResolvedValue(
          releasePr({ number: 9, state: "closed", merged: false }),
        );

        await reconcileTasks(app);

        expect(mockMergePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.mergeRequestedAt).toBeNull();
        expect(row.releaseRequestedAt).toBeNull();

        await app.close();
      });
    });

    // #1015 (archive) — same call sites the autorelease arm above tests,
    // same "already-done"/"clean" distinction: only case "clean" (a real
    // merge just happened) and an "already-done" verdict backed by
    // `pr.merged === true` (never a PR closed WITHOUT merging) may record
    // mergedAt/archivedAt.
    describe("markTaskMerged (#1015)", () => {
      it("sets mergedAt and archivedAt when the task's own PR actually merges (clean)", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, false);
        const taskId = await createDoneTaskWithPendingMerge(app, projectId, 9);
        mockGetPullRequestByNumber.mockResolvedValue(releasePr({ number: 9 }));
        mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
        mockDeleteRemoteBranch.mockResolvedValue(undefined);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergedAt).not.toBeNull();
        expect(row.archivedAt).not.toBeNull();

        await app.close();
      });

      it("sets mergedAt and archivedAt when a human merged it directly on GitHub (already-done, merged)", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, false);
        const taskId = await createDoneTaskWithPendingMerge(app, projectId, 9);
        mockGetPullRequestByNumber.mockResolvedValue(
          releasePr({ number: 9, state: "closed", merged: true }),
        );

        await reconcileTasks(app);

        expect(mockMergePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.mergedAt).not.toBeNull();
        expect(row.archivedAt).not.toBeNull();

        await app.close();
      });

      it("does NOT set mergedAt on a PR closed WITHOUT merging (already-done, not merged)", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, false);
        const taskId = await createDoneTaskWithPendingMerge(app, projectId, 9);
        mockGetPullRequestByNumber.mockResolvedValue(
          releasePr({ number: 9, state: "closed", merged: false }),
        );

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergedAt).toBeNull();
        expect(row.archivedAt).toBeNull();

        await app.close();
      });
    });

    describe("the sweep itself (processReleaseRequests)", () => {
      it("does nothing while inside the quiet window", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithReleaseRequested(app, projectId, {
          releaseRequestedAt: new Date(), // just landed — well inside the window
        });

        await reconcileTasks(app);

        expect(mockDetectReleaseWorkflow).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.releaseRequestedAt).not.toBeNull();

        await app.close();
      });

      it("merges the release PR once quiet, coalescing N armed tasks into ONE merge call", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskA = await createDoneTaskWithReleaseRequested(app, projectId, { prNumber: 10 });
        const taskB = await createDoneTaskWithReleaseRequested(app, projectId, { prNumber: 11 });
        mockDetectReleaseWorkflow.mockResolvedValue(FOUND_WORKFLOW);
        mockGetDefaultBranch.mockResolvedValue("main");
        mockFindReleasePullRequest.mockResolvedValue(RELEASE_PR_SUMMARY);
        mockGetPullRequestByNumber.mockResolvedValue(releasePr());
        mockMergePullRequest.mockResolvedValue({ merged: true, sha: "release-merged" });

        await reconcileTasks(app);

        expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
        expect(mockMergePullRequest).toHaveBeenCalledWith("tok", "o", "r", 42, {
          sha: "release-sha",
          commitTitle: "chore(main): release 1.2.3",
        });
        for (const taskId of [taskA, taskB]) {
          const row = await getTask(app, taskId);
          expect(row.releaseRequestedAt).toBeNull();
          expect(row.releaseError).toBeNull();
        }

        await app.close();
      });

      it("records the reason and keeps retrying when required checks are blocked", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithReleaseRequested(app, projectId);
        mockDetectReleaseWorkflow.mockResolvedValue(FOUND_WORKFLOW);
        mockGetDefaultBranch.mockResolvedValue("main");
        mockFindReleasePullRequest.mockResolvedValue(RELEASE_PR_SUMMARY);
        mockGetPullRequestByNumber.mockResolvedValue(releasePr({ mergeableState: "blocked" }));

        await reconcileTasks(app);

        expect(mockMergePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.releaseRequestedAt).not.toBeNull();
        expect(row.releaseError).toContain("Required checks");

        await app.close();
      });

      it("clears the intent (but keeps the error visible) when the repo has no release-please workflow", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, true);
        const taskId = await createDoneTaskWithReleaseRequested(app, projectId);
        mockDetectReleaseWorkflow.mockResolvedValue({ kind: "not-configured" });

        await reconcileTasks(app);

        expect(mockFindReleasePullRequest).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.releaseRequestedAt).toBeNull();
        expect(row.releaseError).toContain("no release-please workflow");

        await app.close();
      });

      it("ignores a project with autoTagRelease off even if a task somehow has releaseRequestedAt set", async () => {
        const app = await buildApp();
        const projectId = await createProject(app, false);
        const taskId = await createDoneTaskWithReleaseRequested(app, projectId);

        await reconcileTasks(app);

        expect(mockDetectReleaseWorkflow).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.releaseRequestedAt).not.toBeNull();

        await app.close();
      });
    });
  });
});
