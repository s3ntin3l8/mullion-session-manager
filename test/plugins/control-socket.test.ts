import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import net from "node:net";
import fs, { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createControlSocketPtyMock,
  mockControlSocketChildProcess,
  TEST_TOKEN,
  TEST_SECRET,
  TEST_OIDC_ISSUER,
  TEST_OIDC_CLIENT_ID,
  TEST_OIDC_CLIENT_SECRET,
  TEST_OIDC_REDIRECT_URI,
  connect,
  waitForClose,
  waitForReply,
  waitUntil,
  collectFrames,
} from "../helpers/control-socket.js";

const ptyMock = createControlSocketPtyMock();
vi.mock("../../src/services/hook-adapters/codex-trust.js", () => ({
  getCodexHookTrust: () => "pending" as const,
}));
vi.mock("../../src/services/bundle-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBundleSyncedFor: () => false,
}));
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) =>
  mockControlSocketChildProcess(await importOriginal<typeof ChildProcess>()),
);

const { buildApp } = await import("../../src/app.js");
const {
  HANDSHAKE_TIMEOUT_MS,
  buildQueryUrl,
  MAX_INFLIGHT_OPS,
  MAX_OPEN_CHANNELS,
  MAX_HANDSHAKE_BYTES,
  MAX_CONNECTIONS,
  WRITE_HIGH_WATER_BYTES,
  WRITE_HARD_CEILING_BYTES,
} = await import("../../src/plugins/control-socket.js");

describe("buildQueryUrl", () => {
  // Issue #1720 (roadmap 8.6) — the Android device panel is LINUX-ONLY (its
  // emulator runs in a `systemd --user` scope), so on a non-Linux host the
  // panel is off and every device route answers 400. This file asserts the
  // panel's ENABLED behaviour, so the host platform is stubbed for the whole
  // test — the same technique test/services/scope.test.ts uses for its own
  // darwin case.
  //
  // The stub covers the whole test (not just the build) because the app's
  // plugins read the platform when Fastify makes them ready, and the panel's
  // gate is read at REQUEST time.
  let originalPlatform: NodeJS.Platform;
  beforeEach(() => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });
  it("returns the bare path with no body", () => {
    expect(buildQueryUrl("/api/sessions", undefined)).toBe("/api/sessions");
  });

  it("percent-encodes special characters in a body value", () => {
    const url = buildQueryUrl("/api/sessions", { projectId: "a b&c=d" });
    expect(url).toBe("/api/sessions?projectId=a+b%26c%3Dd");
    expect(new URL(url, "http://x").searchParams.get("projectId")).toBe("a b&c=d");
  });

  it("joins multiple scalar body fields", () => {
    const url = buildQueryUrl("/api/sessions", { projectId: "3", kind: "dock" });
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("projectId")).toBe("3");
    expect(parsed.searchParams.get("kind")).toBe("dock");
  });

  it("skips null/undefined and non-scalar values", () => {
    const url = buildQueryUrl("/api/sessions", {
      projectId: "3",
      missing: undefined,
      absent: null,
      nested: { a: 1 },
    });
    expect(url).toBe("/api/sessions?projectId=3");
  });
});

