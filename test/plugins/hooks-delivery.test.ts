import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { vi } from "vitest";

// Issue #3174 — the delivery protocol of the hook socket: the acknowledgement
// a retried `Stop` needs, and the at-most-once guarantee behind it.
//
// A `Stop` the socket refuses (Mullion or an agent host restarting, the
// session's token not registered again yet) is dropped by the
// fire-and-forget path, and a lost Stop leaves a finished headless Task
// Master worker looking unfinished until its budget expires. So the forwarder
// delivers a Stop with an explicit acknowledgement and retries it — which
// needs the socket to (a) say whether the delivery was accepted, and (b)
// recognise a retry of a delivery that already landed, so the same event
// never reaches the session twice.
//
// Split out of test/plugins/hooks.test.ts (same "real socket, real client"
// posture — see that file's own header): that file had grown past the
// repo's per-file size ceiling (scripts/check-max-file-lines.mjs), and this
// block is a self-contained concern with its own fixture.
class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<() => void> = [];
  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }
  onExit(cb: () => void) {
    this.exitListeners.push(cb);
    return { dispose: () => {} };
  }
  write() {}
  resize() {}
  kill() {}
}

vi.mock("node:pty", () => ({
  spawn: vi.fn(() => new FakePty()),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");

/** Connects a raw net socket to `path`, resolving once actually connected. */
function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Resolves once `socket` closes (the server's refusal path closes it). */
function waitForClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });
}

/** Collects every newline-terminated line the server writes back. */
function collectReplies(socket: net.Socket): string[] {
  const replies: string[] = [];
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      replies.push(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  return replies;
}

/** Waits until `count` replies have arrived (or the wait budget runs out). */
async function waitForReplies(replies: string[], count: number): Promise<void> {
  for (let i = 0; i < 100 && replies.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("hook delivery protocol (issue #3174)", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    // The same state-file sweep test/plugins/hooks.test.ts does: a session's
    // state file outlives the app that wrote it, and the next buildApp()
    // would restore the previous test's session 1 instead of starting clean.
    if (process.env.SESSIONS_DIR && fs.existsSync(process.env.SESSIONS_DIR)) {
      for (const entry of fs.readdirSync(process.env.SESSIONS_DIR)) {
        if (entry.endsWith(".state.json")) {
          fs.rmSync(path.join(process.env.SESSIONS_DIR, entry), { force: true });
        }
      }
    }
  });

  /** A session a delivery handshake can name. */
  function deliverySession(app_: Awaited<ReturnType<typeof buildApp>>) {
    return app_.pty.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
  }

  it("acknowledges a delivery connection and dispatches its message", async () => {
    app = await buildApp();
    await app.ready();
    const session = deliverySession(app);
    const dispatched = vi.spyOn(session, "emitHookEvent");

    const socket = await connect(app.pty.hookSocketPath);
    const replies = collectReplies(socket);
    socket.write(`${JSON.stringify({ token: session.hookToken, deliveryId: "delivery-1" })}\n`);
    socket.write(`${JSON.stringify({ kind: "progress", phase: "done" })}\n`);

    await waitForReplies(replies, 2);

    expect(replies.map((line) => JSON.parse(line))).toEqual([
      { ack: "accepted" },
      { ack: "delivered" },
    ]);
    expect(dispatched).toHaveBeenCalledTimes(1);
    socket.destroy();
  });

  it("does NOT dispatch a retried delivery a second time", async () => {
    app = await buildApp();
    await app.ready();
    const session = deliverySession(app);
    const dispatched = vi.spyOn(session, "emitHookEvent");

    const message = `${JSON.stringify({ kind: "progress", phase: "done" })}\n`;
    for (const _attempt of [1, 2]) {
      const socket = await connect(app.pty.hookSocketPath);
      const replies = collectReplies(socket);
      socket.write(`${JSON.stringify({ token: session.hookToken, deliveryId: "delivery-2" })}\n`);
      socket.write(message);

      await waitForReplies(replies, 2);
      // The retry is acknowledged — the client stops retrying — but the
      // session never sees the event twice.
      expect(replies.map((line) => JSON.parse(line))).toEqual([
        { ack: "accepted" },
        { ack: "delivered" },
      ]);
      socket.destroy();
    }

    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it("acknowledges each message of a multi-message delivery separately", async () => {
    app = await buildApp();
    await app.ready();
    const session = deliverySession(app);
    const dispatched = vi.spyOn(session, "emitHookEvent");

    const socket = await connect(app.pty.hookSocketPath);
    const replies = collectReplies(socket);
    socket.write(`${JSON.stringify({ token: session.hookToken, deliveryId: "delivery-3" })}\n`);
    socket.write(`${JSON.stringify({ kind: "progress", phase: "done" })}\n`);
    socket.write(`${JSON.stringify({ kind: "tool_done", tool: "Bash" })}\n`);

    await waitForReplies(replies, 3);

    expect(replies.map((line) => JSON.parse(line))).toEqual([
      { ack: "accepted" },
      { ack: "delivered" },
      { ack: "delivered" },
    ]);
    expect(dispatched).toHaveBeenCalledTimes(2);
    socket.destroy();
  });

  it("refuses a delivery connection whose token does not resolve", async () => {
    app = await buildApp();
    await app.ready();

    const socket = await connect(app.pty.hookSocketPath);
    const replies = collectReplies(socket);
    socket.write(`${JSON.stringify({ token: "not-a-live-token", deliveryId: "delivery-4" })}\n`);

    await waitForReplies(replies, 1);

    expect(replies.map((line) => JSON.parse(line))).toEqual([{ ack: "refused" }]);
    await waitForClose(socket);
  });

  it("leaves an ordinary fire-and-forget connection unacknowledged", async () => {
    app = await buildApp();
    await app.ready();
    const session = deliverySession(app);

    const socket = await connect(app.pty.hookSocketPath);
    const replies = collectReplies(socket);
    socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
    socket.write(`${JSON.stringify({ kind: "progress", phase: "done" })}\n`);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replies).toEqual([]);
    socket.destroy();
  });
});
