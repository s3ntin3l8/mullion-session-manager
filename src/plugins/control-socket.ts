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
import { SocketChannel } from "../services/socket-channel.js";
import { reclaimSocketPath } from "../services/unix-socket.js";

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
function extractSessionId(body: Record<string, unknown> | undefined): string | null {
  const rawId = body?.sessionId;
  if (rawId === undefined || rawId === null) return null;
  if (typeof rawId !== "string" && typeof rawId !== "number") return null;
  const id = String(rawId);
  // An empty string is never a real session id — treating it as "not
  // provided" (rather than a literal target) means a bogus `{sessionId:""}`
  // gets the same "'sessionId' is required" 400 every other omitted-id case
  // does, instead of silently reaching app.inject() with an empty path
  // segment (Hermes review, PR #398).
  return id.length === 0 ? null : id;
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
  const rawId = body?.projectId;
  if (rawId === undefined || rawId === null) return null;
  if (typeof rawId !== "string" && typeof rawId !== "number") return null;
  const id = String(rawId);
  return id.length === 0 ? null : id;
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
  const rawId = body?.parentSessionId;
  if (rawId === undefined || rawId === null) return null;
  if (typeof rawId !== "string" && typeof rawId !== "number") return null;
  const id = String(rawId);
  return id.length === 0 ? null : id;
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
      const {
        sessionId: _sessionId,
        parentSessionId: _parentSessionId,
        projectId: _projectId,
        worktree: _worktree,
        worktreeRefresh: _worktreeRefresh,
        ...rest
      } = body ?? {};
      // Session-scoped callers may never set `skipPermissions` or `kind`
      // (independent review, PR #426): both are privilege-adjacent —
      // skipPermissions disables permission prompts for the new session,
      // and kind:"dock" hides it from the normal per-project session list
      // (Sidebar.tsx renders only kind:"terminal"; only Dock.tsx surfaces
      // "dock" sessions). Letting a session-scoped connection — whose hook
      // token is inherited by every subprocess an agent spawns — set
      // either would hand an already-compromised or merely misbehaving
      // subprocess a strictly MORE privileged, less visible session than
      // its own, which is exactly the escalation `sessions.create`'s
      // full-scope gate exists to withhold. Full scope keeps both
      // (matching `sessions.create`'s own behavior for that scope) since a
      // full-scope caller already has this power directly.
      //
      // `env` (issue #822) joins this list for the same reason: without
      // it, a NEW field added to POST /api/sessions' schema would silently
      // widen session scope the moment it landed — this `...rest` spread
      // forwards anything not explicitly named above. A session-scoped
      // agent spawning a child of its own session has no legitimate need
      // to hand that child arbitrary extra env; a full-scope caller
      // already has this power directly (same as skipPermissions/kind).
      if (conn.scope === "session") {
        delete rest.skipPermissions;
        delete rest.kind;
        delete rest.env;
      }
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
          headers: { ...buildAuthHeaders(app), "content-type": "application/json" },
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
  "sessions.kill": {
    scopes: ["full"],
    handler: async ({ app, conn, body, reply }) => {
      const id = extractSessionId(body);
      if (id === null) {
        reply({ ok: false, status: 400, error: "'sessionId' is required" });
        return;
      }
      const cascade = body?.cascade;
      // Rejected explicitly here (independent review, PR #426) rather than
      // silently dropped — an invalid value used to fall through to the
      // REST route's own default ("detach") instead of surfacing the same
      // 400 a bad value gets over REST directly, which was inconsistent
      // between the two transports for identical input.
      if (cascade !== undefined && cascade !== "detach" && cascade !== "kill") {
        reply({
          ok: false,
          status: 400,
          error: "'cascade' must be 'detach' or 'kill'",
        });
        return;
      }
      const query = cascade !== undefined ? { cascade } : undefined;
      reply(
        await injectRoute(app, conn, {
          method: "DELETE",
          url: buildQueryUrl(`/api/sessions/${encodeURIComponent(id)}`, query),
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
      // Deliberately NOT trimmed before this check: PATCH /api/sessions/:id's
      // own ajv schema is `minLength: 1` with no trim either, so a
      // whitespace-only name is accepted by both layers alike. Trimming
      // only here would make the socket stricter than the REST route it's
      // supposed to be an alternative transport for, not more consistent
      // with it (Hermes review, PR #398) — a real "reject whitespace-only
      // names" policy change belongs in renameSessionSchema itself, for
      // every caller, not bolted onto one transport.
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
      if (conn.openChannels.has(id)) {
        reply({ ok: false, status: 400, error: "a stream is already open for this id" });
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
      const channel = conn.openChannels.get(id);
      if (!channel) {
        reply({ ok: false, status: 400, error: "no open stream for this id" });
        return;
      }
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
      const channel = conn.openChannels.get(id);
      if (!channel) {
        reply({ ok: false, status: 400, error: "no open stream for this id" });
        return;
      }
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
      const channel = conn.openChannels.get(id);
      if (!channel) {
        reply({ ok: false, status: 400, error: "no open stream for this id" });
        return;
      }
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
      if (conn.openChannels.has(id)) {
        reply({ ok: false, status: 400, error: "a stream is already open for this id" });
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
      const channel = conn.openChannels.get(id);
      if (!channel) {
        reply({ ok: false, status: 400, error: "no open stream for this id" });
        return;
      }
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
      const channel = conn.openChannels.get(id);
      if (!channel) {
        reply({ ok: false, status: 400, error: "no open stream for this id" });
        return;
      }
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
  "events.query": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const resolved = resolveEventsSessionFilter(conn, body);
      if (!resolved.ok) {
        reply(resolved.reply);
        return;
      }
      const queryBody: Record<string, unknown> = { ...body };
      if (resolved.sessionId !== undefined) queryBody.sessionId = resolved.sessionId;
      else delete queryBody.sessionId;
      reply(
        await injectAndShape(app, {
          method: "GET",
          url: buildQueryUrl("/api/events", queryBody),
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  // Phase 4 (#189) — request/response, not a stream: `executeBrowserAction`
  // (browser-automation.ts) already returns a full snapshot/console/errors
  // envelope in one shot, so there's nothing here that needs multiplexing
  // the way PTY output or a live events feed does. Same target-id shape as
  // sessions.get/scrollback/rename above — `body.sessionId` is stripped
  // before forwarding (it's this socket's own targeting field, not part of
  // AgentAction's schema) so the REST route only ever sees the action body
  // it actually expects.
  "browser.action": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveTargetSessionId(conn, body);
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const { sessionId: _sessionId, ...actionBody } = body ?? {};
      reply(
        await injectAndShape(app, {
          method: "POST",
          url: `/api/sessions/${encodeURIComponent(target.id)}/browser`,
          headers: { ...buildAuthHeaders(app), "content-type": "application/json" },
          payload: JSON.stringify(actionBody),
        }),
      );
    },
  },
  // Same shape as browser.action — `body.sessionId` targets the session,
  // the rest (`by`/`value`/`name`/`limit`) is FindElementsBody verbatim.
  "browser.find": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveTargetSessionId(conn, body);
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const { sessionId: _sessionId, ...findBody } = body ?? {};
      reply(
        await injectAndShape(app, {
          method: "POST",
          url: `/api/sessions/${encodeURIComponent(target.id)}/browser/find`,
          headers: { ...buildAuthHeaders(app), "content-type": "application/json" },
          payload: JSON.stringify(findBody),
        }),
      );
    },
  },
  // Read-only inspect of which browser pane(s) a session is bound to —
  // same target-id shape as sessions.get, no request body beyond sessionId.
  "browser.bindings": {
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
          url: `/api/sessions/${encodeURIComponent(target.id)}/browser`,
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
  // Phase 4 (#134, PR6) — reachable at session scope: an agent inside a
  // session asking "what launchers does my own project have" with no
  // `projectId` at all is the shape `mullion project actions` actually uses
  // — see resolveTargetProjectId. Multi-host proxying (a project on a
  // remote agent host) is inherited for free through app.inject() against
  // the real route, same as every other op here.
  "projects.actions": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveTargetProjectId(app, conn, body);
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      reply(
        await injectAndShape(app, {
          method: "GET",
          url: `/api/projects/${encodeURIComponent(target.id)}/actions`,
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  // Full scope only, per the plan's per-scope allowlist — unlike
  // projects.actions above, dock controls are an operator-facing concept
  // (persistent monitors toggled from the dashboard), not something an
  // agent inside a session needs to introspect about itself.
  "projects.dock": {
    scopes: ["full"],
    handler: async ({ app, conn, body, reply }) => {
      const id = extractProjectId(body);
      if (id === null) {
        reply({ ok: false, status: 400, error: "'projectId' is required" });
        return;
      }
      reply(
        await injectRoute(app, conn, {
          method: "GET",
          url: `/api/projects/${encodeURIComponent(id)}/dock`,
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  // Full scope only — project tooling is operator-authored config, not
  // something an agent inside a session should modify about an unrelated
  // project. GET is session-scoped (agents can read their own project's
  // tooling); SET is full-scope only.
  "projects.get_tooling": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveTargetProjectId(app, conn, body);
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      reply(
        await injectAndShape(app, {
          method: "GET",
          url: `/api/projects/${encodeURIComponent(target.id)}/tooling`,
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  "projects.set_tooling": {
    scopes: ["full"],
    handler: async ({ app, conn: _conn, body, reply }) => {
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
        results.briefing = await injectAndShape(app, {
          method: "PUT",
          url: base,
          headers,
          payload: { briefing: b.briefing },
        });
        if ((results.briefing as { ok?: boolean })?.ok === false) allOk = false;
      }
      if (b.skill !== undefined) {
        results.skill = await injectAndShape(app, {
          method: "PUT",
          url: `${base}/skill`,
          headers,
          payload: { skill: b.skill },
        });
        if ((results.skill as { ok?: boolean })?.ok === false) allOk = false;
      }
      if (b.reviewerAgent !== undefined) {
        results.reviewerAgent = await injectAndShape(app, {
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
  "previews.create": {
    scopes: ["full"],
    handler: async ({ app, conn, body, reply }) => {
      reply(
        await injectRoute(app, conn, {
          method: "POST",
          url: "/api/previews",
          headers: { ...buildAuthHeaders(app), "content-type": "application/json" },
          payload: JSON.stringify(body ?? {}),
        }),
      );
    },
  },
  "previews.get": {
    scopes: ["full"],
    handler: async ({ app, conn, body, reply }) => {
      const slug = typeof body?.slug === "string" ? body.slug : null;
      if (slug === null || slug.length === 0) {
        reply({ ok: false, status: 400, error: "'slug' is required" });
        return;
      }
      reply(
        await injectRoute(app, conn, {
          method: "GET",
          url: `/api/previews/${encodeURIComponent(slug)}`,
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  "previews.delete": {
    scopes: ["full"],
    handler: async ({ app, conn, body, reply }) => {
      const slug = typeof body?.slug === "string" ? body.slug : null;
      if (slug === null || slug.length === 0) {
        reply({ ok: false, status: 400, error: "'slug' is required" });
        return;
      }
      reply(
        await injectRoute(app, conn, {
          method: "DELETE",
          url: `/api/previews/${encodeURIComponent(slug)}`,
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  // Full scope only — previews are host-global (no session/user scoping
  // column on the table), so a session-scoped connection listing all
  // previews would leak every external preview's URL to whichever session
  // happens to hold a hook token.
  "previews.list": {
    scopes: ["full"],
    handler: async ({ app, conn, reply }) => {
      reply(
        await injectRoute(app, conn, {
          method: "GET",
          url: "/api/previews",
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  // Full scope only, matching the plan's allowlist — the set of installed
  // agent CLIs on the host is operator-facing config, not something an
  // in-session agent needs to query about itself.
  "agents.list": {
    scopes: ["full"],
    handler: async ({ app, conn, reply }) => {
      reply(
        await injectRoute(app, conn, {
          method: "GET",
          url: "/api/agents",
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  // Full scope only — issue #944, same posture as agents.list: bundle-sync
  // status is operator-facing host config, not something an in-session
  // agent needs to introspect about itself.
  "bundle.status": {
    scopes: ["full"],
    handler: async ({ app, conn, reply }) => {
      reply(
        await injectRoute(app, conn, {
          method: "GET",
          url: "/api/bundle-sync/status",
          headers: buildAuthHeaders(app),
        }),
      );
    },
  },
  "bundle.resync": {
    scopes: ["full"],
    handler: async ({ app, conn, reply }) => {
      reply(
        await injectRoute(app, conn, {
          method: "POST",
          url: "/api/bundle-sync/resync",
          headers: { ...buildAuthHeaders(app), "content-type": "application/json" },
          payload: "{}",
        }),
      );
    },
  },
  // Issue #945 — full scope only, same reasoning: removing Mullion's own
  // integration from the host is an operator action, never something an
  // in-session agent should be able to trigger against its own host.
  "bundle.remove": {
    scopes: ["full"],
    handler: async ({ app, conn, reply }) => {
      reply(
        await injectRoute(app, conn, {
          method: "POST",
          url: "/api/bundle-sync/remove",
          headers: { ...buildAuthHeaders(app), "content-type": "application/json" },
          payload: "{}",
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
  // Trimmed via configuredToken, same as every other credential path in
  // services/auth.ts (security audit finding AS2, found on this parallel
  // path in Hermes review) — comparing against the raw, untrimmed config
  // value here made a token with incidental surrounding whitespace
  // authenticate over HTTP (trimmed) but fail on this control socket
  // (untrimmed), a third inconsistent reading of "the configured token"
  // alongside the two AS2 already unified.
  const expected = configuredToken(app.config);
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
