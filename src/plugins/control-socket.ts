import fp from "fastify-plugin";
import type { FastifyInstance, InjectOptions } from "fastify";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { chmodSync, unlinkSync } from "node:fs";
import {
  parseControlMessage,
  parseControlHandshake,
  HANDSHAKE_TIMEOUT_MS,
  MAX_HANDSHAKE_BYTES,
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
import { isPipePath } from "../cli/ipc-path.mjs";
import { restrictPipeToCurrentUser } from "../cli/pipe-acl.mjs";
import { and, eq, inArray } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { crossProjectAllowed, messageAllowed } from "../services/cross-project.js";
import {
  DEFAULT_MESSAGE_TTL_MS,
  SessionMessageQueue,
  WindowRateLimiter,
  type DeliverOutcome,
  type QueuedMessage,
  type TargetReadiness,
} from "../services/session-message-queue.js";
import type { SessionSeverity, SessionStatus } from "../shared/types.js";
import { compileOutputMatcher } from "../services/output-wait.js";
import {
  parseWaitTimeout,
  parseWaitUntil,
  waitForSession,
  type WaitSnapshot,
} from "../services/session-wait.js";
import {
  CONTROL_SOCKET_VIA_HEADER,
  CONTROL_SOCKET_VIA_TOKEN,
} from "../services/internal-request.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { resolveBackend } from "../services/session-backend.js";
import { deliverPrompt } from "../services/session-prompt.js";
import { adoptSurvivingSession } from "../services/session-adopt.js";
import {
  readSessionLiveInfo,
  resolveSessionHostId,
  withLiveInfo,
} from "../services/session-live-info.js";
import { getStoredSettings } from "../services/settings.js";
import { MAX_PROMPT_BYTES, sanitizePromptText } from "../services/hook-adapters/shared.js";

type ProjectRow = typeof projects.$inferSelect;

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
export { HANDSHAKE_TIMEOUT_MS };

// Issue #1517 — per-connection load bounds. One session-scoped client (the
// socket path is injected into every spawned session) must not be able to
// queue unbounded work or reply bytes in this process.
/** Max ops dispatched but not yet replied to on one connection; past it the
 * socket is paused and the remaining buffered lines wait. */
export const MAX_INFLIGHT_OPS = 32;
/** Max open sessions.attach / events.subscribe streams per connection. */
export const MAX_OPEN_CHANNELS = 16;
/** Max simultaneously pending sessions.wait ops on one connection. Each holds
 * an in-flight slot and re-reads status every tick, so an uncapped fan-out
 * could fill MAX_INFLIGHT_OPS (pausing the socket and starving the
 * connection's other ops) and multiply the per-tick work. Each pending wait
 * costs ~2 injected REST reads + 1 DB read per second; raising this cap
 * safely means deriving the status in-process (as buildLiveInfo does) rather
 * than re-entering GET /api/sessions/:id on every tick. */
export const MAX_WAITS_PER_CONNECTION = 4;
/** Once this many reply bytes are queued unwritten, stop reading requests
 * until the socket 'drain's. */
export const WRITE_HIGH_WATER_BYTES = 1024 * 1024;
export { WRITE_HARD_CEILING_BYTES };
/** Pre-handshake input is just `{"token":"..."}`; nothing legitimate needs
 * more than this before authenticating. */
export { MAX_HANDSHAKE_BYTES };
/** Global cap on simultaneously open connections (server.maxConnections). */
export const MAX_CONNECTIONS = 256;

type Scope = "full" | "session";

export interface ConnectionState {
  /** The reply sink every op writes through (`dispatch`'s `reply` included),
   * so an op never touches the transport. */
  send: (message: { id: number | null } & Record<string, unknown>) => void;
  /** Runs `listener` once if the connection closes; returns the unsubscribe. */
  onClose: (listener: () => void) => () => void;
  /** The raw socket, for the streaming ops (`attach`, `events.*`) that write
   * through a SocketChannel. A relayed connection carries its in-memory pair's
   * server half here (#2125). Null only on a connection with no socket at all
   * (a test sink), where those ops are refused. */
  readonly socket: net.Socket | null;
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
  /** Pending sessions.wait ops (see MAX_WAITS_PER_CONNECTION). */
  activeWaits: number;
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
 * verified against createSessionSchema in routes/sessions.ts.
 *
 * Issue #1733 — `skipPermissions` joins the list, but it is CAPPED by the
 * parent's own value right here, where the connection's scope is known, so
 * forwarding it can only ever NARROW the child's permission posture, never
 * widen it. See the handler's own comment for the reasoning.
 * `kind` does NOT join: making a child a dock session hides it from the
 * session list, which is a visibility change rather than a permission one,
 * and #426 called it out explicitly.
 *
 * Issue #1951 — `targetHostId`/`targetPlatform` (run the child on a chosen
 * host) and `isolate` (a server-chosen fresh worktree on that host) join.
 * A target only reaches hosts the PROJECT is mapped on (`hostCwds`, the
 * operator's own list of where the project lives) that are also eligible
 * (placement.ts's resolveTargetHost). That DOES widen where a session-scoped
 * caller can put a child compared with a `pinned` project's default of "the
 * project's own host": a `pinned` project is not placed automatically, but
 * an explicit target may use any host the operator mapped for it. Mapping a
 * host under `hostCwds` is therefore the opt-in; do not map one you do not
 * want children to reach. `isolate` is the safe spelling of a worktree — the
 * raw `worktree` stays stripped. createSessionRecord rejects `isolate`
 * combined with `cwd`/`worktree`.
 */
const SESSION_SPAWN_CHILD_FIELDS: readonly string[] = [
  "command",
  "name",
  "cwd",
  "model",
  "smallModel",
  "seedPrompt",
  "open",
  "skipPermissions",
  "targetHostId",
  "targetPlatform",
  "isolate",
];

/**
 * Issue #2110 — resolves the `project` a coordinator named for a cross-project
 * spawn: a project id (a number, or a string of digits) or an EXACT project
 * name. A name that matches more than one project the caller may use -> 409,
 * asking for the id (project names are not unique).
 *
 * Issues #2123 / #2124 — only a project the source may reach AND that accepts it
 * (`allowed`) can be resolved. At session scope (`uniform`) everything else is the
 * SAME 403 — a project that does not exist, one outside the coordinator's list,
 * one that refuses coordinators — so a session cannot probe which projects and
 * names exist. Full scope is the operator and keeps the precise 404.
 */
function resolveSpawnTarget(
  app: FastifyInstance,
  ref: unknown,
  rule: { allowed: (project: ProjectRow) => boolean; uniform: boolean },
): { ok: true; id: number } | { ok: false; reply: ReplyPayload } {
  const bad = (status: number, error: string) => ({
    ok: false as const,
    reply: { ok: false as const, status, error },
  });
  const refused = (notFound: string) =>
    rule.uniform ? bad(403, CROSS_PROJECT_TARGET_REFUSED) : bad(404, notFound);
  if (typeof ref === "number" || (typeof ref === "string" && /^\d+$/.test(ref.trim()))) {
    const id = Number(ref);
    const [row] = app.db.select().from(projects).where(eq(projects.id, id)).all();
    if (!row) return refused(`unknown project ${id}`);
    return rule.allowed(row) ? { ok: true, id: row.id } : bad(403, CROSS_PROJECT_TARGET_REFUSED);
  }
  if (typeof ref !== "string" || ref.trim() === "") {
    return bad(400, "'project' must be a project id or an exact project name");
  }
  const rows = app.db.select().from(projects).where(eq(projects.name, ref)).all();
  if (rows.length === 0) return refused(`unknown project "${ref}"`);
  const usable = rows.filter(rule.allowed);
  if (usable.length === 0) return bad(403, CROSS_PROJECT_TARGET_REFUSED);
  if (usable.length > 1) {
    return bad(
      409,
      `more than one project is named "${ref}" (ids ${usable.map((r) => r.id).join(", ")}); pass the id`,
    );
  }
  return { ok: true, id: usable[0]!.id };
}

const CROSS_PROJECT_TARGET_REFUSED =
  "no such project, or this session's project may not spawn children there " +
  "(see 'This project coordinates' and the target project's consent in Edit project)";

const CROSS_PROJECT_DISABLED =
  "this session's project is not allowed to spawn children in other projects " +
  "(turn on 'This project coordinates' in Edit project)";

/** Whether `projectId` is a coordinator project (projects.allowCrossProjectSpawn). */
function projectCoordinates(app: FastifyInstance, projectId: number): boolean {
  const [row] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  return row?.allowCrossProjectSpawn === true;
}

/** The projects a session of `source` may start children in (the rule of
 * services/cross-project.ts), never including the source itself. */
function allowedSpawnTargets(app: FastifyInstance, source: ProjectRow): ProjectRow[] {
  return app.db
    .select()
    .from(projects)
    .all()
    .filter((p) => p.id !== source.id && crossProjectAllowed(source, p));
}

/** Streaming ops need a socket to write their frames to; only a connection with
 * none (a test sink) lacks one now that a relay carries its pair (#2125). */
const STREAM_UNAVAILABLE: ReplyPayload = {
  ok: false,
  status: 501,
  error: "not-available-over-relay: streaming ops need a local control-socket connection",
};

function writeFrame(
  socket: net.Socket,
  message: { id: number | null } & Record<string, unknown>,
): void {
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

/** Whether `id`'s DB row is still `active`. A hook token outlives its
 * session's own intent (it stays valid until the process is reaped), so an
 * op that lets a session act beyond itself re-checks the ROW — the source of
 * intent; the in-memory PtyManager map can lack a live session (#1518). */
function sessionRowIsActive(app: FastifyInstance, id: string): boolean {
  const row = app.db
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, Number(id)))
    .get();
  return row?.status === "active";
}

/** The ids of `parentId`'s children (issue #2125: seeds an event replay). */
function childSessionIds(app: FastifyInstance, parentId: number): number[] {
  return app.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.parentSessionId, parentId))
    .all()
    .map((row) => row.id);
}

