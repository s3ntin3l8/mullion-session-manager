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
const { reconcileTasks, resetMergeBackoff, MERGE_UNCONFIRMED_PREFIX } =
  await import("../../src/services/task-reconciler.js");
const { subscribeToTaskEvents, clearTaskEventSubscribersForTests } =
  await import("../../src/services/task-events.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { deriveWorktreePath } = await import("../../src/services/git-worktree.js");
const { GitHubApiError } = await import("../../src/services/github.js");

const {
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockGetPullRequestByNumber,
  mockMergePullRequest,
  mockUpdatePullRequestBranch,
  mockDeleteRemoteBranch,
  mockUpdatePullRequestTitle,
  mockFetchCheckRunsForHead,
  mockResumeTaskWorktree,
  mockRemoveWorktree,
} = reconcilerMocks;

describe("reconcileTasks — merge-on-approve sweep", () => {
  setupReconcilerTestLifecycle("task-reconciler-merge");
  describe("merge-on-approve sweep (processMergeRequests)", () => {
    // Mirrors createReviewingTaskWithNoPR above — inserts a "done" task with
    // a linked PR and mergeRequestedAt already set, exactly the state
    // approve (or a "Merge now" click) leaves behind. worktreePath is
    // deliberately left null (never set) on every task here: the sweep must
    // resolve repoRef/token from the project alone (see attemptMerge's own
    // doc comment) — a task whose worktree was already cleaned up at
    // approve is the REAL shape this sweep always sees, so a test that
    // accidentally depended on worktreePath would be testing a case that
    // can't happen in production.

    beforeEach(() => {
      mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
      mockResolveGitHubToken.mockResolvedValue("tok");
    });

    // Same reasoning as the CI-gated review-spawn block's own afterEach
    // above: restore the pass-through defaults so this block's fake
    // "tok"/"o/r" values can't leak into an unrelated later test.
    afterEach(() => {
      restorePassThroughMocks();
    });

    it("merges a clean PR and deletes its remote branch, clearing the merge flag", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
      mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
      mockDeleteRemoteBranch.mockResolvedValue(undefined);

      await reconcileTasks(app);

      expect(mockMergePullRequest).toHaveBeenCalledWith("tok", "o", "r", 9, {
        sha: "sha-head",
        commitTitle: "feat: do the thing",
      });
      expect(mockDeleteRemoteBranch).toHaveBeenCalledWith("tok", "o", "r", "mullion/task-x");
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).toBeNull();
      expect(row.mergeError).toBeNull();

      await app.close();
    });

    it("still merges when the remote-branch delete fails — the merge itself is the outcome that matters", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
      mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
      mockDeleteRemoteBranch.mockRejectedValue(new Error("network blip"));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).toBeNull();
      expect(row.mergeError).toBeNull();

      await app.close();
    });

    describe("ambiguous merge transport failure (timeout)", () => {
      const timeout = () =>
        new GitHubApiError("Could not reach GitHub: The operation was aborted due to timeout", 0);

      // A minimal stand-in for a task-events WS subscriber: records what the
      // refresh broadcast delivers.
      function subscribeFakeSocket() {
        const sent: string[] = [];
        const socket = {
          readyState: 1,
          OPEN: 1,
          bufferedAmount: 0,
          on: () => {},
          send: (m: string) => sent.push(m),
        };
        subscribeToTaskEvents(socket as never);
        return {
          sent,
          socket,
        };
      }

      afterEach(() => clearTaskEventSubscribersForTests());

      it("finishes the task when the merge landed server-side and only the response timed out", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        const { sent } = subscribeFakeSocket();
        mockGetPullRequestByNumber
          .mockResolvedValueOnce(mockPr({ mergeableState: "clean" }))
          .mockResolvedValueOnce(mockPr({ state: "closed", merged: true }));
        mockMergePullRequest.mockRejectedValue(timeout());

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergedAt).not.toBeNull();
        expect(row.archivedAt).not.toBeNull();
        expect(row.mergeRequestedAt).toBeNull();
        expect(row.mergeError).toBeNull();
        expect(sent.some((m) => m.includes('"kind":"ingested"'))).toBe(true);

        await app.close();
      });

      it("reports an unconfirmed outcome, not a failure, when the confirming read fails too — then recovers", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber
          .mockResolvedValueOnce(mockPr({ mergeableState: "clean" }))
          .mockRejectedValueOnce(timeout());
        mockMergePullRequest.mockRejectedValue(timeout());

        await reconcileTasks(app);

        let row = await getTask(app, taskId);
        expect(row.mergedAt).toBeNull();
        expect(row.mergeRequestedAt).not.toBeNull();
        expect(row.mergeError).toContain(MERGE_UNCONFIRMED_PREFIX);
        expect(row.mergeError).not.toContain("Merge attempt failed");

        // Next sweep (backoff elapsed): GitHub now says it merged.
        resetMergeBackoff(taskId);
        mockGetPullRequestByNumber.mockReset();
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ state: "closed", merged: true }));
        await reconcileTasks(app);

        row = await getTask(app, taskId);
        expect(row.mergedAt).not.toBeNull();
        expect(row.mergeError).toBeNull();
        expect(row.mergeRequestedAt).toBeNull();

        await app.close();
      });

      it("still reports a definite failure when the confirming read shows the PR open", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
        mockMergePullRequest.mockRejectedValue(timeout());

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergeError).toContain("Merge attempt failed");
        expect(row.mergedAt).toBeNull();

        await app.close();
      });

      it("treats a PR closed without merging as already-done, not merged", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber
          .mockResolvedValueOnce(mockPr({ mergeableState: "clean" }))
          .mockResolvedValueOnce(mockPr({ state: "closed", merged: false }));
        mockMergePullRequest.mockRejectedValue(timeout());

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergedAt).toBeNull();
        expect(row.mergeRequestedAt).toBeNull();
        expect(row.mergeError).toBeNull();

        await app.close();
      });

      it("keeps a definite GitHub rejection a failure without a confirming read", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
        mockMergePullRequest.mockRejectedValue(new GitHubApiError("HTTP 405 not mergeable", 405));

        await reconcileTasks(app);

        expect(mockGetPullRequestByNumber).toHaveBeenCalledTimes(1);
        expect((await getTask(app, taskId)).mergeError).toContain("Merge attempt failed");

        await app.close();
      });

      it("a late timeout cannot restore a merge error on a task a webhook already merged", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithPendingMerge(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
        // The webhook lands while the merge request is still in flight, then
        // the request times out and the confirming read times out as well.
        mockMergePullRequest.mockImplementation(async () => {
          app.db
            .update(tasks)
            .set({ mergedAt: new Date(), mergeError: null })
            .where(eq(tasks.id, taskId))
            .run();
          mockGetPullRequestByNumber.mockRejectedValue(timeout());
          throw timeout();
        });

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.mergedAt).not.toBeNull();
        expect(row.mergeError).toBeNull();

        await app.close();
      });
    });

    it("updates a behind branch and waits for the next tick instead of merging in the same pass", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "behind" }));
      mockUpdatePullRequestBranch.mockResolvedValue(undefined);

      await reconcileTasks(app);

      expect(mockUpdatePullRequestBranch).toHaveBeenCalledWith("tok", "o", "r", 9, "sha-head");
      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toContain("behind");

      await app.close();
    });

    it("does not merge on 'unstable' — a non-required check is failing or still running", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toContain("non-required check");

      await app.close();
    });

    it("names the red check in the merge hold so a human knows what to fix or override", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "unstable" }));
      mockFetchCheckRunsForHead.mockResolvedValue([
        {
          name: "codecov/patch",
          conclusion: "failure",
          detail: "66.66% of diff hit (target 75.00%)",
        },
        { name: "test-node / lint-and-test", conclusion: "success" },
      ]);

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeError).toContain("codecov/patch: 66.66% of diff hit (target 75.00%)");
      expect(row.mergeError).toContain("Merge anyway");

      await app.close();
    });

    // #1035 — a red NON-required title-lint check (e.g. one that's
    // deliberately not in branch protection) leaves the task in
    // `unstable` with no auto-merge and no round-cap escape (no round is
    // being spent), so the task strands indefinitely. Self-heal: same
    // `attemptSelfHealPrTitle` helper the red-required path uses; no
    // round consumed, no mergeError recorded (the next tick will
    // re-read mergeable_state and may now be "clean").
    it("self-heals a non-required title-lint 'unstable' failure rather than leaving the task stuck", async () => {
      const app = await buildApp();
      // Insert directly with a non-conventional title and a Conventional
      // `prTitle` (what the worker would have ingested) — the helper
      // re-derives the conventional one. Bypasses
      // `createDoneTaskWithPendingMerge`'s no-overrides shape.
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: `p-unstable-self-heal-${Math.random()}`,
          cwd: "/tmp",
        },
      });
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId: project.json().id,
          title: "Add a thing",
          status: "done",
          claimedAt: new Date(),
          completedAt: new Date(),
          prNumber: 9,
          prUrl: "https://github.com/o/r/pull/9",
          prTitle: "feat: add a thing",
          mergeRequestedAt: new Date(),
        })
        .returning()
        .all();
      const taskId = row.id;
      mockGetPullRequestByNumber.mockResolvedValue(
        mockPr({ mergeableState: "unstable", title: "Add a thing" }),
      );
      mockFetchCheckRunsForHead.mockResolvedValue([
        { name: "lint-pr-title", conclusion: "failure" },
      ]);

      await reconcileTasks(app);

      expect(mockUpdatePullRequestTitle).toHaveBeenCalledWith(
        "tok",
        "o",
        "r",
        9,
        "feat: add a thing",
      );
      const finalRow = await getTask(app, taskId);
      // No mergeError recorded — the self-heal short-circuits before
      // recordMergeError, so the task isn't recorded as stranded.
      expect(finalRow.mergeError).toBeNull();
      // mergeRequestedAt is preserved — the task IS still pending merge,
      // the next tick just needs to see the title-lint check clear and
      // mergeable_state -> "clean".
      expect(finalRow.mergeRequestedAt).not.toBeNull();

      await app.close();
    });

    it("backs off and retries on a real conflict ('dirty') rather than giving up", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toContain("Conflicts with main");

      await app.close();
    });

    describe("auto-rebase on a real conflict (#758)", () => {
      // Mirrors createDoneTaskWithPendingMerge above, plus the fields
      // attemptAutoRebase needs: branchName/agentCommand (a claimed task
      // always has both by the time it's "done" — see task-claim.ts's own
      // reservation transaction) project.autoApprove defaulted ON
      // (unlike the bare merge-sweep tests above, which deliberately leave
      // it off to prove the plain-backoff fallback).
      async function createDoneTaskWithConflict(
        app: Awaited<ReturnType<typeof buildApp>>,
        overrides: Partial<{
          autoApprove: boolean;
          branchName: string | null;
          agentCommand: string | null;
          rebaseAttempts: number;
          rebaseStartedAt: Date | null;
          sessionId: number | null;
        }> = {},
      ) {
        const { autoApprove = true, ...taskOverrides } = overrides;
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            createDir: true,
            name: `p-rebase-${Math.random()}`,
            cwd: "/tmp",
          },
        });
        const projectId = project.json().id;
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}`,
          payload: { autoApprove },
        });
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            title: "conflicted",
            status: "done",
            claimedAt: new Date(),
            completedAt: new Date(),
            prNumber: 9,
            prUrl: "https://github.com/o/r/pull/9",
            mergeRequestedAt: new Date(),
            branchName: "mullion/task-x",
            agentCommand: "claude",
            ...taskOverrides,
          })
          .returning()
          .all();
        return { taskId: row.id, projectId };
      }

      it("spawns an auto-rebase worker when autoApprove is on", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
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
        expect(row.worktreePath).toBe("/tmp/.mullion-worktrees/mullion-task-x");
        expect(row.mergeError).toContain("in progress");
        // #9 — the rebase worker is still task #N's worker, named/locked
        // the same as the claim/retry spawns.
        const rebaseSession = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, row.sessionId!))
          .all()[0];
        expect(rebaseSession).toMatchObject({
          name: `Task #${taskId} · worker`,
          nameLocked: true,
        });

        await app.close();
      });

      it("clears a stale worktree from a prior attempt before resuming", async () => {
        const app = await buildApp();
        await createDoneTaskWithConflict(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
        mockResumeTaskWorktree.mockResolvedValue({
          path: "/tmp/.mullion-worktrees/mullion-task-x",
          branch: "mullion/task-x",
        });

        await reconcileTasks(app);

        const expectedStalePath = deriveWorktreePath("/tmp", "mullion/task-x");
        expect(mockRemoveWorktree).toHaveBeenCalledWith(expectedStalePath, "/tmp");
        // Cleared BEFORE resuming, not after — a second attempt at the same
        // deterministic path fails outright otherwise (resumeTaskWorktree's
        // own "target path already exists" refusal).
        const removeOrder = mockRemoveWorktree.mock.invocationCallOrder[0];
        const resumeOrder = mockResumeTaskWorktree.mock.invocationCallOrder[0];
        expect(removeOrder).toBeLessThan(resumeOrder);

        await app.close();
      });

      it("does not spawn a second worker while one is still in flight", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app, {
          rebaseAttempts: 1,
          rebaseStartedAt: new Date(),
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.rebaseAttempts).toBe(1);
        expect(row.mergeError).toContain("in progress");

        await app.close();
      });

      it("retries once the previous attempt's window goes stale", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app, {
          rebaseAttempts: 1,
          rebaseStartedAt: new Date(Date.now() - 31 * 60_000),
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
        mockResumeTaskWorktree.mockResolvedValue({
          path: "/tmp/.mullion-worktrees/mullion-task-x",
          branch: "mullion/task-x",
        });

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).toHaveBeenCalledWith("/tmp", "mullion/task-x");
        const row = await getTask(app, taskId);
        expect(row.rebaseAttempts).toBe(2);

        await app.close();
      });

      // Fresh review, PR #783 — a stale rebaseStartedAt is a TIME check, not
      // proof the previous attempt's session actually died: Task Master
      // workers are told to keep running, so "still active" is normal even
      // for a genuinely long-running (not abandoned) rebase-and-reverify
      // round. This proves the still-active session is terminated (and its
      // row flips to "killed", not left "active") BEFORE the stale-worktree
      // force-remove/retry proceeds — never force-removing a worktree a live
      // process might still be writing to.
      it("terminates a stale attempt's still-active session before clearing its worktree and retrying", async () => {
        const app = await buildApp();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            createDir: true,
            name: `p-rebase-${Math.random()}`,
            cwd: "/tmp",
          },
        });
        const projectId = project.json().id;
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}`,
          payload: { autoApprove: true },
        });
        const session = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const staleSessionId = session.json().id as number;
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            title: "conflicted",
            status: "done",
            claimedAt: new Date(),
            completedAt: new Date(),
            prNumber: 9,
            prUrl: "https://github.com/o/r/pull/9",
            mergeRequestedAt: new Date(),
            branchName: "mullion/task-x",
            agentCommand: "claude",
            sessionId: staleSessionId,
            rebaseAttempts: 1,
            rebaseStartedAt: new Date(Date.now() - 31 * 60_000),
          })
          .returning()
          .all();
        const taskId = row.id;
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
        mockResumeTaskWorktree.mockResolvedValue({
          path: "/tmp/.mullion-worktrees/mullion-task-x",
          branch: "mullion/task-x",
        });

        await reconcileTasks(app);

        const staleSession = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, staleSessionId))
          .all()[0];
        expect(staleSession.status).toBe("killed");
        expect(mockResumeTaskWorktree).toHaveBeenCalledWith("/tmp", "mullion/task-x");
        const updatedRow = await getTask(app, taskId);
        expect(updatedRow.rebaseAttempts).toBe(2);
        expect(updatedRow.sessionId).not.toBe(staleSessionId);

        await app.close();
      });

      it("gives up and falls back to plain conflict backoff once attempts are exhausted", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app, { rebaseAttempts: 2 });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
        expect(mockRemoveWorktree).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.rebaseAttempts).toBe(2);
        expect(row.mergeRequestedAt).not.toBeNull();
        expect(row.mergeError).toContain("gave up after 2 attempt(s)");

        await app.close();
      });

      // Second review, PR #783 — the cap check must run BEFORE the
      // stale-attempt termination, not after: a task that's already at the
      // cap gets no more attempts either way, so terminating a possibly
      // still-working session only to then immediately give up would be a
      // pointless, irreversible kill. This is the one case that combination
      // can actually happen in (stale window + at cap + session still
      // active) — the previous "gives up..." test above never sets
      // rebaseStartedAt, so it can't exercise this ordering.
      // Third review, PR #783 — the in-flight/window check runs BEFORE the
      // cap check specifically so a last-attempt-at-cap still within its
      // window waits for it rather than being reported as "gave up" while
      // it may yet succeed. Every other test here covers rebaseAttempts at
      // 1 (under cap) or a STALE window at the cap — nothing pins the
      // "at cap, but still fresh" combination, which is exactly the case
      // that ordering exists to get right and a future refactor could
      // silently regress.
      it("keeps waiting on an in-flight attempt even when it's the last one allowed (at cap, still within its window)", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app, {
          rebaseAttempts: 2,
          rebaseStartedAt: new Date(),
        });
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
        expect(mockRemoveWorktree).not.toHaveBeenCalled();
        const row = await getTask(app, taskId);
        expect(row.rebaseAttempts).toBe(2);
        expect(row.mergeError).toContain("in progress");
        expect(row.mergeError).not.toContain("gave up");

        await app.close();
      });

      it("gives up without terminating a stale attempt's still-active session, once attempts are exhausted", async () => {
        const app = await buildApp();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            createDir: true,
            name: `p-rebase-${Math.random()}`,
            cwd: "/tmp",
          },
        });
        const projectId = project.json().id;
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}`,
          payload: { autoApprove: true },
        });
        const session = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const staleSessionId = session.json().id as number;
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            title: "conflicted",
            status: "done",
            claimedAt: new Date(),
            completedAt: new Date(),
            prNumber: 9,
            prUrl: "https://github.com/o/r/pull/9",
            mergeRequestedAt: new Date(),
            branchName: "mullion/task-x",
            agentCommand: "claude",
            sessionId: staleSessionId,
            rebaseAttempts: 2,
            rebaseStartedAt: new Date(Date.now() - 31 * 60_000),
          })
          .returning()
          .all();
        const taskId = row.id;
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));

        await reconcileTasks(app);

        expect(mockResumeTaskWorktree).not.toHaveBeenCalled();
        expect(mockRemoveWorktree).not.toHaveBeenCalled();
        const staleSession = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, staleSessionId))
          .all()[0];
        expect(staleSession.status).toBe("active");
        const updatedRow = await getTask(app, taskId);
        expect(updatedRow.rebaseAttempts).toBe(2);
        expect(updatedRow.sessionId).toBe(staleSessionId);
        expect(updatedRow.mergeError).toContain("gave up after 2 attempt(s)");

        await app.close();
      });

      it("surfaces rather than retries when the branch can't be recreated", async () => {
        const app = await buildApp();
        const { taskId } = await createDoneTaskWithConflict(app);
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "dirty" }));
        mockResumeTaskWorktree.mockResolvedValue(null);

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        // Not retryable by spawning again — attempts/rebaseStartedAt are left
        // untouched so a later merge-sweep tick doesn't mistake this for an
        // in-flight or exhausted attempt; it's surfaced for a human instead.
        expect(row.rebaseAttempts).toBe(0);
        expect(row.rebaseStartedAt).toBeNull();
        expect(row.mergeError).toContain("could not recreate the worktree");

        await app.close();
      });

      // Fresh review, PR #783 — a rebased-then-merged task's worktree/session
      // are real again (attemptAutoRebase overwrote them from their
      // post-approve null) nothing else ever cleans them up once the
      // conflict resolves: the task never leaves "done", so approveTask's
      // own cleanup (which only fires on a "-> done" transition) never fires
      // a second time for it. clearMergeState must do that cleanup itself —
      // and must NOT reset rebaseAttempts, a lifetime counter design point 8
      // otherwise has zero coverage for.
      it("cleans up the worktree/session and clears rebaseStartedAt on a successful merge, but preserves rebaseAttempts", async () => {
        const app = await buildApp();
        const session = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            createDir: true,
            name: `p-rebase-merge-${Math.random()}`,
            cwd: "/tmp",
          },
        });
        const projectId = session.json().id;
        const workerSession = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const sessionId = workerSession.json().id as number;
        const [row] = app.db
          .insert(tasks)
          .values({
            projectId,
            title: "was-conflicted",
            status: "done",
            claimedAt: new Date(),
            completedAt: new Date(),
            prNumber: 9,
            prUrl: "https://github.com/o/r/pull/9",
            mergeRequestedAt: new Date(),
            branchName: "mullion/task-x",
            agentCommand: "claude",
            sessionId,
            worktreePath: "/tmp/.mullion-worktrees/mullion-task-x",
            rebaseAttempts: 1,
            rebaseStartedAt: new Date(),
          })
          .returning()
          .all();
        const taskId = row.id;
        mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "clean" }));
        mockMergePullRequest.mockResolvedValue({ merged: true, sha: "sha-merged" });
        mockDeleteRemoteBranch.mockResolvedValue(undefined);

        await reconcileTasks(app);

        const updatedRow = await getTask(app, taskId);
        expect(updatedRow.mergeRequestedAt).toBeNull();
        expect(updatedRow.rebaseStartedAt).toBeNull();
        // The lifetime counter — never reset, unlike everything else
        // clearMergeState clears.
        expect(updatedRow.rebaseAttempts).toBe(1);
        const finalSession = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .all()[0];
        expect(finalSession.status).toBe("killed");

        await app.close();
      });
    });

    it("backs off and retries when a required check is blocked", async () => {
      const app = await buildApp();
      const { taskId } = await createDoneTaskWithPendingMerge(app);
      mockGetPullRequestByNumber.mockResolvedValue(mockPr({ mergeableState: "blocked" }));

      await reconcileTasks(app);

      expect(mockMergePullRequest).not.toHaveBeenCalled();
      const row = await getTask(app, taskId);
      expect(row.mergeRequestedAt).not.toBeNull();
      expect(row.mergeError).toContain("Required checks");

      await app.close();
    });
  });
});
