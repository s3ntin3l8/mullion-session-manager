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
import {
  isAuthEnabled,
  createSessionCookieValue,
  configuredToken,
  SESSION_COOKIE_NAME,
} from "../services/auth.js";
import { timingSafeTokenMatch } from "../services/crypto-utils.js";
import { CONTROL_SOCKET_ADDR } from "../services/control-socket-addr.js";
import { resolveAndAttach } from "../routes/terminal.js";
import { attachAggregatedEventsSocket, attachLocalEventsSocket } from "../routes/events.js";
import { SocketChannel, WRITE_HARD_CEILING_BYTES } from "../services/socket-channel.js";
import { reclaimSocketPath } from "../services/unix-socket.js";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";

// Phase 4 (#185) — a general-purpose Unix control socket: the transport
// behind the `mullion` CLI (#134/#190) and any other local script that wants
// session/browser/event access without an HTTP base URL or bearer token.
// Modeled directly on src/plugins/hooks.ts's shape (reclaim-stale-socket →
// listen → chmod 0600 → decorate → onClose teardown, line-buffered NDJSON
// with a byte-cap) but a different protocol and a different auth principal
// — see docs/socket-api.md for the full wire-protocol writeup.
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
// and SCROLLBACK_MAX_BYTES (scrollback-buffer.ts) is already 1 MiB before the
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

// Issue #1517 — per-connection load bounds. One session-scoped client (the
// socket path is injected into every spawned session) must not be able to
// queue unbounded work or reply bytes in this process.
/** Max ops dispatched but not yet replied to on one connection; past it the
 * socket is paused and the remaining buffered lines wait. */
export const MAX_INFLIGHT_OPS = 32;
/** Max open sessions.attach / events.subscribe streams per connection. */
export const MAX_OPEN_CHANNELS = 16;
/** Once this many reply bytes are queued unwritten, stop reading requests
 * until the socket 'drain's. */
export const WRITE_HIGH_WATER_BYTES = 1024 * 1024;
export { WRITE_HARD_CEILING_BYTES };
/** Pre-handshake input is just `{"token":"..."}`; nothing legitimate needs
 * more than this before authenticating. */
export const MAX_HANDSHAKE_BYTES = 4 * 1024;
/** Global cap on simultaneously open connections (server.maxConnections). */
export const MAX_CONNECTIONS = 256;

type Scope = "full" | "session";

