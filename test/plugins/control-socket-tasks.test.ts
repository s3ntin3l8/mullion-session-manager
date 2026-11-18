import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers/app.js";
import { makeConnectionState } from "../helpers/control-socket.js";
import { dispatch } from "../../src/plugins/control-socket.js";
import { projects, tasks } from "../../src/db/schema.js";
import { insertTask } from "../../src/services/task-store.js";
import { eq } from "drizzle-orm";

const mockSyncTaskTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/task-github-sync.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    syncTaskTransition: (...args: unknown[]) => mockSyncTaskTransition(...args),
  };
});

describe("tasks.list and tasks.get control-socket ops (#3165)", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function createProject(name: string): number {
    return Number(
      app!.db
        .insert(projects)
        .values({ name, cwd: `/tmp/${name}` })
        .run().lastInsertRowid,
    );
  }

  it("tasks.list full scope: lists tasks and filters by status and projectId", async () => {
    app = await buildTestApp();
    await app.ready();
    const projectA = createProject("proj-a");
    const projectB = createProject("proj-b");
    const t1 = insertTask(app, {
      projectId: projectA,
      issueNumber: 101,
      title: "Ready A",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/101",
      status: "ready",
    })!;
    insertTask(app, {
      projectId: projectA,
      issueNumber: 102,
      title: "Done A",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/102",
      status: "done",
    });
    insertTask(app, {
      projectId: projectB,
      issueNumber: 103,
      title: "Ready B",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/103",
      status: "ready",
    });

    const { conn, frames } = makeConnectionState("full");
    await dispatch(app, conn, { id: 1, op: "tasks.list" });
    expect(frames[0].ok).toBe(true);
    expect((frames[0].result as Array<{ id: number }>).length).toBe(3);

    await dispatch(app, conn, {
      id: 2,
      op: "tasks.list",
      body: { status: "ready", projectId: String(projectA) },
    });
    expect(frames[1].ok).toBe(true);
    const filtered = frames[1].result as Array<{ id: number; status: string; title: string }>;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ id: t1.id, status: "ready", title: "Ready A" });
  });

  it("tasks.list session scope: a caller whose session is not active gets 403", async () => {
    app = await buildTestApp();
    await app.ready();
    const { conn, frames } = makeConnectionState("session", "1");
    await dispatch(app, conn, { id: 1, op: "tasks.list" });
    expect(frames[0]).toMatchObject({ id: 1, ok: false, status: 403 });
  });

  it("tasks.get full scope: returns task by id, 404s on unknown id, 400s on missing id", async () => {
    app = await buildTestApp();
    await app.ready();
    const projectId = createProject("proj-get");
    const task = insertTask(app, {
      projectId,
      issueNumber: 201,
      title: "Single task",
      body: "details",
      htmlUrl: "https://github.com/o/r/issues/201",
      status: "ready",
    })!;

    const { conn, frames } = makeConnectionState("full");
    await dispatch(app, conn, { id: 1, op: "tasks.get", body: { taskId: task.id } });
    expect(frames[0].ok).toBe(true);
    expect(frames[0].result).toMatchObject({
      id: task.id,
      status: "ready",
      title: "Single task",
    });

    await dispatch(app, conn, { id: 2, op: "tasks.get", body: { taskId: 999999 } });
    expect(frames[1]).toMatchObject({ id: 2, ok: false, status: 404 });

    await dispatch(app, conn, { id: 3, op: "tasks.get", body: {} });
    expect(frames[2]).toMatchObject({ id: 3, ok: false, status: 400 });
  });

  it("tasks.get session scope: rejects out-of-scope caller with 403", async () => {
    app = await buildTestApp();
    await app.ready();
    const { conn, frames } = makeConnectionState("session", "1");
    await dispatch(app, conn, { id: 1, op: "tasks.get", body: { taskId: "1" } });
    expect(frames[0]).toMatchObject({ id: 1, ok: false, status: 403 });
  });
});

