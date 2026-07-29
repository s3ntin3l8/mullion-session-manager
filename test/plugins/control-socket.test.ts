import { describe, it, expect, afterEach, beforeEach } from "vitest";
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
//
// Every spawned instance is captured here (not just created and discarded)
// so a scrollback-identity test can push real, distinguishable output
// through a specific session's PTY after the fact — see
// createRealSession's own doc comment below.
const fakePtyChildren: FakePty[] = [];

// Same reason as test/routes/agents.test.ts's own mock of this module —
// getCodexHookTrust() reads the real ~/.codex otherwise, which would make
// this file's agents.list/projects.actions tests (Phase 4 PR6) depend on
// whatever machine runs the suite.
vi.mock("../../src/services/hook-adapters/codex-trust.js", () => ({
  getCodexHookTrust: () => "pending" as const,
}));

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<() => void> = [];
  writeSpy = vi.fn();
  resizeSpy = vi.fn();
  constructor() {
    fakePtyChildren.push(this);
  }
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
  spawn: vi.fn(() => new FakePty()),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      ee.stdout = new EventEmitter();
      // Both "exit" and "close": the systemd-run/dtach bootstrap this mock
      // originally existed for only needs "exit", but agent-detect.ts's
      // probe() (now exercised by this file's own projects.actions/
      // agents.list tests, Phase 4 PR6) resolves off "close" specifically —
      // see that file's own comment on why "exit" alone isn't enough.
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.emit("close", 0);
      });
      return ee;
    }),
  };
});

// Minimal Playwright fake for the browser.* ops (Phase 4, #189) — just
// enough surface for executeBrowserAction/executeBrowserFind
// (browser-automation.ts) to run without a real Chromium, mirroring
// test/routes/browser-automation.test.ts's own (more exhaustive) fake at a
// smaller scale: these tests only need to prove the control-socket op
// dispatches to the real REST route and shapes the reply correctly, not
// re-verify every AgentAction variant that file already covers.
class FakeLocator {
  async ariaSnapshot() {
    return "- generic: Hello";
  }
  async all() {
    return [];
  }
}
class FakePage extends EventEmitter {
  currentUrl = "about:blank";
  async goto(url: string) {
    this.currentUrl = url;
  }
  url() {
    return this.currentUrl;
  }
  async title() {
    return "Test Page";
  }
  locator(_selector: string) {
    return new FakeLocator();
  }
  async evaluate(script: string) {
    // The snapshot fold-in (executeBrowserAction, browser-automation.ts)
    // always tags interactive elements via a script containing this marker
    // — anything else is an "eval" action's own arbitrary script, faked
    // here with a fixed, distinguishable return value.
    if (script.includes("data-mullion-ref")) return [];
    return "eval-result";
  }
  getByText() {
    return new FakeLocator();
  }
  getByRole() {
    return new FakeLocator();
  }
  getByLabel() {
    return new FakeLocator();
  }
  getByPlaceholder() {
    return new FakeLocator();
  }
  getByTestId() {
    return new FakeLocator();
  }
}
class FakeBrowser extends EventEmitter {
  isConnected() {
    return true;
  }
  async newContext() {
    return { newPage: async () => new FakePage(), storageState: async () => ({}) };
  }
  async close() {}
}
vi.mock("playwright", () => ({
  chromium: { launch: vi.fn(async () => new FakeBrowser()) },
}));

const { buildApp } = await import("../../src/app.js");
const { HANDSHAKE_TIMEOUT_MS, buildQueryUrl } = await import("../../src/plugins/control-socket.js");

const TEST_TOKEN = "test-auth-token-0123456789";
const TEST_SECRET = "test-session-secret-0123456789";
const TEST_OIDC_ISSUER = "https://idp.test";
const TEST_OIDC_CLIENT_ID = "test-oidc-client-id";
const TEST_OIDC_CLIENT_SECRET = "test-oidc-client-secret";
const TEST_OIDC_REDIRECT_URI = "https://mullion.test/api/auth/oidc/callback";

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

async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

/** Accumulates every complete newline-terminated line the server writes
 * back onto this socket, JSON-parsed, in arrival order — unlike
 * waitForReply (first line only), this is for asserting on a whole
 * sequence of frames (e.g. events.subscribe's ack arriving after any
 * already-buffered replay events it flushed first). */
function collectFrames(socket: net.Socket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      frames.push(JSON.parse(buffer.slice(0, newlineIndex)));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  return frames;
}

