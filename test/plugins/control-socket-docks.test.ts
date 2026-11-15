import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers/app.js";
import { dispatch, type ConnectionState } from "../../src/plugins/control-socket.js";
import { projects, sessions } from "../../src/db/schema.js";

// #2494 — a session may list/start/stop the dock controls of its OWN project
// through `docks.*`, and nothing else about docks.
interface LaunchParams extends Record<string, unknown> {
  projectId: number;
  command: string;
  name?: string;
  dockControlId?: string;
}
const launch = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], live: "idle" }));
vi.mock("../../src/services/session-live-info.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withLiveStatus: vi.fn(async (_app: unknown, row: object) => ({
      ...row,
      sessionStatus: launch.live,
    })),
  };
});
vi.mock("../../src/services/session-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Records what the launch asked for and inserts a row, with no real spawn.
    createSessionRecord: vi.fn(async (app: FastifyInstance, params: LaunchParams) => {
      launch.calls.push(params);
      const { sessions: sessionsTable } = await import("../../src/db/schema.js");
      const row = app.db
        .insert(sessionsTable)
        .values({
          projectId: params.projectId,
          command: params.command,
          kind: "dock",
          name: params.name ?? null,
          dockControlId: params.dockControlId,
        })
        .returning()
        .get();
      const project = app.db.select().from(projects).where(eq(projects.id, params.projectId)).get();
      return { ok: true, row, project };
    }),
    killSession: vi.fn(async (app: FastifyInstance, id: number) => {
      const { sessions: sessionsTable } = await import("../../src/db/schema.js");
      return (
        app.db
          .update(sessionsTable)
          .set({ status: "killed" })
          .where(eq(sessionsTable.id, id))
          .returning()
          .get() ?? null
      );
    }),
  };
});

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

