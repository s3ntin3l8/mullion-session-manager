// Session authority for the control socket (issue #2402): which session (or
// project) an op may act on, given the connection's scope and pin.
//
// This used to be three near-copies inside plugins/control-socket.ts
// (resolveTargetSessionId, resolveOwnedSessionId, resolveEventsSessionFilter)
// plus two more for the project and the spawn parent. They now share ONE
// implementation, `resolveSessionTarget`, and every behavioural difference is
// a field on its `SessionTargetPolicy`, so a difference is visible where it is
// declared rather than hidden in a copy that drifted:
//
//   - `field`       which body field names the target (sessionId, or
//                   parentSessionId for sessions.spawn_child)
//   - `mismatch`    the 403 text for a session-scoped connection naming
//                   another session when children are not allowed
//   - `children`    when present, a session-scoped connection may ALSO name a
//                   child it spawned. That adds the parent_session_id check,
//                   the caller's own sessionRowIsActive re-check and the
//                   canonical-id rewrite; `childOnly` additionally refuses the
//                   connection's own session as a target (sessions.kill)
//   - `fullScope`   "required" 400s a full-scope request with no target,
//                   "optional" lets it through as `undefined` (events.query:
//                   "every session")
//
// This module sits under services/, so it must not import plugins/ or
// routes/ (scripts/check-import-boundaries.mjs): the connection and reply
// shapes it needs are declared structurally below, and the plugin's own
// ConnectionState / ReplyPayload satisfy them.

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";

/** The slice of a control-socket connection the authority checks read. */
export interface AuthorityConn {
  readonly scope: "full" | "session";
  /** Set only for scope "session": the session the connection is pinned to. */
  readonly sessionId: string | null;
}

export interface AuthorityRefusal {
  ok: false;
  status: number;
  error: string;
}

export type AuthorityResult<T = string> =
  { ok: true; id: T } | { ok: false; reply: AuthorityRefusal };

const refuse = (status: number, error: string): { ok: false; reply: AuthorityRefusal } => ({
  ok: false,
  reply: { ok: false, status, error },
});

/**
 * Reads `body[key]` as an id: a non-empty string or a number (stringified).
 * An empty string is never a real id — treating it as "not provided" (rather
 * than a literal target) means a bogus `{sessionId:""}` gets the same
 * "'sessionId' is required" 400 every other omitted-id case does, instead of
 * silently reaching app.inject() with an empty path segment (Hermes review,
 * PR #398). The one helper behind every id field the socket reads
 * (`sessionId`, `projectId`, `parentSessionId`, ...).
 */
export function extractIdField(
  body: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const rawId = body?.[key];
  if (rawId === undefined || rawId === null) return null;
  if (typeof rawId !== "string" && typeof rawId !== "number") return null;
  const id = String(rawId);
  return id.length === 0 ? null : id;
}

/** Whether `id`'s DB row is still `active`. A hook token outlives its
 * session's own intent (it stays valid until the process is reaped), so an
 * op that lets a session act beyond itself re-checks the ROW — the source of
 * intent; the in-memory PtyManager map can lack a live session (#1518). */
export function sessionRowIsActive(app: FastifyInstance, id: string): boolean {
  const row = app.db
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, Number(id)))
    .get();
  return row?.status === "active";
}

