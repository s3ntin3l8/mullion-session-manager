import { describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../helpers/app.js";
import {
  closeDeniedRelayStreams,
  dispatch,
  type ConnectionState,
} from "../../src/plugins/control-socket.js";
import { projects, sessions } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

// dispatch() writes only through `conn.send` and `conn.onClose`, so a
// connection with no socket behind it (what a relay builds, #1656) works.
function sinkConn(
  scope: "full" | "session",
  sessionId: string | null,
): { conn: ConnectionState; frames: Record<string, unknown>[] } {
  const frames: Record<string, unknown>[] = [];
  const conn: ConnectionState = {
    send: (message) => void frames.push(message),
    onClose: () => () => {},
    socket: null,
    scope,
    sessionId,
    openChannels: new Map(),
    activeWaits: 0,
  };
  return { conn, frames };
}

describe("dispatch over a socket-less connection (#1656)", () => {
  it("replies through the sink for an unknown op", async () => {
    const app = await buildTestApp();
    await app.ready();
    const { conn, frames } = sinkConn("session", "1");
    await dispatch(app, conn, { id: 7, op: "nope" });
    expect(frames).toEqual([{ id: 7, ok: false, status: 404, error: "unknown op: nope" }]);
  });

  it("rejects an op outside the connection's scope through the sink", async () => {
    const app = await buildTestApp();
    await app.ready();
    const { conn, frames } = sinkConn("session", "1");
    await dispatch(app, conn, { id: 2, op: "projects.list" });
    expect(frames[0]).toMatchObject({ id: 2, ok: false, status: 403 });
  });

  it("refuses streaming ops: they need a local socket", async () => {
    const app = await buildTestApp();
    await app.ready();
    const { conn, frames } = sinkConn("session", "1");
    await dispatch(app, conn, { id: 3, op: "sessions.attach", body: {} });
    await dispatch(app, conn, { id: 4, op: "events.subscribe", body: {} });
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame).toMatchObject({ ok: false, status: 501 });
      expect(String(frame.error)).toContain("not-available-over-relay");
    }
  });

  it("resolves the pinned session's project from the DB, not PtyManager", async () => {
    const app = await buildTestApp();
    await app.ready();
    const projectId = Number(
      app.db.insert(projects).values({ name: "relayed", cwd: "/tmp/relayed" }).run()
        .lastInsertRowid,
    );
    // A row the primary's PtyManager has never heard of — a remote host's session.
    const sessionId = Number(
      app.db.insert(sessions).values({ projectId, command: "bash", cwd: "/tmp/relayed" }).run()
        .lastInsertRowid,
    );
    expect(app.pty.get(String(sessionId))).toBeUndefined();
    const { conn, frames } = sinkConn("session", String(sessionId));
    await dispatch(app, conn, { id: 5, op: "projects.actions" });
    expect(frames[0]).toMatchObject({ id: 5, ok: true });
  });

  it("400s when the pinned session has no row", async () => {
    const app = await buildTestApp();
    await app.ready();
    const { conn, frames } = sinkConn("session", "999999");
    await dispatch(app, conn, { id: 6, op: "projects.actions" });
    expect(frames[0]).toMatchObject({ id: 6, ok: false, status: 400 });
  });

  it("aborts a pending sessions.wait when the connection closes, and unsubscribes", async () => {
    const app = await buildTestApp();
    await app.ready();
    const projectId = Number(
      app.db.insert(projects).values({ name: "waiter", cwd: "/tmp/waiter" }).run().lastInsertRowid,
    );
    const parent = Number(
      app.db.insert(sessions).values({ projectId, command: "bash", cwd: "/tmp/waiter" }).run()
        .lastInsertRowid,
    );
    const child = Number(
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: "/tmp/waiter", parentSessionId: parent })
        .run().lastInsertRowid,
    );
    const { conn, frames } = sinkConn("session", String(parent));
    let fire: (() => void) | undefined;
    let unsubscribed = 0;
    conn.onClose = (listener) => {
      fire = listener;
      return () => void unsubscribed++;
    };
    const pending = dispatch(app, conn, {
      id: 8,
      op: "sessions.wait",
      body: { sessionId: String(child), until: ["working"], timeoutMs: 60_000 },
    });
    await vi.waitFor(() => expect(fire).toBeDefined());
    fire!();
    await pending;
    expect(unsubscribed).toBe(1);
    expect(conn.activeWaits).toBe(0);
    expect(frames).toEqual([]);
  });

  it("400s for a pinned session that is no longer active", async () => {
    const app = await buildTestApp();
    await app.ready();
    const projectId = Number(
      app.db.insert(projects).values({ name: "gone", cwd: "/tmp/gone" }).run().lastInsertRowid,
    );
    const sessionId = Number(
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: "/tmp/gone", status: "exited" })
        .run().lastInsertRowid,
    );
    const { conn, frames } = sinkConn("session", String(sessionId));
    await dispatch(app, conn, { id: 9, op: "projects.actions" });
    expect(frames[0]).toMatchObject({ id: 9, ok: false, status: 400 });
  });

  it("answers 503, not a raw 500, when a request lands as the app is closing", async () => {
    const app = await buildTestApp();
    await app.ready();
    const projectId = Number(
      app.db.insert(projects).values({ name: "closing", cwd: "/tmp/closing" }).run()
        .lastInsertRowid,
    );
    const sessionId = Number(
      app.db.insert(sessions).values({ projectId, command: "bash", cwd: "/tmp/closing" }).run()
        .lastInsertRowid,
    );
    const { conn, frames } = sinkConn("session", String(sessionId));
    // What app.inject() throws once the app has closed.
    vi.spyOn(app, "inject").mockRejectedValue(
      Object.assign(new Error("closed"), { code: "FST_ERR_REOPENED_CLOSE_SERVER" }),
    );
    await dispatch(app, conn, { id: 10, op: "projects.actions" });
    expect(frames[0]).toMatchObject({ id: 10, ok: false, status: 503 });
    expect(String(frames[0].error)).toContain("shutting down");
  });
});

