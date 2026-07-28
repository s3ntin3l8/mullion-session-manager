import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { statSync } from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { vi } from "vitest";

// Real integration test against the actual listening Unix socket — same
// "app.inject() can't drive this, so build a real app and connect a real
// client" reasoning as test/plugins/hooks.test.ts, whose mocking setup this
// mirrors exactly (node-pty and the systemd-run/dtach bootstrap child_process
// are faked so a session-scoped handshake test can spawn a session without a
// real systemd --user session).
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

vi.mock("node-pty", () => ({
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

const TEST_TOKEN = "test-auth-token-0123456789";
const TEST_SECRET = "test-session-secret-0123456789";

function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });
}

/** Resolves with the first complete newline-terminated line the server
 * writes back, JSON-parsed. */
function waitForReply(socket: net.Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) resolve(JSON.parse(buffer.slice(0, newlineIndex)));
    });
  });
}

describe("controlSocketPlugin (issue #185)", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    delete process.env.MULLION_AUTH_TOKEN;
    delete process.env.MULLION_SESSION_SECRET;
    delete process.env.MULLION_ROLE;
  });

  it("listens on app.pty.controlSocketPath once ready, mode 0600", async () => {
    app = await buildApp();
    await app.ready();

    const socket = await connect(app.pty.controlSocketPath);
    socket.destroy();

    const mode = statSync(app.pty.controlSocketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("does not register for MULLION_ROLE=agent", async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "agent-token-0123456789";
    app = await buildApp();
    await app.ready();
    expect(app.hasDecorator("controlServer")).toBe(false);
    delete process.env.MULLION_AGENT_TOKEN;
  });

  describe("auth disabled (default)", () => {
    it("accepts an empty handshake at full scope and answers ping in-process", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      socket.write(`${JSON.stringify({ id: 1, op: "ping" })}\n`);

      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 1, ok: true, status: 200, result: { pong: true } });
      socket.destroy();
    });

    it("dispatches sessions.list via app.inject against the real REST route", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      socket.write(`${JSON.stringify({ id: 2, op: "sessions.list" })}\n`);

      const reply = await waitForReply(socket);
      expect(reply.id).toBe(2);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect(Array.isArray(reply.result)).toBe(true);
      socket.destroy();
    });

    it("dispatches projects.list via app.inject", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      socket.write(`${JSON.stringify({ id: 3, op: "projects.list" })}\n`);

      const reply = await waitForReply(socket);
      expect(reply.id).toBe(3);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      expect(Array.isArray(reply.result)).toBe(true);
      socket.destroy();
    });

    it("passes body fields through as a query string (sessions.list?kind=)", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      socket.write(
        `${JSON.stringify({ id: 4, op: "sessions.list", body: { kind: "not-a-real-kind" } })}\n`,
      );

      const reply = await waitForReply(socket);
      // The REST route's own ajv schema rejects an invalid `kind` — proof
      // the query string round-tripped into the real route rather than
      // being silently dropped.
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(400);
      socket.destroy();
    });

    it("replies 404 for an unrecognized op", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      socket.write(`${JSON.stringify({ id: 5, op: "nonexistent.op" })}\n`);

      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 5, ok: false, status: 404, error: "unknown op: nonexistent.op" });
      socket.destroy();
    });

    it("replies with an error but keeps the connection open on a malformed message", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      socket.write("not json at all\n");

      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(false);
      expect(reply.status).toBe(400);
      expect(reply.id).toBeNull();

      // Connection stays open — a follow-up well-formed request still works.
      socket.write(`${JSON.stringify({ id: 6, op: "ping" })}\n`);
      const second = await new Promise<Record<string, unknown>>((resolve) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n").filter(Boolean);
          const last = lines[lines.length - 1];
          if (last) {
            const parsed = JSON.parse(last) as Record<string, unknown>;
            if (parsed.id === 6) resolve(parsed);
          }
        });
      });
      expect(second).toEqual({ id: 6, ok: true, status: 200, result: { pong: true } });
      socket.destroy();
    });

    it("closes the connection on a malformed handshake line", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("not json\n");
      await waitForClose(socket);
      expect(socket.destroyed).toBe(true);
    });
  });

  describe("auth enabled (MULLION_AUTH_TOKEN + MULLION_SESSION_SECRET set)", () => {
    it("closes the connection on an empty handshake (auth enabled, no token)", async () => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      await waitForClose(socket);
      expect(socket.destroyed).toBe(true);
    });

    it("closes the connection on an invalid token", async () => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write(`${JSON.stringify({ token: "totally-wrong-token" })}\n`);
      await waitForClose(socket);
      expect(socket.destroyed).toBe(true);
    });

    it("grants full scope for MULLION_AUTH_TOKEN and can list sessions", async () => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write(`${JSON.stringify({ token: TEST_TOKEN })}\n`);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.list" })}\n`);

      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      socket.destroy();
    });

    it("grants session scope for a live session's hook token, pinned to that session", async () => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      app = await buildApp();
      await app.ready();
      const session = app.pty.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });

      const socket = await connect(app.pty.controlSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(`${JSON.stringify({ id: 1, op: "ping" })}\n`);

      const reply = await waitForReply(socket);
      expect(reply).toEqual({ id: 1, ok: true, status: 200, result: { pong: true } });
      socket.destroy();
    });

    it("rejects a session-scoped connection calling a full-scope-only op", async () => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      app = await buildApp();
      await app.ready();
      const session = app.pty.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });

      const socket = await connect(app.pty.controlSocketPath);
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.list" })}\n`);

      const reply = await waitForReply(socket);
      expect(reply).toEqual({
        id: 1,
        ok: false,
        status: 403,
        error: "not permitted for this connection's scope",
      });
      socket.destroy();
    });
  });
});
