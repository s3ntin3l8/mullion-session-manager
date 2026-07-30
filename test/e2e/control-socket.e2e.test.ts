import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { statSync } from "node:fs";

// Issue #407's checklist items that test/plugins/control-socket.test.ts
// already covers logically (via app.inject()'s own request pipeline) but
// never against a real, minute-long burst of real socket traffic, or with a
// standalone assertion on the socket's real on-disk permission bits:
//
//   - "confirm `stat -c '%a'` on the socket is `600`"
//   - "`mullion ps` in a tight loop does not 429 (rate-limit allowList)"
//   - "`grep -r MULLION_AUTH_TOKEN` over a spawned session's env confirms
//     the scrub holds" — done directly against buildSessionEnv() rather
//     than by shelling into a real spawned process's /proc (see that
//     function's own module for why: it's a pure, synchronously-testable
//     transform, and this file's other cases already prove the real socket
//     transport around it works).
const { buildApp } = await import("../../src/app.js");
const { buildSessionEnv, SERVER_ENV_KEYS } = await import("../../src/services/session-env.js");

function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Accumulates every complete newline-terminated line the server writes
 * back onto this socket, JSON-parsed, in arrival order. */
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

async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("control socket — raw wire-level checks (issue #407)", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it("handshakes and answers ping over a real Unix socket connection", async () => {
    app = await buildApp();
    await app.ready();
    const socket = await connect(app.pty.controlSocketPath);
    const frames = collectFrames(socket);
    socket.write("{}\n");
    socket.write(`${JSON.stringify({ id: 1, op: "ping" })}\n`);

    await waitUntil(() => frames.length > 0);
    expect(frames[0]).toEqual({ id: 1, ok: true, status: 200, result: { pong: true } });
    socket.destroy();
  });

  it("creates the socket file with real on-disk mode 0600, checked directly with statSync", async () => {
    app = await buildApp();
    await app.ready();
    const socket = await connect(app.pty.controlSocketPath);
    socket.destroy();

    const mode = statSync(app.pty.controlSocketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("a real >100-call-in-a-minute burst of sessions.list does not 429 (rate-limit allowList)", async () => {
    app = await buildApp();
    await app.ready();
    const socket = await connect(app.pty.controlSocketPath);
    const frames = collectFrames(socket);
    socket.write("{}\n");

    // Comfortably over app.config.RATE_LIMIT_MAX's default of 100/minute —
    // every one of these calls actually re-enters Fastify's real request
    // pipeline via app.inject() (unlike `ping`, which never touches
    // app.inject() at all and so proves nothing about the rate limiter).
    const CALL_COUNT = 150;
    for (let i = 1; i <= CALL_COUNT; i++) {
      socket.write(`${JSON.stringify({ id: i, op: "sessions.list" })}\n`);
    }

    await waitUntil(() => frames.length >= CALL_COUNT);
    const statuses = new Set(frames.map((f) => f.status));
    expect(statuses.has(429)).toBe(false);
    expect(frames.every((f) => f.ok === true)).toBe(true);
    socket.destroy();
  });

  it("buildSessionEnv scrubs MULLION_AUTH_TOKEN (and the rest of SERVER_ENV_KEYS) from a spawned session's env", () => {
    const fakeServerEnv = {
      PATH: "/usr/bin",
      MULLION_AUTH_TOKEN: "test-auth-token-0123456789",
      MULLION_SESSION_SECRET: "test-session-secret-0123456789",
      DATABASE_URL: "file:/should/not/leak.db",
    };

    const sessionEnv = buildSessionEnv(fakeServerEnv);

    expect(sessionEnv.MULLION_AUTH_TOKEN).toBeUndefined();
    for (const key of SERVER_ENV_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(sessionEnv, key)).toBe(false);
    }
    // Non-Mullion-owned vars pass through untouched.
    expect(sessionEnv.PATH).toBe("/usr/bin");
  });
});
