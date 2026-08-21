import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

// task-promote.ts's real implementation needs a pushed branch and a working
// GitHub connection — mocked here so these tests exercise approveTask's own
// promote -> CAS -> transition sequence against a controllable promotion
// outcome, not a real git push + GitHub API round trip. Same mocking
// posture as test/routes/tasks.test.ts's own approve/reject block.
const mockPromoteTaskToPR = vi.fn();
vi.mock("../../src/services/task-promote.js", () => ({
  promoteTaskToPR: mockPromoteTaskToPR,
}));

// #772 — approveTask now kills the task's own sessions via killSession,
// which spawns real OS processes (systemd-run, dtach) via PtyManager unless
// faked. Same fakes as task-reconciler.test.ts / task-claim.test.ts.
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
const { tasks, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { approveTask } = await import("../../src/services/task-approve.js");

const tmpDb = path.join(os.tmpdir(), `task-approve-test-${process.pid}.db`);

describe("approveTask", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    mockPromoteTaskToPR.mockReset().mockResolvedValue({
      ok: true,
      prUrl: "https://github.com/o/r/pull/1",
      prNumber: 1,
    });
  });

  async function createProjectAndReviewingTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    mergeOnApprove = false,
    withSessions = false,
  ) {
    const projRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: `p-approve-${Math.random()}`, cwd: "/tmp" },
    });
    const projectId = projRes.json().id;
    if (mergeOnApprove) {
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { mergeOnApprove: true },
      });
    }
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    let sessionId: number | null = null;
    let reviewSessionId: number | null = null;
    if (withSessions) {
      const worker = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      sessionId = worker.json().id as number;
      const reviewer = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      reviewSessionId = reviewer.json().id as number;
    }
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, title: "under review", status: "reviewing", sessionId, reviewSessionId })
      .returning()
      .all();
    return { task, project };
  }

  it("promotes, flips the task to done, and records the transition with the given `via`", async () => {
    const app = await buildApp();
    const { task, project } = await createProjectAndReviewingTask(app);

    const outcome = await approveTask(app, task, project, "auto-approve");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.task.status).toBe("done");
    expect(outcome.task.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(outcome.task.prNumber).toBe(1);
    expect(outcome.task.completedAt).not.toBeNull();

    const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    // No dedicated GET-by-id transition-history endpoint here — the row's
    // own final state is what matters for a pure-function unit test; the
    // `via` value's routing is exercised end-to-end by
    // test/routes/tasks.test.ts's own approve tests.
    expect(check.json().status).toBe("done");

    await app.close();
  });

  it("does not set mergeRequestedAt when the project's mergeOnApprove is off", async () => {
    const app = await buildApp();
    const { task, project } = await createProjectAndReviewingTask(app, false);

    const outcome = await approveTask(app, task, project, "approve");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.task.mergeRequestedAt).toBeNull();

    await app.close();
  });

  it("sets mergeRequestedAt when the project's mergeOnApprove is on", async () => {
    const app = await buildApp();
    const { task, project } = await createProjectAndReviewingTask(app, true);

    const outcome = await approveTask(app, task, project, "approve");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.task.mergeRequestedAt).not.toBeNull();

    await app.close();
  });

  it("passes a promotion failure straight through as its own reason", async () => {
    const app = await buildApp();
    const { task, project } = await createProjectAndReviewingTask(app);
    mockPromoteTaskToPR.mockResolvedValue({
      ok: false,
      reason: "dirty-tree",
      detail: "Worktree has uncommitted changes",
    });

    const outcome = await approveTask(app, task, project, "approve");

    expect(outcome).toEqual({
      ok: false,
      reason: "dirty-tree",
      detail: "Worktree has uncommitted changes",
    });

    const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(check.json().status).toBe("reviewing");

    await app.close();
  });

  it("returns cas-lost (not a thrown error) when the task left 'reviewing' before the CAS write could land", async () => {
    const app = await buildApp();
    const { task, project } = await createProjectAndReviewingTask(app);
    // Simulates a concurrent reject landing while promoteTaskToPR's own
    // network call is still in flight.
    mockPromoteTaskToPR.mockImplementation(async () => {
      app.db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, task.id)).run();
      return { ok: true, prUrl: "https://github.com/o/r/pull/2", prNumber: 2 };
    });

    const outcome = await approveTask(app, task, project, "approve");

    expect(outcome).toEqual({
      ok: false,
      reason: "cas-lost",
      prUrl: "https://github.com/o/r/pull/2",
      prNumber: 2,
    });

    const check = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(check.json().status).toBe("in_progress");
    expect(check.json().prUrl).toBeNull();

    await app.close();
  });

  // #772 — nothing terminated a task's worker/review sessions once it left
  // "reviewing" for good; both lingered indefinitely as live processes with
  // no task attached. approveTask now kills both.
  it("kills both the worker and review sessions on approve", async () => {
    const app = await buildApp();
    const { task, project } = await createProjectAndReviewingTask(app, false, true);
    expect(task.sessionId).not.toBeNull();
    expect(task.reviewSessionId).not.toBeNull();

    const outcome = await approveTask(app, task, project, "approve");
    expect(outcome.ok).toBe(true);

    const { sessions } = await import("../../src/db/schema.js");
    const [workerRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, task.sessionId!))
      .all();
    const [reviewRow] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, task.reviewSessionId!))
      .all();
    expect(workerRow.status).toBe("killed");
    expect(reviewRow.status).toBe("killed");

    await app.close();
  });

  it("logs a warning (without throwing) when killSession itself throws", async () => {
    const app = await buildApp();
    const { task, project } = await createProjectAndReviewingTask(app, false, true);
    const sessionLifecycleModule = await import("../../src/services/session-lifecycle.js");
    const killSpy = vi
      .spyOn(sessionLifecycleModule, "killSession")
      .mockRejectedValue(new Error("boom"));
    const warnSpy = vi.spyOn(app.log, "warn");

    const outcome = await approveTask(app, task, project, "approve");
    expect(outcome.ok).toBe(true);

    // cleanupTaskSessions is fire-and-forget — flush microtasks so its
    // rejected promise's .catch() handler has actually run before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "task cleanup: killSession threw",
    );

    killSpy.mockRestore();
    await app.close();
  });

  it("approve is a no-op on session cleanup when neither session id is set", async () => {
    const app = await buildApp();
    const { task, project } = await createProjectAndReviewingTask(app, false, false);
    expect(task.sessionId).toBeNull();
    expect(task.reviewSessionId).toBeNull();

    // Would throw if cleanupTaskSessions dereferenced a null id instead of
    // skipping it.
    const outcome = await approveTask(app, task, project, "approve");
    expect(outcome.ok).toBe(true);

    await app.close();
  });
});
