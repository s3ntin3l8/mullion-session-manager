import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/services/pty-manager.test.ts,
// so this file exercises the route/DB layer without depending on a real
// systemd --user session existing in CI. See that file for why.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const listeners: Array<(data: string) => void> = [];
    return {
      onData: (cb: (data: string) => void) => {
        listeners.push(cb);
        return { dispose: () => {} };
      },
      onExit: () => ({ dispose: () => {} }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
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

const tmpDb = path.join(os.tmpdir(), `sessions-test-${process.pid}.db`);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("sessions route", () => {
  // SESSIONS_DIR is already isolated per test file by test/setup.ts.
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/tmp" },
    });
    return res.json().id as number;
  }

  it("creates a session, spawns it, and lists it as alive", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      projectId,
      command: "bash",
      status: "active",
      kind: "terminal",
    });
    const sessionId = created.json().id;

    await waitUntil(async () => {
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      return list.json()[0]?.alive === true;
    });

    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.json()).toEqual([expect.objectContaining({ id: sessionId, alive: true })]);

    await app.close();
  });

  it("accepts an optional cwd override distinct from the project's cwd", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", cwd: "/tmp/subdir" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ projectId, command: "bash", cwd: "/tmp/subdir" });

    await app.close();
  });

  it("creates a dock-kind session and filters it via ?kind=dock (WS-5)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" }, // default kind: terminal
    });
    const dockCreated = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "npm run dev", kind: "dock" },
    });
    expect(dockCreated.json()).toMatchObject({ kind: "dock" });

    const dockOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&kind=dock`,
    });
    expect(dockOnly.json()).toEqual([expect.objectContaining({ kind: "dock" })]);

    const terminalOnly = await app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}&kind=terminal`,
    });
    expect(
      (terminalOnly.json() as Array<{ kind: string }>).every((s) => s.kind === "terminal"),
    ).toBe(true);

    await app.close();
  });

  it("rejects an invalid kind querystring value", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/sessions?kind=bogus" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an invalid kind in the create body", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", kind: "bogus" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("defaults cwd to null (falls back to the project's cwd) when omitted", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(created.json().cwd).toBeNull();

    await app.close();
  });

  it("rejects creating a session for an unknown project", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: 999999, command: "bash" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("renames a session", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = created.json().id;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}`,
      payload: { name: "my shell" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("my shell");

    await app.close();
  });

  it("404s renaming an unknown session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/sessions/999999",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("kills a session: marks it killed and stops reporting alive", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = created.json().id;
    await waitUntil(async () => {
      const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
      return list.json()[0]?.alive === true;
    });

    const killed = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(killed.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.json()).toEqual([
      expect.objectContaining({ id: sessionId, status: "killed", alive: false }),
    ]);

    await app.close();
  });
});
