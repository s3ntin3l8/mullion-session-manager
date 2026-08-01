import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

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
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_BUDGET_MINUTES;
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
});
