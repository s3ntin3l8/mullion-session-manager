import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { spawn as childProcessSpawn } from "node:child_process";

// Same fakes as session-reconciler.test.ts / test/routes/sessions.test.ts —
// session creation still spawns real OS processes (systemd-run, dtach) via
// PtyManager, faked so this file exercises reconcileTasks against a real
// app + DB without needing a real systemd --user session in CI.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

// Hermes review, PR #574 (finding #2) — maybeOpenDraftPR's wiring into both
// "-> reviewing" transitions was previously untested: every existing
// reviewing-transition test here ran the REAL openDraftPRForTask, which
// silently no-ops on "no-token"/"remote-not-supported" in this file's test
// DB and never proved the reconciler actually calls it or persists its
// result. Mocked (importOriginal-preserved) so those existing tests keep
// their prior no-op behavior, while new tests below assert the call
// directly.
const mockOpenDraftPRForTask = vi.fn();
vi.mock("../../src/services/task-promote.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    openDraftPRForTask: mockOpenDraftPRForTask,
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-test-${process.pid}.db`);

// A minimal, fully-idle SessionInfo — every field defaultDeriveStatusInfo
// would otherwise default, but supplied explicitly so each test only
// overrides the one or two fields it cares about (activity /
// lastTurnEndedAt / outstandingBackgroundTasks), matching the exact
// precedence deriveSessionStatus documents (session-status.ts).
function fakeInfo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    activity: "idle",
    attention: false,
    attentionKind: null,
    permissionState: "idle",
    planState: "idle",
    gateState: "idle",
    promoteState: "idle",
    elicitationState: "idle",
    questionState: "idle",
    errorState: "idle",
    errorDetail: null,
    endedReason: null,
    exitCode: null,
    compactState: "idle",
    subagentCount: 0,
    lastTurnEndedAt: null,
    outstandingBackgroundTasks: [],
    ...overrides,
  };
}

describe("reconcileTasks", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    // Reconciler tests exercise already-claimed tasks (inserted directly,
    // bypassing POST .../claim) — Task Master enabled by default here so
    // the review-agent-spawn tests exercise their happy path; the one test
    // that specifically covers Hermes review PR #480's gate overrides this
    // back off via settings.taskMaster.enabled.
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_BUDGET_MINUTES;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  beforeEach(() => {
    // Matches the real openDraftPRForTask's actual no-op outcome in this
    // file's test DB (no GitHub token configured) — existing
    // reviewing-transition tests below rely on the draft-PR attempt being a
    // harmless no-op, same as before this was mocked.
    mockOpenDraftPRForTask.mockReset().mockResolvedValue({ ok: false, reason: "no-token" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createSessionAndTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    status: "claimed" | "in_progress",
    claimedAt: Date = new Date(),
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/tmp" },
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const sessionId = session.json().id as number;
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "t",
        status,
        sessionId,
        claimedAt,
        startedAt: status === "in_progress" ? claimedAt : null,
      })
      .returning()
      .all();
    return { taskId: row.id, sessionId };
  }

  async function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  async function createSessionAndTaskWithReviewAgent(
    app: Awaited<ReturnType<typeof buildApp>>,
    status: "claimed" | "in_progress",
    reviewAgent: string,
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p-review", cwd: "/tmp" },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.json().id}`,
      payload: { defaultReviewAgent: reviewAgent },
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const sessionId = session.json().id as number;
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "reviewed task",
        body: "some spec",
        status,
        sessionId,
        claimedAt: new Date(),
        startedAt: status === "in_progress" ? new Date() : null,
        // maybeSpawnReviewAgent early-returns without a worktreePath — a
        // real claim always sets one; faked here since this test inserts
        // the task row directly rather than going through POST .../claim.
        worktreePath: "/tmp",
      })
      .returning()
      .all();
    return { taskId: row.id, sessionId };
  }

  it("is a no-op when there are no claimed/in_progress tasks", async () => {
    const app = await buildApp();
    const getSpy = vi.spyOn(app.pty, "get");
    await expect(reconcileTasks(app)).resolves.toBeUndefined();
    expect(getSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("flips claimed -> in_progress once the session shows any non-idle signal", async () => {
    const app = await buildApp();
    const { taskId, sessionId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ activity: "working" }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.startedAt).not.toBeNull();
    void sessionId;
    await app.close();
  });

  it("leaves claimed alone while the session is still idle (no signal yet)", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo(),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("claimed");
    expect(row.startedAt).toBeNull();
    await app.close();
  });

  it("flips claimed straight to reviewing when the first observed signal is already finished (task-state.ts's claimed -> reviewing edge)", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.startedAt).not.toBeNull();
    expect(row.reviewingAt).not.toBeNull();
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

  it("does not advance an untracked session (app.pty has no live handle for it) past idle defaults", async () => {
    // LocalBackend.liveStatus always sets a key for every requested id —
    // `app.pty.get(id)?.toInfo(...) ?? null` — so an untracked session
    // reads as `null`, not an omitted key; `defaultDeriveStatusInfo(null)`
    // then supplies its own idle defaults, which is what this test
    // actually exercises. (A genuinely *omitted* key is a remote-host-only
    // possibility — reconcileTasks's own `info === undefined` guard exists
    // for that case, mirroring session-reconciler.ts's `alive === undefined`
    // rule, but isn't reachable through a local-only test setup like this
    // one.)
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("claimed");
    await app.close();
  });

  describe("review agent (this phase's binding design)", () => {
    it("spawns the configured review agent when a task enters reviewing, recording reviewSessionId", async () => {
      const app = await buildApp();
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "claimed",
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

    it("spawns the review agent even when its adapter can't receive a seed (#487), recording reviewSeedDelivered: false and logging a warning", async () => {
      const app = await buildApp();
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "claimed",
        "opencode",
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
      // opencode has no initial-prompt argv form — the spawned command is
      // untouched, not carrying the review prompt anywhere.
      const call = vi
        .mocked(childProcessSpawn)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe("opencode");

      await app.close();
    });

    it("records reviewSeedDelivered: true for a seed-capable review agent, delivering the review prompt as argv (not stashSeed — additionalContext never starts a turn)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "claimed", "codex");
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

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-review-skew", cwd: "/remote/project", hostId },
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
          projectId,
          title: "reviewed task",
          body: "some spec",
          status: "claimed",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          worktreePath: "/remote/project",
        })
        .returning()
        .all();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        spawn: vi.fn().mockResolvedValue({}),
        // Keyed by the real worker session id — task-reconciler.ts treats
        // an omitted key as "unknown, skip" (defaultDeriveStatusInfo never
        // runs), same posture as an untracked local session; `fakeInfo`'s
        // shape matches what app.pty.get(id).toInfo() returns elsewhere in
        // this file, and this is liveStatus's own remote-host equivalent.
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        isMasterAlive: vi.fn().mockResolvedValue({}),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
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

    it("does not spawn a review agent when none is configured", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "claimed");
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
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "claimed", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const sessionsModule = await import("../../src/routes/sessions.js");
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
        const { taskId } = await createSessionAndTaskWithReviewAgent(app, "claimed", "codex");
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);
        const sessionsModule = await import("../../src/routes/sessions.js");
        const createSessionSpy = vi.spyOn(sessionsModule, "createSessionRecord");

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        // Left in "claimed" rather than advanced to "reviewing" — approve
        // and reject are both gated on "enabled" too, so a reviewing task
        // would otherwise be unresolvable until Task Master is turned back
        // on. Still reachable by the (ungated) budget force-fail below.
        expect(row.status).toBe("claimed");
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
        const { taskId } = await createSessionAndTaskWithReviewAgent(app, "claimed", "codex");
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);

        await reconcileTasks(app);
        expect((await getTask(app, taskId)).status).toBe("claimed");

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
  describe("draft PR on entering reviewing (Hermes review, PR #574, finding #2)", () => {
    it("calls openDraftPRForTask on the claimed -> reviewing edge and persists prUrl/prNumber on success", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "claimed");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockOpenDraftPRForTask.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/9",
        prNumber: 9,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(mockOpenDraftPRForTask.mock.calls[0][1]).toMatchObject({ id: taskId });
      expect(row.prUrl).toBe("https://github.com/test-owner/test-repo/pull/9");
      expect(row.prNumber).toBe(9);

      await app.close();
    });

    it("calls openDraftPRForTask on the in_progress -> reviewing edge too, and persists its result", async () => {
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
      expect(row.prUrl).toBe("https://github.com/test-owner/test-repo/pull/11");
      expect(row.prNumber).toBe(11);

      await app.close();
    });

    it("never blocks the reviewing transition, and leaves prUrl/prNumber unset, when openDraftPRForTask fails (best-effort posture)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "claimed");
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
});