/**
 * Event filter for a session-scoped `events.subscribe` with `includeChildren`:
 * the pinned session plus every session whose `parent_session_id` is it. The
 * bus carries no "child spawned" event, so an id is classified the first time
 * one of its events shows up, with one synchronous DB lookup memoised per
 * subscription — safe to cache negatives too, because `parent_session_id` is
 * set at creation and never changes.
 */
function ownAndChildSessionFilter(
  app: FastifyInstance,
  pinnedId: number,
): (sessionId: number) => boolean {
  const known = new Map<number, boolean>([[pinnedId, true]]);
  const missedOnce = new Set<number>();
  return (sessionId) => {
    let isOwn = known.get(sessionId);
    if (isOwn === undefined) {
      const row = app.db
        .select({ parentSessionId: sessions.parentSessionId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get();
      isOwn = row?.parentSessionId === pinnedId;
      // A missing row could be an event racing the INSERT, so the first miss
      // is not cached; a second miss means the row is not coming (an id that
      // never gets a row would otherwise re-run this SELECT on every event).
      if (row || missedOnce.has(sessionId)) known.set(sessionId, isOwn);
      else missedOnce.add(sessionId);
    }
    return isOwn;
  };
}

/** 409 text for ops that need the child's live PTY when its host has none
 * for it: the session exited, or was never started there. (A child on ANOTHER
 * host is routed to that host — see childHostId — it is not this case.) */
const NOT_LOCAL_MESSAGE = "the session is not running (it has no live process on its host)";

/** 503 text when a local child's scope could not be checked: not "not running". */
const UNVERIFIABLE_MESSAGE = "the session's liveness could not be verified, retry shortly";

/**
 * Issue #2271 — re-adopts a LOCAL child that survived a Mullion restart (its
 * scope is alive, PtyManager has not been told yet) before an op that needs
 * its live PTY or its live status. Resolves to a refusal when the scope could
 * not be checked (503, retryable); null otherwise, including for a dead
 * session — the op's own gate then answers it (409 "not running") as before.
 * A child on another host is that host's business.
 */
async function adoptLocalChild(app: FastifyInstance, id: string): Promise<ReplyPayload | null> {
  if (childHostId(app, id) !== LOCAL_HOST_ID) return null;
  return (await adoptSurvivingSession(app, id)) === "unverifiable"
    ? bad(503, UNVERIFIABLE_MESSAGE)
    : null;
}

/** The host a session runs on: its own (`sessions.hostId`), else its project's.
 * "local" for an id with no row, so a stray id keeps today's local behaviour. */
function childHostId(app: FastifyInstance, id: string): string {
  const row = app.db
    .select({ projectId: sessions.projectId, hostId: sessions.hostId })
    .from(sessions)
    .where(eq(sessions.id, Number(id)))
    .get();
  return row ? resolveSessionHostId(app, row) : LOCAL_HOST_ID;
}

/**
 * Like resolveTargetSessionId, but a session-scoped connection may ALSO name
 * a child it spawned (`sessions.parent_session_id === its pinned id`) — the
 * parent→child orchestration surface. Anything else, including a sibling, an
 * unrelated session, or an id that doesn't exist, is the same 403 (never a
 * 404, so a session can't probe which ids exist).
 *
 * The relationship is read from the DB row, not PtyManager, so a parent can
 * still inspect a child that has already exited. Acting on a child also
 * requires the CALLER's own row to still be active (see sessionRowIsActive).
 * `childOnly` additionally rejects the connection's own session as a target
 * (used by sessions.kill: a session may not kill itself through this socket).
 */
function resolveOwnedSessionId(
  app: FastifyInstance,
  conn: ConnectionState,
  body: Record<string, unknown> | undefined,
  opts: { childOnly?: boolean } = {},
): { ok: true; id: string } | { ok: false; reply: ReplyPayload } {
  if (conn.scope === "full") return resolveTargetSessionId(conn, body);

  const pinnedId = conn.sessionId!;
  const provided = extractSessionId(body);
  const forbidden = (error: string): { ok: false; reply: ReplyPayload } => ({
    ok: false,
    reply: { ok: false, status: 403, error },
  });

  if (provided === null || provided === pinnedId) {
    return opts.childOnly
      ? forbidden("session-scoped connections may only target a child of their own session")
      : { ok: true, id: pinnedId };
  }

  const childId = Number(provided);
  const childRow = Number.isInteger(childId)
    ? app.db
        .select({ parentSessionId: sessions.parentSessionId })
        .from(sessions)
        .where(eq(sessions.id, childId))
        .get()
    : undefined;
  if (!childRow || childRow.parentSessionId !== Number(pinnedId)) {
    return forbidden(
      "session-scoped connections may only target their own session or its children",
    );
  }
  if (!sessionRowIsActive(app, pinnedId)) {
    return forbidden("this session is no longer active");
  }
  // Canonical form, so a non-canonical spelling ("05", "0x5") that passed the
  // numeric check above can't reach a downstream route as a different string.
  return { ok: true, id: String(childId) };
}

/**
 * Resolves the `sessionId` filter `events.query` should apply — a variant of
 * resolveTargetSessionId's own shape, but for a QUERY rather than a
 * single-target op: full scope may omit `sessionId` entirely (meaning
 * "every session"), where every other session-targeted op requires it.
 * Session scope still can't broaden its own view: it may omit `sessionId`
 * (defaulting to its own pinned session, same as sessions.get), name that
 * exact session, or name one of its own CHILDREN (resolveOwnedSessionId) —
 * but never an unrelated session or "all sessions". `events.subscribe`
 * (live stream) is still pinned to the connection's own session only
 * (#1626 tracks extending it to children).
 */
function resolveEventsSessionFilter(
  app: FastifyInstance,
  conn: ConnectionState,
  body: Record<string, unknown> | undefined,
): { ok: true; sessionId: string | undefined } | { ok: false; reply: ReplyPayload } {
  const provided = extractSessionId(body);

  if (conn.scope === "session") {
    // Own session, or a child of it — never "all sessions".
    const target = resolveOwnedSessionId(app, conn, body);
    return target.ok ? { ok: true, sessionId: target.id } : { ok: false, reply: target.reply };
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
    // A DB read, not app.pty: a relayed session is not in this process's PtyManager.
    const row = app.db
      .select({ projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, Number(conn.sessionId)))
      .get();
    // The row must still be active: the PtyManager lookup this replaced also
    // 400'd once the session had exited.
    const ownProjectId =
      row?.projectId != null && sessionRowIsActive(app, conn.sessionId!)
        ? String(row.projectId)
        : null;
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

type ResolveFn = (ctx: OpContext) => Route | ReplyPayload | Promise<Route | ReplyPayload>;

/**
 * A resolver that has DECLARED how it relates to session scope — the tagged
 * union `routeOp` requires for any op listing "session" in its scopes:
 *  - `pinned`: the resolver verifies the request's target against the
 *    connection's own session/project pin (resolveTargetSessionId & co).
 *  - `unscoped`: the target is deliberately NOT pinned to the connection
 *    (a host-global read, or an explicit resource id by design) — a
 *    reviewed, greppable opt-out rather than an accident.
 *  - `owned`: the target may be the connection's own session OR a child it
 *    spawned (resolveOwnedSessionId) — wider than `pinned`, but still
 *    bounded by the parent_session_id relationship, never an arbitrary id.
 * `routeOp`'s full-only overload also takes a bare function, because
 * `injectRoute` already structurally enforces full scope there; the
 * session-reachable overload does not, so an op can't list "session" with a
 * resolver that silently pins nothing (#1546).
 */
export interface DeclaredResolver {
  readonly target: "pinned" | "unscoped" | "owned";
  readonly run: ResolveFn;
}

/** Declares that `run` pins its target to the connection's own session/project. */
export const pinned = (run: ResolveFn): DeclaredResolver => ({ target: "pinned", run });

/** Declares that `run` deliberately does not pin its target. */
export const unscoped = (run: ResolveFn): DeclaredResolver => ({ target: "unscoped", run });

/** Declares that `run` limits its target to the connection's own session or
 * one of that session's children (resolveOwnedSessionId). */
export const owned = (run: ResolveFn): DeclaredResolver => ({ target: "owned", run });

type FullOnlyScopes = readonly ["full"];
type SessionReachableScopes =
  readonly ["full", "session"] | readonly ["session", "full"] | readonly ["session"];

/**
 * Declarative request/response op: `resolve` turns the request into either a
 * `Route` to forward or an early `ReplyPayload` (validation / pin failure).
 * The runner picks `injectRoute` for full-scope-only ops (structural
 * enforcement) and `injectAndShape` for ops that list "session" — whose
 * resolver the type system forces to be declared `pinned`/`unscoped`.
 */
export function routeOp(scopes: FullOnlyScopes, resolve: ResolveFn | DeclaredResolver): OpSpec;
export function routeOp(scopes: SessionReachableScopes, resolve: DeclaredResolver): OpSpec;
export function routeOp(scopes: readonly Scope[], resolve: ResolveFn | DeclaredResolver): OpSpec {
  const fullOnly = scopes.length === 1 && scopes[0] === "full";
  const run = typeof resolve === "function" ? resolve : resolve.run;
  return {
    scopes,
    handler: async (ctx) => {
      const resolved = await run(ctx);
      if (!("method" in resolved)) {
        ctx.reply(resolved);
        return;
      }
      const opts = {
        method: resolved.method,
        url: resolved.url,
        headers: {
          ...(resolved.payload !== undefined ? jsonHeaders(ctx.app) : buildAuthHeaders(ctx.app)),
          // Marks a CLI/agent-originated request so routes that audit their
          // caller (DELETE /api/sessions/:id) can tell it from a browser one.
          [CONTROL_SOCKET_VIA_HEADER]: CONTROL_SOCKET_VIA_TOKEN,
        },
        ...(resolved.payload !== undefined ? { payload: resolved.payload } : {}),
      };
      ctx.reply(
        await (fullOnly ? injectRoute(ctx.app, ctx.conn, opts) : injectAndShape(ctx.app, opts)),
      );
    },
  };
}

type Resolver = DeclaredResolver;

/** Resolver wrapper: pins the target session (resolveTargetSessionId). */
const onSession = (fn: (id: string, ctx: OpContext) => Route | ReplyPayload): Resolver =>
  pinned((ctx) => {
    const target = resolveTargetSessionId(ctx.conn, ctx.body);
    return target.ok ? fn(target.id, ctx) : target.reply;
  });

/** Resolver wrapper: own session or one of its children (resolveOwnedSessionId). */
const onOwnedSession = (
  fn: (id: string, ctx: OpContext) => Route | ReplyPayload | Promise<Route | ReplyPayload>,
): Resolver =>
  owned((ctx) => {
    const target = resolveOwnedSessionId(ctx.app, ctx.conn, ctx.body);
    return target.ok ? fn(target.id, ctx) : target.reply;
  });

/** Resolver wrapper: pins the target project (resolveTargetProjectId). */
const onProject = (fn: (id: string, ctx: OpContext) => Route | ReplyPayload): Resolver =>
  pinned((ctx) => {
    const target = resolveTargetProjectId(ctx.app, ctx.conn, ctx.body);
    return target.ok ? fn(target.id, ctx) : target.reply;
  });

/** Resolver wrapper: a required explicit id field, 400 when absent. Does NOT
 * pin — the caller names the resource (see device.action's own comment). */
const onField = (key: string, fn: (id: string, ctx: OpContext) => Route | ReplyPayload): Resolver =>
  unscoped((ctx) => {
    const id = extractIdField(ctx.body, key);
    return id === null ? bad(400, `'${key}' is required`) : fn(id, ctx);
  });

const enc = encodeURIComponent;

/**
 * The target-selecting fields a review/triage relay request may carry:
 * `prNumber`, and the `repo`/`branch` of work happening outside the session's
 * own project repo. Only fields the caller actually set are forwarded, so an
 * absent one keeps the route's own default; the route's schema validates them.
 */
function relayTargetFields(
  body: Record<string, unknown> | undefined,
  keys: readonly string[] = ["prNumber", "repo", "branch"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (body?.[key] !== undefined) out[key] = body[key];
  return out;
}

/** `?a=1&b=x` for the set fields, `""` for none. */
function relayQuery(fields: Record<string, unknown>): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

type WaitBodyOpts = {
  until: Set<string>;
  timeoutMs: number;
  afterSeq?: number;
};

/** Parses sessions.wait's (and sessions.prompt's `wait`) until/timeoutMs[/afterSeq]. */
function parseWaitBody(
  body: Record<string, unknown> | undefined,
  { allowAfterSeq }: { allowAfterSeq: boolean },
): { ok: true; opts: WaitBodyOpts } | { ok: false; reply: ReplyPayload } {
  const until = parseWaitUntil(body?.until);
  if (!until.ok) return { ok: false, reply: bad(400, until.error) };
  const timeout = parseWaitTimeout(body?.timeoutMs);
  if (!timeout.ok) return { ok: false, reply: bad(400, timeout.error) };
  const afterSeq = allowAfterSeq ? body?.afterSeq : undefined;
  if (
    afterSeq !== undefined &&
    (typeof afterSeq !== "number" || !Number.isInteger(afterSeq) || afterSeq < 0)
  ) {
    return { ok: false, reply: bad(400, "'afterSeq' must be a non-negative integer") };
  }
  return {
    ok: true,
    opts: {
      until: until.until,
      timeoutMs: timeout.timeoutMs,
      ...(afterSeq !== undefined ? { afterSeq } : {}),
    },
  };
}

/** A session's derived status via the SAME REST path GET /api/sessions/:id
 * serves (so the derivation — and remote-host proxying — can't drift), or
 * null if it doesn't exist. Throws on any other failure. */
async function readDerivedStatus(app: FastifyInstance, id: string): Promise<WaitSnapshot | null> {
  const res = await injectAndShape(app, {
    method: "GET",
    url: `/api/sessions/${enc(id)}`,
    headers: buildAuthHeaders(app),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(res.error ?? "unable to read session status");
  }
  const row = res.result as {
    sessionStatus: SessionStatus;
    sessionStatusSeverity: SessionSeverity;
    sessionStatusDetail: string | null;
  };
  return {
    status: row.sessionStatus,
    severity: row.sessionStatusSeverity,
    detail: row.sessionStatusDetail ?? null,
  };
}

/**
 * Issue #1962 — one FRESH read of a session that lives on another host: its
 * derived status (the same derivation `GET /api/sessions/:id` applies, via
 * `withLiveInfo`) plus the two fields of the host's own `SessionInfo` that the
 * primary cannot get anywhere else — the event head and whether a prompted
 * turn is in flight. `fresh` bypasses the host client's 1.5 s cache, which
 * could otherwise hand back the PREVIOUS turn's `finished` right after a
 * prompt. A host that does not answer is reported as suspended (as the REST
 * path does); one that answers with an error is thrown. `snapshot` is null for
 * a session that has no row.
 */
async function readRemoteSession(
  app: FastifyInstance,
  id: string,
  hostId: string,
): Promise<{ snapshot: WaitSnapshot | null; eventSeqHead?: number; turnInFlight: boolean }> {
  const row = app.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, Number(id)))
    .get();
  if (!row) return { snapshot: null, turnInFlight: false };
  const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
  const { info, hostReachable, failure, error } = await readSessionLiveInfo(
    app,
    row,
    idleThresholdMs,
    hostId,
    { fresh: true },
  );
  // A host that ANSWERED and refused (a 429 from its rate limit, a stale
  // token) is not a host that is down: reporting it as `suspended` would let a
  // wait run to its timeout blaming a dead host. Throw it, so the wait's
  // consecutive-failure limit ends it with the real reason (and a prompt's
  // pre-check answers 500 with it). An unreachable host stays `suspended`.
  if (failure === "refused") throw error;
  const view = withLiveInfo(app, row, info, hostId, { hostReachable });
  return {
    snapshot: {
      status: view.sessionStatus,
      severity: view.sessionStatusSeverity,
      detail: view.sessionStatusDetail ?? null,
    },
    eventSeqHead: info?.eventSeqHead,
    turnInFlight: info?.agentTurnInFlight === true,
  };
}

/**
 * Runs one server-side wait on `id` for this connection and maps the outcome
 * to a reply. Enforces MAX_WAITS_PER_CONNECTION, aborts on socket close
 * (returns null — nobody left to reply to), and, for a session-scoped
 * waiter, requires it to stay active for the whole wait.
 */
async function runWait(
  app: FastifyInstance,
  conn: ConnectionState,
  id: string,
  opts: WaitBodyOpts,
  // `expectGuard`: the caller just delivered a prompt, so the "a new turn
  // started" guard is part of what it asked for. A remote host that cannot arm
  // it (an agent build that reports no event head) is then SAID so in the
  // reply, rather than the wait quietly losing its protection.
  extra: { expectGuard?: boolean } = {},
): Promise<ReplyPayload | null> {
  if ((conn.activeWaits ?? 0) >= MAX_WAITS_PER_CONNECTION) {
    return bad(429, "too many pending waits on this connection");
  }
  const controller = new AbortController();
  const onClose = () => controller.abort();
  const offClose = conn.onClose(onClose);
  conn.activeWaits = (conn.activeWaits ?? 0) + 1;
  // Issue #1962 — a child on another host has no Session in THIS process's
  // PtyManager, so its event head, its events and its status all come from
  // that host: every read below is a fresh one over the wire, and the wait is
  // woken by its 1 s tick (the host's events do not reach this process).
  const remoteHostId = childHostId(app, id);
  const remote = remoteHostId !== LOCAL_HOST_ID;
  // The host's event head as of the last read. `headSeen` stays false when the
  // host never reports one (an agent build that predates the field): the
  // "a new turn started" guard is then disabled (today's behaviour), not
  // stuck closed.
  let remoteHead = 0;
  let headSeen = false;
  const eventSeqHead = (): number => {
    if (!remote) return app.pty.get(id)?.eventSeqHead ?? 0;
    if (headSeen) return remoteHead;
    // Only the guard sees this stand-in (anything but `afterSeq` opens it);
    // it is never reported as the child's counter — see `resultSeq`.
    return opts.afterSeq === undefined ? 0 : opts.afterSeq + 1;
  };
  // The `eventSeq` in the reply: the host's real counter, or 0 ("none") for a
  // host that never reported one — never the stand-in above, which is not a
  // cursor the host produced.
  const resultSeq = (): number =>
    remote ? (headSeen ? remoteHead : 0) : (app.pty.get(id)?.eventSeqHead ?? 0);
  try {
    const result = await waitForSession(opts, {
      signal: controller.signal,
      // A session-scoped waiter must stay active for the whole wait (the
      // same rule resolveOwnedSessionId applies at the start).
      authorized: () => conn.scope !== "session" || sessionRowIsActive(app, conn.sessionId!),
      readStatus: remote
        ? async () => {
            const read = await readRemoteSession(app, id, remoteHostId);
            if (read.eventSeqHead !== undefined) {
              remoteHead = read.eventSeqHead;
              headSeen = true;
            }
            return read.snapshot;
          }
        : () => readDerivedStatus(app, id),
      eventSeqHead,
      // Bound ONCE, at wait start. If the child's Session isn't in app.pty
      // yet (or is replaced mid-wait) this is a no-op and the wait is woken
      // only by the 1 s tick — added latency, not a correctness gap (a
      // `gone` child still matches via readStatus).
      subscribe: remote
        ? () => () => {}
        : (listener) => app.pty.get(id)?.onEvent(() => listener()) ?? (() => {}),
    });
    if ("aborted" in result) return null;
    // Without a head from the host (or an `afterSeq` from its prompt reply)
    // the guard ran open: a wait that matched may have matched the PREVIOUS
    // turn. Tell the caller, so it can cross-check with `wait_for_output`.
    const guardDisabled =
      extra.expectGuard === true && remote && (opts.afterSeq === undefined || !headSeen);
    return {
      ok: true,
      status: 200,
      result: {
        ...result,
        eventSeq: resultSeq(),
        ...(guardDisabled ? { guardDisabled: true } : {}),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message === "session not found"
      ? bad(404, message)
      : message === "not authorized"
        ? bad(403, "this session is no longer active")
        : bad(500, message);
  } finally {
    conn.activeWaits -= 1;
    offClose();
  }
}

/** A 409 reply if typing into this session now would be wrong — it is
 * `blocked` on a dialog (typing would answer it) or gone — else null. Re-reads
 * the derived status, so it is accurate at the moment it runs. */
async function refuseIfBlockedOrGone(
  app: FastifyInstance,
  id: string,
  opts: { note?: string; refuseBusy?: boolean } = {},
): Promise<ReplyPayload | null> {
  let snapshot: WaitSnapshot | null;
  // Whether a prompted turn is in flight — read from the host that owns the
  // session (issue #1962), as only that host's PtyManager knows.
  let turnInFlight: boolean;
  const hostId = childHostId(app, id);
  try {
    if (hostId === LOCAL_HOST_ID) {
      snapshot = await readDerivedStatus(app, id);
      turnInFlight = app.pty.get(id)?.agentTurnInFlight === true;
    } else {
      const read = await readRemoteSession(app, id, hostId);
      snapshot = read.snapshot;
      turnInFlight = read.turnInFlight;
    }
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : String(err));
  }
  if (snapshot === null) return bad(404, "session not found");
  if (snapshot.severity === "blocked") {
    return bad(
      409,
      `agent_blocked: the session is ${snapshot.status} — typing would answer its dialog; resolve that first${opts.note ?? ""}`,
    );
  }
  if (snapshot.severity === "gone") {
    return bad(409, `agent_gone: the session is ${snapshot.status}${opts.note ?? ""}`);
  }
  // A prompt that will be WAITED on must start from a quiet agent: a child
  // that is mid-turn queues the paste, so the in-flight turn's end would
  // satisfy the wait before the prompted turn ever ran.
  // Name the in-flight turn only when that is what fired: a child that is busy
  // on background tasks / subagents can be so AFTER its turn ended.
  if (opts.refuseBusy && (snapshot.severity === "busy" || turnInFlight)) {
    return bad(
      409,
      `agent_busy: the session is ${snapshot.status}${turnInFlight ? " with a prompted turn still in flight" : ""} — prompt without \`wait\` to queue the ` +
        'message, or let it go quiet first (sessions.wait with until=["done","dormant"]; ' +
        "the default `until` never matches a child that stays busy on background tasks or subagents)",
    );
  }
  return null;
}

// Op registry — the extension point every later Phase 4 PR (4.2–4.5) appends
// to, same "adding an op is a table entry, never a dispatch-loop change"
// shape as src/mcp/tools.mjs's own TOOLS registry. Request/response ops
// (this PR's three) call `reply()` exactly once; a future streaming op
// (sessions.attach, events.subscribe) instead holds the connection open and
// emits its own `{id, type, ...}` frames outside this envelope — see
// docs/socket-api.md's stream section — without needing any change to
// handleConnection's dispatch loop below.
/** Exported for the scope-matrix test in test/plugins/control-socket.test.ts. */

// ---------------------------------------------------------------------------
// Issue #2270 — sessions.message: a coordinator's session hands text to an already
// running TOP-LEVEL session in another project, with that project's consent.
// ---------------------------------------------------------------------------

/** Most bytes of one message. Smaller than a prompt: this is a note, not a task. */
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_MESSAGE_TTL_SECONDS = 3600;
/** Messages one session may send per minute. */
const MESSAGES_PER_MINUTE = 10;

/** One uniform 403 for every reason a message is not allowed (no such session, a
 * child, the sender's own project, a project that has not opted in, ...), decided from
 * rows alone, so a sender cannot probe which sessions and projects exist. */
const MESSAGE_REFUSED =
  "no such session, or this session may not message it " +
  "(a coordinator project, and a target project that accepts messages from it, are required)";

/** Null when `callerId` may message the running top-level session `targetId`. */
function messageRefusal(app: FastifyInstance, callerId: number, targetId: number): string | null {
  if (callerId === targetId) return MESSAGE_REFUSED;
  const rows = app.db
    .select({
      id: sessions.id,
      status: sessions.status,
      parentSessionId: sessions.parentSessionId,
      projectId: sessions.projectId,
    })
    .from(sessions)
    .where(inArray(sessions.id, [callerId, targetId]))
    .all();
  const caller = rows.find((row) => row.id === callerId);
  const target = rows.find((row) => row.id === targetId);
  if (!caller || !target || target.status !== "active" || target.parentSessionId !== null) {
    return MESSAGE_REFUSED;
  }
  if (caller.projectId === null || target.projectId === null) return MESSAGE_REFUSED;
  const [callerProject] = app.db
    .select()
    .from(projects)
    .where(eq(projects.id, caller.projectId))
    .all();
  const [targetProject] = app.db
    .select()
    .from(projects)
    .where(eq(projects.id, target.projectId))
    .all();
  return messageAllowed(callerProject, targetProject) ? null : MESSAGE_REFUSED;
}

const isBusyOrBlocked = (error: string | undefined): boolean =>
  typeof error === "string" && /^agent_(busy|blocked)\b/.test(error);

interface MessageState {
  queue: SessionMessageQueue;
  limiter: WindowRateLimiter;
}
const messageStates = new WeakMap<FastifyInstance, MessageState>();

function messageState(app: FastifyInstance): MessageState {
  const existing = messageStates.get(app);
  if (existing) return existing;
  const queue = new SessionMessageQueue({
    // Re-decided at delivery time: consent can be revoked, the sender can die, the
    // target can finish or start a turn in the meantime.
    check: async (message): Promise<TargetReadiness> => {
      if (messageRefusal(app, message.fromSessionId, message.targetSessionId) !== null) {
        return { state: "refuse", reason: "no longer permitted" };
      }
      if (!sessionRowIsActive(app, String(message.fromSessionId))) {
        return { state: "refuse", reason: "the sender is no longer active" };
      }
      const refusal = await refuseIfBlockedOrGone(app, String(message.targetSessionId), {
        refuseBusy: true,
      });
      if (refusal === null) return { state: "ready" };
      return isBusyOrBlocked(refusal.ok ? undefined : refusal.error)
        ? { state: "wait" }
        : { state: "refuse", reason: refusal.ok ? "refused" : (refusal.error ?? "refused") };
    },
    deliver: async (message): Promise<DeliverOutcome> => {
      const id = String(message.targetSessionId);
      const text = sanitizePromptText(
        `Message from session ${message.fromSessionId}${message.fromLabel ? ` (${message.fromLabel})` : ""}:\n${message.text}`,
      );
      const hostId = childHostId(app, id);
      if (hostId !== LOCAL_HOST_ID) {
        const outcome = await resolveBackend(app, hostId).prompt(id, { text, submit: true });
        return outcome.ok
          ? { ok: true }
          : { ok: false, reason: outcome.error, retry: isBusyOrBlocked(outcome.error) };
      }
      const unverifiable = await adoptLocalChild(app, id);
      if (unverifiable) return { ok: false, reason: UNVERIFIABLE_MESSAGE, retry: true };
      const delivery = await deliverPrompt(app, id, {
        text,
        submit: true,
        notRunning: NOT_LOCAL_MESSAGE,
        check: async (stage) => {
          const refusal = await refuseIfBlockedOrGone(
            app,
            id,
            stage === "before"
              ? { refuseBusy: true }
              : {
                  note: " — the text was typed but NOT submitted and may still be in its input box",
                },
          );
          return refusal && !refusal.ok
            ? { status: refusal.status ?? 500, error: refusal.error ?? "refused" }
            : null;
        },
      });
      return delivery.ok
        ? { ok: true }
        : { ok: false, reason: delivery.error, retry: isBusyOrBlocked(delivery.error) };
    },
    onChange: (message) => auditMessage(app, message),
  });
  const state = { queue, limiter: new WindowRateLimiter(MESSAGES_PER_MINUTE, 60_000) };
  messageStates.set(app, state);
  return state;
}

/** Logs a message's outcome and records it on both sessions' event history (where the
 * session lives on this primary; a session on another host is covered by the log). */
function auditMessage(app: FastifyInstance, message: QueuedMessage): void {
  const detail = {
    messageId: message.id,
    from: message.fromSessionId,
    to: message.targetSessionId,
    status: message.status,
    ...(message.reason !== undefined ? { reason: message.reason } : {}),
  };
  app.log.info(detail, "sessions.message");
  app.pty.get(String(message.fromSessionId))?.emitMessageEvent("message_sent", detail);
  if (message.status === "delivered") {
    app.pty.get(String(message.targetSessionId))?.emitMessageEvent("message_received", {
      ...detail,
      bytes: Buffer.byteLength(message.text, "utf8"),
    });
  }
}

function describeMessage(message: QueuedMessage): Record<string, unknown> {
  return {
    messageId: message.id,
    status: message.status,
    targetSessionId: message.targetSessionId,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
    ...(message.reason !== undefined ? { reason: message.reason } : {}),
    ...(message.finishedAt !== undefined ? { finishedAt: message.finishedAt } : {}),
  };
}

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
    onOwnedSession(async (id, { app }) => {
      // Reads `alive`/`stateRestored`/`hookEmits` off the live PTY, so a
      // survivor of a restart must be re-adopted first (#2271). A read stays
      // usable when that fails: a dead, unverifiable or erroring scope just
      // reads as not alive, unlike the ops that need the PTY and refuse.
      await adoptSurvivingSession(app, id).catch(() => undefined);
      return { method: "GET", url: `/api/sessions/${enc(id)}` };
    }),
  ),
  // The caller's own children (live and exited) with their derived status —
  // the parent→child orchestration listing. Session scope is pinned to its
  // OWN id as the parent (a session can only enumerate its own children);
  // full scope names the parent via `sessionId`. An optional `status` filter
  // (active|killed|exited) rides through.
  "sessions.children": routeOp(
    ["full", "session"],
    pinned(async ({ app, conn, body }) => {
      const target = resolveTargetSessionId(conn, body);
      if (!target.ok) return target.reply;
      // Same "caller must still be active" rule as every other op that
      // looks at a child (resolveOwnedSessionId) — a killed parent's
      // lingering hook token must not keep enumerating its children.
      if (conn.scope === "session" && !sessionRowIsActive(app, target.id)) {
        return bad(403, "this session is no longer active");
      }
      // Children that survived a Mullion restart are alive in their scopes
      // but untracked until something attaches (#2271): re-adopt them so the
      // listing reports their real status. One failure must not sink the list.
      const activeChildren = app.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.parentSessionId, Number(target.id)), eq(sessions.status, "active")))
        .all();
      // Only untracked ones: a listing must cost what the adoption does.
      await Promise.allSettled(
        activeChildren
          .filter((c) => !app.pty.get(String(c.id))?.isAlive)
          .map((c) => adoptSurvivingSession(app, String(c.id))),
      );
      return {
        method: "GET",
        url: buildQueryUrl("/api/sessions", {
          parentSessionId: target.id,
          status: body?.status,
        }),
      };
    }),
  ),
  // Server-owned wait (services/session-wait.ts): blocks THIS request — not
  // the agent's own turn budget — until the target's derived status matches
  // `until` (statuses and/or severities; default = anything needing
  // attention), or `timeoutMs` (default 10 min, max 1 h) elapses. At session
  // scope the target must be a CHILD (waiting on yourself can only time out).
  // The handler stays pending, so the dispatch loop counts it against
  // MAX_INFLIGHT_OPS for as long as it waits; a closed socket aborts it.
  // `afterSeq` is the stale-latch guard (see WaitOptions); the reply carries
  // the session's current `eventSeq` so a caller can chain it into the next
  // wait.
  //
  // Deliberately a raw OpSpec rather than routeOp(): a long-lived, cancellable
  // handler can't be expressed as a Route to forward. That means routeOp's
  // compile-time scope guard (#1546) does not cover it, so this handler must
  // do its own pin work — it resolves its target through
  // resolveOwnedSessionId({childOnly:true}) FIRST, before any other work, and
  // test/plugins/control-socket.test.ts's sessions.wait block asserts the
  // self / stranger / no-target 403s that guard exists for.
  "sessions.wait": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveOwnedSessionId(app, conn, body, { childOnly: true });
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const parsed = parseWaitBody(body, { allowAfterSeq: true });
      if (!parsed.ok) {
        reply(parsed.reply);
        return;
      }
      const unverifiable = await adoptLocalChild(app, target.id);
      if (unverifiable) {
        reply(unverifiable);
        return;
      }
      // null == the peer hung up mid-wait; there is nobody to reply to.
      const result = await runWait(app, conn, target.id, parsed.opts);
      if (result) reply(result);
    },
  },
  // Waits until a CHILD prints some text (issue #1625) — the output-content
  // sibling of sessions.wait. Body: `sessionId` (a child), `match` (<= 256
  // chars; a literal substring unless `regex: true`, in which case it must
  // have no backreferences/lookarounds and star height <= 1 — see
  // services/output-wait.ts), `timeoutMs` (default 10 min, clamped to 1 h) and
  // `afterOffset` (a `sessions.prompt` reply's `outputOffset`, taken after the
  // prompt was typed and submitted: output printed since then still counts, so a
  // fast reply is not missed — but a TUI may redraw the submitted prompt into its
  // transcript, so do not match on text the prompt contains; omitted means only
  // output from now on). Matches against the last 16 KiB of ANSI-stripped
  // output. A child on another host is waited on THERE, in bounded chunks
  // (SessionBackend.waitOutput, #1951); 409 only when it has no live process.
  // Resolves `{matched, text, line}`, `{timedOut:true}` or `{gone:true}`.
  // A raw OpSpec like sessions.wait, so it does its own pinning FIRST.
  "sessions.wait_for_output": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveOwnedSessionId(app, conn, body, { childOnly: true });
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const matcher = compileOutputMatcher(body?.match, body?.regex);
      if (!matcher.ok) {
        reply(bad(400, matcher.error));
        return;
      }
      const timeout = parseWaitTimeout(body?.timeoutMs);
      if (!timeout.ok) {
        reply(bad(400, timeout.error));
        return;
      }
      const afterOffset = body?.afterOffset;
      if (
        afterOffset !== undefined &&
        (typeof afterOffset !== "number" || !Number.isInteger(afterOffset) || afterOffset < 0)
      ) {
        reply(bad(400, "'afterOffset' must be a non-negative integer"));
        return;
      }
      if ((conn.activeWaits ?? 0) >= MAX_WAITS_PER_CONNECTION) {
        reply(bad(429, "too many pending waits on this connection"));
        return;
      }
      const unverifiable = await adoptLocalChild(app, target.id);
      if (unverifiable) {
        reply(unverifiable);
        return;
      }
      const controller = new AbortController();
      const onClose = () => controller.abort();
      const offClose = conn.onClose(onClose);
      conn.activeWaits = (conn.activeWaits ?? 0) + 1;
      try {
        const callerActive = () =>
          conn.scope !== "session" || sessionRowIsActive(app, conn.sessionId!);
        // The wait runs on the child's own host (issue #1951): the PTY lives
        // there. A local child is one in-process wait; a remote one is a loop
        // of bounded waits (SessionBackend.waitOutput).
        const outcome = await resolveBackend(app, childHostId(app, target.id)).waitOutput(
          target.id,
          {
            match: body?.match as string,
            regex: body?.regex === true,
            timeoutMs: timeout.timeoutMs,
            ...(afterOffset !== undefined ? { afterOffset } : {}),
            signal: controller.signal,
            // The caller must stay active for the whole wait, same as sessions.wait.
            alive: callerActive,
          },
        );
        if ("aborted" in outcome) return;
        if ("notRunning" in outcome) {
          reply(bad(409, NOT_LOCAL_MESSAGE));
          return;
        }
        if ("failed" in outcome) {
          reply(bad(outcome.status, outcome.error));
          return;
        }
        if ("gone" in outcome && !callerActive()) {
          reply(bad(403, "this session is no longer active"));
          return;
        }
        reply({ ok: true, status: 200, result: outcome });
      } finally {
        conn.activeWaits -= 1;
        offClose();
      }
    },
  },
  // Types a prompt into a running CHILD agent and (optionally) waits for its
  // turn to end — the "lead agent drives a worker" primitive. Body:
  // `sessionId` (a child at session scope), `text` (<= 32 KB), `submit`
  // (default true; false pastes without pressing Enter), `wait` (true, or
  // {until?, timeoutMs?} — see sessions.wait). Refuses rather than guesses:
  //   - 409 if the child is `blocked` (typing would ANSWER a permission /
  //     plan / question dialog) or gone;
  //   - 501 if the child's agent has no opt-in `submitPrompt` framing
  //     (hook-adapters/*: claude-code, codex, opencode; plain shells, agy and
  //     unknown CLIs don't);
  //   - 503 if the bytes could not be delivered (write backpressure).
  // The input goes through Session.writeAgentInput, NOT write(): a parent's
  // prompt must not read as the human acknowledging the child's pending
  // attention. It still starts a new turn (Session.beginAgentTurn) so a
  // following wait can't match the previous turn's `finished`.
  // Issue #2270 — hand a note to an already-running top-level session in ANOTHER
  // project. Session scope only (full scope has sessions.prompt). Allowed when the
  // caller's project is a coordinator that reaches the target's project AND that
  // project accepts messages from it (off by default); anything else is one uniform
  // 403. The text is QUEUED, not typed: it is delivered, framed with its source, once
  // the target is idle and not on a dialog, or expires. `wait: true` holds the reply
  // until it is delivered, refused or expired.
  "sessions.message": {
    scopes: ["session"],
    handler: async ({ app, conn, body, reply }) => {
      const targetRef = extractSessionId(body);
      if (targetRef === null) {
        reply(bad(400, "'sessionId' is required (the session to message)"));
        return;
      }
      const text = body?.text;
      if (typeof text !== "string") {
        reply(bad(400, "'text' is required"));
        return;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
        reply(bad(413, `'text' exceeds ${MAX_MESSAGE_BYTES} bytes`));
        return;
      }
      if (sanitizePromptText(text).trim().length === 0) {
        reply(bad(400, "'text' is required"));
        return;
      }
      const ttlSeconds = body?.ttlSeconds;
      if (
        ttlSeconds !== undefined &&
        (typeof ttlSeconds !== "number" ||
          !Number.isInteger(ttlSeconds) ||
          ttlSeconds < 1 ||
          ttlSeconds > MAX_MESSAGE_TTL_SECONDS)
      ) {
        reply(bad(400, `'ttlSeconds' must be an integer from 1 to ${MAX_MESSAGE_TTL_SECONDS}`));
        return;
      }
      const wait = body?.wait;
      if (wait !== undefined && typeof wait !== "boolean") {
        reply(bad(400, "'wait' must be a boolean"));
        return;
      }
      const callerId = Number(conn.sessionId);
      if (!sessionRowIsActive(app, conn.sessionId!)) {
        reply({ ok: false, status: 403, error: "this session is no longer active" });
        return;
      }
      const { queue, limiter } = messageState(app);
      // Counted before the authorization below, so probing for a consenting session
      // is bounded too.
      if (!limiter.take(String(callerId))) {
        reply(bad(429, `at most ${MESSAGES_PER_MINUTE} messages per minute per session`));
        return;
      }
      const targetId = Number(targetRef);
      const refusal = Number.isInteger(targetId)
        ? messageRefusal(app, callerId, targetId)
        : MESSAGE_REFUSED;
      if (refusal !== null) {
        reply({ ok: false, status: 403, error: refusal });
        return;
      }
      if (wait === true && (conn.activeWaits ?? 0) >= MAX_WAITS_PER_CONNECTION) {
        reply(bad(429, "too many pending waits on this connection"));
        return;
      }
      const [callerRow] = app.db
        .select({ name: projects.name })
        .from(sessions)
        .innerJoin(projects, eq(sessions.projectId, projects.id))
        .where(eq(sessions.id, callerId))
        .all();
      const message = queue.enqueue({
        fromSessionId: callerId,
        fromLabel: sanitizePromptText(`project ${JSON.stringify(callerRow?.name ?? "?")}`).slice(
          0,
          120,
        ),
        targetSessionId: targetId,
        text,
        ttlMs: (ttlSeconds ?? DEFAULT_MESSAGE_TTL_MS / 1000) * 1000,
      });
      if (message === null) {
        reply(bad(429, "too many messages are already waiting for that session"));
        return;
      }
      if (wait !== true) {
        reply({ ok: true, status: 202, result: describeMessage(message) });
        return;
      }
      conn.activeWaits += 1;
      const aborter = new AbortController();
      const offClose = conn.onClose(() => aborter.abort());
      try {
        const settled = await queue.waitUntilSettled(message.id, aborter.signal);
        if (settled && !aborter.signal.aborted) {
          reply({ ok: true, status: 200, result: describeMessage(settled) });
        }
      } finally {
        conn.activeWaits -= 1;
        offClose();
      }
    },
  },
  // The delivery status of a message the caller sent: queued, delivered, expired or
  // refused. Only the sender can ask; an unknown id, someone else's, and a message the
  // primary forgot (a restart, or an hour after it finished) are all the same 404.
  "sessions.message_status": {
    scopes: ["session"],
    handler: ({ app, conn, body, reply }) => {
      const messageId = body?.messageId;
      if (typeof messageId !== "string" || messageId.length === 0) {
        reply(bad(400, "'messageId' is required"));
        return;
      }
      const message = messageState(app).queue.get(messageId);
      if (!message || message.fromSessionId !== Number(conn.sessionId)) {
        reply(bad(404, "unknown message (it may have been forgotten after a restart)"));
        return;
      }
      reply({ ok: true, status: 200, result: describeMessage(message) });
    },
  },
  "sessions.prompt": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const target = resolveOwnedSessionId(app, conn, body, { childOnly: true });
      if (!target.ok) {
        reply(target.reply);
        return;
      }
      const text = body?.text;
      if (typeof text !== "string") {
        reply(bad(400, "'text' is required"));
        return;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
        reply(bad(413, `'text' exceeds ${MAX_PROMPT_BYTES} bytes`));
        return;
      }
      // Validate what will actually be TYPED: text that is only control
      // characters sanitizes to nothing and must not become a bare Enter.
      if (sanitizePromptText(text).trim().length === 0) {
        reply(bad(400, "'text' is required"));
        return;
      }
      const submit = body?.submit;
      if (submit !== undefined && typeof submit !== "boolean") {
        reply(bad(400, "'submit' must be a boolean"));
        return;
      }
      const shouldSubmit = submit !== false;
      let waitOpts: Omit<WaitBodyOpts, "afterSeq"> | null = null;
      const waitArg = body?.wait;
      if (waitArg !== undefined && waitArg !== false) {
        // Strict like `submit`: only `true` or an options object. null / 0 /
        // [] / "yes" must not fall through to a default 10-minute wait.
        if (
          waitArg !== true &&
          (typeof waitArg !== "object" || waitArg === null || Array.isArray(waitArg))
        ) {
          reply(bad(400, "'wait' must be a boolean or an object"));
          return;
        }
        if (!shouldSubmit) {
          reply(bad(400, "'wait' requires 'submit' (nothing to wait for otherwise)"));
          return;
        }
        const parsed = parseWaitBody(waitArg === true ? {} : (waitArg as Record<string, unknown>), {
          allowAfterSeq: false,
        });
        if (!parsed.ok) {
          reply(parsed.reply);
          return;
        }
        waitOpts = parsed.opts;
        if ((conn.activeWaits ?? 0) >= MAX_WAITS_PER_CONNECTION) {
          reply(bad(429, "too many pending waits on this connection"));
          return;
        }
      }

      const id = target.id;
      const hostId = childHostId(app, id);
      let outputOffset: number;
      let afterSeq: number | undefined;
      if (hostId !== LOCAL_HOST_ID) {
        // Issue #1951 — a child on another host: its PTY is there, so the
        // delivery runs there (SessionBackend.prompt). What the primary can
        // still decide itself is whether typing is wise at all, from a fresh
        // read of the child's status (issue #1962: also its in-flight turn,
        // which only that host knows — the `agent_busy` refusal of a wait).
        const refusal = await refuseIfBlockedOrGone(app, id, { refuseBusy: waitOpts !== null });
        if (refusal) {
          reply(refusal);
          return;
        }
        const outcome = await resolveBackend(app, hostId).prompt(id, {
          text,
          submit: shouldSubmit,
        });
        if (!outcome.ok) {
          reply(bad(outcome.status, outcome.error));
          return;
        }
        ({ outputOffset, afterSeq } = outcome);
      } else {
        const unverifiable = await adoptLocalChild(app, id);
        if (unverifiable) {
          reply(unverifiable);
          return;
        }
        // One prompt at a time per session, and the typing itself, live in
        // services/session-prompt.ts so a remote child's host runs the SAME
        // code. The two checks are this op's derived-status gate: asked
        // before anything is typed, and again before Enter.
        const delivery = await deliverPrompt(app, id, {
          text,
          submit: shouldSubmit,
          notRunning: NOT_LOCAL_MESSAGE,
          check: async (stage) => {
            const refusal = await refuseIfBlockedOrGone(
              app,
              id,
              stage === "before"
                ? { refuseBusy: waitOpts !== null }
                : {
                    note: " — the text was typed but NOT submitted and may still be in its input box",
                  },
            );
            return refusal && !refusal.ok
              ? { status: refusal.status ?? 500, error: refusal.error ?? "refused" }
              : null;
          },
        });
        if (!delivery.ok) {
          reply(bad(delivery.status, delivery.error));
          return;
        }
        ({ afterSeq, outputOffset } = delivery);
      }

      const delivered = { delivered: true, submitted: shouldSubmit, outputOffset };
      if (waitOpts === null) {
        reply({ ok: true, status: 200, result: delivered });
        return;
      }
      // `afterSeq` is the HOST's event head right after the turn began; a
      // remote host that predates it sends none, which runs the wait without
      // the "a new turn started" guard (see runWait).
      const waited = await runWait(app, conn, id, { ...waitOpts, afterSeq }, { expectGuard: true });
      if (waited === null) return;
      // The prompt WAS delivered; a failed wait is reported alongside, not
      // as a failure of the whole op.
      reply({
        ok: true,
        status: 200,
        result: {
          ...delivered,
          wait: waited.ok ? waited.result : { error: waited.error, status: waited.status },
        },
      });
    },
  },
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
  // open). Same-project (unless the parent's project is a coordinator, #2110)
  // and one-level-of-nesting are enforced in
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
      if (conn.scope === "session" && !sessionRowIsActive(app, parent.id)) {
        reply({ ok: false, status: 403, error: "the parent session is no longer active" });
        return;
      }
      const {
        sessionId: _sessionId,
        parentSessionId: _parentSessionId,
        projectId: _projectId,
        // Issue #2110 — read below; never forwarded (the forwarded projectId is
        // the resolved target, set explicitly).
        project: projectRef,
        worktree: _worktree,
        worktreeRefresh: _worktreeRefresh,
        ...fullRest
      } = body ?? {};
      // Issue #2110 — a coordinator names the project to spawn into. Staying
      // in the parent's own project (by its numeric id) needs no permission; any OTHER project
      // needs the parent's project to be a coordinator. createSessionRecord's
      // validateParent enforces the same rule again for every caller.
      let childProjectId = parentProjectId;
      if (projectRef !== undefined && projectRef !== null) {
        if (!projectCoordinates(app, parentProjectId)) {
          // Not a coordinator. The only `project` accepted is the parent's OWN
          // id (a no-op); anything else is the same 403 whether or not such a
          // project exists, decided BEFORE any lookup, so a session without the
          // setting cannot use the 404/403/409 difference to probe which
          // projects and names exist.
          const ownRef =
            typeof projectRef === "number" ||
            (typeof projectRef === "string" && /^\d+$/.test(projectRef.trim()))
              ? Number(projectRef)
              : Number.NaN;
          if (ownRef !== parentProjectId) {
            reply({ ok: false, status: 403, error: CROSS_PROJECT_DISABLED });
            return;
          }
        } else {
          const [sourceProject] = app.db
            .select()
            .from(projects)
            .where(eq(projects.id, parentProjectId))
            .all();
          const target = resolveSpawnTarget(app, projectRef, {
            allowed: (candidate) =>
              candidate.id === parentProjectId || crossProjectAllowed(sourceProject, candidate),
            uniform: conn.scope === "session",
          });
          if (!target.ok) {
            reply(target.reply);
            return;
          }
          childProjectId = target.id;
        }
      }
      // Session scope forwards an explicit ALLOWLIST (#1518), not a denylist:
      // a field newly added to POST /api/sessions' schema (as `env` once was)
      // must not silently widen what a session-scoped caller can set.
      // `kind`, `env`, `nameLocked` etc. are privilege- or visibility-adjacent
      // and stay full-scope only (a full-scope caller has that power
      // directly). `seedPrompt` grants nothing `command` doesn't already (a
      // session-scoped caller fully controls its child's first turn via
      // `command` itself).
      //
      // Issue #1733 — `skipPermissions` IS forwarded now, so a delegated
      // child inherits the parent's unattended permission posture instead of
      // stalling on a prompt nobody is watching. It is CAPPED by the parent's
      // own value, so the field can only narrow: a session-scoped caller can
      // ask for a MORE permissive child and will not get one.
      //
      // The cap is applied HERE, where the connection's scope is known, and
      // not in createSessionRecord — because full scope keeps its own power
      // over a child (the repo pins that: a full-scope caller setting
      // `skipPermissions` on a child of a prompting parent still gets it),
      // and a full-scope caller can already set the flag on the parent
      // itself. Session scope is the only path where the cap is a security
      // boundary rather than a policy.
      const rest: Record<string, unknown> =
        conn.scope === "session"
          ? (() => {
              const forwarded = Object.fromEntries(
                Object.entries(fullRest).filter(([key]) =>
                  SESSION_SPAWN_CHILD_FIELDS.includes(key),
                ),
              );
              // The parent's own posture is the ceiling. `requested` may only
              // narrow it: unset means "inherit", and an explicit true still
              // cannot exceed what the parent has.
              //
              // A NON-boolean value ("true", 1) is neither unset nor `true`,
              // so it narrows to false — the fail-closed reading. The socket
              // body is not schema-validated before this point (only
              // POST /api/sessions would 400 it), so this is the only place
              // a nonsense value can be caught.
              const parentSkipPermissions =
                (parentLookup.result as { skipPermissions?: unknown } | undefined)
                  ?.skipPermissions === true;
              const requested = forwarded.skipPermissions;
              forwarded.skipPermissions =
                (requested === undefined ? true : requested === true) && parentSkipPermissions;
              return forwarded;
            })()
          : fullRest;
      // A name the spawner chose is pinned: unlocked, the agent's own terminal
      // title replaces it in the sidebar within seconds (issue #2112). A
      // full-scope caller that sends an explicit `nameLocked` keeps its value;
      // session scope can't send one (SESSION_SPAWN_CHILD_FIELDS).
      const pinName =
        typeof rest.name === "string" && rest.name.trim() !== "" && rest.nameLocked === undefined;
      const payload = {
        ...rest,
        ...(pinName ? { nameLocked: true } : {}),
        projectId: childProjectId,
        parentSessionId: Number(parent.id),
      };
      app.log.info(
        {
          parentSessionId: parent.id,
          projectId: childProjectId,
          crossProject: childProjectId !== parentProjectId,
          scope: conn.scope,
        },
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
  // Full scope: any session, `body.sessionId` required (no implicit "self").
  // Session scope: a CHILD of the caller's own session only — a session may
  // never kill itself or an unrelated session through this socket
  // (resolveOwnedSessionId's `childOnly`). A child has no children of its own
  // (one level of nesting), so `body.cascade` is moot there but still
  // validated. `body.cascade` ("detach"|"kill", default "detach" — see
  // services/session-lifecycle.ts's killSession) rides through as a querystring on the
  // proxied DELETE, same transport reasoning as that route's own comment.
  "sessions.kill": routeOp(
    ["full", "session"],
    owned(({ app, conn, body }) => {
      const target = resolveOwnedSessionId(app, conn, body, { childOnly: true });
      if (!target.ok) return target.reply;
      const cascade = body?.cascade;
      if (cascade !== undefined && cascade !== "detach" && cascade !== "kill") {
        return bad(400, "'cascade' must be 'detach' or 'kill'");
      }
      const query = cascade !== undefined ? { cascade } : undefined;
      return { method: "DELETE", url: buildQueryUrl(`/api/sessions/${enc(target.id)}`, query) };
    }),
  ),
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
  // Reachable at session scope: an agent asking the Mullion server to relay a
  // Hermes review request for the PR of the repo it is working in. Pinned to
  // the caller's own session (same target-id shape as sessions.get); the repo
  // is derived server-side from that session's project (routes/
  // review-relay.ts), and the Hermes URL/key never reach the session.
  "reviews.request": routeOp(
    ["full", "session"],
    onSession((id, { body }) => ({
      method: "POST",
      url: `/api/sessions/${enc(id)}/review-request`,
      // `force` is for the request only: it overrides the approved-PR guard.
      payload: json(relayTargetFields(body, ["prNumber", "repo", "branch", "force"])),
    })),
  ),
  // #2102 — a Task Master worker pushes its branch through Mullion (gated,
  // bot identity) instead of with its own git credentials. Pinned to the
  // caller's OWN session, so a session can only push its own task; the route
  // (routes/task-push.ts) further requires that session to be a task's worker.
  // Approving a workflow change is deliberately NOT an op.
  "tasks.push": routeOp(
    ["full", "session"],
    onSession((id) => ({ method: "POST", url: `/api/sessions/${enc(id)}/task-push` })),
  ),
  // Status of the latest review run for the caller's PR, and stopping a run the
  // caller's own session dispatched (routes/review-relay.ts enforces that).
  "reviews.status": routeOp(
    ["full", "session"],
    onSession((id, { body }) => ({
      method: "GET",
      url: `/api/sessions/${enc(id)}/review-request${relayQuery(relayTargetFields(body))}`,
    })),
  ),
  // The stop op covers every relay run — a review or a triage — because the
  // run is named, not derived from a target.
  "reviews.stop": routeOp(
    ["full", "session"],
    onSession((id, { body }) =>
      typeof body?.runId !== "string" || body.runId.length === 0
        ? bad(400, "'runId' is required")
        : {
            method: "POST",
            url: `/api/sessions/${enc(id)}/review-stop`,
            payload: json({ runId: body.runId }),
          },
    ),
  ),
  // Issue triage through the same relay (issue #1629). The repo is chosen
  // exactly as for a review (the caller's project, or a named registered
  // one); the issue number
  // always comes from the caller — there is no "current issue" to infer.
  "triage.request": routeOp(
    ["full", "session"],
    onSession((id, { body }) => {
      const issueNumber = body?.issueNumber;
      if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) {
        return bad(400, "'issueNumber' must be a positive integer");
      }
      return {
        method: "POST",
        url: `/api/sessions/${enc(id)}/triage-request`,
        payload: json({ issueNumber, ...relayTargetFields(body, ["repo"]) }),
      };
    }),
  ),
  "triage.status": routeOp(
    ["full", "session"],
    onSession((id, { body }) => {
      const issueNumber = body?.issueNumber;
      if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) {
        return bad(400, "'issueNumber' must be a positive integer");
      }
      return {
        method: "GET",
        url: `/api/sessions/${enc(id)}/triage-request${relayQuery({
          issueNumber,
          ...relayTargetFields(body, ["repo"]),
        })}`,
      };
    }),
  ),
  // Reachable at session scope — same target-id shape as sessions.get.
  "sessions.scrollback": routeOp(
    ["full", "session"],
    onOwnedSession((id, ctx) => ({
      method: "GET",
      // mode:"rendered" asks for the terminal screen as plain text (issue
      // #2112) instead of the raw byte stream; anything else stays raw.
      url: `/api/sessions/${enc(id)}/scrollback${ctx.body?.mode === "rendered" ? "?mode=rendered" : ""}`,
    })),
  ),
  // Issue #2268 — the session's conversation as plain text, from the agent CLI's
  // own transcript. Same target-id shape and reach as sessions.scrollback: own
  // session and own children at session scope. `afterSeq` is the opaque cursor a
  // previous page returned (`nextSeq`); `tools: true` keeps tool calls and
  // results in full instead of a one-line summary.
  "sessions.transcript": routeOp(
    ["full", "session"],
    onOwnedSession((id, ctx) => {
      const { afterSeq, limit, tools } = ctx.body ?? {};
      if (
        afterSeq !== undefined &&
        (typeof afterSeq !== "number" || !Number.isInteger(afterSeq) || afterSeq < 0)
      ) {
        return bad(400, "'afterSeq' must be a non-negative integer");
      }
      if (
        limit !== undefined &&
        (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500)
      ) {
        return bad(400, "'limit' must be an integer from 1 to 500");
      }
      if (tools !== undefined && typeof tools !== "boolean") {
        return bad(400, "'tools' must be a boolean");
      }
      return {
        method: "GET",
        url: `/api/sessions/${enc(id)}/transcript${relayQuery({
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(tools === true ? { tools: "1" } : {}),
        })}`,
      };
    }),
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
      if (conn.socket === null) {
        reply(STREAM_UNAVAILABLE);
        return;
      }
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
    handler: ({ app, conn, id, body, reply }) => {
      if (conn.socket === null) {
        reply(STREAM_UNAVAILABLE);
        return;
      }
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
        if (body?.includeChildren === true) {
          // Opt-in: self plus the caller's own children. Like the other
          // owned ops, the caller's own row must be active when subscribing;
          // the stream then lives until the socket closes (unlike
          // events.query, which re-checks per request).
          if (!sessionRowIsActive(app, conn.sessionId!)) {
            reply({ ok: false, status: 403, error: "this session is no longer active" });
            return;
          }
          const ownId = Number(conn.sessionId);
          attachLocalEventsSocket(app, channel, {
            sessionFilter: ownAndChildSessionFilter(app, ownId),
            // Receiving a child's events is not writing its read cursor.
            seenFilter: (sessionId) => sessionId === ownId,
            // Issue #2125 — the session and its children may live on another host.
            includeRemote: true,
            remoteReplayIds: [ownId, ...childSessionIds(app, ownId)].filter(
              (sessionId) => childHostId(app, String(sessionId)) !== LOCAL_HOST_ID,
            ),
          });
        } else {
          attachLocalEventsSocket(app, channel, {
            sessionIdFilter: conn.sessionId!,
            includeRemote: true,
            remoteReplayIds:
              childHostId(app, conn.sessionId!) !== LOCAL_HOST_ID ? [Number(conn.sessionId)] : [],
          });
        }
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
  // scope may query its own pinned session or one of its children — see
  // resolveEventsSessionFilter / resolveOwnedSessionId. Unlike
  // events.subscribe's `includeChildren`, the caller's row is re-checked on
  // every request.
  "events.query": routeOp(
    ["full", "session"],
    owned(({ app, conn, body }) => {
      const resolved = resolveEventsSessionFilter(app, conn, body);
      if (!resolved.ok) return resolved.reply;
      const queryBody: Record<string, unknown> = { ...body };
      if (resolved.sessionId !== undefined) queryBody.sessionId = resolved.sessionId;
      else delete queryBody.sessionId;
      return { method: "GET", url: buildQueryUrl("/api/events", queryBody) };
    }),
  ),
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
  "device.list": routeOp(
    ["full", "session"],
    unscoped(() => ({ method: "GET", url: "/api/devices" })),
  ),
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
  "device.discovered": routeOp(
    ["full", "session"],
    unscoped(() => ({ method: "GET", url: "/api/devices/discovered" })),
  ),
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
  // Issue #2110 — the projects a coordinator session may spawn a child in:
  // `{ id, name, hostId }` for every OTHER project, so it can name one in
  // `sessions.spawn_child`'s `project`. Only for a session whose own project is
  // a coordinator (403 otherwise) — `projects.list` stays full-scope, and a
  // session that cannot spawn elsewhere has no use for the list. The caller's
  // own project is left out (spawning there needs no `project`).
  "projects.spawn_targets": {
    scopes: ["full", "session"],
    handler: async ({ app, conn, body, reply }) => {
      const caller = resolveParentSessionId(conn, body);
      if (!caller.ok) {
        reply(caller.reply);
        return;
      }
      if (conn.scope === "session" && !sessionRowIsActive(app, caller.id)) {
        reply({ ok: false, status: 403, error: "the session is no longer active" });
        return;
      }
      const own = app.db
        .select({ projectId: sessions.projectId })
        .from(sessions)
        .where(eq(sessions.id, Number(caller.id)))
        .get();
      if (!own) {
        reply({ ok: false, status: 404, error: `unknown session ${caller.id}` });
        return;
      }
      if (own.projectId === null || !projectCoordinates(app, own.projectId)) {
        reply({ ok: false, status: 403, error: CROSS_PROJECT_DISABLED });
        return;
      }
      const [source] = app.db.select().from(projects).where(eq(projects.id, own.projectId)).all();
      const targets = allowedSpawnTargets(app, source!).map((p) => ({
        id: p.id,
        name: p.name,
        hostId: p.hostId,
      }));
      reply({ ok: true, status: 200, result: targets });
    },
  },
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

/** A connection carried by a host's control relay (#1656): already
 * authenticated by that host's agent, so it skips the handshake and is
 * pinned, for its lifetime, to `sessionId` as a session-scope connection. */
export interface RelayBinding {
  hostId: string;
  sessionId: string;
}

/** Why a relayed session may not act right now, or null: its row must still be
 * active and the session must be hosted by the relaying host — the one fact
 * that bounds what a compromised agent can claim to be. */
export function relayedSessionDenied(app: FastifyInstance, relay: RelayBinding): string | null {
  const row = app.db
    .select({ projectId: sessions.projectId, hostId: sessions.hostId, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, Number(relay.sessionId)))
    .get();
  if (!row || row.status !== "active") return "this session is no longer active";
  if (resolveSessionHostId(app, row) !== relay.hostId) {
    return "this session is not hosted by the relaying host";
  }
  return null;
}

/** How often a relayed connection's open streams re-check their session (#2125). */
export const RELAY_STREAM_RECHECK_MS = 30_000;

/**
 * Issue #2125 — a request is re-checked against the session's row each time, but a
 * stream outlives any one request: a session that is killed, or moved to another
 * host, while its `events.subscribe` / `sessions.attach` is open must stop being
 * served. Ends every open stream on `conn` with a `closed` frame carrying the
 * reason, and reports whether it did.
 */
export function closeDeniedRelayStreams(
  app: FastifyInstance,
  relay: RelayBinding,
  conn: ConnectionState,
): boolean {
  if (conn.openChannels.size === 0) return false;
  const denied = relayedSessionDenied(app, relay);
  if (denied === null) return false;
  for (const [id, channel] of [...conn.openChannels]) {
    conn.send({ id, type: "closed", reason: denied });
    channel.close(false);
  }
  conn.openChannels.clear();
  return true;
}

export function handleConnection(
  app: FastifyInstance,
  socket: net.Socket,
  openSockets: Set<net.Socket>,
  relay?: RelayBinding,
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
  // A relayed connection arrives pre-authenticated (session scope, pinned to
  // the id the relaying agent validated); a local one waits for its handshake.
  let conn: ConnectionState | null = relay
    ? {
        send: (message) => writeFrame(socket, message),
        onClose: (listener) => {
          socket.once("close", listener);
          return () => socket.off("close", listener);
        },
        // The in-memory pair's server half: streaming ops (#2125) write their frames
        // to it exactly as to a net.Socket, and the mux carries them back.
        socket,
        scope: "session",
        sessionId: relay.sessionId,
        openChannels: new Map(),
        activeWaits: 0,
      }
    : null;
  if (relay) {
    const recheck = setInterval(() => {
      if (conn) closeDeniedRelayStreams(app, relay, conn);
    }, RELAY_STREAM_RECHECK_MS);
    recheck.unref();
    socket.once("close", () => clearInterval(recheck));
  }
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
  if (relay) clearTimeout(handshakeTimer);

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
        writeFrame(socket, {
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
          send: (message) => writeFrame(socket, message),
          onClose: (listener) => {
            socket.once("close", listener);
            return () => socket.off("close", listener);
          },
          socket,
          scope: resolved.scope,
          sessionId: resolved.sessionId,
          openChannels: new Map(),
          activeWaits: 0,
        };
        continue;
      }

      const result = parseControlMessage(line);
      if (!result.ok) {
        writeFrame(socket, { id: result.id, ok: false, status: 400, error: result.error });
        continue;
      }

      if (relay) {
        // Per request, not per connection: the row can go inactive and the
        // session can be re-homed while a long-lived relayed connection idles.
        const denied = relayedSessionDenied(app, relay);
        if (denied !== null) {
          writeFrame(socket, { id: result.message.id, ok: false, status: 403, error: denied });
          continue;
        }
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

export async function dispatch(
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
    conn.send({
      id: message.id,
      ok: false,
      status: 404,
      error: `unknown op: ${message.op}`,
    });
    return;
  }
  if (!spec.scopes.includes(conn.scope)) {
    conn.send({
      id: message.id,
      ok: false,
      status: 403,
      error: "not permitted for this connection's scope",
    });
    return;
  }

  const reply = (payload: ReplyPayload) => conn.send({ id: message.id, ...payload });
  try {
    await spec.handler({ app, conn, id: message.id, body: message.body, reply });
  } catch (err) {
    // Defense-in-depth: writeFrame() already guards on socket.writable, but a
    // handler throwing after the connection has gone away mid-flight is
    // exactly the moment writing a reply is most likely to itself fail —
    // this must never surface as an unhandled rejection from the `void
    // dispatch(...)` call site above.
    try {
      const message = err instanceof Error ? err.message : String(err);
      // A request that lands while the app is closing (a service restart)
      // is a shutdown, not a fault: say so rather than echo Fastify's text.
      // Keyed off Fastify's error code; its text is only a fallback.
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "FST_ERR_REOPENED_CLOSE_SERVER" || /has already been closed/.test(message)) {
        reply({ ok: false, status: 503, error: "the primary is shutting down" });
      } else {
        reply({ ok: false, status: 500, error: message });
      }
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
  // handshake token above, same posture as hooks.ts's own hook socket
  // (including its named pipe, narrowed to this user and SYSTEM — #2065).
  if (!isPipePath(socketPath)) chmodSync(socketPath, 0o600);
  await restrictPipeToCurrentUser(socketPath, {
    log: (msg) => app.log.warn(`control-socket: ${msg}`),
  });

  app.decorate("controlServer", server);

  app.addHook("onClose", async () => {
    // Issue #2270 — the queue is created on first use (the app may already be listening
    // by then, when hooks can no longer be added), so it is stopped here.
    messageStates.get(app)?.queue.stop();
    for (const socket of openSockets) {
      // Issue #2271 — tell the peer WHY it is being dropped: this is the
      // id-less fatal frame the clients already fail every pending request
      // from (src/cli/client.mjs), here carrying a retryable reason instead
      // of a bare "connection closed".
      // end() flushes the frame before the FIN; destroy() right after write()
      // could discard it. The timer bounds a peer that never closes its side.
      socket.end(
        `${JSON.stringify({ id: null, ok: false, fatal: true, status: 503, error: "server-restarting" })}\n`,
      );
      setTimeout(() => socket.destroy(), 250).unref();
    }
    openSockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    try {
      if (!isPipePath(socketPath)) unlinkSync(socketPath);
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
