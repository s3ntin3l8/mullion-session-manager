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

// Issue #1427 — sent once, right after connect (before the replay batch),
// by attachAggregatedEventsSocket (routes/events.ts): every locally-tracked
// session's server-side read cursor, so this client can reconcile its own
// possibly-stale local cursor against what the server currently knows (see
// store/helpers.ts's mergeCursorsFrame for the merge rule this enables).
// `cursors`' values arrive with string keys (a JSON object can't have
// numeric keys on the wire) — deliberately left as-is here; the numeric
// conversion happens once, in mergeCursorsFrame/adoptServerCursors, rather
// than twice. `bootId` is a fresh random id generated once per backend
// process incarnation (PtyManager's own doc comment) — store/slices/
// events.ts compares it against the last one this connection saw to tell a
// genuine restart apart from an ordinary reconnect, since raw seq/head
// numbers alone can't always disambiguate the two (see
// mergeServerCursor's doc comment).
//
// Issue #1459 — `hostId` is optional and absent on the primary's own local
// frame (attachAggregatedEventsSocket's first send is unchanged); only a
// frame relayed from a remote host (`relayRemoteEventsHost`,
// routes/events.ts) carries one, tagging which host's own boot generation
// this frame describes. store/slices/events.ts keys its per-connection
// bootId tracking off `hostId ?? "local"` specifically so a remote host's
// restart is never conflated with the primary's own.
export interface CursorsWireMessage {
  type: "cursors";
  hostId?: string;
  bootId: string;
  cursors: Record<string, { seen: number; head: number }>;
}

function isCursorsMessage(value: unknown): value is CursorsWireMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "cursors" &&
    ((value as { hostId?: unknown }).hostId === undefined ||
      typeof (value as { hostId?: unknown }).hostId === "string") &&
    typeof (value as { bootId?: unknown }).bootId === "string" &&
    typeof (value as { cursors?: unknown }).cursors === "object" &&
    (value as { cursors?: unknown }).cursors !== null
  );
}

// Issue #1427 — broadcast by attachAggregatedEventsSocket to every OTHER
// currently-open aggregate connection on this process whenever a "seen"
// message (see sendSeen below) genuinely advances a session's cursor.
// Shares its `{type, sessionId, seq}` shape with the outgoing "seen"
// message this same client sends via sendSeen — same fields, opposite
// direction — but this one only ever arrives, never gets echoed back to
// its own sender (routes/events.ts excludes the originating socket).
export interface SeenWireMessage {
  type: "seen";
  sessionId: number;
  seq: number;
}

function isSeenMessage(value: unknown): value is SeenWireMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "seen" &&
    typeof (value as { sessionId?: unknown }).sessionId === "number" &&
    typeof (value as { seq?: unknown }).seq === "number"
  );
}

export interface ConnectEventsStreamHandlers {
  /** Called for every replayed-or-live NotificationEvent frame. */
  onEvent: (event: NotificationEvent) => void;
  /** Called once per connection, right after it opens, before any replayed
   * event — see CursorsWireMessage above. `hostId` is `undefined` for the
   * primary's own local frame, and a remote host's id for a relayed one. */
  onCursors: (
    bootId: string,
    cursors: Record<string, { seen: number; head: number }>,
    hostId?: string,
  ) => void;
  /** Called for every live cross-client "seen" broadcast — see
   * SeenWireMessage above. Never called for this connection's own outgoing
   * sendSeen (the server excludes the sender). */
  onSeen: (sessionId: number, seq: number) => void;
}

/** Opens (and keeps reopening, on any drop) a connection to /ws/events,
 * dispatching each incoming frame to the matching handler in `handlers`.
 * Callers (store.ts) own deduping/accumulating; this module only ever
 * delivers what the wire sends, once per frame, in delivery order. The
 * `type` discriminant is checked before falling back to the bare-event
 * guard, so a future frame shape can never be misread as a phantom
 * NotificationEvent even if it happened to also satisfy that guard. */
export function connectEventsStream(handlers: ConnectEventsStreamHandlers): EventsClientHandle {
  const { onEvent, onCursors, onSeen } = handlers;
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
      if (isCursorsMessage(parsed)) {
        onCursors(parsed.bootId, parsed.cursors, parsed.hostId);
      } else if (isSeenMessage(parsed)) {
        onSeen(parsed.sessionId, parsed.seq);
      } else if (isEventsWireMessage(parsed)) {
        onEvent(parsed);
      }
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
