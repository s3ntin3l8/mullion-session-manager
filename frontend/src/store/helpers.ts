import type { NotificationEvent, Theme as ThemePreference } from "../api.js";
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
export function readThemeHint(): Theme {
  return readString(STORAGE_KEYS.themeHint, "dark") === "light" ? "light" : "dark";
}

// The composite key `dismissedEventKeys` and PaneTab.tsx's own
// dismissed-filter are keyed on — `seq` alone isn't unique across sessions
// (it's a per-session monotonic counter, see api.ts's NotificationEvent
// doc comment), so any per-event state keyed just by seq would collide
// across sessions. Exported so PaneTab.tsx's badge filter and
// NotificationBell.tsx's feed use the exact same key shape as
// dismissEvent() writes.
export function eventKey(sessionId: number, seq: number): string {
  return `${sessionId}:${seq}`;
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
// CLAUDE.md ("the sessions DB row records intent... live process state
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
