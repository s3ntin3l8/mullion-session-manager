import type { StateCreator } from "zustand";
import { connectEventsStream, type EventsClientHandle } from "../../eventsClient.js";
import {
  addEvent,
  applyLiveSeen,
  capDismissedEventKeys,
  eventKey,
  mergeCursorsFrame,
} from "../helpers.js";
import { readDismissedEventKeys, writeDismissedEventKeys } from "../../lib/persistedState.js";
import { EVENTS_REFRESH_THROTTLE_MS } from "../constants.js";
import { getSessionRefreshBlockedUntil } from "./sessions.js";
import type { DashboardState, EventsSlice } from "../types.js";
import type { NotificationEvent } from "../../api/index.js";

// Issue #673 — kinds that cannot move any SessionInfo-derived field AND
// dominate the /ws/events stream, so refreshing sessions on them would be
// pure waste. Deliberately a DENY-list, not an allow-list: any kind added to
// NotificationEvent's union later (src/shared/types.ts) defaults to
// triggering a refresh, which can only ever be too conservative, never
// stale. Measured over 24h of live traffic (1887 events): title_change
// (583) and file_change (333) together were 49% of all events, neither is
// read into SessionInfo by anything today, and title_change is separately
// already debounced at the source (pty-manager.ts's
// scheduleTitleChangeEvent) because it was once 93.6% of all rows on its
// own. Every other kind — including "todo"/"session_diff", which never
// appeared at all in that same 24h window — stays refresh-triggering.
const NON_STATUS_EVENT_KINDS = new Set<NotificationEvent["kind"]>(["title_change", "file_change"]);

