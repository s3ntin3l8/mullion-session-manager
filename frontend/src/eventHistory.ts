import type { NotificationEvent, StoredEventRow } from "./api/index.js";
import { ALL_KINDS } from "./eventDescriptions.js";

// Issue #213 (roadmap 4.7) — the frontend half of "unified session history".
// The backend query surface (GET /api/events, api.listEventHistory) already
// shipped in PR #421; this module is the small adapter layer that lets
// SessionTimeline.tsx render a StoredEventRow (a persisted DB row) using the
// exact same describeEvent/KIND_LABELS machinery it already uses for live
// NotificationEvents from the store — see that component's own comment for
// why this is "swap in a second data source", not "build new filters".
//
// KIND_LABELS/ALL_KINDS moved to eventDescriptions.ts (making notifications
// relevant/scannable) so NotificationBell.tsx's kind pill and this file's
// stored-row validation share one label vocabulary instead of two that could
// drift — that module has no import of its own that would cycle back here
// (it only pulls the `NotificationEvent` type from api/index.ts), so this
// direction is safe. ALL_KINDS is re-imported here (not just re-exported)
// because KNOWN_KINDS below needs it directly.
const KNOWN_KINDS = new Set<string>(ALL_KINDS);

function isKnownKind(kind: string): kind is NotificationEvent["kind"] {
  return KNOWN_KINDS.has(kind);
}

// The type SessionTimeline.tsx's `described`/`filtered` pipeline actually
// operates on — a NotificationEvent widened just enough to also represent a
// persisted-history row:
//   - `sessionId: number | null` — session_events.sessionId's FK is
//     `onDelete: "set null"` (a row deliberately outlives its session; that
//     IS the point of history), so a rendered row must handle this.
//   - `rowId` — the DB row's own `id`, present only for a history row.
//     `(sessionId, seq)` is NOT a safe key/dedupe pair across a backend
//     restart: `Session.eventSeq` (src/services/pty-manager.ts) is a plain
//     in-memory counter, absent from readStateFile's restore list, so it
//     resets to 1 on every restart for a surviving dtach session. A history
//     row's own autoincrement `id` has no such collision; a live store event
//     has no `id` at all (hence optional).
export interface TimelineEvent {
  seq: number;
  kind: NotificationEvent["kind"];
  ts: number;
  payload: Record<string, unknown>;
  sessionId: number | null;
  rowId?: number;
}

/** Adapts a persisted `StoredEventRow` into a `TimelineEvent`, or drops it
 * (returns null) when there's nothing sensible to render:
 *   - `kind` isn't one SessionTimeline.tsx / eventDescriptions.ts knows
 *     about (the DB column is plain `text`, not an enum — schema.ts's own
 *     comment on why — so an old or future-version row can carry an unknown
 *     kind). Same "last-known-good, not everything" posture `described`
 *     already applies when describeEvent itself returns null.
 * `payload: null` (either genuinely stored null, or a row whose JSON failed
 * to parse — src/services/event-history.ts's parsePayload) normalizes to
 * `{}`, matching describeEvent's expectation of always getting an object. */
export function toTimelineEvent(row: StoredEventRow): TimelineEvent | null {
  if (!isKnownKind(row.kind)) return null;
  return {
    seq: row.seq,
    kind: row.kind,
    ts: row.ts,
    payload: row.payload ?? {},
    sessionId: row.sessionId,
    rowId: row.id,
  };
}

/** Turns a live store NotificationEvent into the same widened shape, so
 * store events and history rows can be merged into one array before
 * sorting/filtering. `sessionId` is never null for a live event (the store
 * only ever holds events for a session actually tracked in
 * useDashboardStore.sessions), and `rowId` stays undefined — a live event's
 * key is `eventKey(sessionId, seq)`, not a DB row id. */
export function fromLiveEvent(event: NotificationEvent): TimelineEvent {
  return {
    seq: event.seq,
    kind: event.kind,
    ts: event.ts,
    payload: event.payload,
    sessionId: event.sessionId,
  };
}

/** Merges live store events with fetched history rows into one
 * deduplicated, ascending-`ts` array. The two sources legitimately overlap:
 * history persistence is debounced (5s, 30s hard ceiling —
 * src/services/event-store.ts), so the newest several seconds of activity
 * exist in the live store before they're ever written to the DB.
 *
 * Dedupe key is `sessionId:seq:ts:kind` — NOT `sessionId:seq` alone (fact:
 * seq resets across a backend restart, see TimelineEvent's own comment), so
 * a genuine post-restart `seq: 1` is never mistaken for the pre-restart
 * `seq: 1` it collides with.
 *
 * When both a history and a live copy of the same event exist, the HISTORY
 * copy wins — it carries `rowId`, so a row's React key stops changing once
 * history finishes loading instead of remounting mid-render. */
export function mergeTimelineEvents(
  historyEvents: TimelineEvent[],
  liveEvents: TimelineEvent[],
): TimelineEvent[] {
  const byKey = new Map<string, TimelineEvent>();
  const keyOf = (e: TimelineEvent): string => `${e.sessionId}:${e.seq}:${e.ts}:${e.kind}`;
  // Live events first, history second — history's later `set()` call
  // overwrites any live duplicate, giving history the win described above.
  for (const event of liveEvents) byKey.set(keyOf(event), event);
  for (const event of historyEvents) byKey.set(keyOf(event), event);
  return Array.from(byKey.values()).sort(
    (a, b) => a.ts - b.ts || a.seq - b.seq || (a.sessionId ?? -1) - (b.sessionId ?? -1),
  );
}
