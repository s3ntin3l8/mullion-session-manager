import fp from "fastify-plugin";
import type { FastifyInstance, InjectOptions } from "fastify";
import net from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import {
  parseControlMessage,
  parseControlHandshake,
  type ControlMessage,
} from "../services/control-protocol.js";
import { isAuthEnabled, createSessionCookieValue, SESSION_COOKIE_NAME } from "../services/auth.js";
import { timingSafeTokenMatch } from "../services/crypto-utils.js";
import { CONTROL_SOCKET_ADDR } from "../services/control-socket-addr.js";

// Phase 4 (#185) — a general-purpose Unix control socket: the transport
// behind the `mullion` CLI (#134/#190) and any other local script that wants
// session/browser/event access without an HTTP base URL or bearer token.
// Modeled directly on src/plugins/hooks.ts's shape (stale-unlink → listen →
// chmod 0600 → decorate → onClose teardown, line-buffered NDJSON with a
// byte-cap) but a different protocol and a different auth principal — see
// docs/socket-api.md for the full wire-protocol writeup.
//
// Dispatch is deliberately NOT a hand-rolled reimplementation of each
// route's logic: every request/response op re-enters Fastify via
// app.inject() against the real REST route, so this socket inherits ajv
// validation, multi-host RemoteHostClient proxying, and every side effect
// (worktree cleanup, browser-binding bookkeeping, live-status merge) for
// free, with zero drift risk. "The socket is not a separate API — it's an
// alternative transport" (docs/roadmap.md's Phase 4 design note) is
// structural here, not just a stated intention.
//
// Registered only for the primary role: an "agent" process has no
// dbPlugin and none of the /api/* routes this dispatches into (see
// src/app.ts's role branch) — app.inject() against them would just 404.

// Larger than hooks.ts's 64 KiB cap: base64'd scrollback replay and
// screenshot payloads travel on this socket (added in later Phase 4 PRs),
// and SCROLLBACK_MAX_BYTES (pty-manager.ts) is already 1 MiB before the
// ~33% base64 inflation — see docs/socket-api.md's framing section.
const MAX_LINE_BYTES = 2 * 1024 * 1024;

type Scope = "full" | "session";

interface ConnectionState {
  readonly socket: net.Socket;
  scope: Scope;
  /** Set only for scope "session" — the connection is pinned to this
   * session id for the lifetime of the connection (see resolveHandshake). */
  sessionId: string | null;
}

interface ReplyPayload {
  ok: boolean;
  status?: number;
  result?: unknown;
  error?: string;
}

interface OpContext {
  app: FastifyInstance;
  conn: ConnectionState;
  body: Record<string, unknown> | undefined;
  reply: (payload: ReplyPayload) => void;
}

interface OpSpec {
  /** Which connection scopes may invoke this op — see the plan's per-scope
   * allowlist: MULLION_SOCKET_PATH is injected into every spawned session,
   * so a session-scoped connection must never reach an op a full-scope
   * operator credential alone should gate (same env-leak class the roadmap's
   * "Security & trust" design note warns about for the hook socket). */
  scopes: readonly Scope[];
  handler: (ctx: OpContext) => Promise<void> | void;
}

function send(socket: net.Socket, message: { id: number | null } & Record<string, unknown>): void {
  if (!socket.writable) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

/** Best-effort `id` recovery for a reply to a line that failed to parse as a
 * full ControlMessage — lets a malformed-body error still correlate back to
 * the caller's request when the `id` field itself was present and valid. */
function tryExtractId(line: string): number | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { id?: unknown }).id === "number"
    ) {
      return (parsed as { id: number }).id;
    }
  } catch {
    // fall through to null
  }
  return null;
}

function safeJsonParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/**
 * Mints the same signed session cookie POST /api/auth/login issues, so an
 * app.inject() re-entry passes src/plugins/auth.ts's global onRequest gate
 * exactly like an authenticated browser request would. Safe to call
 * unconditionally when auth is enabled: MULLION_SESSION_SECRET is a hard
 * boot invariant whenever MULLION_AUTH_TOKEN or OIDC is configured (see
 * src/app.ts's fail-closed check), so it can never be empty here. Returns no
 * header at all when auth is disabled, matching every other unauthenticated
 * HTTP request in that mode.
 */
function buildAuthHeaders(app: FastifyInstance): Record<string, string> {
  if (!isAuthEnabled(app.config)) return {};
  const cookieValue = createSessionCookieValue(app.config.MULLION_SESSION_SECRET);
  return { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

function buildQueryUrl(path: string, body: Record<string, unknown> | undefined): string {
  if (!body) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Runs `app.inject()` against a REST route and reshapes the response into
 * this socket's own reply envelope — a JSON error body's `message` becomes
 * the flat `error` string the wire protocol uses, everything else on
 * success becomes `result` verbatim. Every call is tagged with
 * CONTROL_SOCKET_ADDR (see that module's own comment) so the app-wide rate
 * limiter's allowList recognizes and exempts it. */
async function injectRoute(
  app: FastifyInstance,
  opts: Omit<InjectOptions, "remoteAddress">,
): Promise<ReplyPayload> {
  const res = await app.inject({ ...opts, remoteAddress: CONTROL_SOCKET_ADDR });
  const parsed = safeJsonParse(res.payload);
  if (res.statusCode >= 400) {
    const message =
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { message?: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : res.payload;
    return { ok: false, status: res.statusCode, error: message };
  }
  return { ok: true, status: res.statusCode, result: parsed };
}

// Op registry — the extension point every later Phase 4 PR (4.2–4.5) appends
// to, same "adding an op is a table entry, never a dispatch-loop change"
// shape as src/mcp/tools.mjs's own TOOLS registry. Request/response ops
// (this PR's three) call `reply()` exactly once; a future streaming op
// (sessions.attach, events.subscribe) instead holds the connection open and
// emits its own `{id, type, ...}` frames outside this envelope — see
// docs/socket-api.md's stream section — without needing any change to
// handleConnection's dispatch loop below.
const OPS: Record<string, OpSpec> = {
  ping: {
    scopes: ["full", "session"],
    handler: ({ reply }) => {
      reply({ ok: true, status: 200, result: { pong: true } });
    },
  },
  "sessions.list": {
    scopes: ["full"],
    handler: async ({ app, body, reply }) => {
      reply(
        await injectRoute(app, {
          method: "GET",
          url: buildQueryUrl("/api/sessions", body),
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  "projects.list": {
    scopes: ["full"],
    handler: async ({ app, reply }) => {
      reply(
        await injectRoute(app, {
          method: "GET",
          url: "/api/projects",
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
};

/**
 * Resolves the mandatory line-1 handshake to a connection scope. Two
 * accepted principals:
 *  - MULLION_AUTH_TOKEN (the operator's own credential) → "full" scope.
 *  - a live session's own MULLION_HOOK_TOKEN, resolved via the same
 *    app.pty.resolveToken() the hook socket uses → "session" scope, pinned
 *    to that session id.
 * When auth is disabled entirely, an empty handshake (`{}`) is accepted at
 * full scope — the 0600 socket mode is the only gate then, same posture
 * src/plugins/auth.ts's onRequest hook already takes for plain HTTP.
 *
 * Note: an OIDC-only deployment (no MULLION_AUTH_TOKEN set) has no static
 * full-scope secret to present here at all — only session-scoped
 * connections from inside an already-running session work. An operator who
 * wants `mullion ps` from a bare shell needs MULLION_AUTH_TOKEN configured,
 * which can coexist with OIDC.
 */
function resolveHandshake(
  app: FastifyInstance,
  token: string | null,
): { scope: Scope; sessionId: string | null } | null {
  if (token !== null) {
    if (
      app.config.MULLION_AUTH_TOKEN.trim() !== "" &&
      timingSafeTokenMatch(token, app.config.MULLION_AUTH_TOKEN)
    ) {
      return { scope: "full", sessionId: null };
    }
    const sessionId = app.pty.resolveToken(token);
    if (sessionId !== undefined) return { scope: "session", sessionId };
    return null;
  }
  if (!isAuthEnabled(app.config)) return { scope: "full", sessionId: null };
  return null;
}

function handleConnection(app: FastifyInstance, socket: net.Socket): void {
  let buffer = "";
  let conn: ConnectionState | null = null;

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_LINE_BYTES) {
      app.log.warn("control connection sent an oversized line without a terminator, closing");
      socket.destroy();
      return;
    }

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (line.trim() === "") continue;

      if (conn === null) {
        const handshake = parseControlHandshake(line);
        if (handshake === null) {
          app.log.warn("malformed control-socket handshake, closing connection");
          socket.destroy();
          return;
        }
        const resolved = resolveHandshake(app, handshake.token);
        if (resolved === null) {
          const hint =
            handshake.token === null
              ? "no token presented"
              : `token ${handshake.token.slice(0, 8)}… did not match MULLION_AUTH_TOKEN or any live session`;
          app.log.warn(`control connection presented an invalid handshake, closing (${hint})`);
          socket.destroy();
          return;
        }
        conn = { socket, scope: resolved.scope, sessionId: resolved.sessionId };
        continue;
      }

      const result = parseControlMessage(line);
      if (!result.ok) {
        send(socket, { id: tryExtractId(line), ok: false, status: 400, error: result.error });
        continue;
      }

      void dispatch(app, conn, result.message);
    }
  });

  socket.on("error", (err) => {
    app.log.debug({ err }, "control connection error");
  });
}

async function dispatch(
  app: FastifyInstance,
  conn: ConnectionState,
  message: ControlMessage,
): Promise<void> {
  const spec = OPS[message.op];
  if (!spec) {
    send(conn.socket, {
      id: message.id,
      ok: false,
      status: 404,
      error: `unknown op: ${message.op}`,
    });
    return;
  }
  if (!spec.scopes.includes(conn.scope)) {
    send(conn.socket, {
      id: message.id,
      ok: false,
      status: 403,
      error: "not permitted for this connection's scope",
    });
    return;
  }

  const reply = (payload: ReplyPayload) => send(conn.socket, { id: message.id, ...payload });
  try {
    await spec.handler({ app, conn, body: message.body, reply });
  } catch (err) {
    reply({ ok: false, status: 500, error: err instanceof Error ? err.message : String(err) });
  }
}

export const controlSocketPlugin = fp(async (app: FastifyInstance) => {
  // An "agent" role process has no dbPlugin and none of the /api/* routes
  // this dispatches into (see src/app.ts's role branch) — app.inject()
  // against them would just 404, so there's nothing useful for this socket
  // to do there.
  if (app.config.MULLION_ROLE !== "primary") return;

  const socketPath = app.pty.controlSocketPath;

  // Best-effort stale-socket cleanup, mirroring hooks.ts's own — a prior
  // process that exited without running this plugin's onClose (crash,
  // kill -9) can leave the socket file behind, and net.Server.listen()
  // refuses to bind an already-existing path (EADDRINUSE) even though
  // nothing is actually listening on it anymore.
  try {
    unlinkSync(socketPath);
  } catch {
    // ENOENT is the expected case.
  }

  const server = net.createServer((socket) => handleConnection(app, socket));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // 0600: filesystem perms are the first line of defense alongside the
  // handshake token above, same posture as hooks.ts's own hook socket.
  chmodSync(socketPath, 0o600);

  app.decorate("controlServer", server);

  app.addHook("onClose", () => {
    server.close();
    try {
      unlinkSync(socketPath);
    } catch {
      // Already gone is fine.
    }
  });
});

declare module "fastify" {
  interface FastifyInstance {
    controlServer: net.Server;
  }
}