describe("buildQueryUrl", () => {
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
    // Give the handshake a moment to land so this is a genuinely "open,
    // authenticated" connection at close time, not one mid-handshake.
    await new Promise((resolve) => setImmediate(resolve));

    const closed = waitForClose(socket);
    await app.close();
    app = null;
    await closed;
    expect(socket.destroyed).toBe(true);
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

  describe("session lifecycle ops (Phase 4, #187)", () => {
    beforeEach(() => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
    });

    /** Creates a real project + session via the actual REST routes (not
     * app.pty.getOrCreate directly) so the DB row app.inject()'s dispatch
     * re-enters actually exists — createSessionRecord's spawn step still
     * registers the same in-memory PtyManager session (and hookToken) these
     * tests need for a session-scoped handshake. Also pushes a
     * session-id-tagged marker through the session's own FakePty once it's
     * spawned, so a scrollback test can assert it got back THIS session's
     * content, not just some non-empty base64 string (which the
     * getScrollback() preamble alone would already satisfy). */
    async function createRealSession(): Promise<{ sessionId: number; hookToken: string }> {
      // Direct app.inject() calls (not through the socket) still hit the
      // real global auth gate — MULLION_AUTH_TOKEN is set for every test in
      // this describe block, so setup here needs the same bearer header a
      // real authenticated client would send.
      const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
      const project = await app!.inject({
        method: "POST",
        url: "/api/projects",
        headers: authHeaders,
        payload: { name: "p", cwd: "/tmp" },
      });
      const before = fakePtyChildren.length;
      const created = await app!.inject({
        method: "POST",
        url: "/api/sessions",
        headers: authHeaders,
        payload: { projectId: project.json().id, command: "bash" },
      });
      const sessionId = created.json().id as number;
      const hookToken = app!.pty.get(String(sessionId))!.hookToken;
      await waitUntil(() => fakePtyChildren.length > before);
      fakePtyChildren[fakePtyChildren.length - 1].emitData(`scrollback-marker-${sessionId}\r\n`);
      return { sessionId, hookToken };
    }

    async function fullScopeSocket(): Promise<net.Socket> {
      const socket = await connect(app!.pty.controlSocketPath);
      socket.write(`${JSON.stringify({ token: TEST_TOKEN })}\n`);
      return socket;
    }

    async function sessionScopeSocket(hookToken: string): Promise<net.Socket> {
      const socket = await connect(app!.pty.controlSocketPath);
      socket.write(`${JSON.stringify({ token: hookToken })}\n`);
      return socket;
    }

    describe("sessions.get", () => {
      it("full scope: returns the session by explicit sessionId", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId } })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.status).toBe(200);
        expect((reply.result as { id: number }).id).toBe(sessionId);
        socket.destroy();
      });

      it("full scope: 400s with no sessionId — a full-scope connection has no implicit self", async () => {
        app = await buildApp();
        await app.ready();
        await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.get" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'sessionId' is required" });
        socket.destroy();
      });

      it("full scope: 400s with an empty-string sessionId, treated the same as omitted rather than a literal target", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId: "" } })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'sessionId' is required" });
        socket.destroy();
      });

      it("session scope: defaults to the connection's own pinned session with no sessionId given", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId, hookToken } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.get" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect((reply.result as { id: number }).id).toBe(sessionId);
        socket.destroy();
      });

      it("session scope: an explicit sessionId matching its own pin also works", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId, hookToken } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId } })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        socket.destroy();
      });

      it("session scope: rejects targeting a DIFFERENT session id", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const { sessionId: otherSessionId } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId: otherSessionId } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 403,
          error: "session-scoped connections may only target their own session",
        });
        socket.destroy();
      });

      it("full scope: 404s for an unknown session id, same as the REST route", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.get", body: { sessionId: 999999 } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(false);
        expect(reply.status).toBe(404);
        socket.destroy();
      });
    });

    describe("sessions.scrollback", () => {
      it("full scope: returns a base64 scrollback buffer for an explicit sessionId, containing that session's own output", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.scrollback", body: { sessionId } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        const { b64 } = reply.result as { b64: string };
        expect(typeof b64).toBe("string");
        expect(Buffer.from(b64, "base64").toString("utf8")).toContain(
          `scrollback-marker-${sessionId}`,
        );
        socket.destroy();
      });

      it("session scope: defaults to its own pinned session with no sessionId given, returning that session's own output", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId, hookToken } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.scrollback" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        const { b64 } = reply.result as { b64: string };
        expect(Buffer.from(b64, "base64").toString("utf8")).toContain(
          `scrollback-marker-${sessionId}`,
        );
        socket.destroy();
      });

      it("session scope: rejects targeting a different session id", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const { sessionId: otherSessionId } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.scrollback", body: { sessionId: otherSessionId } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(false);
        expect(reply.status).toBe(403);
        socket.destroy();
      });
    });

    describe("sessions.rename", () => {
      it("full scope: renames by explicit sessionId", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.rename", body: { sessionId, name: "renamed" } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect((reply.result as { name: string }).name).toBe("renamed");
        socket.destroy();
      });

      it("session scope: renames its own pinned session with no sessionId given", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.rename", body: { name: "self" } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect((reply.result as { name: string }).name).toBe("self");
        socket.destroy();
      });

      it("400s when 'name' is missing", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.rename", body: { sessionId } })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'name' is required" });
        socket.destroy();
      });

      it("session scope: rejects renaming a different session id", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const { sessionId: otherSessionId } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.rename", body: { sessionId: otherSessionId, name: "x" } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(false);
        expect(reply.status).toBe(403);
        socket.destroy();
      });
    });

    describe("sessions.create", () => {
      it("full scope: creates a session", async () => {
        app = await buildApp();
        await app.ready();
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
          payload: { name: "p2", cwd: "/tmp" },
        });
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "sessions.create",
            body: { projectId: project.json().id, command: "bash" },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.status).toBe(201);
        socket.destroy();
      });

      it("reshapes the REST route's own validation error (missing projectId) into the socket's error envelope", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.create", body: { command: "bash" } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(false);
        expect(reply.status).toBe(400);
        expect(typeof reply.error).toBe("string");
        socket.destroy();
      });

      it("session scope: rejected — full-scope-only op", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.create", body: { projectId: 1, command: "bash" } })}\n`,
        );
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

    describe("sessions.kill", () => {
      it("full scope: kills by explicit sessionId", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.kill", body: { sessionId } })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({ id: 1, ok: true, status: 204, result: "" });
        socket.destroy();
      });

      it("full scope: 400s with no sessionId", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.kill" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'sessionId' is required" });
        socket.destroy();
      });

      it("full scope: 400s with an empty-string sessionId, rather than reaching app.inject() with an empty path segment", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.kill", body: { sessionId: "" } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'sessionId' is required" });
        socket.destroy();
      });

      it("session scope: rejected — a session may not kill itself or any other session through this socket", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId, hookToken } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.kill", body: { sessionId } })}\n`);
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

    describe("PTY I/O ops (Phase 4, #186)", () => {
      it("full scope: a successful attach has no separate ack — its own scrollback-replay data frame IS the success signal", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();

        // createRealSession already pushed a marker through this session's
        // FakePty (see its own doc comment) BEFORE this attach — the
        // scrollback ring buffer, not live data, is what the attach itself
        // replays first (attachSocketToSession's own getScrollback() call),
        // so that marker must appear on the very first stream frame, with
        // no ok:true reply preceding or following it.
        const framePromise = new Promise<Record<string, unknown>>((resolve) => {
          let buffer = "";
          socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex !== -1) resolve(JSON.parse(buffer.slice(0, newlineIndex)));
          });
        });
        socket.write(
          `${JSON.stringify({ id: 42, op: "sessions.attach", body: { sessionId, cols: 100, rows: 40 } })}\n`,
        );
        const frame = await framePromise;
        expect(frame.id).toBe(42);
        expect(frame.type).toBe("data");
        expect(frame.ok).toBeUndefined();
        const decoded = Buffer.from(frame.b64 as string, "base64").toString("utf8");
        expect(decoded).toContain(`scrollback-marker-${sessionId}`);
        socket.destroy();
      });

      it("session scope: attaches to its own pinned session with no sessionId given", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId, hookToken } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        const framePromise = waitForReply(socket);
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach" })}\n`);
        const frame = await framePromise;
        expect(frame.id).toBe(1);
        expect(frame.type).toBe("data");
        const decoded = Buffer.from(frame.b64 as string, "base64").toString("utf8");
        expect(decoded).toContain(`scrollback-marker-${sessionId}`);
        socket.destroy();
      });

      it("session scope: rejects attaching to a different session id", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const { sessionId: otherSessionId } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: otherSessionId } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 403,
          error: "session-scoped connections may only target their own session",
        });
        socket.destroy();
      });

      it("400s attaching to an unknown session id, reusing resolveAndAttach's own error", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: 999999 } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(false);
        expect(reply.status).toBe(404);
        socket.destroy();
      });

      it("400s attaching with a non-numeric session id instead of a confusing 404", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: "not-a-number" } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "sessionId must be an integer",
        });
        socket.destroy();
      });

      it("400s re-attaching the same stream id without detaching first", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 5, op: "sessions.attach", body: { sessionId } })}\n`);
        await waitForReply(socket);

        const secondReply = new Promise<Record<string, unknown>>((resolve) => {
          let buffer = "";
          socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const lines = buffer.split("\n").filter(Boolean);
            for (const line of lines) {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed.error === "a stream is already open for this id") resolve(parsed);
            }
          });
        });
        socket.write(`${JSON.stringify({ id: 5, op: "sessions.attach", body: { sessionId } })}\n`);
        expect(await secondReply).toEqual({
          id: 5,
          ok: false,
          status: 400,
          error: "a stream is already open for this id",
        });
        socket.destroy();
      });

      it("sessions.input writes decoded bytes to the session's PTY, silently (no reply) on success", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const child = fakePtyChildren[fakePtyChildren.length - 1];
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
        await waitForReply(socket);

        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.input", body: { b64: Buffer.from("ls\n").toString("base64") } })}\n`,
        );
        await waitUntil(() => child.writeSpy.mock.calls.length > 0);
        expect(child.writeSpy).toHaveBeenCalledWith("ls\n");
        socket.destroy();
      });

      it("sessions.input 400s with no open stream for the given id", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.input", body: { b64: "aGk=" } })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "no open stream for this id",
        });
        socket.destroy();
      });

      it("sessions.resize calls the session's own resize, silently (no reply) on success", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const child = fakePtyChildren[fakePtyChildren.length - 1];
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
        await waitForReply(socket);

        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.resize", body: { cols: 120, rows: 45 } })}\n`,
        );
        await waitUntil(() => child.resizeSpy.mock.calls.length > 0);
        expect(child.resizeSpy).toHaveBeenCalledWith(120, 45);
        socket.destroy();
      });

      it("sessions.resize 400s when cols/rows are missing", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
        await waitForReply(socket);

        socket.write(`${JSON.stringify({ id: 1, op: "sessions.resize" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "'cols' and 'rows' are required",
        });
        socket.destroy();
      });

      it("sessions.resize 400s on a non-finite cols/rows instead of silently no-oping downstream (Hermes review, PR #399)", async () => {
        // `1e400` is valid JSON syntax (an ordinary number literal with a
        // large exponent) that JSON.parse overflows to Infinity — still
        // `typeof "number"`, so it must be rejected explicitly here.
        // (JSON.stringify({cols: Infinity}) would render `null` on the
        // client side before ever hitting the wire, which is why this test
        // builds the wire line by hand instead of stringifying a JS object
        // containing a literal Infinity.)
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const child = fakePtyChildren[fakePtyChildren.length - 1];
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
        await waitForReply(socket);

        socket.write('{"id":1,"op":"sessions.resize","body":{"cols":1e400,"rows":10}}\n');
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "'cols' and 'rows' are required",
        });
        expect(child.resizeSpy).not.toHaveBeenCalled();
        socket.destroy();
      });

      it("sessions.detach ends the stream and a follow-up input/resize on the same id 400s", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
        await waitForReply(socket);

        socket.write(`${JSON.stringify({ id: 1, op: "sessions.detach" })}\n`);
        const detachReply = await waitForReply(socket);
        expect(detachReply).toEqual({ id: 1, ok: true, status: 200 });

        socket.write(
          `${JSON.stringify({ id: 1, op: "sessions.resize", body: { cols: 10, rows: 10 } })}\n`,
        );
        const afterDetach = await waitForReply(socket);
        expect(afterDetach).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "no open stream for this id",
        });
        socket.destroy();
      });

      it("sessions.detach 400s with no open stream for the given id", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.detach" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "no open stream for this id",
        });
        socket.destroy();
      });

      it("closing the whole connection detaches every still-open stream (attachSocketToSession's own close cleanup runs)", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const child = fakePtyChildren[fakePtyChildren.length - 1];
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId } })}\n`);
        await waitForReply(socket);

        socket.destroy();
        await waitForClose(socket);

        // The session itself is never killed by a connection drop — same
        // "detach ≠ kill" posture as /ws/terminal's own socket close
        // handler — so its master keeps running (nothing to assert on the
        // fake PTY's kill() here, only that this doesn't throw and the
        // process stays otherwise healthy).
        expect(child.writeSpy).toBeDefined();
      });

      it("openChannels is scoped per-connection, not global — two connections reusing the same stream id never cross-talk", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId: sessionA } = await createRealSession();
        const childA = fakePtyChildren[fakePtyChildren.length - 1];
        const { sessionId: sessionB } = await createRealSession();
        const childB = fakePtyChildren[fakePtyChildren.length - 1];

        // Both connections deliberately reuse the same request/stream id (1)
        // — if openChannels were ever hoisted to a connection-independent
        // registry, the second attach would collide with (or overwrite) the
        // first instead of opening its own independent stream.
        const socketA = await fullScopeSocket();
        socketA.write(
          `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: sessionA } })}\n`,
        );
        await waitForReply(socketA);

        const socketB = await fullScopeSocket();
        socketB.write(
          `${JSON.stringify({ id: 1, op: "sessions.attach", body: { sessionId: sessionB } })}\n`,
        );
        await waitForReply(socketB);

        socketA.write(
          `${JSON.stringify({ id: 1, op: "sessions.input", body: { b64: Buffer.from("from-a\n").toString("base64") } })}\n`,
        );
        await waitUntil(() => childA.writeSpy.mock.calls.length > 0);
        expect(childA.writeSpy).toHaveBeenCalledWith("from-a\n");
        expect(childB.writeSpy).not.toHaveBeenCalled();

        // Detaching connection A's stream 1 must not touch connection B's
        // own, independently-tracked stream 1.
        socketA.write(`${JSON.stringify({ id: 1, op: "sessions.detach" })}\n`);
        expect(await waitForReply(socketA)).toEqual({ id: 1, ok: true, status: 200 });

        socketB.write(
          `${JSON.stringify({ id: 1, op: "sessions.resize", body: { cols: 90, rows: 30 } })}\n`,
        );
        await waitUntil(() => childB.resizeSpy.mock.calls.length > 0);
        expect(childB.resizeSpy).toHaveBeenCalledWith(90, 30);

        socketA.destroy();
        socketB.destroy();
      });
    });

    describe("notification events ops (Phase 4, #188)", () => {
      it("events.subscribe (full scope): replays already-buffered events, then acks, then streams live ones", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const child = fakePtyChildren[fakePtyChildren.length - 1];
        // Buffered BEFORE the subscribe — must still show up in the replay
        // batch, same "reconstructs what happened while unwatched"
        // guarantee /ws/events's own WS route already gives.
        child.emitData("\x1b]2;working\x07");

        const socket = await fullScopeSocket();
        const frames = collectFrames(socket);
        socket.write(`${JSON.stringify({ id: 11, op: "events.subscribe" })}\n`);

        await waitUntil(() => frames.some((f) => f.ok === true));
        const ackIndex = frames.findIndex((f) => f.ok === true);
        expect(frames[ackIndex]).toEqual({ id: 11, ok: true, status: 200 });
        // The replay event arrived BEFORE the ack — attaching flushes any
        // already-buffered events synchronously, before this handler ever
        // calls reply().
        const replayEvent = frames.slice(0, ackIndex).find((f) => f.kind === "title_change");
        expect(replayEvent).toMatchObject({ id: 11, sessionId, kind: "title_change" });

        child.emitData("\x1b]2;still-working\x07");
        await waitUntil(() =>
          frames.slice(ackIndex + 1).some((f) => f.kind === "title_change" && f.seq === 2),
        );
        socket.destroy();
      });

      it("events.subscribe (session scope): filtered to only the connection's own pinned session", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId: sessionA, hookToken } = await createRealSession();
        const childA = fakePtyChildren[fakePtyChildren.length - 1];
        const { sessionId: sessionB } = await createRealSession();
        const childB = fakePtyChildren[fakePtyChildren.length - 1];

        const socket = await sessionScopeSocket(hookToken);
        const frames = collectFrames(socket);
        socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
        await waitUntil(() => frames.some((f) => f.ok === true));

        childA.emitData("\x1b]2;from-a\x07");
        childB.emitData("\x1b]2;from-b\x07");
        await waitUntil(() => frames.some((f) => f.kind === "title_change"));

        // Give any (incorrect) cross-session delivery a chance to arrive
        // before asserting only session A's event ever showed up.
        await new Promise((resolve) => setImmediate(resolve));
        const titleChanges = frames.filter((f) => f.kind === "title_change");
        expect(titleChanges.every((f) => f.sessionId === sessionA)).toBe(true);
        expect(titleChanges.some((f) => f.sessionId === sessionB)).toBe(false);
        socket.destroy();
      });

      it("400s re-subscribing on the same id without unsubscribing first", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
        await waitForReply(socket);

        socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "a stream is already open for this id",
        });
        socket.destroy();
      });

      it("events.seen forwards to app.pty.markEventsSeen, silently on success (no reply)", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const markEventsSeenSpy = vi.spyOn(app.pty, "markEventsSeen");
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
        await waitForReply(socket);

        socket.write(
          `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId, seq: 3 } })}\n`,
        );
        await waitUntil(() => markEventsSeenSpy.mock.calls.length > 0);
        expect(markEventsSeenSpy).toHaveBeenCalledWith(String(sessionId), 3);
        socket.destroy();
      });

      it("events.seen (session scope): naming the connection's own pinned sessionId reaches markEventsSeen (Hermes review, PR #400)", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId, hookToken } = await createRealSession();
        const markEventsSeenSpy = vi.spyOn(app.pty, "markEventsSeen");
        const socket = await sessionScopeSocket(hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
        await waitForReply(socket);

        socket.write(
          `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId, seq: 2 } })}\n`,
        );
        await waitUntil(() => markEventsSeenSpy.mock.calls.length > 0);
        expect(markEventsSeenSpy).toHaveBeenCalledWith(String(sessionId), 2);
        socket.destroy();
      });

      it("events.seen (session scope): naming a DIFFERENT session's id is silently ignored by attachLocalEventsSocket's own filter", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const { sessionId: otherSessionId } = await createRealSession();
        const markEventsSeenSpy = vi.spyOn(app.pty, "markEventsSeen");
        const socket = await sessionScopeSocket(hookToken);
        socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
        await waitForReply(socket);

        socket.write(
          `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId: otherSessionId, seq: 1 } })}\n`,
        );
        // No reply is expected either way (events.seen is silent on
        // success) — the assertion is that the OTHER session's cursor was
        // never advanced, not that this op itself errored.
        await new Promise((resolve) => setImmediate(resolve));
        expect(markEventsSeenSpy).not.toHaveBeenCalled();
        socket.destroy();
      });

      it("events.seen 400s with no open stream for the given id", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId: 1, seq: 1 } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "no open stream for this id",
        });
        socket.destroy();
      });

      it("events.seen 400s on missing or non-finite sessionId/seq", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
        await waitForReply(socket);

        socket.write(`${JSON.stringify({ id: 1, op: "events.seen" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "'sessionId' and 'seq' must be finite numbers",
        });

        // 1e400 is valid JSON syntax that JSON.parse overflows to Infinity
        // — still typeof "number", same edge case as sessions.resize's own
        // Number.isFinite guard (Hermes review, PR #399).
        socket.write('{"id":1,"op":"events.seen","body":{"sessionId":1e400,"seq":1}}\n');
        const secondReply = await waitForReply(socket);
        expect(secondReply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "'sessionId' and 'seq' must be finite numbers",
        });
        socket.destroy();
      });

      it("events.unsubscribe ends the stream and a follow-up events.seen on the same id 400s", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
        await waitForReply(socket);

        socket.write(`${JSON.stringify({ id: 1, op: "events.unsubscribe" })}\n`);
        expect(await waitForReply(socket)).toEqual({ id: 1, ok: true, status: 200 });

        socket.write(
          `${JSON.stringify({ id: 1, op: "events.seen", body: { sessionId: 1, seq: 1 } })}\n`,
        );
        const afterUnsubscribe = await waitForReply(socket);
        expect(afterUnsubscribe).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "no open stream for this id",
        });
        socket.destroy();
      });

      it("events.unsubscribe 400s with no open stream for the given id", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "events.unsubscribe" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "no open stream for this id",
        });
        socket.destroy();
      });

      it("an events.subscribe stream and a sessions.attach stream can be open concurrently on distinct ids without cross-talk", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const child = fakePtyChildren[fakePtyChildren.length - 1];
        const socket = await fullScopeSocket();
        const frames = collectFrames(socket);

        socket.write(`${JSON.stringify({ id: 1, op: "events.subscribe" })}\n`);
        await waitUntil(() => frames.some((f) => f.id === 1 && f.ok === true));

        socket.write(`${JSON.stringify({ id: 2, op: "sessions.attach", body: { sessionId } })}\n`);
        await waitUntil(() => frames.some((f) => f.id === 2 && f.type === "data"));

        child.emitData("\x1b]2;live\x07");
        await waitUntil(() => frames.some((f) => f.id === 1 && f.kind === "title_change"));
        expect(frames.some((f) => f.id === 2 && f.kind === "title_change")).toBe(false);
        socket.destroy();
      });
    });

    describe("browser ops (Phase 4, #189)", () => {
      beforeEach(() => {
        process.env.BROWSER_ENABLED = "true";
      });
      afterEach(() => {
        delete process.env.BROWSER_ENABLED;
      });

      it("browser.action (full scope): dispatches to POST /api/sessions/:id/browser and shapes the response", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "browser.action",
            body: { sessionId, action: "navigate", url: "http://example.com/" },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.status).toBe(200);
        expect(reply.result).toMatchObject({ ok: true, url: "http://example.com/" });
        socket.destroy();
      });

      it("browser.action (session scope): omits sessionId, defaults to the connection's own pinned session", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "browser.action", body: { action: "snapshot" } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        socket.destroy();
      });

      it("browser.action (session scope): naming a DIFFERENT session's id gets a 403, never a silent redirect", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const { sessionId: otherSessionId } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "browser.action",
            body: { sessionId: otherSessionId, action: "snapshot" },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 403,
          error: "session-scoped connections may only target their own session",
        });
        socket.destroy();
      });

      it("browser.action (full scope): a non-navigate action (eval) forwards its own body fields correctly", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "browser.action",
            body: { sessionId, action: "eval", script: "1+1" },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.result).toMatchObject({ result: "eval-result" });
        socket.destroy();
      });

      it("browser.action 400s when BROWSER_ENABLED is false", async () => {
        delete process.env.BROWSER_ENABLED;
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "browser.action",
            body: { sessionId, action: "snapshot" },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(false);
        expect(reply.status).toBe(400);
        socket.destroy();
      });

      it("browser.find (full scope): dispatches to POST /api/sessions/:id/browser/find", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "browser.find",
            body: { sessionId, by: "text", value: "Submit" },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.result).toMatchObject({ ok: true, matchCount: 0, elements: [] });
        socket.destroy();
      });

      it("browser.find (session scope): naming a DIFFERENT session's id gets a 403", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const { sessionId: otherSessionId } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({
            id: 1,
            op: "browser.find",
            body: { sessionId: otherSessionId, by: "text", value: "x" },
          })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 403,
          error: "session-scoped connections may only target their own session",
        });
        socket.destroy();
      });

      it("browser.bindings (full scope): dispatches to GET /api/sessions/:id/browser", async () => {
        app = await buildApp();
        await app.ready();
        const { sessionId } = await createRealSession();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "browser.bindings", body: { sessionId } })}\n`);
        const reply = await waitForReply(socket);
        expect(reply.ok).toBe(true);
        expect(reply.result).toEqual([]);
        socket.destroy();
      });

      it("browser.bindings (full scope): 400s when sessionId is omitted", async () => {
        app = await buildApp();
        await app.ready();
        const socket = await fullScopeSocket();
        socket.write(`${JSON.stringify({ id: 1, op: "browser.bindings" })}\n`);
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 400,
          error: "'sessionId' is required",
        });
        socket.destroy();
      });

      it("browser.bindings (session scope): naming a DIFFERENT session's id gets a 403, never a silent redirect", async () => {
        app = await buildApp();
        await app.ready();
        const { hookToken } = await createRealSession();
        const { sessionId: otherSessionId } = await createRealSession();
        const socket = await sessionScopeSocket(hookToken);
        socket.write(
          `${JSON.stringify({ id: 1, op: "browser.bindings", body: { sessionId: otherSessionId } })}\n`,
        );
        const reply = await waitForReply(socket);
        expect(reply).toEqual({
          id: 1,
          ok: false,
          status: 403,
          error: "session-scoped connections may only target their own session",
        });
        socket.destroy();
      });
    });

    describe("project/preview/agent ops (Phase 4, #134 PR6)", () => {
      describe("projects.actions", () => {
        it("full scope: dispatches to GET /api/projects/:id/actions with an explicit projectId", async () => {
          app = await buildApp();
          await app.ready();
          const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
          const project = await app.inject({
            method: "POST",
            url: "/api/projects",
            headers: authHeaders,
            payload: { name: "p", cwd: "/tmp" },
          });
          const socket = await fullScopeSocket();
          socket.write(
            `${JSON.stringify({ id: 1, op: "projects.actions", body: { projectId: project.json().id } })}\n`,
          );
          const reply = await waitForReply(socket);
          expect(reply.ok).toBe(true);
          expect(Array.isArray(reply.result)).toBe(true);
          socket.destroy();
        });

        it("full scope: 400s with no projectId", async () => {
          app = await buildApp();
          await app.ready();
          const socket = await fullScopeSocket();
          socket.write(`${JSON.stringify({ id: 1, op: "projects.actions" })}\n`);
          const reply = await waitForReply(socket);
          expect(reply).toEqual({
            id: 1,
            ok: false,
            status: 400,
            error: "'projectId' is required",
          });
          socket.destroy();
        });

        it("session scope: defaults to its own pinned session's project with no projectId given", async () => {
          app = await buildApp();
          await app.ready();
          const { hookToken } = await createRealSession();
          const socket = await sessionScopeSocket(hookToken);
          socket.write(`${JSON.stringify({ id: 1, op: "projects.actions" })}\n`);
          const reply = await waitForReply(socket);
          expect(reply.ok).toBe(true);
          expect(Array.isArray(reply.result)).toBe(true);
          socket.destroy();
        });

        it("session scope: rejects targeting a DIFFERENT project id", async () => {
          app = await buildApp();
          await app.ready();
          const { hookToken } = await createRealSession();
          const otherProject = await app.inject({
            method: "POST",
            url: "/api/projects",
            headers: { authorization: `Bearer ${TEST_TOKEN}` },
            payload: { name: "other", cwd: "/tmp/other" },
          });
          const socket = await sessionScopeSocket(hookToken);
          socket.write(
            `${JSON.stringify({ id: 1, op: "projects.actions", body: { projectId: otherProject.json().id } })}\n`,
          );
          const reply = await waitForReply(socket);
          expect(reply).toEqual({
            id: 1,
            ok: false,
            status: 403,
            error: "session-scoped connections may only target their own session's project",
          });
          socket.destroy();
        });
      });

      describe("projects.dock", () => {
        it("full scope: dispatches to GET /api/projects/:id/dock", async () => {
          app = await buildApp();
          await app.ready();
          const project = await app.inject({
            method: "POST",
            url: "/api/projects",
            headers: { authorization: `Bearer ${TEST_TOKEN}` },
            payload: { name: "p", cwd: "/tmp" },
          });
          const socket = await fullScopeSocket();
          socket.write(
            `${JSON.stringify({ id: 1, op: "projects.dock", body: { projectId: project.json().id } })}\n`,
          );
          const reply = await waitForReply(socket);
          expect(reply.ok).toBe(true);
          expect(Array.isArray(reply.result)).toBe(true);
          socket.destroy();
        });

        it("full scope: 400s with no projectId", async () => {
          app = await buildApp();
          await app.ready();
          const socket = await fullScopeSocket();
          socket.write(`${JSON.stringify({ id: 1, op: "projects.dock" })}\n`);
          const reply = await waitForReply(socket);
          expect(reply).toEqual({
            id: 1,
            ok: false,
            status: 400,
            error: "'projectId' is required",
          });
          socket.destroy();
        });

        it("session scope: rejected — full-scope-only op", async () => {
          app = await buildApp();
          await app.ready();
          const { hookToken } = await createRealSession();
          const socket = await sessionScopeSocket(hookToken);
          socket.write(`${JSON.stringify({ id: 1, op: "projects.dock" })}\n`);
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

      describe("previews.create / .get / .delete", () => {
        beforeEach(() => {
          process.env.PREVIEW_BASE_HOST = "preview.example.com";
        });

        it("full scope: creates an external preview and can get/delete it by slug", async () => {
          app = await buildApp();
          await app.ready();
          const socket = await fullScopeSocket();
          socket.write(
            `${JSON.stringify({
              id: 1,
              op: "previews.create",
              body: { kind: "external", url: "https://example.com" },
            })}\n`,
          );
          const createReply = await waitForReply(socket);
          expect(createReply.ok).toBe(true);
          expect(createReply.status).toBe(201);
          const slug = (createReply.result as { slug: string }).slug;
          expect(typeof slug).toBe("string");
          socket.destroy();

          const getSocket = await fullScopeSocket();
          getSocket.write(`${JSON.stringify({ id: 2, op: "previews.get", body: { slug } })}\n`);
          const getReply = await waitForReply(getSocket);
          expect(getReply.ok).toBe(true);
          expect((getReply.result as { slug: string }).slug).toBe(slug);
          getSocket.destroy();

          const deleteSocket = await fullScopeSocket();
          deleteSocket.write(
            `${JSON.stringify({ id: 3, op: "previews.delete", body: { slug } })}\n`,
          );
          const deleteReply = await waitForReply(deleteSocket);
          expect(deleteReply.ok).toBe(true);
          expect(deleteReply.status).toBe(204);
          deleteSocket.destroy();
        });

        it("previews.get: 400s with no slug", async () => {
          app = await buildApp();
          await app.ready();
          const socket = await fullScopeSocket();
          socket.write(`${JSON.stringify({ id: 1, op: "previews.get" })}\n`);
          const reply = await waitForReply(socket);
          expect(reply).toEqual({ id: 1, ok: false, status: 400, error: "'slug' is required" });
          socket.destroy();
        });

        it("previews.get: 404s for an unknown slug, reshaped from the REST route", async () => {
          app = await buildApp();
          await app.ready();
          const socket = await fullScopeSocket();
          socket.write(
            `${JSON.stringify({ id: 1, op: "previews.get", body: { slug: "nonexistent" } })}\n`,
          );
          const reply = await waitForReply(socket);
          expect(reply.ok).toBe(false);
          expect(reply.status).toBe(404);
          socket.destroy();
        });

        it("session scope: previews.create is rejected — full-scope-only op", async () => {
          app = await buildApp();
          await app.ready();
          const { hookToken } = await createRealSession();
          const socket = await sessionScopeSocket(hookToken);
          socket.write(
            `${JSON.stringify({
              id: 1,
              op: "previews.create",
              body: { kind: "external", url: "https://example.com" },
            })}\n`,
          );
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

      describe("agents.list", () => {
        it("full scope: dispatches to GET /api/agents", async () => {
          app = await buildApp();
          await app.ready();
          const socket = await fullScopeSocket();
          socket.write(`${JSON.stringify({ id: 1, op: "agents.list" })}\n`);
          const reply = await waitForReply(socket);
          expect(reply.ok).toBe(true);
          expect(reply.status).toBe(200);
          socket.destroy();
        });

        it("session scope: rejected — full-scope-only op", async () => {
          app = await buildApp();
          await app.ready();
          const { hookToken } = await createRealSession();
          const socket = await sessionScopeSocket(hookToken);
          socket.write(`${JSON.stringify({ id: 1, op: "agents.list" })}\n`);
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
