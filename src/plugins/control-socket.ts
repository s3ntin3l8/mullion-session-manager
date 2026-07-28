import fp from "fastify-plugin";
import type { FastifyInstance, InjectOptions } from "fastify";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
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
// ~33% base64 inflation — see docs/socket-api.md's framing section. Checked
// against Buffer.byteLength of the decoded buffer (not JS string.length,
// which counts UTF-16 code units and would let a line up to 2x this past
// for scrollback containing astral characters).
const MAX_LINE_BYTES = 2 * 1024 * 1024;

// A connection that never completes its line-1 handshake would otherwise
// hold an fd (and up to MAX_LINE_BYTES of buffered, unauthenticated input)
// indefinitely — bound it the same way an HTTP request has an implicit
// socket timeout. Exported for test/plugins/control-socket.test.ts, same
// reasoning as hooks.ts's own exported GATE_TIMEOUT_MS/PROMOTE_TIMEOUT_MS.
export const HANDSHAKE_TIMEOUT_MS = 10_000;

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

/** Exported for a direct unit test of URLSearchParams' own percent-encoding
 * (spaces, `&`, `=`, etc. in a body value) — see
 * test/plugins/control-socket.test.ts. */
export function buildQueryUrl(path: string, body: Record<string, unknown> | undefined): string {
  if (!body) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    // Only scalars round-trip meaningfully through a query string — an
    // array would silently comma-join and an object would stringify to
    // "[object Object]". Every op's body today is scalar-only (ajv would
    // reject a non-scalar query param on the REST side anyway); skip rather
    // than mis-serialize if a future op's body ever carries one.
    if (typeof value === "object") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Runs `app.inject()` against a REST route and reshapes the response into
 * this socket's own reply envelope — a JSON error body's `message` becomes
 * the flat `error` string the wire protocol uses, everything else on
 * success becomes `result` verbatim. Every call is tagged with
 * CONTROL_SOCKET_ADDR (see that module's own comment) so the app-wide rate
 * limiter's allowList recognizes and exempts it.
 *
 * No authorization decision of its own — every caller must have already
 * decided this specific request is allowed before reaching here. The two
 * shapes that decision takes are `injectRoute` (full-scope-only ops) and
 * `resolveTargetSessionId` + a direct call to this function (ops reachable
 * at session scope, which must verify the *target* session id themselves —
 * see that function's own doc comment).
 */
async function injectAndShape(
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

/**
 * Requires `conn.scope === "full"` — structural enforcement, not just the
 * OPS table's own `scopes` allowlist. The minted auth cookie
 * (buildAuthHeaders) carries no scope or session-id claim of its own, so
 * without this check here too, a future op that mistakenly lists "session"
 * in its `scopes` would forward a session-scoped connection's credential
 * into a REST call with no verification that the resource it targets is
 * the one session that connection is pinned to. Every op that legitimately
 * needs session-scoped REST access (sessions.get/scrollback/rename, and
 * sessions.attach/input/resize/detach added in the next Phase 4 PR) must
 * NOT go through this helper — it resolves its own target session id via
 * `resolveTargetSessionId` and calls `injectAndShape` directly, the same
 * way `dispatch()`'s scope check is itself explicit rather than assumed.
 */
async function injectRoute(
  app: FastifyInstance,
  conn: ConnectionState,
  opts: Omit<InjectOptions, "remoteAddress">,
): Promise<ReplyPayload> {
  if (conn.scope !== "full") {
    return { ok: false, status: 403, error: "this operation requires full-scope credentials" };
  }
  return injectAndShape(app, opts);
}

/**
 * Resolves which session id an op reachable at BOTH scopes should act on,
 * and enforces the session pin along the way — this is the "explicit
 * `body.sessionId === conn.sessionId` check" injectRoute's own doc comment
 * requires of every op that bypasses it.
 *
 *  - Full scope: `body.sessionId` is required (a full-scope connection has
 *    no session of its own to default to).
 *  - Session scope: `body.sessionId`, if given at all, MUST equal the
 *    connection's own pinned id — omitting it entirely defaults to that
 *    pinned id, which is what lets an agent inside a session say
 *    `{"op":"sessions.get"}` with no target at all. A session-scoped
 *    connection naming a *different* session id is rejected outright, never
 *    silently redirected to its own.
 */
function extractSessionId(body: Record<string, unknown> | undefined): string | null {
  const rawId = body?.sessionId;
  return rawId !== undefined &&
    rawId !== null &&
    (typeof rawId === "string" || typeof rawId === "number")
    ? String(rawId)
    : null;
}

function resolveTargetSessionId(
  conn: ConnectionState,
  body: Record<string, unknown> | undefined,
): { ok: true; id: string } | { ok: false; reply: ReplyPayload } {
  const provided = extractSessionId(body);

  if (conn.scope === "session") {
    const pinned = conn.sessionId!;
    if (provided !== null && provided !== pinned) {
      return {
        ok: false,
        reply: {
          ok: false,
          status: 403,
          error: "session-scoped connections may only target their own session",
        },
      };
    }
    return { ok: true, id: pinned };
  }

  if (provided === null) {
    return { ok: false, reply: { ok: false, status: 400, error: "'sessionId' is required" } };
  }
  return { ok: true, id: provided };
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
    handler: async ({ app, conn, body, reply }) => {
      reply(
        await injectRoute(app, conn, {
          method: "GET",
          url: buildQueryUrl("/api/sessions", body),
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  // Phase 4 (#187) — single-session inspect. Reachable at session scope
  // with no `sessionId` at all (defaults to the connection's own pinned
  // session — see resolveTargetSessionId), which is the shape an agent
  // running inside that session actually uses.
  "sessions.get": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveTargetSessionId(conn, body);
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      reply(
        await injectAndShape(app, {
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(target.id)}`,
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  // Full scope only (deliberately, not just because REST requires a
  // projectId a session-scoped connection wouldn't have handy) — an agent
  // inside a session has no business spawning an unrelated one.
  "sessions.create": {
    scopes: ["full"],
    handler: async ({ app, conn, body, reply }) => {
      reply(
        await injectRoute(app, conn, {
          method: "POST",
          url: "/api/sessions",
          headers: { ...buildAuthHeaders(app), "content-type": "application/json" },
          payload: JSON.stringify(body ?? {}),
        }),
      );
    },
  },
  // Full scope only — see docs/socket-api.md: a session may not kill
  // itself (or any other session) through this socket, matching the plan's
  // per-scope allowlist. `body.sessionId` is always required here (no
  // implicit "self" the way sessions.get/scrollback/rename have), since
  // full-scope is the only scope that ever reaches this handler.
  "sessions.kill": {
    scopes: ["full"],
    handler: async ({ app, conn, body, reply }) => {
      const id = extractSessionId(body);
      if (id === null) {
        reply({ ok: false, status: 400, error: "'sessionId' is required" });
        return;
      }
      reply(
        await injectRoute(app, conn, {
          method: "DELETE",
          url: `/api/sessions/${encodeURIComponent(id)}`,
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  // Reachable at session scope (an agent renaming its own session), same
  // target-id shape as sessions.get above.
  "sessions.rename": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveTargetSessionId(conn, body);
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      if (typeof body?.name !== "string" || body.name.length === 0) {
        reply({ ok: false, status: 400, error: "'name' is required" });
        return;
      }
      reply(
        await injectAndShape(app, {
          method: "PATCH",
          url: `/api/sessions/${encodeURIComponent(target.id)}`,
          headers: { ...buildAuthHeaders(app), "content-type": "application/json" },
          payload: JSON.stringify({ name: body.name }),
        }),
      );
    },
  },
  // Reachable at session scope — same target-id shape as sessions.get.
  "sessions.scrollback": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveTargetSessionId(conn, body);
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      reply(
        await injectAndShape(app, {
          method: "GET",
          url: `/api/sessions/${encodeURIComponent(target.id)}/scrollback`,
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  "projects.list": {
    scopes: ["full"],
    handler: async ({ app, conn, reply }) => {
      reply(
        await injectRoute(app, conn, {
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
 * When auth is disabled entirely, EVERY handshake is accepted at full
 * scope — not just an empty one — the 0600 socket mode is the only gate
 * then, same posture src/plugins/auth.ts's onRequest hook already takes for
 * plain HTTP (a Bearer header presented when MULLION_AUTH_TOKEN is unset
 * doesn't get rejected either; the whole gate is simply absent). Checked
 * first, before any token comparison: a stale or forged token presented in
 * this mode must not be treated any differently than no token at all —
 * otherwise a session whose hook token predates a Mullion restart (a real,
 * documented case — see pty-manager.ts's loadOrCreateHookToken) would get a
 * hard close instead of the same free access every other client in this
 * mode already has.
 *
 * Note: an OIDC-only deployment (OIDC configured, no MULLION_AUTH_TOKEN) has
 * no static full-scope secret to present here at all — only session-scoped
 * connections from inside an already-running session work. An operator who
 * wants `mullion ps` from a bare shell needs MULLION_AUTH_TOKEN configured,
 * which can coexist with OIDC.
 */
function resolveHandshake(
  app: FastifyInstance,
  token: string | null,
): { scope: Scope; sessionId: string | null } | null {
  if (!isAuthEnabled(app.config)) return { scope: "full", sessionId: null };
  if (token === null) return null;
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

function handleConnection(
  app: FastifyInstance,
  socket: net.Socket,
  openSockets: Set<net.Socket>,
): void {
  openSockets.add(socket);
  socket.once("close", () => openSockets.delete(socket));

  let buffer = "";
  let conn: ConnectionState | null = null;
  // Per-connection decoder, not a fresh Buffer.toString("utf8") per chunk —
  // a chunk boundary landing mid-multi-byte-character would otherwise
  // silently corrupt it (U+FFFD in, real bytes gone). Matters here more
  // than it would for hooks.ts's small NDJSON lines: this socket's cap is
  // 32x larger specifically so multi-chunk scrollback/screenshot payloads
  // (later Phase 4 PRs) fit, and those are guaranteed to span multiple TCP
  // reads.
  const decoder = new StringDecoder("utf8");

  const handshakeTimer = setTimeout(() => {
    app.log.warn("control connection never completed its handshake, closing");
    socket.destroy();
  }, HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref();

  socket.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (line.trim() === "") continue;

      // Guards a *terminated* line of any size — the remnant check after
      // this loop only catches an unterminated tail; a single TCP chunk
      // can legitimately contain one complete line larger than
      // MAX_LINE_BYTES (the newline just happens to arrive in the same
      // write), which would otherwise be extracted and dispatched with no
      // cap applied at all. Checked before any JSON.parse of the line —
      // parsing a deliberately oversized line is itself the expensive
      // operation this cap exists to avoid, so no id is recovered here.
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        if (conn === null) {
          app.log.warn("control connection sent an oversized handshake line, closing");
          clearTimeout(handshakeTimer);
          socket.destroy();
          return;
        }
        send(socket, {
          id: null,
          ok: false,
          status: 400,
          error: "line exceeds the maximum message size",
        });
        continue;
      }

      if (conn === null) {
        const handshake = parseControlHandshake(line);
        if (handshake === null) {
          app.log.warn("malformed control-socket handshake, closing connection");
          clearTimeout(handshakeTimer);
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
          clearTimeout(handshakeTimer);
          socket.destroy();
          return;
        }
        clearTimeout(handshakeTimer);
        conn = { socket, scope: resolved.scope, sessionId: resolved.sessionId };
        continue;
      }

      const result = parseControlMessage(line);
      if (!result.ok) {
        send(socket, { id: result.id, ok: false, status: 400, error: result.error });
        continue;
      }

      void dispatch(app, conn, result.message);
    }

    // Checked AFTER draining every complete line above, not on the raw
    // just-appended buffer — a single chunk can legitimately contain a
    // complete, valid line followed by an oversized, still-incomplete tail
    // (e.g. a handshake line immediately followed by a multi-megabyte
    // write with no terminator yet); that valid line must still be
    // processed rather than the whole connection being destroyed before
    // ever reading it. Only an unterminated remainder counts toward the cap.
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
      app.log.warn("control connection sent an oversized line without a terminator, closing");
      socket.destroy();
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
    // Defense-in-depth: send() already guards on socket.writable, but a
    // handler throwing after the connection has gone away mid-flight is
    // exactly the moment writing a reply is most likely to itself fail —
    // this must never surface as an unhandled rejection from the `void
    // dispatch(...)` call site above.
    try {
      reply({ ok: false, status: 500, error: err instanceof Error ? err.message : String(err) });
    } catch (sendErr) {
      app.log.debug({ sendErr }, "failed to send control-socket error reply");
    }
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

  // Tracks every currently-open connection so onClose below can actually
  // sever them — server.close() alone only stops accepting *new*
  // connections, it never touches sockets already open (a gap that matters
  // more here than it might elsewhere: MULLION_SOCKET_PATH is injected into
  // every spawned session in a later Phase 4 PR, so a wedged same-uid agent
  // connection could otherwise hold this process open past graceful
  // shutdown indefinitely).
  const openSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => handleConnection(app, socket, openSockets));

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
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
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
