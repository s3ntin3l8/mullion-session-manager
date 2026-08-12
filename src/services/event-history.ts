import { and, desc, eq, gte, isNotNull, lte, lt } from "drizzle-orm";
import { sessionEvents } from "../db/schema.js";
import type { getDb } from "../db/client.js";
import type { NotificationEvent } from "./pty-manager.js";

// Issue #213 (roadmap 4.7) — the query/insert/retention logic behind the
// `session_events` table (src/db/schema.ts), shared by three callers:
// src/plugins/event-store.ts (the debounced write path), GET /api/events
// (src/routes/events.ts), and the `events.query` control-socket op
// (src/plugins/control-socket.ts). Pulled out as plain functions taking a
// `db` handle (never `app`) so each is directly unit-testable against a
// temp SQLite file with no Fastify instance required.
//
// As of remote-event-subscriber.ts, this table also holds events from every
// enrolled agent host — event-store.ts's own writer accepts events from both
// app.pty.onEvent() (this process's own sessions) and the long-lived
// per-host subscriptions remote-event-subscriber.ts maintains independent of
// any browser tab being open. insertSessionEvents' onConflictDoNothing()
// below is what lets a reconnecting subscription's replayed events land here
// safely — see schema.ts's own doc comment on the dedupe index.

export interface StoredEventRow {
  id: number;
  sessionId: number | null;
  seq: number;
  kind: string;
  ts: number;
  payload: Record<string, unknown> | null;
}

export interface EventQueryFilter {
  sessionId?: number;
  kind?: string;
  /** Inclusive lower bound on `ts` (epoch ms). */
  since?: number;
  /** Inclusive upper bound on `ts` (epoch ms). */
  until?: number;
  limit?: number;
  /** Opaque pagination token — the `id` of the last row from a previous
   * page's response (`nextCursor`). Returns rows strictly older, in
   * insertion order, than that row — see querySessionEvents' own comment
   * for why this is an `id` cursor, not a `ts` one. */
  cursor?: number;
}

export interface EventQueryResult {
  events: StoredEventRow[];
  nextCursor: number | null;
}

// Defense-in-depth clamp, same "don't trust the caller's own number"
// reasoning as sanitizeSettings' safeNumber (services/settings.ts) — a
// querystring/control-socket `limit` reaches a SQL LIMIT directly otherwise.
export const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 500;

interface MinimalLogger {
  warn: (obj: unknown, msg: string) => void;
}

function parsePayload(
  raw: string | null,
  id: number,
  log?: MinimalLogger,
): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (err) {
    // Never leak the raw, unparsable string into a field typed as an
    // object — log and return null instead (same "best-effort, never
    // throw" posture as the write path).
    log?.warn({ err, id }, "session_events row has unparsable payload JSON, returning null");
    return null;
  }
}

/** Batch-inserts a session's freshly-emitted events. Best-effort by
 * contract: throws straight through on a DB error (e.g. a session id that
 * no longer exists and violates the FK, or a closed DB handle) — callers
 * (event-store.ts) are the ones responsible for catching and logging rather
 * than propagating, per this feature's "must never affect live PTY
 * behavior" requirement. Kept a thrower here (rather than swallowing
 * inside this function) so a test can assert the failure actually
 * surfaces to the caller's catch block. No-ops on an empty batch.
 *
 * onConflictDoNothing() targets the session_events_dedupe_idx unique index
 * on (session_id, seq, ts, kind) — a remote-event-subscriber.ts reconnect
 * replays its buffered events verbatim, so a replayed row's (seq, ts, kind)
 * is byte-identical to what's already stored and silently no-ops here
 * instead of throwing. A post-restart seq:1 (pty-manager.ts's eventSeq
 * resets per process, not per session) carries a fresh `ts` and is NOT a
 * conflict, so restart-reset seqs still insert as new rows — this is
 * intentional, see schema.ts's own doc comment. This also applies to the
 * local (non-remote) write path, since it's the same function: verified
 * that's a no-op there too — PtyManager.emitEvent() increments eventSeq
 * synchronously on every call (pty-manager.ts), so no two events from one
 * session's lifetime can ever share a `seq`, and therefore never collide on
 * this index either. */
