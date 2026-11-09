import type { FastifyInstance, InjectOptions } from "fastify";
import type net from "node:net";
import { isAuthEnabled, createSessionCookieValue, SESSION_COOKIE_NAME } from "../services/auth.js";
import { CONTROL_SOCKET_ADDR } from "../services/control-socket-addr.js";
import type { SocketChannel } from "../services/socket-channel.js";

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

export type Scope = "full" | "session";

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

export interface ReplyPayload {
  ok: boolean;
  status?: number;
  result?: unknown;
  error?: string;
}

export interface OpContext {
  app: FastifyInstance;
  conn: ConnectionState;
  /** The request's own `id` — the streaming ops (sessions.attach/input/
   * resize/detach) use this as the key into `conn.openChannels`, since a
   * client reuses one `id` for every message belonging to the same stream. */
  id: number;
  body: Record<string, unknown> | undefined;
  reply: (payload: ReplyPayload) => void;
}

export interface OpSpec {
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

/** Streaming ops need a socket to write their frames to; only a connection with
 * none (a test sink) lacks one now that a relay carries its pair (#2125). */
export const STREAM_UNAVAILABLE: ReplyPayload = {
  ok: false,
  status: 501,
  error: "not-available-over-relay: streaming ops need a local control-socket connection",
};

/** The open stream for `id`, or replies 400 and returns null. */
export function requireChannel(
  conn: ConnectionState,
  id: number,
  reply: (payload: ReplyPayload) => void,
): SocketChannel | null {
  const channel = conn.openChannels.get(id);
  if (!channel) reply({ ok: false, status: 400, error: "no open stream for this id" });
  return channel ?? null;
}

/** Why a new stream cannot be opened on `conn` under `id`, or null if it can. */
export function streamSlotError(conn: ConnectionState, id: number): ReplyPayload | null {
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
export function buildAuthHeaders(app: FastifyInstance): Record<string, string> {
  if (!isAuthEnabled(app.config)) return {};
  const cookieValue = createSessionCookieValue(app.config.MULLION_SESSION_SECRET);
  return { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

/** Auth headers plus a JSON content type, for ops forwarding a request body. */
export function jsonHeaders(app: FastifyInstance): Record<string, string> {
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
export async function injectAndShape(
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
export async function injectRoute(
  app: FastifyInstance,
  conn: ConnectionState,
  opts: Omit<InjectOptions, "remoteAddress">,
): Promise<ReplyPayload> {
  if (conn.scope !== "full") {
    return { ok: false, status: 403, error: "this operation requires full-scope credentials" };
  }
  return injectAndShape(app, opts);
}

/** One REST request an op forwards via app.inject(). `payload` is the
 * already-serialized JSON body (its presence adds the JSON content type). */
export interface Route {
  method: NonNullable<InjectOptions["method"]>;
  url: string;
  payload?: string;
}

export const bad = (status: number, error: string): ReplyPayload => ({ ok: false, status, error });
export const json = (value: unknown): string => JSON.stringify(value ?? {});
