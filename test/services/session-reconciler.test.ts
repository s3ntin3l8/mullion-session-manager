import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Session creation still spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked the same way as test/routes/sessions.test.ts, since
// this test drives real create/list through the actual app + DB rather
// than hand-faking drizzle's query builder.
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
const { reconcileExitedSessions } = await import("../../src/services/session-reconciler.js");

const tmpDb = path.join(os.tmpdir(), `session-reconciler-test-${process.pid}.db`);

describe("reconcileExitedSessions", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createSession(app: Awaited<ReturnType<typeof buildApp>>) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/tmp" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    return created.json().id as number;
  }

  // Runs first, deliberately, while the shared test-file DB still has zero
  // rows — later tests create sessions whose active/exited state would
  // otherwise make "no active sessions at all" untrue by the time this ran.
  it("is a no-op when there are no active sessions", async () => {
    const app = await buildApp();
    const isMasterAliveSpy = vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);

    await expect(reconcileExitedSessions(app)).resolves.toBeUndefined();
    expect(isMasterAliveSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("leaves an active session alone when its scope is still alive", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);

    await reconcileExitedSessions(app);

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find((s) => s.id === sessionId);
    expect(row?.status).toBe("active");

    await app.close();
  });

  it("flips an active session to exited once its scope is no longer alive", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(false);

    await reconcileExitedSessions(app);

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find((s) => s.id === sessionId);
    expect(row?.status).toBe("exited");

    await app.close();
  });

  it("does not touch an already-killed session", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });

    const isMasterAliveSpy = vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(false);
    await reconcileExitedSessions(app);

    // The row was already "killed" (not "active"), so it's outside the
    // query the reconciler selects — isMasterAlive should never be asked
    // about it at all.
    expect(isMasterAliveSpy).not.toHaveBeenCalledWith(String(sessionId));

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find((s) => s.id === sessionId);
    expect(row?.status).toBe("killed");

    await app.close();
  });
});
