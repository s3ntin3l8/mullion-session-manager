import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket } from "ws";
import type { NotificationEvent } from "../services/pty-manager.js";
import type { SocketLike } from "../services/socket-channel.js";
import { listHosts } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { getStoredSettings } from "../services/settings.js";
import { querySessionEvents } from "../services/event-history.js";
import { resolveSessionHostIds } from "../services/session-live-info.js";

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

// Issue #1459 — the shape an agent's own /internal/ws/events?cursors=1 sends
// (attachCursorsAndSeenBroadcast below, reused on both sides): the exact
// same `{type:"cursors", bootId, cursors}` local browsers already get from
// attachAggregatedEventsSocket, with no `hostId` — an agent has no concept
// of its own hostId (that's a primary-side DB column on `hosts`). Only
// relayRemoteEventsHost's own re-emission (below) tags a frame with hostId,
// once it's confirmed to be forwarding it to a browser.
interface CursorsUpstreamFrame {
  type: "cursors";
  bootId: string;
  cursors: Record<string, { seen: number; head: number }>;
}

function isCursorsUpstreamFrame(value: unknown): value is CursorsUpstreamFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "cursors" &&
    typeof (value as { bootId?: unknown }).bootId === "string" &&
    typeof (value as { cursors?: unknown }).cursors === "object" &&
    (value as { cursors?: unknown }).cursors !== null
  );
}

function sendEvent(socket: SocketLike, event: NotificationEvent): void {
  if (socket.readyState !== socket.OPEN) return;
  if (shouldDropForBackpressure(socket.bufferedAmount)) return;
  socket.send(JSON.stringify(event));
}

export interface AttachLocalEventsOptions {
  /**
   * Restricts both replay and live streaming to events belonging to this one
   * session id, and rejects an incoming "seen" message naming a different
   * one — the control socket's session-scoped `events.subscribe`/`.seen`
   * (control-socket.ts, Phase 4 #188) use this so a connection pinned to one
   * session can never observe (or mark seen) another session's events, the
   * same isolation `resolveTargetSessionId` already enforces for the
   * request/response ops. Omitted entirely (both `/ws/events` callers below)
   * means the full, unfiltered aggregate — unchanged behavior.
   */
  sessionIdFilter?: string;
  /**
   * Called whenever an incoming "seen" message genuinely advances a
   * session's read cursor (`PtyManager.markEventsSeen`'s own return value) —
   * issue #1427's cross-client read-state sync. Wired by
   * `attachAggregatedEventsSocket` below, for the primary's own unfiltered
   * aggregate, and — as of issue #1459 — by routes/internal.ts's
   * `/internal/ws/events?cursors=1` too, via the same
   * `attachCursorsAndSeenBroadcast` helper both call sites share: an agent
   * has its own independent seenSubscribers set (keyed by its own `app`, a
   * different FastifyInstance than the primary's), so this broadcasts to
   * every OTHER currently-open opted-in internal connection on that same
   * agent, and `relayRemoteEventsHost` (below) relays the resulting `seen`
   * frame up to the primary, ownership-filtered, exactly like a `cursors`
   * frame. A `sessionIdFilter`'d connection still doesn't get one
   * (broadcasting there would need its own per-session filtering to avoid
   * leaking another session's cursor to a connection pinned to just one),
   * and the agent's bare (non-opted-in) `/internal/ws/events` doesn't either
   * — see `relayRemoteEventsHost`'s own doc comment for why the opt-in flag
   * exists at all.
   */
  onSeenAdvanced?: (sessionId: number, seq: number) => void;
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
export function attachLocalEventsSocket(
  app: FastifyInstance,
  socket: SocketLike,
  opts?: AttachLocalEventsOptions,
): void {
  const matchesFilter = (sessionId: number): boolean =>
    opts?.sessionIdFilter === undefined || String(sessionId) === opts.sessionIdFilter;

  // Only accumulated until the replay snapshot below is sent — after that,
  // onEvent's callback pushes straight to sendEvent() and stops appending
  // here, so this array can't grow for the rest of the connection's
  // lifetime (a long-lived socket would otherwise buffer every live event
  // forever, since nothing else ever reads or clears it once replay is done).
  const buffered: NotificationEvent[] = [];
  let replaySent = false;
  const unsubscribe = app.pty.onEvent((event) => {
    if (!matchesFilter(event.sessionId)) return;
    if (!replaySent) buffered.push(event);
    sendEvent(socket, event);
  });

  const seen = new Set<string>();
  const replay = [...app.pty.listEvents(), ...buffered]
    .filter((event) => matchesFilter(event.sessionId))
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
    if (isSeenMessage(parsed) && matchesFilter(parsed.sessionId)) {
      const advanced = app.pty.markEventsSeen(String(parsed.sessionId), parsed.seq);
      if (advanced) opts?.onSeenAdvanced?.(parsed.sessionId, parsed.seq);
    }
  });

  socket.on("close", () => {
    unsubscribe();
  });
}

