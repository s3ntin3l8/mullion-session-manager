import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { WebSocket as NodeWebSocket } from "ws";

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
const { createSessionCookieValue, SESSION_COOKIE_NAME } =
  await import("../../src/services/auth.js");

const tmpDb = path.join(os.tmpdir(), `terminal-test-${process.pid}.db`);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

// Session.nudgeRedraw() (pty-manager.ts) schedules its dip/restore with real
// setTimeout(300ms then +400ms) — a setImmediate-polling waitUntil() never
// gets far enough in wall-clock time to observe it, so the one test that
// exercises the redraw nudge polls with real delays instead, up to a timeout
// comfortably past the 700ms the two timers need to both fire.
async function waitUntilReal(check: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never became true");
}

function waitForMessage(ws: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (event) => resolve(event), { once: true });
  });
}

// getScrollback() now always sends a backlog message on connect — even for a
// brand-new session with no real output yet, it's just the screen-mode
// preamble (see pty-manager.ts). Attaching the collector before awaiting
// "open" (rather than a single waitForMessage() call afterwards) avoids a
// race against exactly when that first frame lands relative to the client's
// own "open" event.
function collectMessages(ws: WebSocket): Buffer[] {
  const messages: Buffer[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(Buffer.from(event.data as ArrayBuffer));
  });
  return messages;
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
  async function createProjectAndSession(
    app: Awaited<ReturnType<typeof buildApp>>,
    // Only needed by the auth describe block below, where TESSERA_AUTH_TOKEN
    // is set — app.inject() bypasses the network but not src/plugins/auth.ts's
    // own onRequest hook, so these setup calls need a credential too once
    // it's enabled.
    headers?: Record<string, string>,
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/tmp" },
      headers,
    });
    const projectId = project.json().id as number;

    const before = fakePtyChildren.length;
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
      headers,
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
    const messages = collectMessages(ws);
    await waitForOpenOrClose(ws);

    // First frame is always the (here content-less, preamble-only) backlog.
    await waitUntil(() => messages.length > 0);
    expect(messages[0].toString("utf8")).toBe("\x1b[?1049l");

    pty.emitData("hello from pty");
    await waitUntil(() => messages.length > 1);
    expect(messages[1].toString("utf8")).toBe("hello from pty");

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

  it("nudges a redraw when reattaching to an already-alive session (no client resize)", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId, pty } = await createProjectAndSession(app);

    // POST /api/sessions above already spawned the pty, which nudges its own
    // redraw (dip + restore) via attachClient() -> nudgeRedraw() in
    // pty-manager.ts. Let that settle first so it isn't mistaken for the
    // reattach nudge this test is actually checking.
    await waitUntilReal(() => pty.resizeSpy.mock.calls.length >= 2);
    pty.resizeSpy.mockClear();

    // No resize control message is ever sent on this socket — the session is
    // already alive (attachSocketToSession's `wasAlive` check), so any
    // resize() call the pty sees here can only come from that reattach path
    // requesting its own redraw, not from a genuine client-driven resize.
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
    );
    await waitForOpenOrClose(ws);

    await waitUntilReal(() => pty.resizeSpy.mock.calls.some(([, rows]) => rows === 12));
    await waitUntilReal(() =>
      pty.resizeSpy.mock.calls.some(([cols, rows]) => cols === 80 && rows === 24),
    );

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
    // The backlog is prefixed with a screen-mode preamble (issue #83) so a
    // freshly-attaching xterm.js is guaranteed to land in the correct
    // screen mode — "\x1b[?1049l" here since no alt-screen switch occurred.
    expect(Buffer.from(event.data as ArrayBuffer).toString("utf8")).toBe(
      "\x1b[?1049lexisting output",
    );

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

  // app.inject() can't drive a real WS upgrade (see this file's own top
  // comment), and that's exactly the gap issue #19 needs covered: a browser
  // can't set a custom Authorization header on a WebSocket handshake, but
  // Node's own `ws` client can — used here (instead of the global
  // browser-style WebSocket the tests above use) specifically so these tests
  // can attach an Authorization/Cookie header to the handshake, the same way
  // src/plugins/auth.ts's onRequest hook (which fires before the upgrade
  // completes — see that file's own comment) expects to find them.
  describe("in-process auth gate (issue #19)", () => {
    const TEST_TOKEN = "test-shared-token-abcdef123456";
    const TEST_SECRET = "test-session-secret-abcdef123456";

    beforeEach(() => {
      process.env.TESSERA_AUTH_TOKEN = TEST_TOKEN;
      process.env.TESSERA_SESSION_SECRET = TEST_SECRET;
    });

    afterEach(() => {
      delete process.env.TESSERA_AUTH_TOKEN;
      delete process.env.TESSERA_SESSION_SECRET;
    });

    // Unlike the global browser-style WebSocket the tests above use, `ws`'s
    // own client emits a real 'error' event (an EventEmitter default that
    // crashes the process if unhandled) when the server rejects the
    // handshake outright, rather than only ever going straight to 'close' —
    // a 401 during the upgrade is exactly that case, so this listens for
    // both and treats either as "rejected".
    function waitForNodeWsOpenOrClose(ws: NodeWebSocket): Promise<"open" | "close"> {
      return new Promise((resolve) => {
        ws.once("open", () => resolve("open"));
        ws.once("close", () => resolve("close"));
        ws.once("error", () => resolve("close"));
      });
    }

    it("rejects a /ws/terminal upgrade with no credential once auth is enabled", async () => {
      const { app, port } = await buildAndListen();
      const { sessionId } = await createProjectAndSession(app, {
        authorization: `Bearer ${TEST_TOKEN}`,
      });

      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
      );
      expect(await waitForNodeWsOpenOrClose(ws)).toBe("close");

      await app.close();
    });

    it("rejects a /ws/terminal upgrade with a wrong bearer token", async () => {
      const { app, port } = await buildAndListen();
      const { sessionId } = await createProjectAndSession(app, {
        authorization: `Bearer ${TEST_TOKEN}`,
      });

      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
        { headers: { authorization: "Bearer wrong-token" } },
      );
      expect(await waitForNodeWsOpenOrClose(ws)).toBe("close");

      await app.close();
    });

    it("accepts a /ws/terminal upgrade with a valid bearer token", async () => {
      const { app, port } = await buildAndListen();
      const { sessionId } = await createProjectAndSession(app, {
        authorization: `Bearer ${TEST_TOKEN}`,
      });

      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
        { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
      );
      expect(await waitForNodeWsOpenOrClose(ws)).toBe("open");

      ws.close();
      await app.close();
    });

    it("accepts a /ws/terminal upgrade with a valid session cookie (the login flow's own credential)", async () => {
      const { app, port } = await buildAndListen();
      const { sessionId } = await createProjectAndSession(app, {
        authorization: `Bearer ${TEST_TOKEN}`,
      });

      const cookieValue = createSessionCookieValue(TEST_SECRET);
      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/ws/terminal?sessionId=${sessionId}&cols=80&rows=24`,
        { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` } },
      );
      expect(await waitForNodeWsOpenOrClose(ws)).toBe("open");

      ws.close();
      await app.close();
    });
  });
});
