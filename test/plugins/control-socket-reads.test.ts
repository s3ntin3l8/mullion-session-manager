import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../helpers/app.js";
import { dispatch, OPS, type ConnectionState } from "../../src/plugins/control-socket.js";
import { projects, sessions } from "../../src/db/schema.js";
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

describe("session-scope reads of sessions and tasks", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function project(name: string, extra: Partial<typeof projects.$inferInsert> = {}): number {
    return Number(
      app!.db
        .insert(projects)
        .values({ name, cwd: `/tmp/${name}`, ...extra })
        .run().lastInsertRowid,
    );
  }
  function session(projectId: number): number {
    return Number(
      app!.db
        .insert(sessions)
        .values({ projectId, command: "claude --token=SECRET", env: '{"K":"SECRET"}' })
        .run().lastInsertRowid,
    );
  }
  function task(projectId: number, n: number): number {
    return insertTask(app!, {
      projectId,
      issueNumber: n,
      title: `T${n}`,
      body: "",
      htmlUrl: `https://github.com/o/r/issues/${n}`,
      status: "ready",
      agentCommand: "agent --key=SECRET",
    })!.id;
  }

  async function call(caller: number | null, op: string, body?: Record<string, unknown>) {
    const { conn, frames } = makeConn(
      caller === null ? "full" : "session",
      caller === null ? null : String(caller),
    );
    await dispatch(app!, conn, { id: 1, op, body });
    return frames[0];
  }

  async function world() {
    app = await buildTestApp();
    await app.ready();
    const own = project("own");
    const open = project("open");
    const closed = project("closed", { acceptsChildrenFrom: "none" });
    floor = own;
    const w = {
      own,
      open,
      closed,
      sOwn: session(own),
      sOpen: session(open),
      sClosed: session(closed),
      tOwn: task(own, 1),
      tOpen: task(open, 2),
      tClosed: task(closed, 3),
    };
    return w;
  }

  // The DB is shared across this file's tests, so only the current world's
  // projects (ids from `floor` up) are compared.
  let floor = 0;
  const projectIdsOf = (frame: Record<string, unknown>) =>
    [...new Set((frame.result as Array<{ projectId: number }>).map((r) => r.projectId))]
      .filter((id) => id >= floor)
      .sort((a, b) => a - b);

  it("a non-coordinator sees only its own project", async () => {
    const w = await world();
    expect(projectIdsOf(await call(w.sOwn, "sessions.list"))).toEqual([w.own]);
    expect(projectIdsOf(await call(w.sOwn, "tasks.list"))).toEqual([w.own]);
    expect((await call(w.sOwn, "tasks.get", { taskId: w.tOwn })).ok).toBe(true);
    expect(await call(w.sOwn, "tasks.get", { taskId: w.tOpen })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("a coordinator with no reach list sees every project that accepts it", async () => {
    const w = await world();
    app!.db
      .update(projects)
      .set({ allowCrossProjectSpawn: true })
      .where(eq(projects.id, w.own))
      .run();
    expect(projectIdsOf(await call(w.sOwn, "sessions.list"))).toEqual([w.own, w.open]);
    expect(projectIdsOf(await call(w.sOwn, "tasks.list"))).toEqual([w.own, w.open]);
    expect((await call(w.sOwn, "tasks.get", { taskId: w.tOpen })).ok).toBe(true);
  });

  it("a refusing target is omitted and its task answers like a missing id", async () => {
    const w = await world();
    app!.db
      .update(projects)
      .set({ allowCrossProjectSpawn: true })
      .where(eq(projects.id, w.own))
      .run();
    const refused = await call(w.sOwn, "tasks.get", { taskId: w.tClosed });
    const missing = await call(w.sOwn, "tasks.get", { taskId: 99999 });
    expect(refused).toMatchObject({ ok: false, status: 404 });
    expect(refused.error).toBe(missing.error);
    expect(refused.status).toBe(missing.status);
    expect(projectIdsOf(await call(w.sOwn, "tasks.list"))).not.toContain(w.closed);
    // Filtering on the refusing project is the same as filtering on a missing one.
    expect((await call(w.sOwn, "tasks.list", { projectId: String(w.closed) })).result).toEqual([]);
  });

  it("a coordinator limited by crossProjectTargets sees only the listed ones", async () => {
    const w = await world();
    const other = project("other");
    session(other);
    task(other, 9);
    app!.db
      .update(projects)
      .set({ allowCrossProjectSpawn: true, crossProjectTargets: JSON.stringify([other]) })
      .where(eq(projects.id, w.own))
      .run();
    expect(projectIdsOf(await call(w.sOwn, "sessions.list"))).toEqual([w.own, other]);
    expect(projectIdsOf(await call(w.sOwn, "tasks.list"))).toEqual([w.own, other]);
  });

  it("session-scope replies carry none of the secret fields", async () => {
    const w = await world();
    app!.db
      .update(projects)
      .set({ allowCrossProjectSpawn: true })
      .where(eq(projects.id, w.own))
      .run();
    for (const frame of [
      await call(w.sOwn, "sessions.list"),
      await call(w.sOwn, "tasks.list"),
      await call(w.sOwn, "tasks.get", { taskId: w.tOpen }),
    ]) {
      expect(JSON.stringify(frame.result)).not.toContain("SECRET");
    }
    // Full scope is unchanged.
    expect(JSON.stringify((await call(null, "sessions.list")).result)).toContain("SECRET");
  });

  it("an inactive caller session is refused", async () => {
    const w = await world();
    app!.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, w.sOwn)).run();
    expect(await call(w.sOwn, "sessions.list")).toMatchObject({ ok: false, status: 403 });
  });

  it("every write op stays refused at session scope, coordinator included", async () => {
    const w = await world();
    app!.db
      .update(projects)
      .set({ allowCrossProjectSpawn: true })
      .where(eq(projects.id, w.own))
      .run();
    const writes = [
      "tasks.retry",
      "tasks.start",
      "tasks.close",
      "tasks.archive",
      "tasks.unarchive",
      "sessions.create",
      "previews.create",
      "previews.list",
      "projects.list",
    ].filter((op) => Object.hasOwn(OPS, op));
    expect(writes.length).toBeGreaterThanOrEqual(6);
    for (const op of writes) {
      expect(await call(w.sOwn, op, { taskId: w.tOpen }), op).toMatchObject({
        ok: false,
        status: 403,
      });
    }
  });

  it("kill and dock writes never reach another project from a coordinator", async () => {
    const w = await world();
    app!.db
      .update(projects)
      .set({ allowCrossProjectSpawn: true })
      .where(eq(projects.id, w.own))
      .run();
    for (const [op, body] of [
      ["sessions.kill", { sessionId: String(w.sOpen) }],
      ["docks.start", { projectId: w.open, dockControlId: "x" }],
      ["docks.stop", { projectId: w.open, dockControlId: "x" }],
    ] as const) {
      const r = await call(w.sOwn, op, body);
      expect(r, op).toMatchObject({ ok: false, status: 403 });
    }
  });
});
