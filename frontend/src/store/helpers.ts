import type { NotificationEvent, Theme as ThemePreference } from "../api/index.js";
import { STORAGE_KEYS, readBool, readNumber, readString } from "../lib/persistedState.js";
import { EVENTS_PER_SESSION_CAP, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from "./constants.js";
import type { Theme, ViewMode } from "./types.js";

export function readStoredSidebarWidth(): number {
  const parsed = readNumber(STORAGE_KEYS.sidebarWidth, SIDEBAR_MIN_WIDTH);
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, parsed));
}

// Which workspace was last active survives a reload via localStorage (not
// the DB — it's a per-browser UI preference, not shared server state).
export function readStoredActiveWorkspaceId(): number | null {
  const parsed = readNumber(STORAGE_KEYS.activeWorkspaceId, NaN);
  return Number.isInteger(parsed) ? parsed : null;
}

export function readStoredViewMode(): ViewMode {
  return readString(STORAGE_KEYS.viewMode, "list") === "kanban" ? "kanban" : "list";
}

export function readStoredHierarchicalView(): boolean {
  return readBool(STORAGE_KEYS.hierarchicalView, false);
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

export function resolveTheme(pref: ThemePreference): Theme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

// A thin first-paint mirror of the *resolved* theme only — settings.theme
// itself (dark/light/system) is server-persisted (see hydrateSettings in
// slices/ui.ts), but waiting on that fetch before the very first render
// would flash the wrong theme. This one key is written every time the
// resolved theme changes and read once, synchronously, at module load.
//
// `fallback` defaults to "dark" (the store's own call site relies on that
// default, matching this app's dark-by-default design) but AuthGate.tsx
// passes the OS `prefers-color-scheme` result instead — a login screen has
// no prior resolved-theme write to fall back on for a genuinely first-ever
// visit, so guessing dark there would be wrong for a light-OS visitor.
export function readThemeHint(fallback: Theme = "dark"): Theme {
  return readString(STORAGE_KEYS.themeHint, fallback) === "light" ? "light" : "dark";
}

// The composite key `dismissedEventKeys` and PaneTab.tsx's own
// dismissed-filter are keyed on — `seq` alone isn't unique across sessions
// (it's a per-session monotonic counter, see api.ts's NotificationEvent
// doc comment), so any per-event state keyed just by seq would collide
// across sessions. Exported so PaneTab.tsx's badge filter and
// NotificationBell.tsx's feed use the exact same key shape as
// dismissEvent() writes.
//
// Issue #1427: gained a third `ts` segment. `seq` is also no longer unique
// on its own ACROSS A BACKEND RESTART — pty-manager.ts's `Session.eventSeq`
// resets to 0 when the process restarts (it's not persisted), so two
// genuinely different events for the same session can now share a
// (sessionId, seq) pair. `ts` (the event's own wall-clock timestamp) breaks
// that tie without needing any new counter. pruneDismissedEventKeys' own
// parsing (below) only ever reads the prefix up to the FIRST colon, so it
// keeps working unmodified against this wider key.
export function eventKey(sessionId: number, seq: number, ts: number): string {
  return `${sessionId}:${seq}:${ts}`;
}

// Issue #1427's read-cursor merge rule, applied per session id whenever a
// `cursors` frame arrives (routes/events.ts's attachAggregatedEventsSocket,
// sent right after connect, before replay) or synced against a *stored*
// starting point. The server's own read cursor is itself ephemeral — not
// persisted, see pty-manager.ts's Session.seenSeq doc comment — so this
// can't simply always trust the server's value (that would regress a
// cursor this same client advanced moments before a brief reconnect) or
// always trust the local value (that would leave events the server has
// forgotten about — because it restarted — looking unread forever).
//
// `local > server.head` is the restart signal: `head` (the server's own
// eventSeq) is monotonic and never decreases within one backend process's
// lifetime (Session.eventSeqHead's doc comment), so a local cursor sitting
// ABOVE anything the server has ever emitted can only mean the server's
// own counters reset out from under it — the local cursor's numbering no
// longer corresponds to anything the server can replay, so the server's
// value (even though it's numerically lower) is authoritative. Any other
// case is an ordinary reconnect or a second device's cursor arriving, and
// the higher of the two wins — this also fixes a pre-existing bug: without
// this frame at all, a bare reconnect after a backend restart used to
// leave every already-buffered event looking already-read, because the
// local cursor (still holding its old, now out-of-range value) was never
// reconciled against anything.
export function mergeServerCursor(local: number, server: { seen: number; head: number }): number {
  if (local > server.head) return server.seen;
  return Math.max(local, server.seen);
}

// Applies mergeServerCursor across every session id present in a `cursors`
// frame. A session id ABSENT from `cursors` — a remote host's own session,
// or one this process doesn't track — is left completely untouched, not
// defaulted to anything: `cursors` only ever describes this process's own
// local sessions (PtyManager.listCursors's own doc comment), so silence
// about a session says nothing about its read state either way.
export function mergeCursorsFrame(
  lastSeenSeq: Record<number, number>,
  cursors: Record<string, { seen: number; head: number }>,
): Record<number, number> {
  const next = { ...lastSeenSeq };
  for (const [key, server] of Object.entries(cursors)) {
    const sessionId = Number(key);
    if (!Number.isFinite(sessionId)) continue;
    next[sessionId] = mergeServerCursor(next[sessionId] ?? 0, server);
  }
  return next;
}

// Applies one live "seen" broadcast (issue #1427 — another currently-open
// connection just advanced this session's cursor) to the local
// `lastSeenSeq` record. Monotonic-only, same as markEventSeen's own local
// half — but this deliberately does NOT also call eventsClientHandle's
// sendSeen: the update already originated server-side (some other
// connection sent it), so echoing it back would be a pointless round trip,
// not a bug fix.
export function applyLiveSeen(
  lastSeenSeq: Record<number, number>,
  sessionId: number,
  seq: number,
): Record<number, number> {
  const current = lastSeenSeq[sessionId] ?? 0;
  if (seq <= current) return lastSeenSeq;
  return { ...lastSeenSeq, [sessionId]: seq };
}

// Issue #1427 — bounds dismissedEventKeys the same way EVENTS_PER_SESSION_CAP
// bounds `events`, so an old, long-lived browser tab's localStorage entry
// can't grow unboundedly. Object key insertion order is preserved for
// string keys that aren't canonical array indices — eventKey()'s
// `sid:seq:ts` format always contains a colon, so it never qualifies as one
// — meaning `Object.keys` here really does return dismissal order, oldest
// first, so trimming the front evicts the oldest dismissals first.
export const DISMISSED_EVENT_KEYS_CAP = 500;

export function capDismissedEventKeys(record: Record<string, true>): Record<string, true> {
  const keys = Object.keys(record);
  if (keys.length <= DISMISSED_EVENT_KEYS_CAP) return record;
  const next: Record<string, true> = {};
  for (const key of keys.slice(keys.length - DISMISSED_EVENT_KEYS_CAP)) next[key] = true;
  return next;
}

// Merges one incoming NotificationEvent into the per-session accumulated
// list, deduped by seq (a reconnect's replay batch can re-deliver an
// event this store already holds — see startEventsStream) and capped at
// EVENTS_PER_SESSION_CAP, oldest evicted first.
export function addEvent(
  events: Record<number, NotificationEvent[]>,
  event: NotificationEvent,
): Record<number, NotificationEvent[]> {
  const existing = events[event.sessionId] ?? [];
  if (existing.some((e) => e.seq === event.seq)) return events;
  const next = [...existing, event].sort((a, b) => a.seq - b.seq).slice(-EVENTS_PER_SESSION_CAP);
  return { ...events, [event.sessionId]: next };
}

// P6 perf/correctness fix — `events`, `lastSeenSeq`, and
// `dismissedEventKeys` are keyed by session id and, unlike `gitStatuses`
// (which refreshGitStatuses rebuilds fresh from the live session id list
// every cycle), nothing ever removed a key from any of them: a long-lived
// dashboard accumulates one entry per session id it has EVER seen,
// unbounded. Pruned here (alongside every successful refreshSessions()
// call) rather than at kill/delete time directly: per this repo's own
// AGENTS.md ("the sessions DB row records intent... live process state
// lives only in PtyManager's in-memory map"), a killed session's DB row
// survives and GET /api/sessions keeps returning it — Sidebar's
// hideEndedSessions toggle can still show a killed/exited row — so pruning
// on kill would delete event history a still-visible row needs. The one
// case that's genuinely safe (and the only one this prunes): a session id
// that no longer appears in the live list AT ALL, which — verified against
// routes/sessions.ts's GET /api/sessions (no status filter; killed/exited
// rows are returned same as active ones) — only happens when the DB row
// itself is gone (its project, or the project's host, was deleted; FK
// cascade removes the row outright). That is the remediation plan's own
// conservative boundary: "prune only ids that no longer appear in the
// sessions API response at all, not ids that are merely killed."
export function pruneSessionKeyedRecord<T>(
  record: Record<number, T>,
  liveIds: ReadonlySet<number>,
): Record<number, T> {
  const keys = Object.keys(record);
  // Fast path returns the SAME reference (not a fresh shallow copy) when
  // there's nothing to prune — a no-op prune must not itself manufacture a
  // new identity every tick for whatever's selecting this slice, which
  // would undo this same PR's P1 fine-grained-selector work for any
  // events/lastSeenSeq subscriber.
  if (keys.every((k) => liveIds.has(Number(k)))) return record;
  const next: Record<number, T> = {};
  for (const key of keys) {
    const id = Number(key);
    if (liveIds.has(id)) next[id] = record[id];
  }
  return next;
}

// Same shape as pruneSessionKeyedRecord above, but `dismissedEventKeys` is
// keyed by the composite `eventKey(sessionId, seq)` string (`seq` alone
// isn't unique across sessions — see that function's own doc comment), so
// the session id has to be parsed out of the key's prefix rather than used
// directly.
export function pruneDismissedEventKeys(
  record: Record<string, true>,
  liveIds: ReadonlySet<number>,
): Record<string, true> {
  const keys = Object.keys(record);
  const isLive = (key: string): boolean => {
    // Every key in this map is written by dismissEvent() via eventKey()
    // above, so this should always parse — but a key this prune pass
    // can't confidently attribute to a session id is kept, not dropped:
    // this pass only removes keys it can PROVE belong to a gone session.
    const sep = key.indexOf(":");
    if (sep <= 0) return true;
    const sessionId = Number(key.slice(0, sep));
    if (!Number.isFinite(sessionId)) return true;
    return liveIds.has(sessionId);
  };
  if (keys.every(isLive)) return record;
  const next: Record<string, true> = {};
  for (const key of keys) {
    if (isLive(key)) next[key] = record[key];
  }
  return next;
}