export function insertSessionEvents(
  db: ReturnType<typeof getDb>,
  events: NotificationEvent[],
): void {
  if (events.length === 0) return;
  db.insert(sessionEvents)
    .values(
      events.map((event) => ({
        sessionId: event.sessionId,
        seq: event.seq,
        kind: event.kind,
        ts: event.ts,
        payload: JSON.stringify(event.payload ?? {}),
      })),
    )
    .onConflictDoNothing()
    .run();
}

/** Queries persisted events, newest-inserted-first. Ordered by `id DESC`
 * (insertion order) rather than `ts DESC` — deliberately: `since`/`until`
 * are pure `ts` filters, and pairing a `ts` sort with an `id` cursor could
 * skip or duplicate rows whenever two rows' `ts` values tie or arrive
 * out of order (e.g. a retention sweep test seeding an old `ts` on a
 * recently-inserted row). Insertion order and `id` order are one and the
 * same by construction (autoincrement), so this cursor scheme is exact. */
export function querySessionEvents(
  db: ReturnType<typeof getDb>,
  filter: EventQueryFilter,
  log?: MinimalLogger,
): EventQueryResult {
  const rawLimit = filter.limit ?? DEFAULT_QUERY_LIMIT;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.trunc(rawLimit), MAX_QUERY_LIMIT)
      : DEFAULT_QUERY_LIMIT;

  const conditions = [];
  if (filter.sessionId !== undefined) {
    conditions.push(eq(sessionEvents.sessionId, filter.sessionId));
  }
  if (filter.kind !== undefined) conditions.push(eq(sessionEvents.kind, filter.kind));
  if (filter.since !== undefined) conditions.push(gte(sessionEvents.ts, filter.since));
  if (filter.until !== undefined) conditions.push(lte(sessionEvents.ts, filter.until));
  if (filter.cursor !== undefined) conditions.push(lt(sessionEvents.id, filter.cursor));

  const query = db
    .select()
    .from(sessionEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(sessionEvents.id))
    // Fetch one extra row so "is there a next page" is answered without a
    // separate COUNT(*) query.
    .limit(limit + 1);
  const rows = query.all();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    events: page.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      seq: row.seq,
      kind: row.kind,
      ts: row.ts,
      payload: parsePayload(row.payload, row.id, log),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

/** Deletes session_events rows older than `retentionDays` (by `ts`).
 * `retentionDays <= 0` is "unlimited" and a deliberate no-op — callers
 * (event-store.ts) must check this themselves before even arming a sweep
 * timer, same as git-fetcher.ts's own `intervalSeconds <= 0` gate; kept
 * here too as defense-in-depth against a direct call. Returns the number of
 * rows actually deleted, purely so a caller can log a real transition. */
export function sweepOldSessionEvents(db: ReturnType<typeof getDb>, retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const thresholdMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = db.delete(sessionEvents).where(lt(sessionEvents.ts, thresholdMs)).run();
  return result.changes;
}