// Issue #1459 — the two frame-type prefixes relayRemoteEventsHost's own
// message handler (below) checks for before paying for a JSON.parse. Both
// are built by JSON.stringify()ing an object literal with `type` as its
// first key (attachCursorsAndSeenBroadcast's `cursors` send, and this same
// file's "seen" broadcast payload) — a plain NotificationEvent never starts
// this way (its own field order is `{seq, sessionId, kind, ts, payload}`,
// see pty-manager.ts), so this prefix check can never false-positive on the
// hot path's actual majority case (ordinary event frames) and only ever
// costs a cheap string comparison for those.
const CURSORS_FRAME_PREFIX = '{"type":"cursors"';
const SEEN_FRAME_PREFIX = '{"type":"seen"';

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
    // not an assumption). A frame whose string form doesn't start with
    // either known prefix is forwarded completely unparsed, `data` untouched
    // — the exact same byte-for-byte relay this did before this issue.
    if (!isBinary) {
      const text = data.toString("utf8");
      if (text.startsWith(CURSORS_FRAME_PREFIX)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
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
      if (text.startsWith(SEEN_FRAME_PREFIX)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
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
    }

    browserSocket.send(data, { binary: isBinary });
  });
  upstream.on("error", (err) => {
    app.log.error({ err, hostId }, "remote events ws upstream error");
  });

  return upstream;
}

// Issue #1427 — the subscriber set behind attachAggregatedEventsSocket's
// cross-client "seen" broadcast: every currently-open unfiltered aggregate
// connection to THIS process (a real /ws/events browser tab, or the control
// socket's full-scope `events.subscribe`), so that when one of them marks a
// session read, every other one hears about it without waiting for its own
// reconnect. Keyed by the FastifyInstance itself (a WeakMap, not a bare
// module-level Set) so independent app instances spun up by different tests
// in the same process never leak subscribers into each other — an entry is
// never explicitly deleted; it simply falls out of scope with its app.
//
// Deliberately hand-rolled rather than reusing services/ws-broadcast.ts's
// createBroadcastChannel: that helper's `subscribe()` requires
// `socket.on("error", ...)`, which `SocketLike` (services/socket-channel.ts)
// doesn't declare — the control socket's SocketChannel never emits an
// `error` event at all, only `message`/`close` — so a SocketChannel can't
// satisfy createBroadcastChannel's type, and this function's `socket`
// parameter is a SocketLike, not necessarily a real WebSocket.
const seenSubscribers = new WeakMap<FastifyInstance, Set<SocketLike>>();

function getSeenSubscribers(app: FastifyInstance): Set<SocketLike> {
  let subs = seenSubscribers.get(app);
  if (!subs) {
    subs = new Set();
    seenSubscribers.set(app, subs);
  }
  return subs;
}

/**
 * Shared by attachAggregatedEventsSocket below (the primary's own unfiltered
 * `/ws/events` aggregate) and, as of issue #1459, routes/internal.ts's
 * `/internal/ws/events?cursors=1` (an agent opting in to being covered by
 * the multi-host `cursors`/"seen" story too — see relayRemoteEventsHost's
 * own doc comment for why that's opt-in). Both call sites want the exact
 * same two things for their own `app`/`socket` pair: send a `cursors` frame
 * — `{type:"cursors", bootId: app.pty.bootId, cursors: app.pty.listCursors()}`
 * — before anything else (in particular, before attachLocalEventsSocket's
 * own replay), and join this `app`'s own seenSubscribers set so a "seen"
 * advance from ANY connection sharing this same `app` broadcasts to every
 * OTHER one. `app` is what scopes this correctly for BOTH call sites without
 * either needing to know about the other: on the primary, `app` is the
 * primary's own FastifyInstance, so this broadcasts to every other browser
 * tab; on an agent, `app` is that agent's own, entirely separate
 * FastifyInstance, so this broadcasts to every other opted-in internal
 * connection on that same agent — never across processes, which is exactly
 * what relayRemoteEventsHost's own upstream relay (not this function) is
 * responsible for instead.
 *
 * Returns the `onSeenAdvanced` callback the caller should pass straight
 * through to attachLocalEventsSocket's own options — pulled out as a return
 * value rather than this function taking a socket-agnostic "just wire
 * everything" shape so each caller stays free to layer its own additional
 * attachLocalEventsSocket options (sessionIdFilter, etc.) alongside it,
 * exactly like attachAggregatedEventsSocket already had to before this was
 * extracted.
 */
export function attachCursorsAndSeenBroadcast(
  app: FastifyInstance,
  socket: SocketLike,
): (sessionId: number, seq: number) => void {
  if (socket.readyState === socket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "cursors",
        bootId: app.pty.bootId,
        cursors: app.pty.listCursors(),
      }),
    );
  }

  const subs = getSeenSubscribers(app);
  subs.add(socket);
  socket.on("close", () => {
    subs.delete(socket);
  });

  return (sessionId, seq) => {
    const payload = JSON.stringify({ type: "seen", sessionId, seq });
    for (const other of subs) {
      if (other === socket) continue; // the sender already applied this locally.
      if (other.readyState !== other.OPEN) continue;
      if (shouldDropForBackpressure(other.bufferedAmount)) continue;
      other.send(payload);
    }
  };
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
