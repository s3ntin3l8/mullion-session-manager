// #2804 — the sweep that ends Task Master sessions no task links to (or whose task is
// archived). Its own file: the reconciler's test file is at its file-size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { SessionLiveness } from "../../src/services/session-process.js";

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
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { sweepTaskSessions, TASK_ORPHAN_GRACE_MS } =
  await import("../../src/services/task-orphan-sessions.js");
const { hosts, sessions, tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-orphan-sessions-${process.pid}.db`);
const OLD = new Date(Date.now() - TASK_ORPHAN_GRACE_MS - 60_000);

describe("sweepTaskSessions (#2804)", () => {
  let openApp: Awaited<ReturnType<typeof buildApp>> | undefined;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterEach(async () => {
    await openApp?.close();
    openApp = undefined;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  async function setup() {
    const app = await buildApp();
    openApp = app;
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-orphans", cwd: "/tmp" },
    });
    const projectId = created.json().id as number;
    const terminate = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
    vi.spyOn(app.pty, "isMasterAliveStateBatch").mockImplementation(async (ids: string[]) => {
      const result: Record<string, SessionLiveness> = Object.create(null);
      for (const id of ids) result[id] = "alive";
      return result;
    });
    const addSession = (over: Partial<typeof sessions.$inferInsert> = {}) =>
      app.db
        .insert(sessions)
        .values({
          projectId,
          command: "claude",
          cwd: "/tmp",
          status: "active",
          createdAt: OLD,
          ...over,
        })
        .returning()
        .get();
    const addTask = (over: Partial<typeof tasks.$inferInsert> = {}) =>
      app.db
        .insert(tasks)
        .values({ projectId, title: "t", status: "done", ...over })
        .returning()
        .get();
    const status = (id: number) =>
      app.db.select().from(sessions).where(eq(sessions.id, id)).get()!.status;
    return { app, projectId, terminate, addSession, addTask, status };
  }

  it("ends a task's session that no task links to any more", async () => {
    const { app, terminate, addSession, addTask, status } = await setup();
    const task = addTask();
    const orphan = addSession({ taskId: task.id });

    expect(await sweepTaskSessions(app)).toBe(1);

    expect(terminate).toHaveBeenCalledWith(String(orphan.id));
    expect(status(orphan.id)).toBe("killed");
  });

  it("leaves a session still inside the grace window (a spawn in flight)", async () => {
    const { app, terminate, addSession, addTask, status } = await setup();
    const task = addTask();
    const fresh = addSession({ taskId: task.id, createdAt: new Date() });

    expect(await sweepTaskSessions(app)).toBe(0);

    expect(terminate).not.toHaveBeenCalled();
    expect(status(fresh.id)).toBe("active");
  });

  it("leaves the sessions a live task is linked to", async () => {
    const { app, terminate, addSession, addTask, status } = await setup();
    const task = addTask({ status: "reviewing" });
    const worker = addSession({ taskId: task.id });
    const review = addSession({ taskId: task.id });
    app.db
      .update(tasks)
      .set({ sessionId: worker.id, reviewSessionId: review.id })
      .where(eq(tasks.id, task.id))
      .run();

    expect(await sweepTaskSessions(app)).toBe(0);

    expect(terminate).not.toHaveBeenCalled();
    expect(status(worker.id)).toBe("active");
    expect(status(review.id)).toBe("active");
  });

  it("never touches a human's session in a task worktree (no task_id)", async () => {
    const { app, terminate, addSession, status } = await setup();
    const human = addSession({
      taskId: null,
      cwd: "/tmp/.mullion-worktrees/mullion-task-1-x",
      name: "codex-trust-inline-table",
    });

    expect(await sweepTaskSessions(app)).toBe(0);

    expect(terminate).not.toHaveBeenCalled();
    expect(status(human.id)).toBe("active");
  });

  it("ends the still-linked sessions of an archived task, not those of a live one", async () => {
    const { app, addSession, addTask, status } = await setup();
    const archived = addTask({ archivedAt: new Date(), mergedAt: new Date() });
    const aWorker = addSession({ taskId: archived.id, createdAt: new Date() });
    const aReview = addSession({ taskId: archived.id, createdAt: new Date() });
    app.db
      .update(tasks)
      .set({ sessionId: aWorker.id, reviewSessionId: aReview.id })
      .where(eq(tasks.id, archived.id))
      .run();
    const live = addTask({ status: "reviewing" });
    const lWorker = addSession({ taskId: live.id });
    app.db.update(tasks).set({ sessionId: lWorker.id }).where(eq(tasks.id, live.id)).run();

    expect(await sweepTaskSessions(app)).toBe(2);

    expect(status(aWorker.id)).toBe("killed");
    expect(status(aReview.id)).toBe("killed");
    expect(status(lWorker.id)).toBe("active");
  });

  it("skips a session on an unreachable host instead of marking it killed", async () => {
    const { app, terminate, addSession, addTask, status } = await setup();
    app.db
      .insert(hosts)
      .values({ id: "remote-orphans", name: "remote-orphans", baseUrl: "http://127.0.0.1:1" })
      .run();
    const task = addTask();
    const remote = addSession({ taskId: task.id, hostId: "remote-orphans" });

    expect(await sweepTaskSessions(app)).toBe(0);

    expect(terminate).not.toHaveBeenCalled();
    expect(status(remote.id)).toBe("active");
  });

  it("drops an overlapping call and never throws", async () => {
    const { app, addSession, addTask } = await setup();
    const task = addTask();
    addSession({ taskId: task.id });

    const [a, b] = await Promise.all([sweepTaskSessions(app), sweepTaskSessions(app)]);

    expect(a + b).toBe(1);
    // A closed DB makes the sweep fail internally; it must report, not throw.
    await app.close();
    openApp = undefined;
    await expect(sweepTaskSessions(app)).resolves.toBe(0);
  });
});
