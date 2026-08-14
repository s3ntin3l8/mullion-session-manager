import type { NotificationEvent } from "./api/index.js";

// Phase 1's notification event channel (issue #166): a single WS connection
// to the backend's /ws/events (src/routes/events.ts), pushing a replay batch
// on connect and then every new NotificationEvent live. Connected once at
// app mount (store.ts's startEventsStream, called from App.tsx) — not per
// pane, unlike TerminalPane.tsx's own per-session WS.
//
// Reconnect mirrors TerminalPane.tsx's own capped-exponential-backoff shape
// (500ms -> 8s) with one deliberate difference: TerminalPane gives up after
// prefs.reconnect.maxAttempts and shows a "Disconnected" state a user can
// retry from. This is a single background aggregate stream with no
// per-instance UI of its own to show a give-up state in, so it retries
// indefinitely instead. Issue #673: while the tab is VISIBLE, the
// live-refresh poll (store.ts's startLiveRefresh) is still a fallback that
// keeps SessionInfo eventually-fresh regardless of this channel's state —
// but while hidden, that poll stops entirely (visibilitychange), so this
// channel is the SOLE freshness source for session status until it
// reconnects and replays. A long-hidden tab whose socket died therefore
// shows a stale badge/status until this backoff catches up — a real,
// accepted gap, not one this module tries to close on its own.
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

export interface EventsClientHandle {
  /** Advances this session's server-side read cursor — the "seen" WS
   * message /ws/events' shared read/unread primitive (pty-manager.ts's
   * lastSeenSeq) expects. A no-op while disconnected (mirrors
   * TerminalPane.tsx's own ws.readyState-gated sends) — the next reconnect
   * doesn't retroactively replay a "seen" that was never actually sent. */
  sendSeen: (sessionId: number, seq: number) => void;
  /** Stops reconnecting and closes the current connection, if any. */
  close: () => void;
}

function isEventsWireMessage(value: unknown): value is NotificationEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { seq?: unknown }).seq === "number" &&
    typeof (value as { sessionId?: unknown }).sessionId === "number" &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/** Opens (and keeps reopening, on any drop) a connection to /ws/events,
 * calling `onEvent` for every replayed-or-live NotificationEvent frame.
 * Callers (store.ts) own deduping/accumulating; this module only ever
 * delivers what the wire sends, once per frame, in delivery order. */
export function connectEventsStream(
  onEvent: (event: NotificationEvent) => void,
): EventsClientHandle {
  let ws: WebSocket | null = null;
  let destroyed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  function connect(): void {
    if (destroyed) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/events`);
    ws = socket;

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
    });

    socket.addEventListener("message", (event) => {
      // This channel is JSON-only (see events.ts) — a binary frame here
      // would be a protocol violation, not something to try to parse.
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (isEventsWireMessage(parsed)) onEvent(parsed);
    });

    socket.addEventListener("close", () => {
      if (destroyed) return;
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
        RECONNECT_MAX_DELAY_MS,
      );
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    });
  }

  connect();

  return {
    sendSeen: (sessionId, seq) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "seen", sessionId, seq }));
      }
    },
    close: () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    },
  };
}
