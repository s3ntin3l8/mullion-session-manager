import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { WebSocket as NodeWebSocket } from "ws";
import type { NotificationEvent } from "../services/pty-manager.js";
import { listHosts } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";

// Phase 1's notification-event channel (issue #166): a single, JSON-only WS
// stream that replays every tracked session's buffered events on connect and
// then pushes new ones live — the push counterpart to the existing 4s
// GET /api/sessions poll (still unchanged; see pty-manager.ts's own
// "additive" framing). Unlike /ws/terminal (one socket per session),
// /ws/events is one aggregated socket per browser tab covering every
// session, local and remote-hosted alike.

export const EVENTS_BACKPRESSURE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Pure predicate behind every backpressure drop below — pulled out so the
 * drop condition itself is directly unit-testable without needing a real
 * socket with a controllable bufferedAmount (see test/routes/events.test.ts). */
export function shouldDropForBackpressure(bufferedAmount: number): boolean {
  return bufferedAmount > EVENTS_BACKPRESSURE_MAX_BUFFERED_BYTES;
}

// Bounds how many replayed events a single connect can push, across every
// tracked session combined — each session's own ring buffer already caps at
// EVENTS_MAX (pty-manager.ts), but a host tracking many sessions could still
// add up to more than is useful to dump on connect.
const REPLAY_MAX_EVENTS = 500;

interface SeenMessage {
  type: "seen";
  sessionId: number;
  seq: number;
}

function isSeenMessage(value: unknown): value is SeenMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "seen" &&
    typeof (value as { sessionId?: unknown }).sessionId === "number" &&
    typeof (value as { seq?: unknown }).seq === "number"
  );
}

function sendEvent(socket: WebSocket, event: NotificationEvent): void {
  if (socket.readyState !== socket.OPEN) return;
  if (shouldDropForBackpressure(socket.bufferedAmount)) return;
  socket.send(JSON.stringify(event));
}

/**
 * Wires a freshly-accepted WS socket to this process's own `app.pty` —
 * replay-then-stream every LOCAL session's notification events. Shared by
 * the primary's own `/ws/events` route below and the agent's DB-less
 * `/internal/ws/events` (routes/internal.ts), exactly the same
 * local-core/two-callers shape terminal.ts's attachSocketToSession already
 * uses for `/ws/terminal` + `/internal/ws/attach`.
 *
 * Subscribes to app.pty.onEvent() BEFORE taking the listEvents() replay
 * snapshot (not after) — reversing that order would leave a window where an
 * event emitted between the snapshot and the subscribe is missed entirely
 * (never replayed, never streamed live). Subscribing first means such an
 * event is at worst delivered twice (once live, once — if it also made it
 * into the snapshot — in the replay batch); callers dedupe replay+live by
 * (sessionId, seq) anyway (frontend store), so an over-delivery is harmless
 * while an under-delivery would be a silently dropped event.
 */
