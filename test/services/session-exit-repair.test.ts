import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { SessionLiveness } from "../../src/services/session-process.js";

// Same fakes as session-reconciler.test.ts: session creation spawns real OS
// processes via PtyManager, and no test may let a real systemd-run fire.
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
  const { EventEmitter } = await import("node:events");
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        stdout?: InstanceType<typeof EventEmitter>;
      };
      ee.stdout = new EventEmitter();
      setImmediate(() => {
        ee.emit("exit", 0);
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { repairExited } = await import("../../src/services/session-live-info.js");
const { sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `session-exit-repair-test-${process.pid}.db`);

describe("repairExited (#2602)", () => {
  let openApp: Awaited<ReturnType<typeof buildApp>> | undefined;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  afterEach(async () => {
    await openApp?.close();
    openApp = undefined;
    vi.restoreAllMocks();
  });

  async function setup(liveness: SessionLiveness) {
    const app = await buildApp();
    openApp = app;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const id = created.json().id as number;
    vi.spyOn(app.pty, "isMasterAliveStateBatch").mockImplementation(async (ids: string[]) =>
      Object.fromEntries(ids.map((i) => [i, liveness])),
    );
    const setExited = () =>
      app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, id)).run();
    const row = () => app.db.select().from(sessions).where(eq(sessions.id, id)).all()[0];
    setExited();
    return { app, setExited, row };
  }

  it("re-activates an exited row whose scope is alive, once per session", async () => {
    const { app, setExited, row } = await setup("alive");

    await expect(repairExited(app, "local", 1, row(), "exited")).resolves.toBe(true);
    expect(row().status).toBe("active");

    // A second wrong flip of the same session is not repaired again.
    setExited();
    await expect(repairExited(app, "local", 1, row(), "exited")).resolves.toBe(true);
    expect(row().status).toBe("exited");
  });

  it.each(["dead", "unknown"] as const)("leaves the row alone when liveness is %s", async (v) => {
    const { app, row } = await setup(v);

    await expect(repairExited(app, "local", 1, row(), "exited")).resolves.toBe(true);
    expect(row().status).toBe("exited");
  });

  it("does nothing for a session that does not derive exited", async () => {
    const { app, row } = await setup("alive");

    await expect(repairExited(app, "local", 1, row(), "working")).resolves.toBe(false);
    expect(row().status).toBe("exited");
  });
});