/** The ids of `parentId`'s children (issue #2125: seeds an event replay). */
export function childSessionIds(app: FastifyInstance, parentId: number): number[] {
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
export function ownAndChildSessionFilter(
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

/** What a session-scoped connection may name beyond its own session. */
export interface ChildAccess {
  app: FastifyInstance;
  /** Refuse the connection's own session as a target (sessions.kill: a
   * session may not kill itself through this socket). */
  childOnly: boolean;
}

export interface SessionTargetPolicy {
  /** The body field that names the target. */
  field: "sessionId" | "parentSessionId";
  /** 403 text when a session-scoped connection names a session that is not
   * its own and children are not allowed. */
  mismatch: string;
  /** Present: a session-scoped connection may also name one of its children. */
  children?: ChildAccess;
  /** Full scope has no session of its own to default to: "required" 400s a
   * missing target, "optional" resolves it to `undefined`. */
  fullScope: "required" | "optional";
}

/**
 * The one session-target resolver. Resolves which session id an op should
 * act on and enforces the connection's pin along the way — the "explicit
 * `body.sessionId === conn.sessionId` check" injectRoute's own doc comment
 * requires of every op that bypasses it.
 *
 *  - Session scope: the target field, if given at all, MUST be the
 *    connection's own pinned id; omitting it defaults to that pin, which is
 *    what lets an agent inside a session say `{"op":"sessions.get"}` with no
 *    target. Naming anything else is a 403 — never silently redirected — unless
 *    `policy.children` lets it name a child (see resolveChildOfPinned).
 *  - Full scope: the target is whatever the body names (`fullScope`).
 */
export function resolveSessionTarget(
  conn: AuthorityConn,
  body: Record<string, unknown> | undefined,
  policy: SessionTargetPolicy & { fullScope: "optional" },
): AuthorityResult<string | undefined>;
export function resolveSessionTarget(
  conn: AuthorityConn,
  body: Record<string, unknown> | undefined,
  policy: SessionTargetPolicy,
): AuthorityResult<string>;
export function resolveSessionTarget(
  conn: AuthorityConn,
  body: Record<string, unknown> | undefined,
  policy: SessionTargetPolicy,
): AuthorityResult<string | undefined> {
  const provided = extractIdField(body, policy.field);

  if (conn.scope === "session") {
    const pinnedId = conn.sessionId!;
    if (provided === null || provided === pinnedId) {
      return policy.children?.childOnly
        ? refuse(403, "session-scoped connections may only target a child of their own session")
        : { ok: true, id: pinnedId };
    }
    if (!policy.children) return refuse(403, policy.mismatch);
    return resolveChildOfPinned(policy.children.app, pinnedId, provided);
  }

  if (provided === null) {
    return policy.fullScope === "optional"
      ? { ok: true, id: undefined }
      : refuse(400, `'${policy.field}' is required`);
  }
  return { ok: true, id: provided };
}

/**
 * A session-scoped connection naming a session other than its own pin: allowed
 * only for a child it spawned (`sessions.parent_session_id === its pinned id`)
 * — the parent→child orchestration surface. Anything else, including a
 * sibling, an unrelated session, or an id that doesn't exist, is the same 403
 * (never a 404, so a session can't probe which ids exist).
 *
 * The relationship is read from the DB row, not PtyManager, so a parent can
 * still inspect a child that has already exited. Acting on a child also
 * requires the CALLER's own row to still be active (sessionRowIsActive).
 */
function resolveChildOfPinned(
  app: FastifyInstance,
  pinnedId: string,
  provided: string,
): AuthorityResult<string> {
  const childId = Number(provided);
  const childRow = Number.isInteger(childId)
    ? app.db
        .select({ parentSessionId: sessions.parentSessionId })
        .from(sessions)
        .where(eq(sessions.id, childId))
        .get()
    : undefined;
  if (!childRow || childRow.parentSessionId !== Number(pinnedId)) {
    return refuse(
      403,
      "session-scoped connections may only target their own session or its children",
    );
  }
  if (!sessionRowIsActive(app, pinnedId)) {
    return refuse(403, "this session is no longer active");
  }
  // Canonical form, so a non-canonical spelling ("05", "0x5") that passed the
  // numeric check above can't reach a downstream route as a different string.
  return { ok: true, id: String(childId) };
}

/** The connection's own session (session scope: pinned; full scope: required
 * `sessionId`). No children. */
export function resolveTargetSessionId(
  conn: AuthorityConn,
  body: Record<string, unknown> | undefined,
): AuthorityResult {
  return resolveSessionTarget(conn, body, {
    field: "sessionId",
    mismatch: "session-scoped connections may only target their own session",
    fullScope: "required",
  });
}

/** Like resolveTargetSessionId, but a session-scoped connection may ALSO name
 * a child it spawned; carries the child-parent check and the caller's
 * active-row re-check. `childOnly` is for sessions.kill. */
export function resolveOwnedSessionId(
  app: FastifyInstance,
  conn: AuthorityConn,
  body: Record<string, unknown> | undefined,
  opts: { childOnly?: boolean } = {},
): AuthorityResult {
  return resolveSessionTarget(conn, body, {
    field: "sessionId",
    mismatch: "session-scoped connections may only target their own session or its children",
    children: { app, childOnly: opts.childOnly === true },
    fullScope: "required",
  });
}

/**
 * The `sessionId` filter `events.query` should apply — a QUERY rather than a
 * single-target op: full scope may omit `sessionId` entirely (meaning "every
 * session"). Session scope still can't broaden its own view: it may omit
 * `sessionId` (defaulting to its own pinned session), name that exact session,
 * or name one of its own CHILDREN — but never an unrelated session or "all
 * sessions". `events.subscribe` (live stream) is pinned to the connection's
 * own session only (#1626 tracks extending it to children).
 */
export function resolveEventsSessionFilter(
  app: FastifyInstance,
  conn: AuthorityConn,
  body: Record<string, unknown> | undefined,
): { ok: true; sessionId: string | undefined } | { ok: false; reply: AuthorityRefusal } {
  const target = resolveSessionTarget(conn, body, {
    field: "sessionId",
    mismatch: "session-scoped connections may only target their own session or its children",
    children: { app, childOnly: false },
    fullScope: "optional",
  });
  return target.ok ? { ok: true, sessionId: target.id } : target;
}

/**
 * Resolves the parent session id for sessions.spawn_child. Session scope
 * defaults to (and can never override) its own pinned session id — "an agent
 * spawning a child OF ITSELF," not "an agent naming an arbitrary parent." Full
 * scope has no pinned session, so it must name one.
 */
export function resolveParentSessionId(
  conn: AuthorityConn,
  body: Record<string, unknown> | undefined,
): AuthorityResult {
  return resolveSessionTarget(conn, body, {
    field: "parentSessionId",
    mismatch: "session-scoped connections may only spawn children of their own session",
    fullScope: "required",
  });
}

/**
 * Resolves the project id for `projects.actions` — the one op the per-scope
 * allowlist puts at session scope even though it targets a *project*. A
 * session-scoped connection has no explicit project id to present, so "its
 * own project" means the project its pinned session was launched against; a
 * session with no project (or one whose row is no longer active) has nothing
 * to default to and 400s rather than treating "no project" as a real target.
 */
export function resolveTargetProjectId(
  app: FastifyInstance,
  conn: AuthorityConn,
  body: Record<string, unknown> | undefined,
): AuthorityResult {
  const provided = extractIdField(body, "projectId");

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
    if (ownProjectId === null) return refuse(400, "this session has no associated project");
    if (provided !== null && provided !== ownProjectId) {
      return refuse(403, "session-scoped connections may only target their own session's project");
    }
    return { ok: true, id: ownProjectId };
  }

  if (provided === null) return refuse(400, "'projectId' is required");
  return { ok: true, id: provided };
}
