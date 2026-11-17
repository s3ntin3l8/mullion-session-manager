import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
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

const { buildApp } = await import("../../src/app.js");
const { getDb } = await import("../../src/db/client.js");
const { reconcileTasks, notifyApprovalsAwaitingHuman, retryPermanentPushFailuresNow } =
  await import("../../src/services/task-reconciler.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { taskCommitTitlePath } = await import("../../src/services/task-prompt.js");
const { recordGitHubRateLimit, resetGitHubRateLimitForTests } =
  await import("../../src/services/github-fetch.js");

const {
  mockNotifyTaskNeedsAttention,
  mockOpenDraftPRForTask,
  mockResolveGitHubToken,
  mockDetectReleasePleaseConfig,
} = reconcilerMocks;

describe("reconcileTasks", () => {
  setupReconcilerTestLifecycle("task-reconciler-test");
  it("is a no-op when there are no claimed/in_progress tasks", async () => {
    const app = await buildApp();
    const getSpy = vi.spyOn(app.pty, "get");
    await expect(reconcileTasks(app)).resolves.toBeUndefined();
    expect(getSpy).not.toHaveBeenCalled();
    await app.close();
  });

  // Task-claim queueing (rate-limit-storm fix) — a "claimed" row with a
  // live session should never occur in production anymore (dispatch flips
  // status to "in_progress" INSIDE the same reservation transaction that
  // reserves the slot, before the session is spawned — see
  // task-claim.ts's dispatchClaimedTask). This test constructs that state
  // directly anyway (bypassing enqueueTask/dispatchClaimedTask, same as
  // this file's own createSessionAndTask helper always has) purely as a
  // defensive check: reconcileTasks must leave a "claimed" row alone no
  // matter what its session is doing, regardless of how it got there — the
  // "claimed -> in_progress" and "claimed -> reviewing" promotions this
  // used to test were removed as dead code (dispatchClaimedTask now owns
  // both edges; task-reconciler.ts's own comment where the old "claimed"
  // bucket used to live explains why).
  it("leaves claimed alone regardless of session activity — dispatchClaimedTask, not this pass, owns claimed -> in_progress/reviewing now", async () => {
    const app = await buildApp();
    const working = await createSessionAndTask(app, "claimed");
    const idle = await createSessionAndTask(app, "claimed");
    const finished = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockImplementation((id) => {
      if (id === String(working.sessionId)) {
        return { toInfo: () => fakeInfo({ activity: "working" }) } as never;
      }
      if (id === String(finished.sessionId)) {
        return { toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }) } as never;
      }
      return { toInfo: () => fakeInfo() } as never;
    });

    await reconcileTasks(app);

    for (const { taskId } of [working, idle, finished]) {
      const row = await getTask(app, taskId);
      expect(row.status).toBe("claimed");
      expect(row.startedAt).toBeNull();
    }
    await app.close();
  });

  it("flips in_progress -> reviewing once the session's turn is finished", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    await app.close();
  });

  // #761 — the worker's Conventional Commits title, ingested at the exact
  // same "-> reviewing" transition this describe block already covers.
  describe("Conventional Commits title ingestion at -> reviewing (#761)", () => {
    async function createConventionalTitleTask(
      app: Awaited<ReturnType<typeof buildApp>>,
    ): Promise<{ taskId: number; projectId: number }> {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: `p-cc-title-${Math.random()}`,
          cwd: "/tmp",
        },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { conventionalCommitTitles: true },
      });
      const session = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "t",
          status: "in_progress",
          sessionId: session.json().id,
          claimedAt: new Date(),
          startedAt: new Date(),
        })
        .returning()
        .all();
      return { taskId: row.id, projectId };
    }

    function writeCommitTitle(
      app: Awaited<ReturnType<typeof buildApp>>,
      taskId: number,
      raw: string,
    ) {
      fs.writeFileSync(taskCommitTitlePath(path.dirname(app.pty.hookSocketPath), taskId), raw);
    }

    it("ingests a well-formed title into tasks.prTitle", async () => {
      const app = await buildApp();
      const { taskId } = await createConventionalTitleTask(app);
      writeCommitTitle(app, taskId, "feat: add credential storage\n");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.prTitle).toBe("feat: add credential storage");
      await app.close();
    });

    it("falls back to a null prTitle (never blocks the transition) when the file is malformed", async () => {
      const app = await buildApp();
      const { taskId } = await createConventionalTitleTask(app);
      writeCommitTitle(app, taskId, "just some prose, not a Conventional Commits title");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.prTitle).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
        expect.stringContaining("didn't parse as a Conventional Commits title"),
      );
      await app.close();
    });

    it("leaves prTitle null (never blocks the transition) when the project hasn't opted in", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.prTitle).toBeNull();
      await app.close();
    });

    // Fresh-review follow-up: the case `?? task.prTitle` on the write exists
    // for — a later round (e.g. after an auto-return) that doesn't rewrite
    // the title file must keep the EARLIER round's good title, not erase it
    // just because this round's file is absent.
    it("keeps a prior round's title when this round's file is absent", async () => {
      const app = await buildApp();
      const { taskId } = await createConventionalTitleTask(app);
      app.db
        .update(tasks)
        .set({ prTitle: "feat: add credential storage" })
        .where(eq(tasks.id, taskId))
        .run();
      // Deliberately no writeCommitTitle call for this round.
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.prTitle).toBe("feat: add credential storage");
      await app.close();
    });
  });

  // The existing-project half of the release-please auto-enable feature
  // (project-release-please.ts) — new projects get this at create time
  // (routes/projects.ts's POST handler, covered in projects.test.ts); this
  // sweep is what gets it for a project that already existed before this
  // shipped. Runs every reconcileTasks() tick, but is a no-op for every
  // OTHER test in this file: none of them give a project a real
  // `.git/config` github.com remote, so resolveRepoRefResult's "no remote"
  // branch stamps a negative before ever reaching resolveGitHubToken/
  // detectReleasePleaseConfig — confirmed by this file's full suite passing
  // unchanged when this sweep was added.
  describe("release-please auto-enable sweep (project-release-please.ts)", () => {
    async function createProjectWithGithubRemote(
      app: Awaited<ReturnType<typeof buildApp>>,
      owner: string,
      repo: string,
    ): Promise<number> {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reconciler-release-please-"));
      fs.mkdirSync(path.join(cwd, ".git"));
      fs.writeFileSync(
        path.join(cwd, ".git", "config"),
        `[remote "origin"]\n\turl = git@github.com:${owner}/${repo}.git\n`,
      );
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: `p-rp-auto-${Math.random()}`, cwd },
      });
      return created.json().id;
    }

    it("turns conventionalCommitTitles on for an existing project once release-please is detected", async () => {
      const app = await buildApp();
      mockResolveGitHubToken.mockResolvedValue("tok");
      mockDetectReleasePleaseConfig.mockResolvedValue(true);
      const projectId = await createProjectWithGithubRemote(app, "acme", "auto-enable-widgets");

      await reconcileTasks(app);

      const [row] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      expect(row.conventionalCommitTitles).toBe(true);
      expect(row.conventionalCommitTitlesResolvedAt).not.toBeNull();
      await app.close();
    });

    it("does not re-probe a project once it has been resolved", async () => {
      const app = await buildApp();
      mockResolveGitHubToken.mockResolvedValue("tok");
      mockDetectReleasePleaseConfig.mockResolvedValue(false);
      const projectId = await createProjectWithGithubRemote(app, "acme", "auto-enable-resolved");

      await reconcileTasks(app);
      mockDetectReleasePleaseConfig.mockClear();
      await reconcileTasks(app);

      expect(mockDetectReleasePleaseConfig).not.toHaveBeenCalled();
      const [row] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      expect(row.conventionalCommitTitles).toBeNull();
      await app.close();
    });
  });

  // #772 — a reject-and-re-review cycle leaves the PRIOR round's review
  // session attached as `task.reviewSessionId` right up until this same
  // "-> reviewing" transition nulls it. Before this fix, nothing ever
  // terminated that stale session — it was simply orphaned, still "active"
  // in the DB with no task row pointing at it anymore.
  it("kills the prior round's review session when re-entering reviewing (reject-and-re-review)", async () => {
    const app = await buildApp();
    const { taskId, projectId } = await createSessionAndTask(app, "in_progress").then(async (r) => {
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, r.taskId)).all();
      return { ...r, projectId: row.projectId };
    });
    const staleReview = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const staleReviewSessionId = staleReview.json().id as number;
    app.db
      .update(tasks)
      .set({ reviewSessionId: staleReviewSessionId })
      .where(eq(tasks.id, taskId))
      .run();
    vi.spyOn(app.pty, "get").mockImplementation((id) => {
      if (id === String(staleReviewSessionId)) return { toInfo: () => fakeInfo() } as never;
      return { toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }) } as never;
    });

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.reviewSessionId).not.toBe(staleReviewSessionId);
    const { sessions } = await import("../../src/db/schema.js");
    const [staleRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, staleReviewSessionId))
      .all();
    expect(staleRow.status).toBe("killed");

    await app.close();
  });

  it("does not block the '-> reviewing' transition when killing the stale review session fails", async () => {
    const app = await buildApp();
    const { taskId, projectId } = await createSessionAndTask(app, "in_progress").then(async (r) => {
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, r.taskId)).all();
      return { ...r, projectId: row.projectId };
    });
    const staleReview = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const staleReviewSessionId = staleReview.json().id as number;
    app.db
      .update(tasks)
      .set({ reviewSessionId: staleReviewSessionId })
      .where(eq(tasks.id, taskId))
      .run();
    vi.spyOn(app.pty, "get").mockImplementation((id) => {
      if (id === String(staleReviewSessionId)) return { toInfo: () => fakeInfo() } as never;
      return { toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }) } as never;
    });
    const sessionsModule = await import("../../src/services/session-lifecycle.js");
    const killSpy = vi
      .spyOn(sessionsModule, "killSession")
      .mockRejectedValueOnce(new Error("boom"));
    const warnSpy = vi.spyOn(app.log, "warn");

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    // Fire-and-forget — flush microtasks before asserting the warn fired.
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, reviewSessionId: staleReviewSessionId }),
      "task reconcile: failed to kill the superseded review session",
    );

    killSpy.mockRestore();
    await app.close();
  });

  // #2369 — a review by an external reviewer is a run, not a session, so it
  // has no fresh session id to make its ingest marker stop matching: the whole
  // handle has to be cleared, or the next round would read as already reviewed.

  describe("draft PR on entering reviewing (Hermes review, PR #574, finding #2)", () => {
    // The former "claimed -> reviewing edge" sibling of this test was
    // deleted (task-claim queueing, rate-limit-storm fix) — that edge no
    // longer exists (dispatchClaimedTask now flips claimed -> in_progress
    // BEFORE a session ever spawns), so in_progress -> reviewing is the
    // only edge left to exercise this behavior through.
    it("calls openDraftPRForTask on the in_progress -> reviewing edge, and persists its result", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockOpenDraftPRForTask.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/11",
        prNumber: 11,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(mockOpenDraftPRForTask.mock.calls[0][1]).toMatchObject({ id: taskId });
      expect(row.prUrl).toBe("https://github.com/test-owner/test-repo/pull/11");
      expect(row.prNumber).toBe(11);

      await app.close();
    });

    it("never blocks the reviewing transition, and leaves prUrl/prNumber unset, when openDraftPRForTask fails (best-effort posture)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockOpenDraftPRForTask.mockResolvedValue({ ok: false, reason: "dirty-tree" });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(row.prUrl).toBeNull();
      expect(row.prNumber).toBeNull();

      await app.close();
    });
  });

  // RC2/#722's investigation (task 213765) — a "reviewing" task whose ONE
  // draft-PR attempt (above) failed (dirty tree right after the worker's
  // last turn, a transient host/push failure) previously had no way back
  // into promotion: the claimed/in_progress SELECT excludes it
  // processReviewingTasks is joined on the review session, not the worker,
  // so a task with no review agent is invisible to it too. This sweep
  // (retryStrandedDraftPRs) is the fix.
  describe("stranded draft-PR retry sweep", () => {
    async function createReviewingTaskWithNoPR(
      app: Awaited<ReturnType<typeof buildApp>>,
      prNumber: number | null = null,
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: `p-stranded-${Math.random()}`,
          cwd: "/tmp",
        },
      });
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId: project.json().id,
          title: "stranded",
          status: "reviewing",
          claimedAt: new Date(),
          reviewingAt: new Date(),
          prNumber,
        })
        .returning()
        .all();
      return { taskId: row.id };
    }

    it("retries a reviewing task with no PR and persists the result once it succeeds", async () => {
      const app = await buildApp();
      const { taskId } = await createReviewingTaskWithNoPR(app);
      mockOpenDraftPRForTask.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/42",
        prNumber: 42,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(mockOpenDraftPRForTask.mock.calls[0][1]).toMatchObject({ id: taskId });
      expect(row.status).toBe("reviewing");
      expect(row.prUrl).toBe("https://github.com/test-owner/test-repo/pull/42");
      expect(row.prNumber).toBe(42);

      await app.close();
    });

    it("a 403 push (push-forbidden) logs at warn and waits the full ceiling before the next attempt (#2104)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const app = await buildApp();
        await createReviewingTaskWithNoPR(app);
        mockOpenDraftPRForTask.mockReset().mockResolvedValue({
          ok: false,
          reason: "push-forbidden",
          detail: "GitHub refused the push (403)",
        });
        const warnSpy = vi.spyOn(app.log, "warn");

        await reconcileTasks(app);
        expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ detail: "GitHub refused the push (403)" }),
          expect.stringContaining("the GitHub App cannot push"),
        );

        // Well past the first 5-minute step of the ordinary ramp, still inside the ceiling.
        vi.setSystemTime(Date.now() + 30 * 60_000);
        await reconcileTasks(app);
        expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);

        // Re-saving the credential wakes it at once, with no time passing.
        retryPermanentPushFailuresNow();
        await reconcileTasks(app);
        expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(2);

        await app.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not record a draft PR that opened after the task already left 'reviewing' (independent review, PR #725)", async () => {
      const app = await buildApp();
      const { taskId } = await createReviewingTaskWithNoPR(app);
      // Simulates a concurrent give-up landing while openDraftPRForTask's
      // own network call is still in flight — by the time it resolves, the
      // task is no longer "reviewing".
      mockOpenDraftPRForTask.mockImplementation(async () => {
        app.db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, taskId)).run();
        return {
          ok: true,
          prUrl: "https://github.com/test-owner/test-repo/pull/99",
          prNumber: 99,
        };
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.prUrl).toBeNull();
      expect(row.prNumber).toBeNull();

      await app.close();
    });

    it("does not touch a reviewing task that already has a PR", async () => {
      const app = await buildApp();
      await createReviewingTaskWithNoPR(app, 7);

      await reconcileTasks(app);

      expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
      await app.close();
    });

    it("backs off after an attempt instead of retrying on every tick", async () => {
      const app = await buildApp();
      await createReviewingTaskWithNoPR(app);
      mockOpenDraftPRForTask.mockResolvedValue({ ok: false, reason: "dirty-tree" });

      await reconcileTasks(app);
      await reconcileTasks(app);

      // Second tick lands well inside the 5-minute TTL — no second attempt.
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("does not retry while Task Master is disabled", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        await createReviewingTaskWithNoPR(app);

        await reconcileTasks(app);

        expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("#759 — does not attempt a draft PR while the install-wide GitHub rate-limit budget is in effect", async () => {
      const app = await buildApp();
      try {
        await createReviewingTaskWithNoPR(app);
        recordGitHubRateLimit(Date.now() + 60_000);

        await reconcileTasks(app);

        expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
      } finally {
        resetGitHubRateLimitForTests();
        await app.close();
      }
    });

    // #759 — the entry-point check above only catches a limit already in
    // effect when the sweep opens; this proves the SEPARATE per-task
    // re-check (right beside the sweep's own MAX_DRAFT_PR_RETRIES_PER_SWEEP
    // cap) actually stops the loop when the limit lands mid-pass instead.
    it("#759 — stops attempting further draft PRs mid-pass once the rate limit lands, rather than continuing to the next task", async () => {
      const app = await buildApp();
      try {
        await createReviewingTaskWithNoPR(app);
        await createReviewingTaskWithNoPR(app);
        mockOpenDraftPRForTask.mockImplementation(async () => {
          // Simulates the limit being discovered via this exact attempt's
          // own response — recorded here, not before the sweep started.
          recordGitHubRateLimit(Date.now() + 60_000);
          return { ok: false, reason: "dirty-tree" };
        });

        await reconcileTasks(app);

        // Two "reviewing, no PR" rows exist; only the FIRST attempt should
        // ever fire — the per-task re-check must stop the loop before the
        // second row is ever reached, whichever row that attempt landed on.
        expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      } finally {
        resetGitHubRateLimitForTests();
        await app.close();
      }
    });
  });

  describe("approval push (#2252, notifyApprovalsAwaitingHuman)", () => {
    beforeEach(async () => {
      mockNotifyTaskNeedsAttention.mockReset().mockResolvedValue(undefined);
      // The push channel defaults to off; the sweep only records when it is on.
      const setup = await buildApp();
      await setup.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { notifications: { channels: { push: true } } },
      });
      await setup.close();
      // Shared DB: other tests leave reviewing rows with approving verdicts.
      // Wrapped like the outer beforeEach: with -t filtering, nothing may have migrated the DB yet.
      try {
        getDb().delete(tasks).where(eq(tasks.status, "reviewing")).run();
      } catch {
        // no tasks table yet
      }
    });

    const T0 = new Date(1_700_000_000_000);

    async function createCandidate(
      app: Awaited<ReturnType<typeof buildApp>>,
      overrides: Partial<typeof tasks.$inferInsert> = {},
      autoApprove = false,
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: `p-approval-${Math.random()}`,
          cwd: "/tmp",
        },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { autoApprove },
      });
      const session = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const reviewSessionId = session.json().id as number;
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "secret title",
          status: "reviewing",
          claimedAt: new Date(),
          reviewingAt: new Date(),
          prNumber: 9,
          reviewSessionId,
          reviewFindingsIngestedSessionId: reviewSessionId,
          lastReviewVerdict: "approved",
          lastReviewVerdictAt: T0,
          ...overrides,
        })
        .returning()
        .all();
      return row.id;
    }

    it("pushes once per verdict with a generic body, and again after a new verdict", async () => {
      const app = await buildApp();
      const taskId = await createCandidate(app);
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(1);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledWith(
        expect.anything(),
        taskId,
        `Task #${taskId}: approved, needs your approval`,
      );

      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(1);

      app.db
        .update(tasks)
        .set({ lastReviewVerdictAt: new Date(T0.getTime() + 60_000) })
        .where(eq(tasks.id, taskId))
        .run();
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(2);
      await app.close();
    });

    it("does not send when the verdict was already recorded as announced", async () => {
      const app = await buildApp();
      await createCandidate(app, { approvalNotifiedVerdictAt: T0 });
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).not.toHaveBeenCalled();
      await app.close();
    });

    it("is driven by reconcileTasks", async () => {
      const app = await buildApp();
      await createCandidate(app);
      await reconcileTasks(app);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("stays silent for an auto-approving project with a PR", async () => {
      const app = await buildApp();
      await createCandidate(app, {}, true);
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).not.toHaveBeenCalled();
      await app.close();
    });

    it("pushes when autoApprove is set but there is no PR number", async () => {
      const app = await buildApp();
      await createCandidate(app, { prNumber: null }, true);
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("stays silent when the verdict was not ingested for the current review session", async () => {
      const app = await buildApp();
      await createCandidate(app, { reviewFindingsIngestedSessionId: null });
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).not.toHaveBeenCalled();
      await app.close();
    });

    it("stays silent for a non-approving verdict and for a task that is not reviewing", async () => {
      const app = await buildApp();
      await createCandidate(app, { lastReviewVerdict: "changes-requested" });
      await createCandidate(app, { status: "in_progress" });
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).not.toHaveBeenCalled();
      await app.close();
    });

    it("stays silent while Task Master is disabled", async () => {
      const app = await buildApp();
      await createCandidate(app);
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "off" } },
      });
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).not.toHaveBeenCalled();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { enabled: "inherit" } },
      });
      await app.close();
    });

    it("records nothing while the push channel is off, and announces once it is back on", async () => {
      const app = await buildApp();
      const taskId = await createCandidate(app);
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { notifications: { channels: { push: false } } },
      });
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).not.toHaveBeenCalled();
      expect(
        app.db.select().from(tasks).where(eq(tasks.id, taskId)).get()?.approvalNotifiedVerdictAt,
      ).toBeNull();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { notifications: { channels: { push: true } } },
      });
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("does not throw when a send rejects, and the verdict stays recorded", async () => {
      const app = await buildApp();
      const taskId = await createCandidate(app);
      mockNotifyTaskNeedsAttention.mockRejectedValueOnce(new Error("push down"));
      await expect(notifyApprovalsAwaitingHuman(app)).resolves.toBeUndefined();
      const row = app.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      expect(row?.approvalNotifiedVerdictAt?.getTime()).toBe(T0.getTime());
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("sends at most 20 pushes per sweep", async () => {
      const app = await buildApp();
      for (let i = 0; i < 21; i++) await createCandidate(app);
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(20);
      await notifyApprovalsAwaitingHuman(app);
      expect(mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(21);
      await app.close();
    });
  });
});