describe("tasks.retry/start/close/archive/unarchive control-socket ops (#3173)", () => {
  let app: FastifyInstance | null = null;
  const origTaskMaster = process.env.MULLION_TASK_MASTER_ENABLED;

  afterEach(async () => {
    mockSyncTaskTransition.mockClear();
    if (origTaskMaster === undefined) delete process.env.MULLION_TASK_MASTER_ENABLED;
    else process.env.MULLION_TASK_MASTER_ENABLED = origTaskMaster;
    await app?.close();
    app = null;
  });

  function createProject(name: string): number {
    return Number(
      app!.db
        .insert(projects)
        .values({ name, cwd: `/tmp/${name}` })
        .run().lastInsertRowid,
    );
  }

  it("tasks.retry moves a branchless failed task to ready and clears failureReason", async () => {
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    app = await buildTestApp();
    await app.ready();
    const projectId = createProject("proj-retry-ready");
    const task = insertTask(app, {
      projectId,
      issueNumber: 301,
      title: "Branchless failed",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/301",
      status: "failed",
    })!;
    app.db
      .update(tasks)
      .set({ failureReason: "budget exceeded after 120 minutes", completedAt: new Date() })
      .where(eq(tasks.id, task.id))
      .run();

    const { conn, frames } = makeConnectionState("full");
    await dispatch(app, conn, { id: 1, op: "tasks.retry", body: { taskId: task.id } });
    expect(frames[0]).toMatchObject({
      id: 1,
      ok: true,
      status: 202,
      result: {
        id: task.id,
        status: "ready",
        failureReason: null,
      },
    });
  });

  it("tasks.retry moves a failed task with branchName to claimed and syncs the GitHub label", async () => {
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    app = await buildTestApp();
    await app.ready();
    const projectId = createProject("proj-retry-sync");
    const task = insertTask(app, {
      projectId,
      issueNumber: 302,
      title: "Branched failed",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/302",
      status: "failed",
    })!;
    app.db
      .update(tasks)
      .set({ branchName: "mullion/task-302-fix", failureReason: "budget exceeded" })
      .where(eq(tasks.id, task.id))
      .run();

    const { conn, frames } = makeConnectionState("full");
    await dispatch(app, conn, { id: 1, op: "tasks.retry", body: { taskId: task.id } });
    expect(frames[0]).toMatchObject({
      id: 1,
      ok: true,
      status: 202,
      result: { id: task.id, status: "claimed" },
    });
    expect(mockSyncTaskTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: task.id }),
      expect.objectContaining({ id: projectId }),
      "claimed",
    );
  });

  it("tasks.retry refuses a non-failed transition with 409 and carries the route message", async () => {
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    app = await buildTestApp();
    await app.ready();
    const projectId = createProject("proj-retry-refuse");
    const task = insertTask(app, {
      projectId,
      issueNumber: 303,
      title: "Not failed",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/303",
      status: "ready",
    })!;

    const { conn, frames } = makeConnectionState("full");
    await dispatch(app, conn, { id: 1, op: "tasks.retry", body: { taskId: task.id } });
    expect(frames[0]).toMatchObject({
      id: 1,
      ok: false,
      status: 409,
      error: expect.stringContaining("not failed"),
    });
  });

  it("tasks.start claims a ready task and refuses a non-ready task", async () => {
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    app = await buildTestApp();
    await app.ready();
    const projectId = createProject("proj-start");
    const readyTask = insertTask(app, {
      projectId,
      issueNumber: 304,
      title: "Ready",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/304",
      status: "ready",
    })!;
    const doneTask = insertTask(app, {
      projectId,
      issueNumber: 305,
      title: "Done",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/305",
      status: "done",
    })!;

    const { conn, frames } = makeConnectionState("full");
    await dispatch(app, conn, { id: 1, op: "tasks.start", body: { taskId: readyTask.id } });
    expect(frames[0]).toMatchObject({
      id: 1,
      ok: true,
      status: 202,
      result: { id: readyTask.id, status: "claimed" },
    });

    await dispatch(app, conn, { id: 2, op: "tasks.start", body: { taskId: doneTask.id } });
    expect(frames[1]).toMatchObject({
      id: 2,
      ok: false,
      status: 409,
    });
  });

  it("tasks.close gives up on a reviewing task and refuses a non-reviewing task", async () => {
    app = await buildTestApp();
    await app.ready();
    const projectId = createProject("proj-close");
    const reviewingTask = insertTask(app, {
      projectId,
      issueNumber: 306,
      title: "Reviewing",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/306",
      status: "reviewing",
    })!;
    const readyTask = insertTask(app, {
      projectId,
      issueNumber: 307,
      title: "Ready",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/307",
      status: "ready",
    })!;

    const { conn, frames } = makeConnectionState("full");
    await dispatch(app, conn, {
      id: 1,
      op: "tasks.close",
      body: { taskId: reviewingTask.id, reason: "superseded" },
    });
    expect(frames[0]).toMatchObject({
      id: 1,
      ok: true,
      status: 200,
      result: { id: reviewingTask.id, status: "failed", failureReason: "superseded" },
    });

    await dispatch(app, conn, { id: 2, op: "tasks.close", body: { taskId: readyTask.id } });
    expect(frames[1]).toMatchObject({
      id: 2,
      ok: false,
      status: 409,
      error: expect.stringContaining("Cannot give up"),
    });
  });

  it("tasks.archive and tasks.unarchive work on finished tasks and refuse active ones", async () => {
    app = await buildTestApp();
    await app.ready();
    const projectId = createProject("proj-archive");
    const doneTask = insertTask(app, {
      projectId,
      issueNumber: 308,
      title: "Done",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/308",
      status: "done",
    })!;
    const activeTask = insertTask(app, {
      projectId,
      issueNumber: 309,
      title: "Active",
      body: "",
      htmlUrl: "https://github.com/o/r/issues/309",
      status: "in_progress",
    })!;

    const { conn, frames } = makeConnectionState("full");
    await dispatch(app, conn, { id: 1, op: "tasks.archive", body: { taskId: doneTask.id } });
    expect(frames[0]).toMatchObject({
      id: 1,
      ok: true,
      status: 200,
      result: { id: doneTask.id, status: "done" },
    });
    expect((frames[0].result as { archivedAt: unknown }).archivedAt).not.toBeNull();

    await dispatch(app, conn, { id: 2, op: "tasks.unarchive", body: { taskId: doneTask.id } });
    expect(frames[1]).toMatchObject({
      id: 2,
      ok: true,
      status: 200,
      result: { id: doneTask.id, status: "done", archivedAt: null },
    });

    await dispatch(app, conn, { id: 3, op: "tasks.archive", body: { taskId: activeTask.id } });
    expect(frames[2]).toMatchObject({
      id: 3,
      ok: false,
      status: 409,
      error: expect.stringContaining("Cannot archive"),
    });
  });

  it("rejects out-of-scope session callers with 403 for all mutating task ops", async () => {
    app = await buildTestApp();
    await app.ready();
    const ops = ["tasks.retry", "tasks.start", "tasks.close", "tasks.archive", "tasks.unarchive"];
    for (let i = 0; i < ops.length; i++) {
      const { conn, frames } = makeConnectionState("session", "1");
      await dispatch(app, conn, { id: i + 1, op: ops[i], body: { taskId: "1" } });
      expect(frames[0]).toMatchObject({ id: i + 1, ok: false, status: 403 });
    }
  });
});