export const createEventsSlice: StateCreator<DashboardState, [], [], EventsSlice> = (set, get) => {
  // Set once startEventsStream() connects (App.tsx's mount effect) — the
  // handle markEventSeen() below sends "seen" messages through. Stays null
  // until then (and after cleanup), matching eventsClient.ts's own
  // "no-op while disconnected" semantics rather than throwing.
  let eventsClientHandle: EventsClientHandle | null = null;

  // Issue #673 — fixed-window throttle (not the tasks.ts/github.ts precedent's
  // pure trailing debounce): refreshSessions() is called immediately on the
  // first status-bearing frame, then suppressed for EVENTS_REFRESH_THROTTLE_MS;
  // if another status-bearing frame arrived during that window, exactly one
  // more refresh fires at its end. A pure trailing debounce would delay every
  // transition by the full window (this feeds a latency-sensitive badge, see
  // documentBadge.ts) and can starve entirely under sustained traffic — a real
  // risk here given clearStaleBlockedIfOlderThan can emit up to 10
  // status_change frames per session in one sweep tick, and a reconnect
  // replays up to 500 frames (routes/events.ts's REPLAY_MAX_EVENTS) in one
  // burst. This shape bounds both at exactly 2 refreshSessions() calls.
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingDuringWindow = false;

  const scheduleRefresh = () => {
    // 429 backoff (issue #959): the live poll already established a
    // block window via sessionRefreshBlockedUntil (set when the
    // cascade's refreshSessions caught a RateLimitedError). A
    // status-bearing event from /ws/events would otherwise bypass that
    // backoff — the breaker in api/client.ts would still short-circuit
    // the actual fetch, but we'd still spin up the throw every event.
    // Skip the call entirely here. The push channel's own backoff
    // (EVENTS_REFRESH_THROTTLE_MS = 400ms) already handles the unrelated
    // case of "lots of status events arriving faster than refresh can
    // observe"; this guard handles the orthogonal case of "refresh is
    // rate-limited, don't pile on."
    if (Date.now() < getSessionRefreshBlockedUntil()) {
      return;
    }
    // refreshSessions() gained in-flight coalescing (issue #1008,
    // sessions.ts's refreshSessionsActiveRun/refreshSessionsQueuedRun) —
    // but deliberately NOT the bare "share the in-flight promise" shape
    // PR #477 warned against for a function five mutations
    // (createSession/renameSession/deleteSession/promoteSession/
    // declinePromote) await to observe their own write. A call arriving
    // here while one is already in flight gets queued behind it instead of
    // sharing it, so this call's own eventual fetch still starts strictly
    // after whatever was already running — see sessions.ts's own doc
    // comment for the full reasoning. In practice overlap is still rare:
    // on the live host, GET /api/sessions took 7-14ms for 66KB gzipped
    // (317 sessions) — far below this throttle window. refreshSessions()
    // also rethrows on failure, so .catch() here is required, not
    // stylistic — this call has no awaiting caller and would otherwise
    // surface as an unhandled rejection.
    void get()
      .refreshSessions()
      .catch(() => {});
  };

  const onStatusBearingEvent = () => {
    if (throttleTimer === null) {
      scheduleRefresh();
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (pendingDuringWindow) {
          pendingDuringWindow = false;
          onStatusBearingEvent();
        }
      }, EVENTS_REFRESH_THROTTLE_MS);
    } else {
      pendingDuringWindow = true;
    }
  };

  return {
    events: {},
    lastSeenSeq: {},
    // Issue #1427 — dismissals are purely local UI state (no server
    // counterpart), so they're read from localStorage synchronously at
    // slice-init the same way mutedSessionIds is (slices/ui.ts) — unlike
    // lastSeenSeq above, which starts empty and is populated from the
    // server's own `cursors` frame once startEventsStream connects (see
    // below), since it's now server-owned.
    dismissedEventKeys: readDismissedEventKeys(),

    startEventsStream: () => {
      const handle = connectEventsStream({
        onEvent: (event) => {
          set((state) => ({ events: addEvent(state.events, event) }));
          if (!NON_STATUS_EVENT_KINDS.has(event.kind)) onStatusBearingEvent();
        },
        // Issue #1427 — reconcile the local read cursor against the
        // server's own, per session, via mergeCursorsFrame's restart-aware
        // merge rule. Arrives once per connection, before any replayed
        // event, so this always runs before addEvent above has a chance to
        // make lastSeenSeq's staleness visible as a wrong unread count.
        onCursors: (cursors) => {
          set((state) => ({ lastSeenSeq: mergeCursorsFrame(state.lastSeenSeq, cursors) }));
        },
        // Issue #1427 — another connection (this tab, another tab, another
        // device) just advanced this session's cursor. Deliberately does
        // NOT go through markEventSeen/sendSeen below — the server already
        // knows; this only needs to update local state to match.
        onSeen: (sessionId, seq) => {
          set((state) => ({ lastSeenSeq: applyLiveSeen(state.lastSeenSeq, sessionId, seq) }));
        },
      });
      eventsClientHandle = handle;
      return () => {
        handle.close();
        if (eventsClientHandle === handle) eventsClientHandle = null;
        if (throttleTimer !== null) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        pendingDuringWindow = false;
      };
    },

    markEventSeen: (sessionId, seq) => {
      set((state) => {
        const current = state.lastSeenSeq[sessionId] ?? 0;
        if (seq <= current) return state;
        return { lastSeenSeq: { ...state.lastSeenSeq, [sessionId]: seq } };
      });
      eventsClientHandle?.sendSeen(sessionId, seq);
    },

    markSessionRead: (sessionId) => {
      const events = get().events[sessionId];
      if (!events || events.length === 0) return;
      // addEvent (below) keeps each session's list sorted ascending by seq,
      // so the last entry is always the highest — same invariant
      // PaneTab.tsx's own mark-seen effect relies on.
      get().markEventSeen(sessionId, events[events.length - 1].seq);
    },

    dismissEvent: (sessionId, seq) => {
      // ts comes from the buffered event itself (eventKey's own doc
      // comment — needed to disambiguate a (sessionId, seq) pair that
      // repeats across a backend restart). Every caller dismisses an event
      // it's currently rendering, i.e. one still present in `events`, so
      // this should always find it; Date.now() is a harmless fallback for
      // the theoretical case it doesn't (still dismisses, just without the
      // restart-disambiguation benefit for that one key).
      const ts = get().events[sessionId]?.find((e) => e.seq === seq)?.ts ?? Date.now();
      set((state) => {
        const dismissedEventKeys = capDismissedEventKeys({
          ...state.dismissedEventKeys,
          [eventKey(sessionId, seq, ts)]: true,
        });
        writeDismissedEventKeys(dismissedEventKeys);
        return { dismissedEventKeys };
      });
    },

    dismissEvents: (sessionId, seqs) => {
      if (seqs.length === 0) return;
      const bySeq = new Map(get().events[sessionId]?.map((e) => [e.seq, e.ts]));
      set((state) => {
        let dismissedEventKeys = { ...state.dismissedEventKeys };
        for (const seq of seqs) {
          const ts = bySeq.get(seq) ?? Date.now();
          dismissedEventKeys[eventKey(sessionId, seq, ts)] = true;
        }
        dismissedEventKeys = capDismissedEventKeys(dismissedEventKeys);
        writeDismissedEventKeys(dismissedEventKeys);
        return { dismissedEventKeys };
      });
    },
  };
};
