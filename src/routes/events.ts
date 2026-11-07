import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket } from "ws";
import type { SocketLike } from "../services/socket-channel.js";
import { listHosts } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { getStoredSettings } from "../services/settings.js";
import { querySessionEvents } from "../services/event-history.js";
// The local events core lives in a service: the agent-side
// `/internal/ws/events` path (services/internal-streams.ts) needs it too,
// and a service importing a route inverts the layering (issue #2413).
// Re-exported so every existing importer keeps its path.
import {
  attachCursorsAndSeenBroadcast,
  attachLocalEventsSocket,
  shouldDropForBackpressure,
  startsWithPrefix,
  isSeenMessage,
  isCursorsUpstreamFrame,
  CURSORS_FRAME_PREFIX,
  SEEN_FRAME_PREFIX,
  EVENTS_BACKPRESSURE_MAX_BUFFERED_BYTES,
  type AttachLocalEventsOptions,
} from "../services/session-events.js";
export {
  attachCursorsAndSeenBroadcast,
  attachLocalEventsSocket,
  shouldDropForBackpressure,
  EVENTS_BACKPRESSURE_MAX_BUFFERED_BYTES,
};
export type { AttachLocalEventsOptions };
import { resolveSessionHostIds } from "../services/session-live-info.js";

// Phase 1's notification-event channel (issue #166): a single, JSON-only WS
// stream that replays every tracked session's buffered events on connect and
// then pushes new ones live — the push counterpart to the existing 4s
// GET /api/sessions poll (still unchanged; see pty-manager.ts's own
// "additive" framing). Unlike /ws/terminal (one socket per session),
// /ws/events is one aggregated socket per browser tab covering every
// session, local and remote-hosted alike.

