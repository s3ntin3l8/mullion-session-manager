import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTestApp } from "../helpers/app.js";
import { dispatch, type ConnectionState } from "../../src/plugins/control-socket.js";
import { projects, sessions } from "../../src/db/schema.js";

// #3050 — a session reads/edits its OWN project's .crs/dock.json through
// projects.get_dock_config / projects.set_dock_config.
function sinkConn(scope: "full" | "session", sessionId: string | null) {
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

describe("projects.get_dock_config / set_dock_config (#3050)", () => {
  let cwdA: string;
  let cwdB: string;
  const file = (cwd: string) => path.join(cwd, ".crs", "dock.json");
  const read = (cwd: string) => JSON.parse(fs.readFileSync(file(cwd), "utf8")).controls;

  beforeEach(() => {
    cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "dcfg-a-"));
    cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "dcfg-b-"));
    for (const cwd of [cwdA, cwdB]) {
      fs.mkdirSync(path.join(cwd, ".crs"));
      fs.writeFileSync(
        file(cwd),
        JSON.stringify({ controls: [{ id: "dev", title: "Dev", command: "make dev" }] }),
      );
    }
  });
  afterEach(() => {
    fs.rmSync(cwdA, { recursive: true, force: true });
    fs.rmSync(cwdB, { recursive: true, force: true });
  });

  async function setup() {
    const app = await buildTestApp();
    await app.ready();
    const mk = (name: string, cwd: string) =>
      Number(app.db.insert(projects).values({ name, cwd }).run().lastInsertRowid);
    const projectA = mk("a", cwdA);
    const projectB = mk("b", cwdB);
    const agent = String(
      Number(
        app.db.insert(sessions).values({ projectId: projectA, command: "claude", cwd: cwdA }).run()
          .lastInsertRowid,
      ),
    );
    return { app, projectA, projectB, ...sinkConn("session", agent) };
  }

  it("reads the caller's own project's config", async () => {
    const { app, conn, frames } = await setup();
    await dispatch(app, conn, { id: 1, op: "projects.get_dock_config", body: {} });
    expect(frames[0]).toMatchObject({ ok: true, status: 200 });
    expect((frames[0].result as { controls: { id: string }[] }).controls[0].id).toBe("dev");
  });

  it("upsert adds a control and replaces one with the same id, keeping the others", async () => {
    const { app, conn, frames } = await setup();
    const set = (id: number, body: Record<string, unknown>) =>
      dispatch(app, conn, { id, op: "projects.set_dock_config", body });
    await set(1, { upsert: { id: "logs", title: "Logs", command: "tail -f log" } });
    await set(2, { upsert: { id: "dev", title: "Dev server", command: "make dev" } });
    expect(frames.map((f) => f.status)).toEqual([200, 200]);
    expect(read(cwdA).map((c: { id: string; title: string }) => [c.id, c.title])).toEqual([
      ["dev", "Dev server"],
      ["logs", "Logs"],
    ]);
    // Another project's file is untouched.
    expect(read(cwdB)).toHaveLength(1);
  });

  it("remove drops one control; an unknown id is a 404", async () => {
    const { app, conn, frames } = await setup();
    await dispatch(app, conn, { id: 1, op: "projects.set_dock_config", body: { remove: "nope" } });
    await dispatch(app, conn, { id: 2, op: "projects.set_dock_config", body: { remove: "dev" } });
    expect(frames.map((f) => f.status)).toEqual([404, 200]);
    expect(read(cwdA)).toEqual([]);
  });

  it("controls replaces the whole list", async () => {
    const { app, conn, frames } = await setup();
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_dock_config",
      body: { controls: [{ id: "a", title: "A", command: "a" }] },
    });
    expect(frames[0]).toMatchObject({ ok: true });
    expect(read(cwdA).map((c: { id: string }) => c.id)).toEqual(["a"]);
  });

  it("validates like the Settings editor and writes nothing on failure", async () => {
    const { app, conn, frames } = await setup();
    const set = (id: number, body: Record<string, unknown>) =>
      dispatch(app, conn, { id, op: "projects.set_dock_config", body });
    await set(1, { upsert: { id: "x", title: "X", command: "x", bogus: 1 } });
    await set(2, {
      upsert: { id: "y", title: "Y", command: "y", env: { MULLION_AUTH_TOKEN: "z" } },
    });
    await set(3, { upsert: { title: "no id" } });
    await set(4, {});
    await set(5, { upsert: { id: "a", title: "A", command: "a" }, remove: "dev" });
    expect(frames.map((f) => f.status)).toEqual([400, 400, 400, 400, 400]);
    expect(read(cwdA)).toHaveLength(1);
  });

  it("refuses to upsert into an unparseable dock.json instead of clobbering it", async () => {
    const { app, conn, frames } = await setup();
    fs.writeFileSync(file(cwdA), "{ not json");
    await dispatch(app, conn, {
      id: 1,
      op: "projects.set_dock_config",
      body: { upsert: { id: "a", title: "A", command: "a" } },
    });
    expect(frames[0]).toMatchObject({ ok: false, status: 409 });
    expect(fs.readFileSync(file(cwdA), "utf8")).toBe("{ not json");
  });

  it("refuses another project at session scope", async () => {
    const { app, conn, frames, projectB } = await setup();
    for (const op of ["projects.get_dock_config", "projects.set_dock_config"]) {
      await dispatch(app, conn, {
        id: 1,
        op,
        body: { projectId: String(projectB), remove: "dev" },
      });
    }
    expect(frames.map((f) => f.status)).toEqual([403, 403]);
    expect(read(cwdB)).toHaveLength(1);
  });

  it("full scope names the project", async () => {
    const { app, projectB } = await setup();
    const { conn, frames } = sinkConn("full", null);
    await dispatch(app, conn, { id: 1, op: "projects.get_dock_config", body: {} });
    await dispatch(app, conn, {
      id: 2,
      op: "projects.set_dock_config",
      body: { projectId: String(projectB), remove: "dev" },
    });
    expect(frames.map((f) => f.status)).toEqual([400, 200]);
    expect(read(cwdB)).toEqual([]);
  });

  it("full scope sessionId picks the session's host, accepts a number or a string, and is never silently dropped", async () => {
    const { app, projectA } = await setup();
    const other = Number(
      app.db.insert(sessions).values({ projectId: projectA, command: "bash", cwd: cwdA }).run()
        .lastInsertRowid,
    );
    const { conn, frames } = sinkConn("full", null);
    const body = (extra: Record<string, unknown>) => ({ projectId: String(projectA), ...extra });
    const run = (id: number, op: string, extra: Record<string, unknown>) =>
      dispatch(app, conn, { id, op, body: body(extra) });
    await run(1, "projects.get_dock_config", { sessionId: other }); // numeric
    await run(2, "projects.get_dock_config", { sessionId: String(other) });
    await run(3, "projects.set_dock_config", { sessionId: other, remove: "dev" });
    expect(frames.map((f) => f.status)).toEqual([200, 200, 200]);
    expect(read(cwdA)).toEqual([]); // it is the project's file on that host
    // Present but unusable, or naming no session: refused, never a fallback to the default.
    await run(4, "projects.get_dock_config", { sessionId: {} });
    await run(5, "projects.get_dock_config", { sessionId: "" });
    await run(6, "projects.set_dock_config", { sessionId: [], upsert: { id: "x", command: "x" } });
    await run(7, "projects.get_dock_config", { sessionId: 987654 });
    expect(frames.slice(3).map((f) => f.status)).toEqual([400, 400, 400, 400]);
    expect(read(cwdA)).toEqual([]);
  });
});