// Issue #2125 — a stream outlives any one request, so a relayed connection
// re-checks its session on a timer and ends the streams of a session that is
// gone or has moved to another host.
describe("closeDeniedRelayStreams (#2125)", () => {
  async function relayed() {
    const app = await buildTestApp();
    await app.ready();
    const projectId = Number(
      app.db.insert(projects).values({ name: "r", cwd: "/tmp/r" }).run().lastInsertRowid,
    );
    const id = Number(
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: "/tmp/r", hostId: "remote-1" })
        .run().lastInsertRowid,
    );
    const { conn, frames } = sinkConn("session", String(id));
    const closed: number[] = [];
    for (const streamId of [10, 11]) {
      conn.openChannels.set(streamId, {
        close: () => void closed.push(streamId),
      } as never);
    }
    return {
      app,
      id,
      conn,
      frames,
      closed,
      binding: { hostId: "remote-1", sessionId: String(id) },
    };
  }

  it("leaves the streams of a live, correctly hosted session alone", async () => {
    const { app, conn, frames, closed, binding } = await relayed();
    expect(closeDeniedRelayStreams(app, binding, conn)).toBe(false);
    expect(frames).toEqual([]);
    expect(closed).toEqual([]);
    expect(conn.openChannels.size).toBe(2);
  });

  it("ends every stream, with the reason, once the session is no longer active", async () => {
    const { app, id, conn, frames, closed, binding } = await relayed();
    app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, id)).run();
    expect(closeDeniedRelayStreams(app, binding, conn)).toBe(true);
    expect(closed.sort()).toEqual([10, 11]);
    expect(frames).toEqual([
      { id: 10, type: "closed", reason: "this session is no longer active" },
      { id: 11, type: "closed", reason: "this session is no longer active" },
    ]);
    expect(conn.openChannels.size).toBe(0);
  });

  it("ends them when the session is hosted by a different host now", async () => {
    const { app, id, conn, closed, binding } = await relayed();
    app.db.update(sessions).set({ hostId: "someone-else" }).where(eq(sessions.id, id)).run();
    expect(closeDeniedRelayStreams(app, binding, conn)).toBe(true);
    expect(closed).toHaveLength(2);
  });

  it("does nothing for a connection with no open stream", async () => {
    const { app, id, conn, binding } = await relayed();
    conn.openChannels.clear();
    app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, id)).run();
    expect(closeDeniedRelayStreams(app, binding, conn)).toBe(false);
  });
});
