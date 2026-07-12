import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Real integration test: a genuine WebSocket client against a real listening
// server, not app.inject() (which can't drive a full-duplex upgrade). The
// underlying OS processes (systemd-run, dtach) are faked the same way as
// test/services/pty-manager.test.ts and test/routes/sessions.test.ts, so this
// exercises the actual /ws/terminal route logic — session lookup,
// preValidation rejection, binary I/O framing, resize control messages,
// scrollback replay — without depending on a real systemd --user session.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<() => void> = [];
  writeSpy = vi.fn();
  resizeSpy = vi.fn();

  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }

  onExit(cb: () => void) {
    this.exitListeners.push(cb);
    return { dispose: () => {} };
  }

  write(data: string) {
    this.writeSpy(data);
  }

  resize(cols: number, rows: number) {
    this.resizeSpy(cols, rows);
  }

  kill() {}

  emitData(chunk: string) {
    for (const cb of this.dataListeners) cb(chunk);
  }
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const child = new FakePty();
    fakePtyChildren.push(child);
    return child;
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
const { sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `terminal-test-${process.pid}.db`);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

function waitForMessage(ws: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (event) => resolve(event), { once: true });
  });
}

function waitForOpenOrClose(ws: WebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.addEventListener("open", () => resolve("open"), { once: true });
    ws.addEventListener("close", () => resolve("close"), { once: true });
  });
}

describe("terminal route (/ws/terminal)", () => {
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

  async function buildAndListen() {
    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    return { app, port: address.port };
  }

  // fakePtyChildren accumulates across every test in this file (it's
  // module-scoped, and each test's session needs to survive past its own
  // `it` block, unlike pty-manager.test.ts's per-test reset) — snapshotting
  // the length before creating a session and waiting for it to grow past
  // that snapshot is what actually identifies *this* test's own pty, since
  // `length > 0` alone is trivially already true after the first test.
  async function createProjectAndSession(app: Awaited<ReturnType<typeof buildApp>>) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;

    const before = fakePtyChildren.length;
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = session.json().id as number;

    await waitUntil(() => fakePtyChildren.length > before);
    return { sessionId, pty: fakePtyChildren[fakePtyChildren.length - 1] };
  }

  it("rejects an unknown sessionId before the WS upgrade completes", async () => {
    const { app, port } = await buildAndListen();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?sessionId=999999&cols=80&rows=24`);
    const outcome = await waitForOpenOrClose(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("rejects a session that has been reconciled as exited (WS-6)", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    // Simulate what session-reconciler.ts does once a program's exited on
    // its own — no API sets this directly, so write it straight to the DB.
    app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, sessionId)).run();

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
    );
    const outcome = await waitForOpenOrClose(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("streams pty output to the client and client input to the pty", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId, pty } = await createProjectAndSession(app);

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
    );
    ws.binaryType = "arraybuffer";
    await waitForOpenOrClose(ws);

    const messagePromise = waitForMessage(ws);
    pty.emitData("hello from pty");
    const event = await messagePromise;
    expect(Buffer.from(event.data as ArrayBuffer).toString("utf8")).toBe("hello from pty");

    ws.send(new TextEncoder().encode("echo hi\n"));
    await waitUntil(() => pty.writeSpy.mock.calls.length > 0);
    expect(pty.writeSpy).toHaveBeenCalledWith("echo hi\n");

    ws.close();
    await app.close();
  });

  it("forwards a resize control message to the pty", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId, pty } = await createProjectAndSession(app);

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
    );
    await waitForOpenOrClose(ws);

    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await waitUntil(() => pty.resizeSpy.mock.calls.length > 0);
    expect(pty.resizeSpy).toHaveBeenCalledWith(120, 40);

    ws.close();
    await app.close();
  });

  it("replays scrollback to a newly-attaching client", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId, pty } = await createProjectAndSession(app);
    pty.emitData("existing output");

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
    );
    ws.binaryType = "arraybuffer";
    const messagePromise = waitForMessage(ws);
    await waitForOpenOrClose(ws);
    const event = await messagePromise;
    expect(Buffer.from(event.data as ArrayBuffer).toString("utf8")).toBe("existing output");

    ws.close();
    await app.close();
  });

  it("does not kill the session when the socket closes", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
    );
    await waitForOpenOrClose(ws);
    ws.close();
    await new Promise((resolve) => setImmediate(resolve));

    const list = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(list.json().find((s: { id: number }) => s.id === sessionId)).toMatchObject({
      status: "active",
    });

    await app.close();
  });
});
