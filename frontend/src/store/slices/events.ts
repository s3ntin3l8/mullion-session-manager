import type { StateCreator } from "zustand";
import { connectEventsStream, type EventsClientHandle } from "../../eventsClient.js";
import { addEvent, eventKey } from "../helpers.js";
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
    dismissedEventKeys: {},

    startEventsStream: () => {
      const handle = connectEventsStream((event) => {
        set((state) => ({ events: addEvent(state.events, event) }));
        if (!NON_STATUS_EVENT_KINDS.has(event.kind)) onStatusBearingEvent();
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

    dismissEvent: (sessionId, seq) => {
      set((state) => ({
        dismissedEventKeys: { ...state.dismissedEventKeys, [eventKey(sessionId, seq)]: true },
      }));
    },

    dismissEvents: (sessionId, seqs) => {
      if (seqs.length === 0) return;
      set((state) => {
        const dismissedEventKeys = { ...state.dismissedEventKeys };
        for (const seq of seqs) dismissedEventKeys[eventKey(sessionId, seq)] = true;
        return { dismissedEventKeys };
      });
    },
  };
};