describe("controlSocketPlugin (issue #185)", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    ptyMock.spawnedPtys.length = 0;
    delete process.env.MULLION_AUTH_TOKEN;
    delete process.env.MULLION_SESSION_SECRET;
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_OIDC_ISSUER;
    delete process.env.MULLION_OIDC_CLIENT_ID;
    delete process.env.MULLION_OIDC_CLIENT_SECRET;
    delete process.env.MULLION_OIDC_REDIRECT_URI;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it("listens on app.pty.controlSocketPath once ready, mode 0600", async () => {
    app = await buildApp();
    await app.ready();

    const socket = await connect(app.pty.controlSocketPath);
    socket.destroy();

    const mode = statSync(app.pty.controlSocketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // The actual production incident this guards against: MULLION_SOCKET_PATH
  // is injected into every spawned session, so a dev backend started from
  // inside an already-running Mullion-hosted session inherits it. Before
  // the fix, buildApp() would unconditionally unlink and rebind over an
  // already-live listener at that path — silently hijacking it. Now it must
  // refuse to start, and the pre-existing listener must be left untouched.
  it("refuses to start when MULLION_SOCKET_PATH already has a live listener", async () => {
    const collisionPath = path.join(os.tmpdir(), `control-socket-collision-${process.pid}.sock`);
    const preExisting = net.createServer(() => {});
    await new Promise<void>((resolve) => preExisting.listen(collisionPath, resolve));
    process.env.MULLION_SOCKET_PATH = collisionPath;

    // controlSocketPlugin registers (and so binds) after hooksPlugin in
    // app.ts's sequence — buildApp() rejecting here means hooksPlugin's own
    // socket already bound successfully, with no `app` reference left to
    // close() it (buildApp() never returns one on this path). Isolating
    // SESSIONS_DIR to a scratch directory just for this test, rather than
    // this file's shared one (test/setup.ts), keeps that leaked hooks.sock
    // listener from colliding with — or being silently "cleaned up" by —
    // any other test's own hooksPlugin registration.
    const originalSessionsDir = process.env.SESSIONS_DIR;
    const scratchSessionsDir = path.join(
      os.tmpdir(),
      `control-socket-collision-sessions-${process.pid}`,
    );
    process.env.SESSIONS_DIR = scratchSessionsDir;

    try {
      // Registering controlSocketPlugin (via `await app.register(...)`
      // inside buildApp()) is what actually runs its body here, so the
      // rejection surfaces from buildApp() itself, not a later ready() call
      // — `app` is never assigned in this path, so afterEach's `if (app)`
      // cleanup is a no-op, which is correct: nothing was ever built.
      await expect(buildApp()).rejects.toThrow(/already listening/i);

      // The pre-existing listener must survive completely untouched — not
      // unlinked, still reachable.
      const socket = await connect(collisionPath);
      socket.destroy();
    } finally {
      process.env.SESSIONS_DIR = originalSessionsDir;
      delete process.env.MULLION_SOCKET_PATH;
      preExisting.close();
      fs.rmSync(collisionPath, { force: true });
      fs.rmSync(scratchSessionsDir, { recursive: true, force: true });
    }
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

    it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
      "replies 404 (not a crash) for the Object.prototype member %s used as an op",
      async (op) => {
        app = await buildApp();
        await app.ready();
        const socket = await connect(app.pty.controlSocketPath);
        socket.write("{}\n");
        socket.write(`${JSON.stringify({ id: 6, op })}\n`);

        const reply = await waitForReply(socket);
        expect(reply).toEqual({ id: 6, ok: false, status: 404, error: `unknown op: ${op}` });

        // The connection (and process) must still be serving real ops.
        socket.write(`${JSON.stringify({ id: 7, op: "ping" })}\n`);
        const pong = await waitForReply(socket);
        expect(pong.id).toBe(7);
        expect(pong.ok).toBe(true);
        socket.destroy();
      },
    );

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

    it("grants full scope even for a garbage token — auth-disabled mode has nothing to validate against", async () => {
      // resolveHandshake checks isAuthEnabled() before ever comparing the
      // presented token — a stale or forged token in this mode must not be
      // treated any differently than no token at all (see that function's
      // own doc comment: a session whose hook token predates a Mullion
      // restart is a real, documented case, not a hypothetical).
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write(`${JSON.stringify({ token: "totally-not-a-real-token" })}\n`);
      socket.write(`${JSON.stringify({ id: 1, op: "sessions.list" })}\n`);

      const reply = await waitForReply(socket);
      expect(reply.ok).toBe(true);
      expect(reply.status).toBe(200);
      socket.destroy();
    });

    it("closes the connection on an oversized line with no terminator", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      // Deliberately over MAX_LINE_BYTES (2 MiB) with no trailing newline.
      socket.write(Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
      await waitForClose(socket);
      expect(socket.destroyed).toBe(true);
    });

    it("still processes a complete, valid line even when the same TCP chunk also carries an oversized unterminated tail", async () => {
      // The oversized-line guard must only fire on the still-incomplete
      // remainder AFTER draining every complete line already in the
      // buffer — a single write() containing a valid handshake+request
      // line followed by a multi-megabyte tail with no terminator yet
      // must not destroy the connection before that valid line is read.
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      const replyPromise = waitForReply(socket);

      const validPrefix = `{}\n${JSON.stringify({ id: 1, op: "ping" })}\n`;
      const oversizedTail = Buffer.alloc(2 * 1024 * 1024 + 1, "a");
      socket.write(Buffer.concat([Buffer.from(validPrefix, "utf8"), oversizedTail]));

      expect(await replyPromise).toEqual({ id: 1, ok: true, status: 200, result: { pong: true } });
      await waitForClose(socket);
      expect(socket.destroyed).toBe(true);
    });

    it("rejects a single TERMINATED line that itself exceeds MAX_LINE_BYTES, without closing the connection", async () => {
      // The remnant check above only catches an unterminated tail — a
      // single TCP write can legitimately deliver one complete oversized
      // line (the newline arrives in the same chunk), which must still be
      // rejected rather than dispatched uncapped.
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      await new Promise((resolve) => setImmediate(resolve));

      const hugeBody = { padding: "a".repeat(2 * 1024 * 1024 + 1) };
      const replyPromise = waitForReply(socket);
      socket.write(`${JSON.stringify({ id: 1, op: "ping", body: hugeBody })}\n`);
      const reply = await replyPromise;
      expect(reply).toEqual({
        id: null,
        ok: false,
        status: 400,
        error: "line exceeds the maximum message size",
      });

      // Connection stays open — a follow-up well-formed request still works.
      socket.write(`${JSON.stringify({ id: 2, op: "ping" })}\n`);
      const second = await new Promise<Record<string, unknown>>((resolve) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n").filter(Boolean);
          for (const l of lines) {
            const parsed = JSON.parse(l) as Record<string, unknown>;
            if (parsed.id === 2) resolve(parsed);
          }
        });
      });
      expect(second).toEqual({ id: 2, ok: true, status: 200, result: { pong: true } });
      socket.destroy();
    });

    it("correlates concurrent in-flight requests by id even when replies arrive out of order", async () => {
      // sessions.list and projects.list both go through app.inject(), so two
      // requests dispatched back-to-back race independently — nothing in
      // this test controls which resolves first. The `id` field is what a
      // real client relies on to tell them apart.
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");

      const replies: Record<string, unknown>[] = [];
      const gotBoth = new Promise<void>((resolve) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");
            replies.push(JSON.parse(line));
          }
          if (replies.length >= 2) resolve();
        });
      });
      socket.write(`${JSON.stringify({ id: 101, op: "sessions.list" })}\n`);
      socket.write(`${JSON.stringify({ id: 102, op: "projects.list" })}\n`);
      await gotBoth;

      const byId = new Map(replies.map((r) => [r.id, r]));
      expect(byId.get(101)).toMatchObject({ id: 101, ok: true, status: 200 });
      expect(byId.get(102)).toMatchObject({ id: 102, ok: true, status: 200 });
      socket.destroy();
    });
  });

  it("force-closes a connection that never completes its handshake", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);

      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);

      await waitForClose(socket);
      expect(socket.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys still-open connections on graceful shutdown, not just stops accepting new ones", async () => {
    app = await buildApp();
    await app.ready();
    const socket = await connect(app.pty.controlSocketPath);
    socket.write("{}\n");
    // Drained like a real client: the server now sends a "server-restarting"
    // frame (#2271) first, and an unread frame would keep this end from ever
    // reaching EOF.
    socket.resume();
    // Give the handshake a moment to land so this is a genuinely "open,
    // authenticated" connection at close time, not one mid-handshake.
    await new Promise((resolve) => setImmediate(resolve));

    const closed = waitForClose(socket);
    await app.close();
    app = null;
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  describe("bounded per-connection load (issue #1517) and handshake hardening (issue #1521)", () => {
    /** Replaces app.inject so each call blocks until the test releases it. */
    function blockInject(payload = "[]") {
      const pending: Array<() => void> = [];
      const spy = vi.spyOn(app!, "inject").mockImplementation(
        (() =>
          new Promise((resolve) => {
            pending.push(() => resolve({ statusCode: 200, payload }));
          })) as never,
      );
      return { spy, pending };
    }
    const listLine = (id: number) => `${JSON.stringify({ id, op: "sessions.list" })}\n`;

    it("caps in-flight ops per connection and resumes once they complete", async () => {
      app = await buildApp();
      await app.ready();
      const { spy, pending } = blockInject();
      const socket = await connect(app.pty.controlSocketPath);
      const frames = collectFrames(socket);
      const total = MAX_INFLIGHT_OPS + 8;
      let lines = "{}\n";
      for (let i = 1; i <= total; i++) lines += listLine(i);
      socket.write(lines);

      await waitUntil(() => spy.mock.calls.length >= MAX_INFLIGHT_OPS);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(spy.mock.calls.length).toBe(MAX_INFLIGHT_OPS);

      while (frames.length < total) {
        pending.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(frames.every((f) => f.ok === true)).toBe(true);
      socket.destroy();
    });

    it("stops reading requests while replies are backed up, and continues after drain", async () => {
      app = await buildApp();
      await app.ready();
      const big = JSON.stringify("x".repeat(WRITE_HIGH_WATER_BYTES * 2));
      const { spy, pending } = blockInject(big);
      const socket = await connect(app.pty.controlSocketPath);
      socket.pause();
      socket.write(`{}\n${listLine(1)}`);
      await waitUntil(() => spy.mock.calls.length === 1);
      pending.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.write(listLine(2));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(spy.mock.calls.length).toBe(1);

      socket.resume();
      await waitUntil(() => spy.mock.calls.length === 2);
      socket.destroy();
    });

    it("destroys a connection whose unread replies pass the hard ceiling", async () => {
      app = await buildApp();
      await app.ready();
      const big = JSON.stringify("x".repeat(Math.ceil(WRITE_HARD_CEILING_BYTES / 4)));
      const { spy, pending } = blockInject(big);
      const socket = await connect(app.pty.controlSocketPath);
      socket.pause();
      let lines = "{}\n";
      for (let i = 1; i <= 8; i++) lines += listLine(i);
      socket.write(lines);
      await waitUntil(() => spy.mock.calls.length === 8);
      for (const release of pending) release();
      // The server end is destroyed; the paused client still sees the close
      // once it reads the FIN.
      socket.resume();
      await waitForClose(socket);
      expect(socket.destroyed).toBe(true);
    });

    it("caps open streams per connection with 429", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      const frames = collectFrames(socket);
      let lines = "{}\n";
      for (let i = 1; i <= MAX_OPEN_CHANNELS + 1; i++) {
        lines += `${JSON.stringify({ id: i, op: "events.subscribe" })}\n`;
      }
      socket.write(lines);
      await waitUntil(() => frames.some((f) => f.id === MAX_OPEN_CHANNELS + 1 && f.ok === false));
      const rejected = frames.find((f) => f.id === MAX_OPEN_CHANNELS + 1 && f.ok === false);
      expect(rejected?.status).toBe(429);
      expect(frames.filter((f) => f.ok === true).length).toBe(MAX_OPEN_CHANNELS);
      socket.destroy();
    });

    it("closes a connection that buffers more than the handshake limit before authenticating", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      const started = Date.now();
      socket.write(Buffer.alloc(MAX_HANDSHAKE_BYTES + 1, "a"));
      await waitForClose(socket);
      // Closed by the size cap, not by the 10s handshake timeout.
      expect(Date.now() - started).toBeLessThan(HANDSHAKE_TIMEOUT_MS / 2);
    });

    it("refuses connections beyond the global limit", async () => {
      app = await buildApp();
      await app.ready();
      const sockets: net.Socket[] = [];
      for (let i = 0; i < MAX_CONNECTIONS; i++) {
        sockets.push(await connect(app.pty.controlSocketPath));
      }
      const started = Date.now();
      const extra = await connect(app.pty.controlSocketPath);
      await waitForClose(extra);
      expect(Date.now() - started).toBeLessThan(HANDSHAKE_TIMEOUT_MS / 2);
      for (const s of sockets) s.destroy();
    });

    it("reassembles a line split across many chunks", async () => {
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      const replyPromise = waitForReply(socket);
      const payload = `{}\n${JSON.stringify({ id: 7, op: "ping" })}\n`;
      for (const ch of payload) {
        socket.write(ch);
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(await replyPromise).toEqual({ id: 7, ok: true, status: 200, result: { pong: true } });
      socket.destroy();
    });

    it("never logs any prefix of a mismatched handshake token, only its length", async () => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      app = await buildApp();
      await app.ready();
      const warn = vi.spyOn(app.log, "warn");
      const socket = await connect(app.pty.controlSocketPath);
      socket.write(`${JSON.stringify({ token: "SECRETPREFIX-rest-of-token" })}\n`);
      await waitForClose(socket);
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("invalid handshake");
      expect(logged).not.toContain("SECRETPR");
      expect(logged).toContain("length 26");
    });

    it("binds the socket under a 077 umask and restores the process umask", async () => {
      const original = process.umask();
      let umaskDuringListen: number | null = null;
      const realListen = net.Server.prototype.listen;
      const listenSpy = vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (
        this: net.Server,
        ...args: unknown[]
      ) {
        umaskDuringListen = process.umask();
        return (realListen as (...a: unknown[]) => net.Server).apply(this, args);
      } as never);
      try {
        app = await buildApp();
        await app.ready();
      } finally {
        listenSpy.mockRestore();
      }
      expect(umaskDuringListen! & 0o077).toBe(0o077);
      expect(process.umask()).toBe(original);
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

    it("trims MULLION_AUTH_TOKEN before comparing, matching HTTP's own trimmed check (Hermes review, security audit finding AS2)", async () => {
      // Before this fix, resolveHandshake compared the presented token
      // against the raw, untrimmed config value while every HTTP path
      // (isValidLoginToken/hasValidBearerToken, via configuredToken)
      // compared trimmed — so a token with trailing whitespace like
      // "test-auth-token-0123456789 " would authenticate over HTTP but be
      // rejected here, a third inconsistent reading of "the configured
      // token" alongside the two AS2 originally unified.
      process.env.MULLION_AUTH_TOKEN = `${TEST_TOKEN} `;
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
      socket.write(`${JSON.stringify({ id: 1, op: "projects.list" })}\n`);

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

  describe("auth enabled via OIDC only (no MULLION_AUTH_TOKEN)", () => {
    beforeEach(() => {
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      process.env.MULLION_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.MULLION_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.MULLION_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.MULLION_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
    });

    it("closes the connection on an empty handshake — there is no static full-scope secret to present", async () => {
      // docs/socket-api.md's own stated claim for this deployment shape:
      // isAuthEnabled() is true (OIDC alone is enough), but there is no
      // MULLION_AUTH_TOKEN to grant full scope, so an empty handshake is
      // rejected exactly like the token-based "auth enabled" describe block
      // above — only a live session's own hook token still works.
      app = await buildApp();
      await app.ready();
      const socket = await connect(app.pty.controlSocketPath);
      socket.write("{}\n");
      await waitForClose(socket);
      expect(socket.destroyed).toBe(true);
    });

    it("still grants session scope for a live session's hook token", async () => {
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
  });
});
