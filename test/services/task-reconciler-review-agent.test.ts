import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { seedHostResponse } from "../helpers/hosts.js";
import {
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
  inertBackendMembers,
  fakeInfo,
  createSessionAndTask,
  getTask,
  createSessionAndTaskWithReviewAgent,
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

const { spawn: childProcessSpawn } = await import("node:child_process");
const { buildApp } = await import("../../src/app.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

describe("reconcileTasks — review agent", () => {
  setupReconcilerTestLifecycle("task-reconciler-review-agent");
  describe("review agent (this phase's binding design)", () => {
    it("spawns the configured review agent when a task enters reviewing, recording reviewSessionId", async () => {
      const app = await buildApp();
      // "in_progress", not "claimed" — task-claim queueing (rate-limit-storm
      // fix) removed the claimed -> reviewing edge; see this describe
      // block's own "in_progress -> reviewing" test below for why that
      // used to be tested via BOTH edges and is now only reachable via one.
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "in_progress",
        "codex",
      );
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.reviewSessionId).not.toBe(workerSessionId);

      await app.close();
    });

    // #9 — named and locked at spawn time, same reasoning/pattern as the
    // worker spawns (task-claim.ts's own tests).
    it("names and locks the review session (#9)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      const { sessions } = await import("../../src/db/schema.js");
      const [session] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, row.reviewSessionId!))
        .all();
      expect(session).toMatchObject({ name: `Task #${taskId} · review`, nameLocked: true });

      await app.close();
    });

    it("spawns the review agent even when its adapter can't receive a seed (#487), recording reviewSeedDelivered: false and logging a warning", async () => {
      const app = await buildApp();
      // gemini, not opencode — opencode gained `initialPromptArgs`
      // (`--prompt`) and is seed-capable now, see hook-adapters/opencode.ts.
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "in_progress",
        "gemini",
      );
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.reviewSessionId).not.toBe(workerSessionId);
      // Spawned anyway (advisory, unlike the worker claim's outright
      // refusal) — but the row now records the seed miss instead of it
      // being visible only in server logs.
      expect(row.reviewSeedDelivered).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
        expect.stringContaining("can't receive an initial prompt"),
      );
      // gemini has no adapter at all, so no initial-prompt argv form — the
      // spawned command is untouched, not carrying the review prompt
      // anywhere.
      const call = vi
        .mocked(childProcessSpawn)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe("gemini");

      await app.close();
    });

    it("records reviewSeedDelivered: true for a seed-capable review agent, delivering the review prompt as argv (not stashSeed — additionalContext never starts a turn)", async () => {
      const app = await buildApp();
      // "in_progress", not "claimed" — task-claim queueing (rate-limit-storm
      // fix) removed the claimed -> reviewing edge; in_progress -> reviewing
      // is the only path left to exercise this.
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const stashSeedSpy = vi.spyOn(app.pty, "stashSeed");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.reviewSeedDelivered).toBe(true);
      expect(stashSeedSpy).not.toHaveBeenCalled();

      const call = vi
        .mocked(childProcessSpawn)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      // shellQuote escapes the apostrophe in "task's" as close-escape-reopen.
      // Asserted in pieces rather than as one contiguous string: the review
      // prompt is now built by task-prompt.ts's buildReviewPrompt, which
      // interposes the worker's-worktree hazard between the advisory
      // framing and the task spec. The exact wording lives in
      // test/services/task-prompt.test.ts; what matters here is that the
      // whole thing reaches the spawned command line as argv.
      const spawnedArg = args[args.length - 1];
      expect(spawnedArg).toContain(
        "'Review this task'\\''s diff. You are not expected to make changes.",
      );
      expect(spawnedArg).toContain("Task: reviewed task\n\nsome spec'");

      await app.close();
    });

    // Independent post-Hermes review, PR #538 — the review agent's spawn
    // shares the exact version-skew risk claimTask/retryTask already cover
    // (test/services/task-claim.test.ts): a remote agent build too old to
    // know about `initialPrompt` silently strips it, so `reviewSeedDelivered`
    // must not be trusted as `true` just because the resolved agent's
    // adapter supports it locally.
    it("does not trust reviewSeedDelivered:true for a remote host that never confirms the review prompt was applied (version skew)", async () => {
      const app = await buildApp();
      const warnSpy = vi.spyOn(app.log, "warn");

      const host = await seedHostResponse(app, {
        name: "Remote",
        baseUrl: "http://127.0.0.1:1",
        token: "t",
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, name: "p-review-skew", cwd: "/remote/project", hostId },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultReviewAgent: "codex" },
      });
      // Real (FK-valid) rows, inserted directly rather than through
      // POST /api/sessions/claim — no spawn happens during this setup, so
      // resolveBackend can be mocked afterward with no ordering hazard.
      const { sessions } = await import("../../src/db/schema.js");
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          // "in_progress", not "claimed" — task-claim queueing (rate-limit-
          // storm fix) removed the claimed -> reviewing edge.
          projectId,
          title: "reviewed task",
          body: "some spec",
          status: "in_progress",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          startedAt: new Date(),
          worktreePath: "/remote/project",
        })
        .returning()
        .all();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        ...inertBackendMembers(),
        spawn: vi.fn().mockResolvedValue({}),
        // Keyed by the real worker session id — task-reconciler.ts treats
        // an omitted key as "unknown, skip" (defaultDeriveStatusInfo never
        // runs), same posture as an untracked local session; `fakeInfo`'s
        // shape matches what app.pty.get(id).toInfo() returns elsewhere in
        // this file this is liveStatus's own remote-host equivalent.
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        liveness: vi.fn().mockResolvedValue({}),
        compareWorktreePaths: vi.fn().mockResolvedValue([]),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        getRenderedScrollback: vi.fn().mockResolvedValue(""),
        getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        acknowledgeAttention: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 }),
        waitOutput: vi.fn().mockResolvedValue({ notRunning: true }),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("reviewing");
      // codex is seed-capable — a naive reviewSeedDelivered:seedCapable
      // would have reported true here despite the remote host never
      // confirming it applied the prompt.
      expect(row.reviewSeedDelivered).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, hostId, seedCapable: true }),
        expect.stringContaining("possible version skew"),
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    // #778 — the review agent's seed prompt must be told to write to the
    // OWNING host's own sessionsDir, not the primary's. Extends the
    // version-skew test's fakeBackend/remote-host setup above with a
    // distinct `resolveSessionsDir` return value and asserts the spawned
    // findings path is built from THAT value.
    it("embeds the remote host's own sessionsDir in the review agent's findings path (#778)", async () => {
      const app = await buildApp();

      const host = await seedHostResponse(app, {
        name: "Remote",
        baseUrl: "http://127.0.0.1:1",
        token: "t",
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "p-review-remote-dir",
          cwd: "/remote/project",
          hostId,
        },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultReviewAgent: "codex" },
      });
      const { sessions } = await import("../../src/db/schema.js");
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "reviewed task",
          body: "some spec",
          status: "in_progress",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          startedAt: new Date(),
          worktreePath: "/remote/project",
        })
        .returning()
        .all();

      let capturedInitialPrompt: string | undefined;
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        ...inertBackendMembers(),
        spawn: vi.fn().mockImplementation((opts: { initialPrompt?: string }) => {
          capturedInitialPrompt = opts.initialPrompt;
          return Promise.resolve({});
        }),
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        liveness: vi.fn().mockResolvedValue({}),
        compareWorktreePaths: vi.fn().mockResolvedValue([]),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        getRenderedScrollback: vi.fn().mockResolvedValue(""),
        getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        acknowledgeAttention: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 }),
        waitOutput: vi.fn().mockResolvedValue({ notRunning: true }),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
        readTaskReviewFindings: vi.fn().mockResolvedValue(null),
        deleteTaskReviewFindings: vi.fn().mockResolvedValue(undefined),
        resolveSessionsDir: vi.fn().mockResolvedValue("/remote/own/sessions-dir"),
        readTaskCommitTitle: vi.fn().mockResolvedValue(null),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      await reconcileTasks(app);

      // The initial prompt is only real argv when the review command is
      // seed-capable (codex is) — spawn() itself is what's mocked here, not
      // createSessionRecord's own initialPrompt-vs-stashSeed branching, so
      // this reaches the same prompt-building path buildReviewPrompt uses.
      expect(capturedInitialPrompt).toBeDefined();
      expect(capturedInitialPrompt).toContain(
        `/remote/own/sessions-dir/task-${task.id}.review.0.md`,
      );
      // The wrong (primary-local) path must never appear.
      expect(capturedInitialPrompt).not.toContain(path.dirname(app.pty.hookSocketPath));
      expect(fakeBackend.resolveSessionsDir).toHaveBeenCalled();

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    // #778 — a resolveSessionsDir failure (host unreachable, version skew)
    // must degrade to the primary's local path with a warn, not strand the
    // review spawn.
    it("falls back to the primary's local sessionsDir when resolving the remote host's own fails (#778)", async () => {
      const app = await buildApp();
      const warnSpy = vi.spyOn(app.log, "warn");

      const host = await seedHostResponse(app, {
        name: "Remote",
        baseUrl: "http://127.0.0.1:1",
        token: "t",
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "p-review-remote-fallback",
          cwd: "/remote/project",
          hostId,
        },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultReviewAgent: "codex" },
      });
      const { sessions } = await import("../../src/db/schema.js");
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "reviewed task",
          body: "some spec",
          status: "in_progress",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          startedAt: new Date(),
          worktreePath: "/remote/project",
        })
        .returning()
        .all();

      let capturedInitialPrompt: string | undefined;
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        ...inertBackendMembers(),
        spawn: vi.fn().mockImplementation((opts: { initialPrompt?: string }) => {
          capturedInitialPrompt = opts.initialPrompt;
          return Promise.resolve({});
        }),
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        liveness: vi.fn().mockResolvedValue({}),
        compareWorktreePaths: vi.fn().mockResolvedValue([]),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        getRenderedScrollback: vi.fn().mockResolvedValue(""),
        getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        acknowledgeAttention: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 }),
        waitOutput: vi.fn().mockResolvedValue({ notRunning: true }),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
        readTaskReviewFindings: vi.fn().mockResolvedValue(null),
        deleteTaskReviewFindings: vi.fn().mockResolvedValue(undefined),
        resolveSessionsDir: vi.fn().mockRejectedValue(new Error("host unreachable")),
        readTaskCommitTitle: vi.fn().mockResolvedValue(null),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      await reconcileTasks(app);

      const localSessionsDir = path.dirname(app.pty.hookSocketPath);
      expect(capturedInitialPrompt).toBeDefined();
      expect(capturedInitialPrompt).toContain(`${localSessionsDir}/task-${task.id}.review.0.md`);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, hostId }),
        expect.stringContaining("failed to resolve the owning host's own sessionsDir"),
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("does not spawn a review agent when none is configured", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();

      await app.close();
    });

    it("logs and swallows a review agent spawn failure without affecting the reviewing transition", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const sessionsModule = await import("../../src/services/session-lifecycle.js");
      vi.spyOn(sessionsModule, "createSessionRecord").mockResolvedValueOnce({
        ok: false,
        reason: "spawn-failed",
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();

      await app.close();
    });

    it("does not transition a finished task into reviewing (or spawn a review agent) while Task Master is disabled — avoids stranding it past approve/reject's own gate (Hermes review, PR #480, second pass)", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);
        const sessionsModule = await import("../../src/services/session-lifecycle.js");
        const createSessionSpy = vi.spyOn(sessionsModule, "createSessionRecord");

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        // Left in "in_progress" rather than advanced to "reviewing" —
        // approve and reject are both gated on "enabled" too, so a
        // reviewing task would otherwise be unresolvable until Task Master
        // is turned back on. Still reachable by the (ungated) budget
        // force-fail below.
        expect(row.status).toBe("in_progress");
        expect(row.reviewSessionId).toBeNull();
        expect(createSessionSpy).not.toHaveBeenCalled();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("transitions the held-back task into reviewing (and spawns its review agent) once Task Master is re-enabled", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "codex");
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);

        await reconcileTasks(app);
        expect((await getTask(app, taskId)).status).toBe("in_progress");

        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "on" } },
        });
        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).not.toBeNull();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("spawns the review agent on the in_progress -> reviewing path too", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "agy");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });
  });

  // Hermes review, PR #574 (finding #2) — maybeOpenDraftPR's wiring was
  // previously exercised only via the real openDraftPRForTask silently
  // no-op'ing on "no-token" in this test DB, which never proved the
  // reconciler actually calls it (with the right task/project) or persists
  // its result. task-promote.ts is mocked above specifically for these.
});