/**
 * Opens one upstream `/internal/ws/events?cursors=1` connection to `hostId`
 * and relays its events into `browserSocket` — the multi-host half of
 * `/ws/events` (issue #26's own pattern, mirroring terminal.ts's
 * proxyToRemoteAttach). Pulled out as its own function (rather than inlined
 * in eventsRoute below) specifically so it's directly unit-testable against
 * mock sockets, the same way test/routes/terminal-remote-proxy.test.ts
 * drives proxyToRemoteAttach — a real end-to-end multi-host WS test needs
 * two full listening servers and is proportionally much more expensive for
 * the same coverage.
 *
 * The `cursors: true` opt-in flag (translated by RemoteHostClient into
 * `?cursors=1` on the wire) is what makes this issue #1459's multi-host
 * counterpart to attachAggregatedEventsSocket's own local `cursors` send: it
 * tells the agent's own `/internal/ws/events` to ALSO send its own
 * `{type:"cursors", bootId, cursors}` frame first and join its own
 * seenSubscribers broadcast set (routes/internal.ts). This is opt-in, not
 * unconditional, specifically so an OLDER primary — one that predates this
 * issue and still relays `/internal/ws/events` byte-for-byte with zero
 * parsing — never receives a frame shape it doesn't understand: only a NEW
 * primary (this function) ever sets the flag, so an old primary's agents
 * simply never emit these frames at all, unchanged from today.
 *
 * Every incoming frame is now checked (via the cheap prefix check above)
 * against the two new frame types before being forwarded — a plain
 * NotificationEvent frame (the hot-path majority case) still gets forwarded
 * completely unparsed, verbatim, exactly as before. A `cursors`/`seen` frame
 * is JSON.parsed, filtered down to sessions this call's OWN `hostId`
 * actually owns (resolveSessionHostIds — the same numeric-session-id
 * collision hazard this file's own comments on events themselves already
 * call out), and re-emitted — a `cursors` frame tagged with `hostId` so the
 * frontend can track this host's own boot generation independently of any
 * other host's (store/slices/events.ts's per-hostId knownBootIds map), a
 * `seen` frame unchanged in shape (inherently single-session, just
 * ownership-gated). No primary-side rebroadcast-to-other-upstreams is
 * needed for either: a local seen-broadcast already exists (seenSubscribers
 * below), and a remote agent's own seenSubscribers broadcast (routes/
 * internal.ts) already reaches every browser connected through THIS primary
 * with an open upstream to that same agent.
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
  browserSocket: SocketLike,
  hostId: string,
): NodeWebSocket | null {
  let upstream: NodeWebSocket;
  try {
    upstream = getRemoteHostClient(app, hostId).openEventsStream({ cursors: true });
  } catch (err) {
    app.log.error({ err, hostId }, "failed to open remote events stream");
    return null;
  }

  // isBinary explicitly captured and forwarded (not left to opts-less
  // default inference) for the same reason SocketChannel.send()'s own doc
  // comment gives (services/socket-channel.ts, Phase 4 #186): `ws`'s
  // default binaryType delivers this always-JSON events channel's payload
  // as a Buffer regardless of which frame type it actually was, and a
  // SocketChannel `browserSocket` (control socket's `events.subscribe`,
  // Phase 4 #188) would otherwise misread that Buffer as PTY-style binary
  // data (wrapping it in a base64 `{type:"data"}` frame) instead of a flat
  // JSON events frame. A real WebSocket browserSocket is unaffected either
  // way — forwarding as a text frame is what it already was.
  upstream.on("message", (data, isBinary) => {
    if (browserSocket.readyState !== browserSocket.OPEN) return;
    if (shouldDropForBackpressure(browserSocket.bufferedAmount)) return;

    // Issue #1459 — only a text frame can possibly be a cursors/seen frame
    // (this channel is JSON-only to begin with; isBinary should never be
    // true here in practice, but the check below is what actually decides,
    // not an assumption). startsWithPrefix is a zero-allocation byte
    // compare (see its own doc comment) — `data.toString("utf8")` (and the
    // `JSON.parse` after it) only happen for a frame that already matched
    // one of the two prefixes. A frame that matches neither is forwarded
    // completely unparsed, `data` untouched — the exact same byte-for-byte
    // relay this did before this issue, with no per-frame string
    // allocation on that (hot-path, majority-case) path either.
    if (!isBinary && startsWithPrefix(data, CURSORS_FRAME_PREFIX)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        return; // malformed — drop rather than forward garbage to the browser.
      }
      if (isCursorsUpstreamFrame(parsed)) {
        const ids = Object.keys(parsed.cursors)
          .map(Number)
          .filter((id) => Number.isFinite(id));
        const owners = resolveSessionHostIds(app, ids);
        const filtered: Record<number, { seen: number; head: number }> = {};
        for (const [key, value] of Object.entries(parsed.cursors)) {
          const id = Number(key);
          if (Number.isFinite(id) && owners.get(id) === hostId) filtered[id] = value;
        }
        browserSocket.send(
          JSON.stringify({ type: "cursors", hostId, bootId: parsed.bootId, cursors: filtered }),
        );
      }
      return;
    }
    if (!isBinary && startsWithPrefix(data, SEEN_FRAME_PREFIX)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (isSeenMessage(parsed)) {
        const owners = resolveSessionHostIds(app, [parsed.sessionId]);
        if (owners.get(parsed.sessionId) === hostId) {
          browserSocket.send(
            JSON.stringify({ type: "seen", sessionId: parsed.sessionId, seq: parsed.seq }),
          );
        }
      }
      return;
    }

    browserSocket.send(data, { binary: isBinary });
  });
  upstream.on("error", (err) => {
    app.log.error({ err, hostId }, "remote events ws upstream error");
  });

  return upstream;
}

/**
 * The full multi-host aggregate behind `/ws/events`: this process's own
 * local events (attachLocalEventsSocket) plus one relayed upstream per
 * non-local host (relayRemoteEventsHost), with "seen" messages broadcast to
 * every open upstream too. Extracted from eventsRoute's handler (Phase 4
 * #188) so the control socket's full-scope `events.subscribe` can drive the
 * exact same aggregation logic through a SocketChannel — a session-scoped
 * `events.subscribe` deliberately does NOT call this (see control-socket.ts):
 * a session-scoped connection's pinned session is always local (its hook
 * token can only ever resolve against this process's own PtyManager — a
 * remote-hosted session's token lives in a different process entirely), so
 * there is nothing for it to gain from opening upstream relays to every
 * other host just to filter back down to its own single, local session.
 *
 * Issue #1427: also sends a `cursors` frame and broadcasts every genuine
 * "seen" advance to every other currently-open connection of this same kind
 * on this process — both via attachCursorsAndSeenBroadcast above, shared
 * with the agent-side opt-in counterpart (routes/internal.ts). As of issue
 * #1459, a remote host's own sessions/cursors DO eventually appear to a
 * browser too — not from this function (still local-only, same scope as
 * attachLocalEventsSocket's own replay), but from relayRemoteEventsHost's
 * own upstream relay below, re-emitted as a separate, `hostId`-tagged
 * `cursors`/`seen` frame. `bootId` (PtyManager's own doc comment) is what
 * lets the client tell a genuine backend restart apart from ordinary
 * continued growth, since raw seq/head numbers alone can't always
 * disambiguate the two — per-hostId now (store/slices/events.ts's
 * knownBootIds map), since a local restart and a remote host's own restart
 * are independent events.
 */