/** Caps persisted `session_events` rows at `maxPerSession` per session,
 * newest-kept — the "max events per session" bound issue #213's own body
 * asked for, alongside `sweepOldSessionEvents`' max-age bound above.
 * `maxPerSession <= 0` is "unlimited" and a deliberate no-op, same
 * convention as `sweepOldSessionEvents`.
 *
 * Deliberately per-session (`SELECT DISTINCT session_id` then one DELETE
 * per session), not a single `ROW_NUMBER() OVER (PARTITION BY session_id
 * ORDER BY id DESC)` sweep: the only index on this table is
 * `(session_id, ts)` (schema.ts). A per-session query uses that index for
 * its `WHERE session_id = ?` filter (this sweep's own cursor semantics are
 * `id`-ordered — querySessionEvents' own comment on why `id`, not `ts` — so
 * the `ORDER BY id DESC` itself still needs a per-session sort either way,
 * same as a table-wide window function would; the index only narrows which
 * rows that sort has to run over). A table-wide window function gets no
 * such narrowing at all, scanning and sorting every session's rows in one
 * pass regardless of `maxPerSession`.
 *
 * Hermes review, PR #563 (round 5) — worth noting this is a genuine
 * per-session-sort cost (fine at the hourly cadence this runs on for
 * realistic session sizes; would be worth revisiting only if a single
 * session ever reaches ~100k+ events), not something the index eliminates.
 *
 * Orphaned rows (`sessionId: null`, the FK's `onDelete: "set null"`) have
 * no session to count against and are excluded — `sweepOldSessionEvents`
 * is the only thing that bounds them. Returns the number of rows actually
 * deleted, same contract as `sweepOldSessionEvents`.
 *
 * Hermes review, PR #563 — the original implementation found the newest
 * `maxPerSession` ids to keep, then issued `DELETE ... WHERE id NOT IN
 * (keepIds)`. `notInArray` binds one SQL parameter per id, so a cap set
 * anywhere near the settings clamp's own upper bound (100_000) blew past
 * SQLite's compiled bind-parameter limit (32766) and the DELETE THREW —
 * verified empirically against this repo's own better-sqlite3 build (a
 * 40,000-param NOT IN fails, 30,000 works). Rewritten to a single
 * cutoff-id lookup instead: the id of the Nth-newest row (found via
 * `OFFSET maxPerSession - 1`, no row list at all) becomes a plain `id <
 * cutoff` predicate — O(1) bind params regardless of `maxPerSession`'s
 * magnitude, and it only ever fetches ONE row instead of up to
 * `maxPerSession` of them.
 *
 * Hermes review, PR #563 (round 3) — `Math.trunc` below, not just
 * `<= 0`: `safeNumber` (settings.ts) validates range/finiteness but not
 * integer-ness, and the NumberField backing this setting sends a bare
 * `Number(input)` (ui/primitives.tsx) with nothing stopping a
 * fractional value like `1.5` from persisting. A fractional `OFFSET` is a
 * SQLite "datatype mismatch" the sweep tick's own try/catch would
 * otherwise swallow silently, hourly, forever — verified empirically. This
 * function is exported and public, so it truncates defensively rather than
 * relying on every caller having already validated its input.
 *
 * Hermes review, PR #563 (round 4) — `Number.isFinite` first: `Math.trunc
 * (NaN)` is `NaN`, and `NaN <= 0` is `false` (neither comparison direction
 * is ever true for `NaN`), so a `NaN`/`Infinity` input would otherwise slip
 * past the guard above and reach `OFFSET` anyway. `safeNumber` rejects
 * non-finite values today, but this function claims to defend an
 * unvalidated caller, so it should actually do that. */
export function sweepSessionEventCap(db: ReturnType<typeof getDb>, maxPerSession: number): number {
  if (!Number.isFinite(maxPerSession)) return 0;
  const cap = Math.trunc(maxPerSession);
  if (cap <= 0) return 0;

  const sessionIdRows = db
    .selectDistinct({ sessionId: sessionEvents.sessionId })
    .from(sessionEvents)
    .where(isNotNull(sessionEvents.sessionId))
    .all();

  let deleted = 0;
  for (const { sessionId } of sessionIdRows) {
    if (sessionId === null) continue; // narrows the type; excluded by WHERE above already
    const cutoffRow = db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(desc(sessionEvents.id))
      .limit(1)
      .offset(cap - 1)
      .get();
    // Fewer rows than the cap — nothing at that offset, so nothing to
    // delete. Skip the query entirely rather than issue a guaranteed no-op
    // against every under-cap session on every sweep tick.
    if (cutoffRow === undefined) continue;
    const result = db
      .delete(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), lt(sessionEvents.id, cutoffRow.id)))
      .run();
    deleted += result.changes;
  }
  return deleted;
}