export function attachLocalEventsSocket(app: FastifyInstance, socket: WebSocket): void {
  // Only accumulated until the replay snapshot below is sent — after that,
  // onEvent's callback pushes straight to sendEvent() and stops appending
  // here, so this array can't grow for the rest of the connection's
  // lifetime (a long-lived socket would otherwise buffer every live event
  // forever, since nothing else ever reads or clears it once replay is done).
  const buffered: NotificationEvent[] = [];
  let replaySent = false;
  const unsubscribe = app.pty.onEvent((event) => {
    if (!replaySent) buffered.push(event);
    sendEvent(socket, event);
  });

  const seen = new Set<string>();
  const replay = [...app.pty.listEvents(), ...buffered]
    .filter((event) => {
      const key = `${event.sessionId}:${event.seq}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.ts - b.ts)
    .slice(-REPLAY_MAX_EVENTS);
  for (const event of replay) socket.send(JSON.stringify(event));
  buffered.length = 0;
  replaySent = true;

  // Two separate `message` handlers end up registered on this same socket:
  // this one (local "seen" cursor processing) and, when there are remote
  // hosts, eventsRoute's own handler below (forwarding to upstreams). Both
  // fire for every text frame — that's intentional, not an oversight: each
  // handles a disjoint concern and neither returns/stops propagation, so
  // running both is exactly the desired "process locally AND forward
  // upstream" behavior. Kept as two handlers rather than one combined
  // function so this local-only path stays independently testable/reusable
  // by the agent's DB-less /internal/ws/events, which never registers the
  // second (upstream-forwarding) handler at all.
  socket.on("message", (data, isBinary) => {
    if (isBinary) return; // this channel is JSON-only — see the plan.
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      app.log.warn("dropped malformed events control message");
      return;
    }
    if (isSeenMessage(parsed)) {
      app.pty.markEventsSeen(String(parsed.sessionId), parsed.seq);
    }
  });

  socket.on("close", () => {
    unsubscribe();
  });
}

/**
 * Opens one upstream `/internal/ws/events` connection to `hostId` and relays
 * its events into `browserSocket` — the multi-host half of `/ws/events`
 * (issue #26's own pattern, mirroring terminal.ts's proxyToRemoteAttach).
 * Pulled out as its own function (rather than inlined in eventsRoute below)
 * specifically so it's directly unit-testable against mock sockets, the same
 * way test/routes/terminal-remote-proxy.test.ts drives proxyToRemoteAttach —
 * a real end-to-end multi-host WS test needs two full listening servers and
 * is proportionally much more expensive for the same coverage.
 *
 * Returns the opened upstream socket (so the caller can track it for
 * close-propagation and "seen" forwarding), or null if opening it failed
 * synchronously (e.g. the host has no baseUrl). Unlike proxyToRemoteAttach,
 * a failure on any ONE host's upstream must never tear down the aggregate
 * `browserSocket` — the other hosts' (and this process's own local) events
 * keep flowing regardless, so this never closes `browserSocket` itself.
 */
export function relayRemoteEventsHost(
  app: FastifyInstance,
  browserSocket: WebSocket,
  hostId: string,
): NodeWebSocket | null {
  let upstream: NodeWebSocket;
  try {
    upstream = getRemoteHostClient(app, hostId).openEventsStream();
  } catch (err) {
    app.log.error({ err, hostId }, "failed to open remote events stream");
    return null;
  }

  upstream.on("message", (data) => {
    if (browserSocket.readyState !== browserSocket.OPEN) return;
    if (shouldDropForBackpressure(browserSocket.bufferedAmount)) return;
    browserSocket.send(data);
  });
  upstream.on("error", (err) => {
    app.log.error({ err, hostId }, "remote events ws upstream error");
  });

  return upstream;
}

export async function eventsRoute(app: FastifyInstance) {
  app.get("/ws/events", { websocket: true }, (socket) => {
    attachLocalEventsSocket(app, socket);

    // Known gap (acceptable for this PR): a host that's unreachable at
    // connect time isn't retried until the browser's OWN /ws/events socket
    // reconnects (see the frontend client's capped-backoff reconnect) —
    // there's no independent per-host retry loop inside a single browser
    // connection's lifetime.
    const upstreams: NodeWebSocket[] = [];
    for (const host of listHosts(app)) {
      if (host.isLocal) continue;
      const upstream = relayRemoteEventsHost(app, socket, host.id);
      if (upstream) upstreams.push(upstream);
    }

    // Forwards every text frame (in practice, only "seen" messages) the
    // browser sends up to every open remote host too — each agent's own
    // app.pty.markEventsSeen() is a harmless no-op for a session id it
    // doesn't track (see pty-manager.ts), so broadcasting rather than
    // resolving which single host actually owns a given sessionId is both
    // simpler and correct. This is the second of two "message" handlers on
    // `socket` — see attachLocalEventsSocket's comment above the first one
    // for why that's deliberate, not a bug.
    if (upstreams.length > 0) {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        for (const upstream of upstreams) {
          if (upstream.readyState !== upstream.OPEN) continue;
          if (shouldDropForBackpressure(upstream.bufferedAmount)) continue;
          upstream.send(data);
        }
      });
    }

    socket.on("close", () => {
      for (const upstream of upstreams) {
        if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
          upstream.close();
        }
      }
    });
  });
}