export function attachAggregatedEventsSocket(app: FastifyInstance, socket: SocketLike): void {
  const onSeenAdvanced = attachCursorsAndSeenBroadcast(app, socket);

  attachLocalEventsSocket(app, socket, { onSeenAdvanced });

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
  //
  // { binary: isBinary } is required here, not optional — mirroring
  // relayRemoteEventsHost's own downstream fix above (and
  // proxyToRemoteAttach's established pattern, terminal.ts). Without it,
  // `upstream.send(data)` with a Buffer (which `data` always is for a
  // SocketChannel-sourced `events.seen`, and in fact for ANY caller once
  // `ws`'s default binaryType delivers text frames as Buffer too) defaults
  // to a BINARY frame — and the receiving agent's own attachLocalEventsSocket
  // message handler starts with `if (isBinary) return;`, silently dropping
  // every forwarded "seen" cursor update in a multi-host deployment.
  if (upstreams.length > 0) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      for (const upstream of upstreams) {
        if (upstream.readyState !== upstream.OPEN) continue;
        if (shouldDropForBackpressure(upstream.bufferedAmount)) continue;
        upstream.send(data, { binary: isBinary });
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
}

// Issue #213 (roadmap 4.7) — the persistent-history query surface, backing
// both this REST route and the `events.query` control-socket op
// (src/plugins/control-socket.ts re-enters this exact route via
// app.inject(), same as every other request/response op). As of
// remote-event-subscriber.ts, covers every enrolled host, not just this
// process's own — see src/plugins/event-store.ts's own doc comment (the
// writer this reads back from).
interface EventsQuery {
  sessionId?: number;
  kind?: string;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: number;
}

const eventsQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      // `type: "integer"` (not "string") so ajv's default `coerceTypes`
      // actually converts the querystring's string values to numbers
      // before they reach a SQL filter/LIMIT — GET /api/sessions' own
      // untyped querystring is this codebase's only other precedent, and
      // it has no numeric fields to get wrong the same way.
      sessionId: { type: "integer" },
      kind: { type: "string" },
      since: { type: "integer" },
      until: { type: "integer" },
      limit: { type: "integer" },
      cursor: { type: "integer" },
    },
    additionalProperties: false,
  },
};

export async function eventsRoute(app: FastifyInstance) {
  app.get("/ws/events", { websocket: true }, (socket) => {
    attachAggregatedEventsSocket(app, socket);
  });

  app.get<{ Querystring: EventsQuery }>(
    "/api/events",
    { schema: eventsQuerySchema },
    async (request, reply) => {
      // Explicit content-type: stored event payloads (terminal titles, file
      // paths) are echoed back verbatim — same XSS-guard convention
      // routes/settings.ts already documents for its own GET/PATCH handlers.
      reply.type("application/json");

      const persistenceEnabled = getStoredSettings(app.db).sessions.eventPersistence;
      if (!persistenceEnabled) {
        // Not an error: a caller needs to distinguish "no history because
        // persistence is off" from "no history because nothing happened
        // yet" — this flag is that signal.
        return { persistenceEnabled: false, events: [], nextCursor: null };
      }

      const { events, nextCursor } = querySessionEvents(
        app.db,
        {
          sessionId: request.query.sessionId,
          kind: request.query.kind,
          since: request.query.since,
          until: request.query.until,
          limit: request.query.limit,
          cursor: request.query.cursor,
        },
        app.log,
      );
      return { persistenceEnabled: true, events, nextCursor };
    },
  );
}