interface ConnectionState {
  readonly socket: net.Socket;
  scope: Scope;
  /** Set only for scope "session" — the connection is pinned to this
   * session id for the lifetime of the connection (see resolveHandshake). */
  sessionId: string | null;
  /** Phase 4 (#186, #188) — open streams on this connection (`sessions.attach`
   * or `events.subscribe`), keyed by the request `id` that opened them (the
   * same `id` every subsequent message belonging to that stream —
   * `sessions.input`/`resize`/`detach`, or `events.seen`/`unsubscribe` —
   * reuses). Scoped per-connection, not global: a session-scoped connection
   * can only ever reference a channel IT opened (attach/subscribe already
   * enforced the session pin — see resolveTargetSessionId), so the
   * follow-up ops don't need to re-check ownership, only that an entry
   * exists for this id. */
  openChannels: Map<number, SocketChannel>;
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
  /** The request's own `id` — the streaming ops (sessions.attach/input/
   * resize/detach) use this as the key into `conn.openChannels`, since a
   * client reuses one `id` for every message belonging to the same stream. */
  id: number;
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

/** Body fields a session-scoped `sessions.spawn_child` may forward (#1518);
 * verified against createSessionSchema in routes/sessions.ts. */
const SESSION_SPAWN_CHILD_FIELDS: readonly string[] = [
  "command",
  "name",
  "cwd",
  "model",
  "smallModel",
  "seedPrompt",
];

function send(socket: net.Socket, message: { id: number | null } & Record<string, unknown>): void {
  if (!socket.writable) return;
  socket.write(`${JSON.stringify(message)}\n`);
  // A peer that never reads would otherwise let replies pile up in this
  // process's memory without bound (#1517) — drop it past the hard ceiling.
  if (socket.writableLength > WRITE_HARD_CEILING_BYTES) socket.destroy();
}

/** The open stream for `id`, or replies 400 and returns null. */
function requireChannel(
  conn: ConnectionState,
  id: number,
  reply: (payload: ReplyPayload) => void,
): SocketChannel | null {
  const channel = conn.openChannels.get(id);
  if (!channel) reply({ ok: false, status: 400, error: "no open stream for this id" });
  return channel ?? null;
}

/** Why a new stream cannot be opened on `conn` under `id`, or null if it can. */
function streamSlotError(conn: ConnectionState, id: number): ReplyPayload | null {
  if (conn.openChannels.has(id)) {
    return { ok: false, status: 400, error: "a stream is already open for this id" };
  }
  if (conn.openChannels.size >= MAX_OPEN_CHANNELS) {
    return { ok: false, status: 429, error: "too many open streams on this connection" };
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

/** Auth headers plus a JSON content type, for ops forwarding a request body. */
function jsonHeaders(app: FastifyInstance): Record<string, string> {
  return { ...buildAuthHeaders(app), "content-type": "application/json" };
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
 *
 * A 204-no-content REST response (e.g. `sessions.kill`'s DELETE) has an
 * empty `res.payload`, and `JSON.parse("")` throws — safeJsonParse's
 * documented fallback then returns that empty string verbatim, so `result`
 * for a no-content op is the literal string `""`, not `null` or omitted.
 * That's the intended shape for this case, not an accident of
 * safeJsonParse's error handling; a future no-content op will hit the same
 * path.
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
/**
 * Reads `body[key]` as an id: a non-empty string or a number (stringified).
 * An empty string is never a real id — treating it as "not provided" (rather
 * than a literal target) means a bogus `{sessionId:""}` gets the same
 * "'sessionId' is required" 400 every other omitted-id case does, instead of
 * silently reaching app.inject() with an empty path segment (Hermes review,
 * PR #398).
 */
function extractIdField(body: Record<string, unknown> | undefined, key: string): string | null {
  const rawId = body?.[key];
  if (rawId === undefined || rawId === null) return null;
  if (typeof rawId !== "string" && typeof rawId !== "number") return null;
  const id = String(rawId);
  return id.length === 0 ? null : id;
}

function extractSessionId(body: Record<string, unknown> | undefined): string | null {
  return extractIdField(body, "sessionId");
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

/**
 * Resolves the `sessionId` filter `events.query` should apply — a variant of
 * resolveTargetSessionId's own shape, but for a QUERY rather than a
 * single-target op: full scope may omit `sessionId` entirely (meaning
 * "every session"), where every other session-targeted op requires it.
 * Session scope still can't broaden its own view: it may omit `sessionId`
 * (defaulting to its own pinned session, same as sessions.get) or name that
 * exact session explicitly, but never a different one or "all sessions" —
 * reusing the same pin-enforcement `events.subscribe` already applies via
 * its own `sessionIdFilter`, not a new isolation mechanism.
 */
function resolveEventsSessionFilter(
  conn: ConnectionState,
  body: Record<string, unknown> | undefined,
): { ok: true; sessionId: string | undefined } | { ok: false; reply: ReplyPayload } {
  const provided = extractSessionId(body);

  if (conn.scope === "session") {
    const pinned = conn.sessionId!;
    if (provided !== null && provided !== pinned) {
      return {
        ok: false,
        reply: {
          ok: false,
          status: 403,
          error: "session-scoped connections may only query their own session's events",
        },
      };
    }
    return { ok: true, sessionId: pinned };
  }

  return { ok: true, sessionId: provided ?? undefined };
}

/** Same shape as extractSessionId, for projects.actions' `body.projectId`. */
function extractProjectId(body: Record<string, unknown> | undefined): string | null {
  return extractIdField(body, "projectId");
}

/**
 * Same "resolve + enforce the pin" shape as resolveTargetSessionId, but for
 * `projects.actions` — the one op the plan's per-scope allowlist puts at
 * session scope even though it targets a *project*, not the connection's own
 * session id. A session-scoped connection has no explicit project id to
 * present the way it has its own pinned session id, so "its own project"
 * means the project the connection's own pinned session was launched
 * against (Session.projectId, pty-manager.ts) — a session with no project
 * (projectId === null, e.g. a bare shell) has nothing to default to and 400s
 * rather than silently falling through to "no project" being treated as a
 * real target.
 */
function resolveTargetProjectId(
  app: FastifyInstance,
  conn: ConnectionState,
  body: Record<string, unknown> | undefined,
): { ok: true; id: string } | { ok: false; reply: ReplyPayload } {
  const provided = extractProjectId(body);

  if (conn.scope === "session") {
    const session = app.pty.get(conn.sessionId!);
    const ownProjectId = session?.projectId != null ? String(session.projectId) : null;
    if (ownProjectId === null) {
      return {
        ok: false,
        reply: { ok: false, status: 400, error: "this session has no associated project" },
      };
    }
    if (provided !== null && provided !== ownProjectId) {
      return {
        ok: false,
        reply: {
          ok: false,
          status: 403,
          error: "session-scoped connections may only target their own session's project",
        },
      };
    }
    return { ok: true, id: ownProjectId };
  }

  if (provided === null) {
    return { ok: false, reply: { ok: false, status: 400, error: "'projectId' is required" } };
  }
  return { ok: true, id: provided };
}

/** Same shape as extractSessionId, for sessions.spawn_child's `body.parentSessionId`. */
function extractParentSessionId(body: Record<string, unknown> | undefined): string | null {
  return extractIdField(body, "parentSessionId");
}

/**
 * Phase 5 (Track B, issue #193 5.3b) — resolves the parent session id for
 * sessions.spawn_child, same "resolve + enforce the pin" shape as
 * resolveTargetSessionId/resolveTargetProjectId above. Session scope
 * defaults to (and can never override) its own pinned session id — this is
 * what makes the op "an agent spawning a child OF ITSELF," not "an agent
 * naming an arbitrary parent." Full scope has no pinned session of its own,
 * so it must name one explicitly, matching sessions.get's own full-scope
 * shape.
 */
function resolveParentSessionId(
  conn: ConnectionState,
  body: Record<string, unknown> | undefined,
): { ok: true; id: string } | { ok: false; reply: ReplyPayload } {
  const provided = extractParentSessionId(body);

  if (conn.scope === "session") {
    const pinned = conn.sessionId!;
    if (provided !== null && provided !== pinned) {
      return {
        ok: false,
        reply: {
          ok: false,
          status: 403,
          error: "session-scoped connections may only spawn children of their own session",
        },
      };
    }
    return { ok: true, id: pinned };
  }

  if (provided === null) {
    return { ok: false, reply: { ok: false, status: 400, error: "'parentSessionId' is required" } };
  }
  return { ok: true, id: provided };
}

/** One REST request an op forwards via app.inject(). `payload` is the
 * already-serialized JSON body (its presence adds the JSON content type). */
interface Route {
  method: NonNullable<InjectOptions["method"]>;
  url: string;
  payload?: string;
}

const bad = (status: number, error: string): ReplyPayload => ({ ok: false, status, error });
const json = (value: unknown): string => JSON.stringify(value ?? {});

/**
 * Declarative request/response op: `resolve` turns the request into either a
 * `Route` to forward or an early `ReplyPayload` (validation / pin failure).
 * The runner picks `injectRoute` for full-scope-only ops (structural
 * enforcement) and `injectAndShape` for ops that list "session" — whose
 * `resolve` must itself pin the target, see resolveTargetSessionId.
 */
function routeOp(
  scopes: readonly Scope[],
  resolve: (ctx: OpContext) => Route | ReplyPayload | Promise<Route | ReplyPayload>,
): OpSpec {
  const fullOnly = scopes.length === 1 && scopes[0] === "full";
  return {
    scopes,
    handler: async (ctx) => {
      const resolved = await resolve(ctx);
      if (!("method" in resolved)) {
        ctx.reply(resolved);
        return;
      }
      const opts = {
        method: resolved.method,
        url: resolved.url,
        headers: resolved.payload !== undefined ? jsonHeaders(ctx.app) : buildAuthHeaders(ctx.app),
        ...(resolved.payload !== undefined ? { payload: resolved.payload } : {}),
      };
      ctx.reply(
        await (fullOnly ? injectRoute(ctx.app, ctx.conn, opts) : injectAndShape(ctx.app, opts)),
      );
    },
  };
}

type Resolver = (ctx: OpContext) => Route | ReplyPayload | Promise<Route | ReplyPayload>;

/** Resolver wrapper: pins the target session (resolveTargetSessionId). */
const onSession =
  (fn: (id: string, ctx: OpContext) => Route | ReplyPayload): Resolver =>
  (ctx) => {
    const target = resolveTargetSessionId(ctx.conn, ctx.body);
    return target.ok ? fn(target.id, ctx) : target.reply;
  };

/** Resolver wrapper: pins the target project (resolveTargetProjectId). */
const onProject =
  (fn: (id: string, ctx: OpContext) => Route | ReplyPayload): Resolver =>
  (ctx) => {
    const target = resolveTargetProjectId(ctx.app, ctx.conn, ctx.body);
    return target.ok ? fn(target.id, ctx) : target.reply;
  };

/** Resolver wrapper: a required explicit id field, 400 when absent. */
const onField =
  (key: string, fn: (id: string, ctx: OpContext) => Route | ReplyPayload): Resolver =>
  (ctx) => {
    const id = extractIdField(ctx.body, key);
    return id === null ? bad(400, `'${key}' is required`) : fn(id, ctx);
  };

const enc = encodeURIComponent;

// Op registry — the extension point every later Phase 4 PR (4.2–4.5) appends
// to, same "adding an op is a table entry, never a dispatch-loop change"
// shape as src/mcp/tools.mjs's own TOOLS registry. Request/response ops
// (this PR's three) call `reply()` exactly once; a future streaming op
// (sessions.attach, events.subscribe) instead holds the connection open and
// emits its own `{id, type, ...}` frames outside this envelope — see
// docs/socket-api.md's stream section — without needing any change to
// handleConnection's dispatch loop below.
/** Exported for the scope-matrix test in test/plugins/control-socket.test.ts. */
export const OPS: Record<string, OpSpec> = {
  ping: {
    scopes: ["full", "session"],
    handler: ({ reply }) => {
      reply({ ok: true, status: 200, result: { pong: true } });
    },
  },
  "sessions.list": routeOp(["full"], ({ body }) => ({
    method: "GET",
    url: buildQueryUrl("/api/sessions", body),
  })),
  // Phase 4 (#187) — single-session inspect. Reachable at session scope
  // with no `sessionId` at all (defaults to the connection's own pinned
  // session — see resolveTargetSessionId), which is the shape an agent
  // running inside that session actually uses.
  "sessions.get": routeOp(
    ["full", "session"],
    onSession((id) => ({ method: "GET", url: `/api/sessions/${enc(id)}` })),
  ),
  // Full scope only (deliberately, not just because REST requires a
  // projectId a session-scoped connection wouldn't have handy) — an agent
  // inside a session has no business spawning an unrelated one.
  "sessions.create": routeOp(["full"], ({ body }) => ({
    method: "POST",
    url: "/api/sessions",
    payload: json(body),
  })),
  // Phase 5 (Track B, issue #193 5.3b) — the narrow, session-scoped path to
  // a REAL child session (own PTY, own dtach socket), as opposed to
  // sessions.create's full-scope-only restriction above ("an agent inside a
  // session has no business spawning an UNRELATED one" — a same-project
  // child of the caller's own session is precisely the case that leaves
  // open). Same-project and one-level-of-nesting are enforced in
  // createSessionRecord (services/session-lifecycle.ts), not here — this handler's
  // only job is resolving WHICH session is the parent, deriving that
  // parent's own project via a real GET (never trusting a body-supplied
  // projectId), and stamping both onto the forwarded POST /api/sessions
  // body. `worktree`/`worktreeRefresh` are stripped from the caller's body
  // deliberately: createSessionRecord's cwd-containment check for a child
  // spawn assumes no worktree was requested (see that function's comment).
  "sessions.spawn_child": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const parent = resolveParentSessionId(conn, body);
      if (!parent.ok) {
        reply(parent.reply);
        return;
      }
      const parentLookup = await injectAndShape(app, {
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(parent.id)}`,
        headers: buildAuthHeaders(app),
      });
      if (!parentLookup.ok) {
        reply(parentLookup);
        return;
      }
      const parentProjectId = (parentLookup.result as { projectId?: unknown } | undefined)
        ?.projectId;
      if (typeof parentProjectId !== "number") {
        reply({ ok: false, status: 400, error: "unable to resolve the parent session's project" });
        return;
      }
      // A session-scoped connection outlives its session's own intent: a hook
      // token stays valid until the process is reaped, so re-check the ROW
      // (the source of intent; the in-memory PtyManager map can lack a live
      // session) and refuse to let a killed/exited parent keep spawning (#1518).
      if (conn.scope === "session") {
        const row = app.db
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, Number(parent.id)))
          .get();
        if (row?.status !== "active") {
          reply({ ok: false, status: 403, error: "the parent session is no longer active" });
          return;
        }
      }
      const {
        sessionId: _sessionId,
        parentSessionId: _parentSessionId,
        projectId: _projectId,
        worktree: _worktree,
        worktreeRefresh: _worktreeRefresh,
        ...fullRest
      } = body ?? {};
      // Session scope forwards an explicit ALLOWLIST (#1518), not a denylist:
      // a field newly added to POST /api/sessions' schema (as `env` once was)
      // must not silently widen what a session-scoped caller can set.
      // `skipPermissions`, `kind`, `env`, `nameLocked` etc. are privilege- or
      // visibility-adjacent and stay full-scope only (a full-scope caller has
      // that power directly). `seedPrompt` grants nothing `command` doesn't
      // already (a session-scoped caller fully controls its child's first turn
      // via `command` itself).
      const rest: Record<string, unknown> =
        conn.scope === "session"
          ? Object.fromEntries(
              Object.entries(fullRest).filter(([key]) => SESSION_SPAWN_CHILD_FIELDS.includes(key)),
            )
          : fullRest;
      const payload = {
        ...rest,
        projectId: parentProjectId,
        parentSessionId: Number(parent.id),
      };
      app.log.info(
        { parentSessionId: parent.id, projectId: parentProjectId, scope: conn.scope },
        "sessions.spawn_child",
      );
      reply(
        await injectAndShape(app, {
          method: "POST",
          url: "/api/sessions",
          headers: jsonHeaders(app),
          payload: JSON.stringify(payload),
        }),
      );
    },
  },
  // Full scope only — see docs/socket-api.md: a session may not kill
  // itself (or any other session) through this socket, matching the plan's
  // per-scope allowlist. `body.sessionId` is always required here (no
  // implicit "self" the way sessions.get/scrollback/rename have), since
  // full-scope is the only scope that ever reaches this handler.
  // `body.cascade` ("detach"|"kill", default "detach" — see
  // services/session-lifecycle.ts's killSession) rides through as a querystring on the
  // proxied DELETE, same transport reasoning as that route's own comment.
  "sessions.kill": routeOp(["full"], ({ body }) => {
    const id = extractSessionId(body);
    if (id === null) return bad(400, "'sessionId' is required");
    const cascade = body?.cascade;
    if (cascade !== undefined && cascade !== "detach" && cascade !== "kill") {
      return bad(400, "'cascade' must be 'detach' or 'kill'");
    }
    const query = cascade !== undefined ? { cascade } : undefined;
    return { method: "DELETE", url: buildQueryUrl(`/api/sessions/${enc(id)}`, query) };
  }),
  // Reachable at session scope (an agent renaming its own session), same
  // target-id shape as sessions.get above.
  "sessions.rename": routeOp(
    ["full", "session"],
    onSession((id, { body }) =>
      typeof body?.name !== "string" || body.name.length === 0
        ? bad(400, "'name' is required")
        : { method: "PATCH", url: `/api/sessions/${enc(id)}`, payload: json({ name: body.name }) },
    ),
  ),
  // Reachable at session scope — same target-id shape as sessions.get.
  "sessions.scrollback": routeOp(
    ["full", "session"],
    onSession((id) => ({ method: "GET", url: `/api/sessions/${enc(id)}/scrollback` })),
  ),
  // Phase 4 (#186) — opens a multiplexed PTY I/O stream on this connection,
  // keyed by this request's own `id`: attachSocketToSession/
  // proxyToRemoteAttach (terminal.ts) write scrollback replay and live
  // output as unsolicited `{id, type:"data", b64}`/`{id, type:"exited"}`
  // frames on the SAME `id`, entirely outside this `reply()` envelope — see
  // resolveAndAttach's own doc comment for why this function, not a
  // reimplementation, is what both this op and /ws/terminal call. Only a
  // FAILED attach gets a `reply()` — a successful one has no separate ack at
  // all (see the handler's own comment for why one would be confusingly
  // out of order): the scrollback replay's own `{id,type:"data"}` frame,
  // sent synchronously inside resolveAndAttach before this handler returns,
  // IS the success signal, and it's unconditional (getScrollback()'s
  // synthesized preamble is never actually empty) so it always arrives even
  // for a session that's produced no real output yet.
  "sessions.attach": {
    scopes: ["full", "session"],
    handler: ({ app, conn, id, body, reply }) => {
      const target = resolveTargetSessionId(conn, body);
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const slotError = streamSlotError(conn, id);
      if (slotError) {
        reply(slotError);
        return;
      }
      // Same fallback shape as /ws/terminal's own query-param defaults
      // (terminal.ts) — a caller that doesn't care about real dimensions
      // yet (e.g. a one-shot `mullion logs`) doesn't have to supply them.
      const cols = Number(body?.cols) || 80;
      const rows = Number(body?.rows) || 24;

      // No explicit `reply({ok:true})` on success: resolveAndAttach's own
      // attachSocketToSession call synchronously writes the scrollback
      // replay as a `{id,type:"data",b64}` frame on this same id BEFORE
      // this handler gets a chance to run any code after it returns — an
      // ack sent after that would be confusingly out of order (data before
      // its own "attach succeeded" acknowledgment). getScrollback()'s
      // synthesized alt-screen preamble is unconditional (pty-manager.ts),
      // so that first data frame always arrives regardless of whether the
      // session has actually produced any real output yet — it IS the
      // success signal, matching the wire protocol's own documented shape
      // (docs/socket-api.md): only a failure gets a `reply()`.
      const channel = new SocketChannel(conn.socket, id);
      const result = resolveAndAttach(app, channel, { sessionId: Number(target.id), cols, rows });
      if (!result.ok) {
        reply({ ok: false, status: result.status, error: result.error });
        return;
      }
      conn.openChannels.set(id, channel);
      // The stream can end WITHOUT going through sessions.detach below —
      // most importantly, proxyToRemoteAttach (terminal.ts) calls this
      // channel's close() on any upstream (remote-host) failure, with no
      // request/response op involved at all. Without this listener,
      // conn.openChannels would keep the dead entry forever: a fresh
      // sessions.attach on this same id would 400 "already open" forever,
      // and sessions.input/resize would keep silently reaching a channel
      // whose message listeners already stopped forwarding anywhere.
      channel.on("close", () => {
        conn.openChannels.delete(id);
      });
    },
  },
  // Client→server keystrokes for an already-open sessions.attach stream —
  // deliberately silent on success (no reply): acking every single input
  // frame would be a reply flood for interactive typing. Errors still
  // reply, so a caller can tell a broken/detached stream apart from normal
  // fire-and-forget input.
  "sessions.input": {
    scopes: ["full", "session"],
    handler: ({ conn, id, body, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      const b64 = typeof body?.b64 === "string" ? body.b64 : null;
      if (b64 === null) {
        reply({ ok: false, status: 400, error: "'b64' is required" });
        return;
      }
      // isBinary: true routes into attachSocketToSession's own binary-frame
      // branch (raw keystroke bytes → session.write()), not its JSON
      // control-message branch.
      channel.emitMessage(Buffer.from(b64, "base64"), true);
    },
  },
  // Same "silent on success, reply on error" posture as sessions.input —
  // delivered as attachSocketToSession's own `{"type":"resize",...}` text
  // control frame, so the resize logic itself lives in exactly one place.
  "sessions.resize": {
    scopes: ["full", "session"],
    handler: ({ conn, id, body, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      const cols = body?.cols;
      const rows = body?.rows;
      // Number.isFinite, not just typeof === "number": NaN/Infinity are
      // both `typeof "number"` too, and would otherwise sail past this
      // check only to get silently swallowed downstream — JSON.stringify
      // renders them as `null`, which attachSocketToSession's own
      // isResizeMessage (terminal.ts) then rejects as not a resize message
      // at all, dropping the request with no error ever reported back
      // (Hermes review, PR #399).
      if (
        typeof cols !== "number" ||
        typeof rows !== "number" ||
        !Number.isFinite(cols) ||
        !Number.isFinite(rows)
      ) {
        reply({ ok: false, status: 400, error: "'cols' and 'rows' are required" });
        return;
      }
      channel.emitMessage(Buffer.from(JSON.stringify({ type: "resize", cols, rows })), false);
    },
  },
  // Ends one stream without affecting the connection or any other stream
  // multiplexed on it — the session itself is never killed (matching
  // /ws/terminal's own "socket close ≠ session death" posture); use
  // sessions.kill for that.
  "sessions.detach": {
    scopes: ["full", "session"],
    handler: ({ conn, id, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      // notify: false — the reply() below already tells this caller the
      // stream ended; a redundant unsolicited {id,type:"closed"} frame
      // would arrive on the wire ahead of this very reply (close() runs
      // synchronously here) and is exactly the "confusingly out of order"
      // shape sessions.attach's own success path avoids for the same
      // reason. The close listener registered in sessions.attach above
      // still fires and removes this entry from openChannels regardless.
      channel.close(false);
      reply({ ok: true, status: 200 });
    },
  },
  // Phase 4 (#188) — opens a multiplexed notification-events stream on this
  // connection, keyed by this request's own `id`, exactly the same
  // multiplexing shape as sessions.attach above. Unlike sessions.attach,
  // this DOES send an explicit `{ok:true}` ack: attachLocalEventsSocket's
  // replay batch (routes/events.ts) can genuinely be empty (an idle system
  // with nothing buffered yet), unlike getScrollback()'s unconditionally
  // non-empty preamble — so there is no data frame guaranteed to arrive
  // that could serve as an implicit success signal the way it does for PTY
  // attach. The ack is sent AFTER attaching (which synchronously flushes
  // any replay events first), so a client can rely on: anything received
  // before the ack is replay, anything after is live.
  "events.subscribe": {
    scopes: ["full", "session"],
    handler: ({ app, conn, id, reply }) => {
      const slotError = streamSlotError(conn, id);
      if (slotError) {
        reply(slotError);
        return;
      }
      const channel = new SocketChannel(conn.socket, id);
      if (conn.scope === "session") {
        // Always a LOCAL session — a session-scoped connection's pin can
        // only ever resolve against this process's own PtyManager (see
        // attachAggregatedEventsSocket's own doc comment) — so there is no
        // multi-host aggregation to open here, only a same-process filter.
        attachLocalEventsSocket(app, channel, { sessionIdFilter: conn.sessionId! });
      } else {
        attachAggregatedEventsSocket(app, channel);
      }
      conn.openChannels.set(id, channel);
      channel.on("close", () => {
        conn.openChannels.delete(id);
      });
      reply({ ok: true, status: 200 });
    },
  },
  // Forwards a "seen" cursor update on an already-open events.subscribe
  // stream — delivered as attachLocalEventsSocket's own
  // `{"type":"seen",...}` text control frame (routes/events.ts), the exact
  // same message a real /ws/events browser connection sends, so the cursor
  // logic itself lives in exactly one place. Deliberately silent on success
  // (no reply), same posture as sessions.input/resize; errors still reply.
  // A session-scoped connection naming a different session's id is
  // silently ignored by attachLocalEventsSocket's own filter (not rejected
  // with an error here) — matching how a session-scoped events.subscribe
  // never received that other session's events in the first place, so
  // there is nothing for this op to have corrupted.
  "events.seen": {
    scopes: ["full", "session"],
    handler: ({ conn, id, body, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      const sessionId = body?.sessionId;
      const seq = body?.seq;
      if (
        typeof sessionId !== "number" ||
        typeof seq !== "number" ||
        !Number.isFinite(sessionId) ||
        !Number.isFinite(seq)
      ) {
        reply({ ok: false, status: 400, error: "'sessionId' and 'seq' must be finite numbers" });
        return;
      }
      channel.emitMessage(Buffer.from(JSON.stringify({ type: "seen", sessionId, seq })), false);
    },
  },
  // Ends one events stream without affecting the connection or any other
  // stream multiplexed on it — same shape as sessions.detach.
  "events.unsubscribe": {
    scopes: ["full", "session"],
    handler: ({ conn, id, reply }) => {
      const channel = requireChannel(conn, id, reply);
      if (!channel) return;
      channel.close(false);
      reply({ ok: true, status: 200 });
    },
  },
  // Issue #213 (roadmap 4.7) — request/response, not a stream: unlike
  // events.subscribe (a live push feed), this queries the persisted
  // `session_events` history (src/plugins/event-store.ts) via GET
  // /api/events, one shot, same shape as sessions.list. Full scope may
  // query any session (or omit `sessionId` for every session); session
  // scope is restricted to its own pinned session only — see
  // resolveEventsSessionFilter's own doc comment for why this reuses
  // events.subscribe's isolation model rather than inventing a new one.
  "events.query": routeOp(["full", "session"], ({ conn, body }) => {
    const resolved = resolveEventsSessionFilter(conn, body);
    if (!resolved.ok) return resolved.reply;
    const queryBody: Record<string, unknown> = { ...body };
    if (resolved.sessionId !== undefined) queryBody.sessionId = resolved.sessionId;
    else delete queryBody.sessionId;
    return { method: "GET", url: buildQueryUrl("/api/events", queryBody) };
  }),
  // Phase 4 (#189) — request/response, not a stream: `executeBrowserAction`
  // (browser-automation.ts) already returns a full snapshot/console/errors
  // envelope in one shot, so there's nothing here that needs multiplexing
  // the way PTY output or a live events feed does. Same target-id shape as
  // sessions.get/scrollback/rename above — `body.sessionId` is stripped
  // before forwarding (it's this socket's own targeting field, not part of
  // AgentAction's schema) so the REST route only ever sees the action body
  // it actually expects.
  "browser.action": routeOp(
    ["full", "session"],
    onSession((id, { body }) => {
      const { sessionId: _sessionId, ...actionBody } = body ?? {};
      return { method: "POST", url: `/api/sessions/${enc(id)}/browser`, payload: json(actionBody) };
    }),
  ),
  // Same shape as browser.action — `body.sessionId` targets the session,
  // the rest (`by`/`value`/`name`/`limit`) is FindElementsBody verbatim.
  "browser.find": routeOp(
    ["full", "session"],
    onSession((id, { body }) => {
      const { sessionId: _sessionId, ...findBody } = body ?? {};
      return {
        method: "POST",
        url: `/api/sessions/${enc(id)}/browser/find`,
        payload: json(findBody),
      };
    }),
  ),
  // Read-only inspect of which browser pane(s) a session is bound to —
  // same target-id shape as sessions.get, no request body beyond sessionId.
  "browser.bindings": routeOp(
    ["full", "session"],
    onSession((id) => ({ method: "GET", url: `/api/sessions/${enc(id)}/browser` })),
  ),
  // Unlike browser.action/browser.bindings above, a device has no "belongs
  // to this session" relationship to resolve — resolveTargetSessionId's
  // whole point is pinning a session-scoped connection to ITS OWN session,
  // and there is no analogous "this session's own device." So `deviceId` is
  // always explicit, at either scope, and a session-scoped connection is
  // NOT restricted to any particular device — a deliberate choice, not an
  // oversight: closing the agent-facing "verify my own UI change" loop
  // (the whole point of exposing this at session scope at all) requires
  // acting on whichever device the agent is actually driving, which this
  // socket has no way to know in advance the way it does for "my own
  // session." Devices are a much lower blast-radius resource than the SSH
  // agent traffic resolveTargetSessionId's pinning exists to protect
  // (worst case here: an unrelated tap/screenshot, not a credential). Still
  // reached via injectAndShape directly, never injectRoute, per this file's
  // own structural rule for any op listing "session" in scopes.
  "device.action": routeOp(
    ["full", "session"],
    onField("deviceId", (id, { body }) => {
      const { deviceId: _deviceId, ...actionBody } = body ?? {};
      return { method: "POST", url: `/api/devices/${enc(id)}/action`, payload: json(actionBody) };
    }),
  ),
  "device.list": routeOp(["full", "session"], () => ({ method: "GET", url: "/api/devices" })),
  // Same "explicit deviceId, no pinning" posture as device.action above.
  "device.get": routeOp(
    ["full", "session"],
    onField("deviceId", (id) => ({ method: "GET", url: `/api/devices/${enc(id)}` })),
  ),
  "device.create": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      // Hermes review on this PR: `kind: "physical"` (routed to
      // wireless.connect() with `serial: address`, device-manager.ts's
      // connectPhysical()) is NOT the same blast radius as the emulator
      // path below it — it makes the host's adb server dial an ARBITRARY
      // network address a session-scoped caller supplies, an outbound-dial/
      // internal-network-probe primitive the emulator branch never had, and
      // then that same session-scope connection can drive it via the
      // already-session-scope device.action ops. That is exactly the
      // "bigger blast radius" reasoning device.pair (below) is gated
      // full-scope-only for, so the same gate applies here — checked
      // inline, not via injectRoute, since (per this file's own structural
      // rule for any op listing "session" in scopes) only the EMULATOR
      // half of this op may still go through injectAndShape directly for a
      // session-scoped caller.
      if ((body as { kind?: string } | undefined)?.kind === "physical" && conn.scope !== "full") {
        reply({ ok: false, status: 403, error: "this operation requires full-scope credentials" });
        return;
      }
      reply(
        await injectAndShape(app, {
          method: "POST",
          url: "/api/devices",
          headers: jsonHeaders(app),
          payload: JSON.stringify(body ?? {}),
        }),
      );
    },
  },
  // Deliberately `["full"]` ONLY — unlike every other device.* op above,
  // which mirrors device.action's "worst case: an unrelated tap/screenshot,
  // not a credential" reasoning (see that op's own comment), pairing
  // authorizes the HOST's adb server to trust a new piece of hardware.
  // That's a materially bigger blast radius than driving a device Mullion
  // already manages, so it doesn't get the session-scope carve-out the rest
  // of this family does.
  "device.pair": routeOp(["full"], ({ body }) => ({
    method: "POST",
    url: "/api/devices/pair",
    payload: json(body),
  })),
  // Same "full-only because it dials an arbitrary address" reasoning as
  // device.pair above. Accepts either a `discoveryId` (from
  // device.discovered) or a manual `pairingAddress`+`connectAddress` pair.
  "device.pair-and-connect": routeOp(["full"], ({ body }) => ({
    method: "POST",
    url: "/api/devices/pair-and-connect",
    payload: json(body),
  })),
  // Read-only mDNS snapshot. Cheap (in-memory cache), no network side
  // effects, no scope concerns beyond the rest of the device.list family.
  "device.discovered": routeOp(["full", "session"], () => ({
    method: "GET",
    url: "/api/devices/discovered",
  })),
  // Keeps its historical name (and its documented meaning — "flips the row
  // to `killed` and tears down the live process/scope") even though the
  // `mullion device stop` verb now maps here rather than to DELETE: stop is
  // reversible, the row survives, and `device.delete` below is the
  // irreversible one. Renaming the op would break every raw-socket caller
  // of a published API for no behavioural gain.
  "device.terminate": routeOp(
    ["full", "session"],
    onField("deviceId", (id) => ({ method: "POST", url: `/api/devices/${enc(id)}/stop` })),
  ),
  // Start is the mirror of terminate above and equally reversible, so it
  // gets the same full+session reachability — an agent that can stop a
  // device can start one again.
  "device.start": routeOp(
    ["full", "session"],
    onField("deviceId", (id) => ({ method: "POST", url: `/api/devices/${enc(id)}/start` })),
  ),
  // Full scope only, on the same "bigger blast radius than driving a device
  // Mullion already manages" reasoning as device.pair and (for the same
  // destroy-something-permanently shape) sessions.kill/previews.delete:
  // this drops the row and the id that identifies its systemd scope, with
  // no undo. A session-scoped caller can still start/stop the device.
  "device.delete": routeOp(
    ["full"],
    onField("deviceId", (id) => ({ method: "DELETE", url: `/api/devices/${enc(id)}` })),
  ),
  "projects.list": routeOp(["full"], () => ({ method: "GET", url: "/api/projects" })),
  // Phase 4 (#134, PR6) — reachable at session scope: an agent inside a
  // session asking "what launchers does my own project have" with no
  // `projectId` at all is the shape `mullion project actions` actually uses
  // — see resolveTargetProjectId. Multi-host proxying (a project on a
  // remote agent host) is inherited for free through app.inject() against
  // the real route, same as every other op here.
  "projects.actions": routeOp(
    ["full", "session"],
    onProject((id) => ({ method: "GET", url: `/api/projects/${enc(id)}/actions` })),
  ),
  // Full scope only, per the plan's per-scope allowlist — unlike
  // projects.actions above, dock controls are an operator-facing concept
  // (persistent monitors toggled from the dashboard), not something an
  // agent inside a session needs to introspect about itself.
  "projects.dock": routeOp(
    ["full"],
    onField("projectId", (id) => ({ method: "GET", url: `/api/projects/${enc(id)}/dock` })),
  ),
  // Full scope only — project tooling is operator-authored config, not
  // something an agent inside a session should modify about an unrelated
  // project. GET is session-scoped (agents can read their own project's
  // tooling); SET is full-scope only.
  "projects.get_tooling": routeOp(
    ["full", "session"],
    onProject((id) => ({ method: "GET", url: `/api/projects/${enc(id)}/tooling` })),
  ),
  "projects.set_tooling": {
    scopes: ["full"],
    handler: async ({ app, conn, body, reply }) => {
      const id = extractProjectId(body);
      if (id === null) {
        reply({ ok: false, status: 400, error: "'projectId' is required" });
        return;
      }
      // Forward each field that was explicitly provided. The REST routes
      // each handle their own validation and upsert independently.
      const results: Record<string, unknown> = {};
      let allOk = true;
      const base = `/api/projects/${encodeURIComponent(id)}/tooling`;
      const headers = buildAuthHeaders(app);
      const b = body ?? {};
      if (b.briefing !== undefined) {
        results.briefing = await injectRoute(app, conn, {
          method: "PUT",
          url: base,
          headers,
          payload: { briefing: b.briefing },
        });
        if ((results.briefing as { ok?: boolean })?.ok === false) allOk = false;
      }
      if (b.skill !== undefined) {
        results.skill = await injectRoute(app, conn, {
          method: "PUT",
          url: `${base}/skill`,
          headers,
          payload: { skill: b.skill },
        });
        if ((results.skill as { ok?: boolean })?.ok === false) allOk = false;
      }
      if (b.reviewerAgent !== undefined) {
        results.reviewerAgent = await injectRoute(app, conn, {
          method: "PUT",
          url: `${base}/reviewer-agent`,
          headers,
          payload: { reviewerAgent: b.reviewerAgent },
        });
        if ((results.reviewerAgent as { ok?: boolean })?.ok === false) allOk = false;
      }
      reply({ ok: allOk, ...results });
    },
  },
  // Full scope only — same posture as sessions.create: an agent inside a
  // session has no business minting a preview subdomain for an unrelated
  // project or arbitrary external URL through this socket.
  "previews.create": routeOp(["full"], ({ body }) => ({
    method: "POST",
    url: "/api/previews",
    payload: json(body),
  })),
  "previews.get": routeOp(["full"], (ctx) => {
    const slug = typeof ctx.body?.slug === "string" ? ctx.body.slug : null;
    if (slug === null || slug.length === 0) return bad(400, "'slug' is required");
    return { method: "GET", url: `/api/previews/${enc(slug)}` };
  }),
  "previews.delete": routeOp(["full"], (ctx) => {
    const slug = typeof ctx.body?.slug === "string" ? ctx.body.slug : null;
    if (slug === null || slug.length === 0) return bad(400, "'slug' is required");
    return { method: "DELETE", url: `/api/previews/${enc(slug)}` };
  }),
  // Full scope only — previews are host-global (no session/user scoping
  // column on the table), so a session-scoped connection listing all
  // previews would leak every external preview's URL to whichever session
  // happens to hold a hook token.
  "previews.list": routeOp(["full"], () => ({ method: "GET", url: "/api/previews" })),
  // Full scope only, matching the plan's allowlist — the set of installed
  // agent CLIs on the host is operator-facing config, not something an
  // in-session agent needs to query about itself.
  "agents.list": routeOp(["full"], () => ({ method: "GET", url: "/api/agents" })),
  // Full scope only — issue #944, same posture as agents.list: bundle-sync
  // status is operator-facing host config, not something an in-session
  // agent needs to introspect about itself.
  "bundle.status": routeOp(["full"], () => ({ method: "GET", url: "/api/bundle-sync/status" })),
  "bundle.resync": routeOp(["full"], () => ({
    method: "POST",
    url: "/api/bundle-sync/resync",
    payload: "{}",
  })),
  // Issue #945 — full scope only, same reasoning: removing Mullion's own
  // integration from the host is an operator action, never something an
  // in-session agent should be able to trigger against its own host.
  "bundle.remove": routeOp(["full"], () => ({
    method: "POST",
    url: "/api/bundle-sync/remove",
    payload: "{}",
  })),
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
  // Trimmed via configuredToken, same as every other credential path in
  // services/auth.ts (security audit finding AS2, found on this parallel
  // path in Hermes review) — comparing against the raw, untrimmed config
  // value here made a token with incidental surrounding whitespace
  // authenticate over HTTP (trimmed) but fail on this control socket
  // (untrimmed), a third inconsistent reading of "the configured token"
  // alongside the two AS2 already unified.
  const expected = configuredToken(app.config);
  // Issue #1059 — both sides are fixed-length (operator-configured
  // MULLION_AUTH_TOKEN vs inbound bearer); same fixed-length assumption as
  // auth.ts / internal.ts — see crypto-utils.ts for the full constraint.
  if (expected !== "" && timingSafeTokenMatch(token, expected)) {
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
  socket.once("close", () => {
    openSockets.delete(socket);
    // Phase 4 (#186) — the whole connection going away must close every
    // still-open `sessions.attach` stream on it too (unsubscribing
    // attachSocketToSession's own data/exit listeners — see
    // SocketChannel.close()), the same way a real WS's own "close" event
    // would; nothing else ever does this for a connection that just drops
    // without an explicit sessions.detach first. notify: false — the
    // underlying net.Socket has already closed by the time this fires
    // (this IS its own "close" event), so a wire write is pointless;
    // clear() below removes every entry in one pass rather than relying on
    // each channel's own close listener to do it one at a time.
    if (conn) {
      for (const channel of conn.openChannels.values()) channel.close(false);
      conn.openChannels.clear();
    }
  });

  let buffer = "";
  // UTF-8 byte length of `buffer`, tracked incrementally so framing never
  // re-measures (or re-scans) the whole buffer per chunk (#1521).
  let bufferBytes = 0;
  // Everything before this index has already been searched for "\n".
  let scanFrom = 0;
  let conn: ConnectionState | null = null;
  let inflight = 0;
  let paused = false;
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

  const overloaded = () =>
    conn !== null &&
    (inflight >= MAX_INFLIGHT_OPS || socket.writableLength >= WRITE_HIGH_WATER_BYTES);

  // Reconciles the socket's paused state with current load and, when load has
  // cleared, resumes processing lines that were left buffered while paused.
  const setPaused = (next: boolean) => {
    if (paused === next) return;
    paused = next;
    if (next) socket.pause();
    else socket.resume();
  };
  const flow = () => {
    if (socket.destroyed) return;
    if (overloaded()) {
      setPaused(true);
      return;
    }
    setPaused(false);
    pump();
  };
  socket.on("drain", flow);

  const pump = () => {
    while (!socket.destroyed) {
      // Lines already buffered are NOT dispatched while overloaded — pausing
      // the socket alone would not stop the rest of a chunk already read.
      if (overloaded()) {
        setPaused(true);
        return;
      }
      const newlineIndex = buffer.indexOf("\n", scanFrom);
      if (newlineIndex === -1) {
        scanFrom = buffer.length;
        break;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      scanFrom = 0;
      const lineBytes = Buffer.byteLength(line, "utf8");
      bufferBytes -= lineBytes + 1;

      if (line.trim() === "") continue;

      // Guards a *terminated* line of any size — the remnant check after
      // this loop only catches an unterminated tail; a single TCP chunk
      // can legitimately contain one complete line larger than
      // MAX_LINE_BYTES (the newline just happens to arrive in the same
      // write), which would otherwise be extracted and dispatched with no
      // cap applied at all. Checked before any JSON.parse of the line —
      // parsing a deliberately oversized line is itself the expensive
      // operation this cap exists to avoid, so no id is recovered here.
      if (conn === null && lineBytes > MAX_HANDSHAKE_BYTES) {
        app.log.warn("control connection sent an oversized handshake line, closing");
        clearTimeout(handshakeTimer);
        socket.destroy();
        return;
      }
      if (lineBytes > MAX_LINE_BYTES) {
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
          // Never log any prefix of the presented token (#1521): a session's
          // hook token is a live credential.
          const hint =
            handshake.token === null
              ? "no token presented"
              : `presented token of length ${handshake.token.length} did not match MULLION_AUTH_TOKEN or any live session`;
          app.log.warn(`control connection presented an invalid handshake, closing (${hint})`);
          clearTimeout(handshakeTimer);
          socket.destroy();
          return;
        }
        clearTimeout(handshakeTimer);
        conn = {
          socket,
          scope: resolved.scope,
          sessionId: resolved.sessionId,
          openChannels: new Map(),
        };
        continue;
      }

      const result = parseControlMessage(line);
      if (!result.ok) {
        send(socket, { id: result.id, ok: false, status: 400, error: result.error });
        continue;
      }

      inflight++;
      dispatch(app, conn, result.message)
        .catch((err) => app.log.error({ err }, "dispatch failed"))
        .finally(() => {
          inflight--;
          flow();
        });
    }

    // Checked AFTER draining every complete line above, not on the raw
    // just-appended buffer — a single chunk can legitimately contain a
    // complete, valid line followed by an oversized, still-incomplete tail
    // (e.g. a handshake line immediately followed by a multi-megabyte
    // write with no terminator yet); that valid line must still be
    // processed rather than the whole connection being destroyed before
    // ever reading it. Only an unterminated remainder counts toward the cap.
    if (!socket.destroyed && bufferBytes > (conn === null ? MAX_HANDSHAKE_BYTES : MAX_LINE_BYTES)) {
      app.log.warn("control connection sent an oversized line without a terminator, closing");
      socket.destroy();
    }
  };

  socket.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    buffer += text;
    bufferBytes += Buffer.byteLength(text, "utf8");
    pump();
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
  // Own-property lookup: OPS is a plain object, so `OPS["toString"]` /
  // `"__proto__"` / `"constructor"` would otherwise resolve to an inherited
  // Object.prototype member with no `.scopes`, and the `.includes` below would
  // throw outside the try — an unhandled rejection that takes the process down.
  const spec = Object.hasOwn(OPS, message.op) ? OPS[message.op] : undefined;
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
    await spec.handler({ app, conn, id: message.id, body: message.body, reply });
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

  // Removes a genuinely stale socket file (mirrors hooks.ts's own — a prior
  // process that exited without running this plugin's onClose leaves one
  // behind) but throws instead of unlinking if something IS still live at
  // this path — see unix-socket.ts's own doc comment for the incident this
  // prevents (this socket path is injected into every spawned session, so a
  // stray dev backend started from inside one inherits it and would
  // otherwise silently hijack the real listener).
  await reclaimSocketPath(socketPath);

  // Tracks every currently-open connection so onClose below can actually
  // sever them — server.close() alone only stops accepting *new*
  // connections, it never touches sockets already open (a gap that matters
  // more here than it might elsewhere: MULLION_SOCKET_PATH is injected into
  // every spawned session in a later Phase 4 PR, so a wedged same-uid agent
  // connection could otherwise hold this process open past graceful
  // shutdown indefinitely).
  const openSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => handleConnection(app, socket, openSockets));
  server.maxConnections = MAX_CONNECTIONS;

  // bind() creates the socket file with 0777 & ~umask; a 077 umask for the
  // (synchronous) bind means it is never group/world-accessible, not even
  // between listen() and the chmod below (#1521). Restored immediately —
  // umask is process-wide. Unsupported in worker threads, hence the guard.
  let previousUmask: number | null = null;
  try {
    previousUmask = process.umask(0o077);
  } catch {
    previousUmask = null;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
      if (previousUmask !== null) process.umask(previousUmask);
      previousUmask = null;
    });
  } finally {
    if (previousUmask !== null) process.umask(previousUmask);
  }
  // 0600: filesystem perms are the first line of defense alongside the
  // handshake token above, same posture as hooks.ts's own hook socket.
  chmodSync(socketPath, 0o600);

  app.decorate("controlServer", server);

  app.addHook("onClose", async () => {
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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
