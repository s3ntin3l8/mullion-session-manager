import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers/app.js";
import { dispatch, type ConnectionState } from "../../src/plugins/control-socket.js";
import { projects } from "../../src/db/schema.js";
import { insertTask } from "../../src/services/task-store.js";

function makeConn(scope: "full" | "session", sessionId: string | null = null) {
  const frames: Array<Record<string, unknown>> = [];
  const conn: ConnectionState = {
    send: (m) => frames.push(m),
    onClose: () => () => {},
    socket: null,
    scope,
    sessionId,
    openChannels: new Map(),
    activeWaits: 0,
  };
  return { conn, frames };
}

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

    const { conn, frames } = makeConn("full");
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

  it("tasks.list session scope: rejects out-of-scope caller with 403", async () => {
    app = await buildTestApp();
    await app.ready();
    const { conn, frames } = makeConn("session", "1");
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

    const { conn, frames } = makeConn("full");
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
    const { conn, frames } = makeConn("session", "1");
    await dispatch(app, conn, { id: 1, op: "tasks.get", body: { taskId: "1" } });
    expect(frames[0]).toMatchObject({ id: 1, ok: false, status: 403 });
  });
});