describe("docks.* ops (#2494)", () => {
  let cwdA: string;
  let cwdB: string;
  beforeEach(() => {
    launch.calls.length = 0;
    launch.live = "idle";
    const controls = {
      controls: [
        { id: "dev-server", title: "Dev server", command: "make dev", cwd: "web", env: { A: "1" } },
        { id: "logs", title: "Logs", command: "tail -f log" },
      ],
    };
    cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "docks-a-"));
    cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "docks-b-"));
    for (const cwd of [cwdA, cwdB]) {
      fs.mkdirSync(path.join(cwd, ".crs"));
      fs.writeFileSync(path.join(cwd, ".crs", "dock.json"), JSON.stringify(controls));
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
    const agentSession = String(
      Number(
        app.db.insert(sessions).values({ projectId: projectA, command: "claude", cwd: cwdA }).run()
          .lastInsertRowid,
      ),
    );
    return { app, projectA, projectB, agentSession };
  }

  it("lists the caller's own project's controls, nothing running", async () => {
    const { app, agentSession } = await setup();
    const { conn, frames } = sinkConn("session", agentSession);
    await dispatch(app, conn, { id: 1, op: "docks.list", body: {} });
    expect(frames[0]).toMatchObject({ ok: true, status: 200 });
    const result = frames[0].result as { id: string; running: unknown }[];
    expect(result.map((c) => [c.id, c.running])).toEqual([
      ["dev-server", null],
      ["logs", null],
    ]);
  });

  it("starts a control with its cwd/env, tags the session, and refuses a second start", async () => {
    const { app, projectA, agentSession } = await setup();
    const { conn, frames } = sinkConn("session", agentSession);
    await dispatch(app, conn, {
      id: 1,
      op: "docks.start",
      body: { dockControlId: "dev-server" },
    });
    expect(frames[0]).toMatchObject({ ok: true, status: 201 });
    expect(launch.calls[0]).toMatchObject({
      projectId: projectA,
      command: "make dev",
      kind: "dock",
      dockControlId: "dev-server",
      name: "Dev server",
      cwd: "web",
      env: { A: "1" },
    });
    const sessionId = (frames[0].result as { sessionId: number }).sessionId;
    // Running now: listed with the session, and a second start conflicts.
    await dispatch(app, conn, { id: 2, op: "docks.list", body: {} });
    const listed = frames[1].result as { id: string; running: { sessionId: number } | null }[];
    expect(listed.find((c) => c.id === "dev-server")?.running?.sessionId).toBe(sessionId);
    await dispatch(app, conn, { id: 3, op: "docks.start", body: { dockControlId: "dev-server" } });
    expect(frames[2]).toMatchObject({ ok: false, status: 409 });
    expect(launch.calls).toHaveLength(1);
  });

  it("restarts a control whose row is active but whose process already died", async () => {
    const { app, agentSession } = await setup();
    const { conn, frames } = sinkConn("session", agentSession);
    await dispatch(app, conn, { id: 1, op: "docks.start", body: { dockControlId: "logs" } });
    const stale = (frames[0].result as { sessionId: number }).sessionId;
    launch.live = "exited";
    await dispatch(app, conn, { id: 2, op: "docks.start", body: { dockControlId: "logs" } });
    expect(frames[1]).toMatchObject({ ok: true, status: 201 });
    expect((frames[1].result as { sessionId: number }).sessionId).not.toBe(stale);
    expect(app.db.select().from(sessions).where(eq(sessions.id, stale)).get()?.status).toBe(
      "killed",
    );
  });

  it("start with a branch runs the control in a branch worktree", async () => {
    const { app, agentSession } = await setup();
    const { conn } = sinkConn("session", agentSession);
    await dispatch(app, conn, {
      id: 1,
      op: "docks.start",
      body: { dockControlId: "dev-server", branch: "feat/x" },
    });
    expect(launch.calls[0]).toMatchObject({ worktree: { branch: "feat/x" } });
    expect(launch.calls[0]).not.toHaveProperty("cwd");
  });

  it("stops a running control, and stopping a stopped one is a no-op", async () => {
    const { app, agentSession } = await setup();
    const { conn, frames } = sinkConn("session", agentSession);
    await dispatch(app, conn, { id: 1, op: "docks.start", body: { dockControlId: "logs" } });
    const sessionId = (frames[0].result as { sessionId: number }).sessionId;
    await dispatch(app, conn, { id: 2, op: "docks.stop", body: { dockControlId: "logs" } });
    expect(frames[1]).toMatchObject({ ok: true, result: { sessionId } });
    expect(app.db.select().from(sessions).where(eq(sessions.id, sessionId)).get()?.status).toBe(
      "killed",
    );
    await dispatch(app, conn, { id: 3, op: "docks.stop", body: { dockControlId: "logs" } });
    expect(frames[2]).toMatchObject({ ok: true, result: { sessionId: null } });
  });

  it("refuses another project at session scope, without launching", async () => {
    const { app, projectB, agentSession } = await setup();
    const { conn, frames } = sinkConn("session", agentSession);
    for (const op of ["docks.list", "docks.start", "docks.stop"]) {
      await dispatch(app, conn, {
        id: 1,
        op,
        body: { projectId: String(projectB), dockControlId: "dev-server" },
      });
    }
    expect(frames.map((f) => f.status)).toEqual([403, 403, 403]);
    expect(launch.calls).toHaveLength(0);
  });

  it("an unknown control is a 404, and the docker-sourced path stays out", async () => {
    const { app, agentSession } = await setup();
    const { conn, frames } = sinkConn("session", agentSession);
    await dispatch(app, conn, { id: 1, op: "docks.start", body: { dockControlId: "nope" } });
    await dispatch(app, conn, { id: 2, op: "docks.stop", body: { dockControlId: "nope" } });
    await dispatch(app, conn, { id: 3, op: "docks.start", body: {} });
    expect(frames.map((f) => f.status)).toEqual([404, 404, 400]);
    expect(launch.calls).toHaveLength(0);
  });

  it("session scope still cannot create a dock session or list/kill dock sessions", async () => {
    const { app, projectA, agentSession } = await setup();
    const { conn, frames } = sinkConn("session", agentSession);
    await dispatch(app, conn, {
      id: 1,
      op: "sessions.create",
      body: { projectId: String(projectA), command: "make dev", kind: "dock" },
    });
    await dispatch(app, conn, {
      id: 2,
      op: "projects.dock",
      body: { projectId: String(projectA) },
    });
    expect(frames.map((f) => f.status)).toEqual([403, 403]);
  });

  it("full scope names the project explicitly", async () => {
    const { app, projectB } = await setup();
    const { conn, frames } = sinkConn("full", null);
    await dispatch(app, conn, { id: 1, op: "docks.list", body: {} });
    await dispatch(app, conn, { id: 2, op: "docks.list", body: { projectId: String(projectB) } });
    expect(frames.map((f) => f.status)).toEqual([400, 200]);
  });

  it("POST /api/sessions accepts dockControlId only for kind: dock", async () => {
    const { app, projectA } = await setup();
    const bad = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: projectA, command: "make dev", dockControlId: "dev-server" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: projectA, command: "make dev", kind: "dock", dockControlId: "dev" },
    });
    expect(ok.statusCode).toBe(201);
    expect(launch.calls.at(-1)).toMatchObject({ dockControlId: "dev" });
  });

  describe("logs, wait and switch (#3049)", () => {
    async function running(controlId = "dev-server") {
      const ctx = await setup();
      const { conn, frames } = sinkConn("session", ctx.agentSession);
      await dispatch(ctx.app, conn, {
        id: 1,
        op: "docks.start",
        body: { dockControlId: controlId },
      });
      const sessionId = (frames[0].result as { sessionId: number }).sessionId;
      frames.length = 0;
      return { ...ctx, conn, frames, sessionId };
    }

    it("docks.logs reads the running control's screen; not running is a 404", async () => {
      const { app, conn, frames } = await running();
      await dispatch(app, conn, { id: 2, op: "docks.logs", body: { dockControlId: "logs" } });
      await dispatch(app, conn, { id: 3, op: "docks.logs", body: {} });
      expect(frames.map((f) => f.status)).toEqual([404, 400]);
      // The running one resolves to its session's scrollback (empty: no live PTY here).
      await dispatch(app, conn, { id: 4, op: "docks.logs", body: { dockControlId: "dev-server" } });
      expect(frames[2]).toMatchObject({ ok: true, status: 200, result: { text: "" } });
    });

    it("docks.logs and docks.wait_for_output refuse another project and a stopped control", async () => {
      const { app, conn, frames, projectB } = await running();
      for (const op of ["docks.logs", "docks.wait_for_output"]) {
        await dispatch(app, conn, {
          id: 5,
          op,
          body: { projectId: String(projectB), dockControlId: "dev-server", match: "x" },
        });
      }
      await dispatch(app, conn, {
        id: 6,
        op: "docks.wait_for_output",
        body: { dockControlId: "logs", match: "x" },
      });
      expect(frames.map((f) => f.status)).toEqual([403, 403, 404]);
    });

    it("docks.wait_for_output validates like sessions.wait_for_output", async () => {
      const { app, conn, frames } = await running();
      await dispatch(app, conn, {
        id: 7,
        op: "docks.wait_for_output",
        body: { dockControlId: "dev-server" },
      });
      expect(frames[0]).toMatchObject({ ok: false, status: 400 });
    });

    it("docks.switch restarts the control on a branch", async () => {
      const { app, conn, frames, sessionId } = await running();
      await dispatch(app, conn, {
        id: 8,
        op: "docks.switch",
        body: { dockControlId: "dev-server", branch: "feat/x" },
      });
      expect(frames[0]).toMatchObject({ ok: true, status: 201 });
      expect(launch.calls.at(-1)).toMatchObject({ worktree: { branch: "feat/x" } });
      expect(app.db.select().from(sessions).where(eq(sessions.id, sessionId)).get()?.status).toBe(
        "killed",
      );
    });

    it("docks.switch refuses a bad target before stopping anything", async () => {
      const { app, conn, frames, sessionId } = await running();
      const bodies = [
        { dockControlId: "dev-server" },
        { dockControlId: "dev-server", branch: "a", worktreePath: cwdA },
        { dockControlId: "dev-server", worktreePath: os.tmpdir() },
      ];
      for (const body of bodies) await dispatch(app, conn, { id: 9, op: "docks.switch", body });
      expect(frames.map((f) => f.status)).toEqual([400, 400, 400]);
      expect(app.db.select().from(sessions).where(eq(sessions.id, sessionId)).get()?.status).toBe(
        "active",
      );
    });

    it("docks.switch on a stopped control starts it on the target", async () => {
      const { app, conn, frames } = await running("logs");
      await dispatch(app, conn, { id: 11, op: "docks.stop", body: { dockControlId: "logs" } });
      launch.calls.length = 0;
      await dispatch(app, conn, {
        id: 12,
        op: "docks.switch",
        body: { dockControlId: "logs", branch: "feat/z" },
      });
      expect(frames[1]).toMatchObject({ ok: true, status: 201 });
      expect(launch.calls).toHaveLength(1);
      expect(launch.calls[0]).toMatchObject({ worktree: { branch: "feat/z" } });
    });

    it("docks.switch launches the resolved path it validated, not the raw input", async () => {
      const { app, conn, frames } = await running();
      await dispatch(app, conn, {
        id: 13,
        op: "docks.switch",
        body: { dockControlId: "dev-server", worktreePath: `${cwdA}/web/../web` },
      });
      expect(frames[0]).toMatchObject({ ok: true, status: 201 });
      expect(launch.calls.at(-1)).toMatchObject({ cwd: path.join(fs.realpathSync(cwdA), "web") });
    });

    it("docks.switch anchors a relative worktreePath at the project checkout", async () => {
      const { app, conn, frames } = await running();
      await dispatch(app, conn, {
        id: 14,
        op: "docks.switch",
        body: { dockControlId: "dev-server", worktreePath: "web" },
      });
      expect(frames[0]).toMatchObject({ ok: true, status: 201 });
      expect(launch.calls.at(-1)).toMatchObject({ cwd: path.join(fs.realpathSync(cwdA), "web") });
    });

    it("docks.start accepts a worktreePath and refuses one outside the project", async () => {
      const { app, agentSession } = await setup();
      const { conn, frames } = sinkConn("session", agentSession);
      await dispatch(app, conn, {
        id: 15,
        op: "docks.start",
        body: { dockControlId: "logs", worktreePath: "web" },
      });
      await dispatch(app, conn, {
        id: 16,
        op: "docks.start",
        body: { dockControlId: "dev-server", worktreePath: cwdB },
      });
      expect(frames.map((f) => f.status)).toEqual([201, 400]);
      expect(launch.calls).toHaveLength(1);
      expect(launch.calls[0]).toMatchObject({ cwd: path.join(fs.realpathSync(cwdA), "web") });
    });

    it("docks.switch refuses a symlink that escapes the checkout, before stopping anything", async () => {
      const { app, conn, frames, sessionId } = await running();
      fs.symlinkSync(cwdB, path.join(cwdA, "escape"));
      await dispatch(app, conn, {
        id: 17,
        op: "docks.switch",
        body: { dockControlId: "dev-server", worktreePath: "escape" },
      });
      expect(frames[0]).toMatchObject({ ok: false, status: 400 });
      expect(app.db.select().from(sessions).where(eq(sessions.id, sessionId)).get()?.status).toBe(
        "active",
      );
    });

    it("docks.switch accepts a path inside the project checkout", async () => {
      const { app, conn, frames } = await running();
      await dispatch(app, conn, {
        id: 10,
        op: "docks.switch",
        body: { dockControlId: "dev-server", worktreePath: path.join(cwdA, "web") },
      });
      expect(frames[0]).toMatchObject({ ok: true, status: 201 });
      expect(launch.calls.at(-1)).toMatchObject({ cwd: path.join(fs.realpathSync(cwdA), "web") });
    });
  });
});
