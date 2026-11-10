// The local events core: replay-then-stream this process's own session
// notification events onto a socket, and the cross-connection "cursors"/
// "seen" broadcast.
//
// They live in a service because the
// agent-side `/internal/ws/events` path lives in a service too
// (services/internal-streams.ts) and needs the same core — a service
// importing a route inverts the layering (issue #2413's subject).
//
// Phase 1's notification-event channel (issue #166): a single, JSON-only WS
// stream that replays every tracked session's buffered events on connect and
// then pushes new ones live — the push counterpart to the existing 4s
// GET /api/sessions poll (still unchanged; see pty-manager.ts's own
// "additive" framing). Unlike /ws/terminal (one socket per session),
// /ws/events is one aggregated socket per browser tab covering every
// session, local and remote-hosted alike.

import type { FastifyInstance } from "fastify";
import type { NotificationEvent } from "./pty-manager.js";
import type { SocketLike } from "./socket-channel.js";
import { querySessionEvents } from "./event-history.js";

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
export const REPLAY_MAX_EVENTS = 500;
/** Persisted events replayed per remote session when a relayed stream opens (#2125). */
const REMOTE_REPLAY_PER_SESSION = 100;

interface SeenMessage {
  type: "seen";
  sessionId: number;
  seq: number;
}

export function isSeenMessage(value: unknown): value is SeenMessage {
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

export function isCursorsUpstreamFrame(value: unknown): value is CursorsUpstreamFrame {
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
   * Predicate variant of `sessionIdFilter`, for a connection that may see
   * more than one session (a session-scoped `events.subscribe` that opted
   * into its own children). Applied in the same three places. When both are
   * given, an event must satisfy both.
   */
  sessionFilter?: (sessionId: number) => boolean;
  /**
   * Overrides the predicate an incoming "seen" message must satisfy (default:
   * the same filters as the event stream). A connection that may RECEIVE a
   * child's events still must not WRITE the child's read cursor, so the
   * includeChildren subscribe pins this to its own id.
   */
  seenFilter?: (sessionId: number) => boolean;
  /**
   * Issue #2125 — also deliver events that REMOTE hosts report for sessions that
   * pass the filter (the primary's `remoteEventBus`), live and, for the sessions
   * named in `remoteReplayIds`, as a replay of what was persisted. Off for the
   * browser aggregate, which reaches remote hosts through its own upstream relays
   * and would otherwise see every remote event twice.
   */
  includeRemote?: boolean;
  /** Session ids whose persisted events (from the DB) seed the replay when
   * `includeRemote` is set; sessions outside this list start live-only. */
  remoteReplayIds?: number[];
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
    (opts?.sessionIdFilter === undefined || String(sessionId) === opts.sessionIdFilter) &&
    (opts?.sessionFilter === undefined || opts.sessionFilter(sessionId));

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
  // Same subscribe-before-snapshot order as above, for the remote hosts' feed.
  const unsubscribeRemote = opts?.includeRemote
    ? app.remoteEventBus?.subscribe((event) => {
        if (!matchesFilter(event.sessionId)) return;
        if (!replaySent) buffered.push(event);
        sendEvent(socket, event);
      })
    : undefined;

  const seen = new Set<string>();
  const persisted =
    opts?.includeRemote && app.db
      ? (opts.remoteReplayIds ?? []).flatMap((sessionId) =>
          querySessionEvents(app.db, { sessionId, limit: REMOTE_REPLAY_PER_SESSION }).events.map(
            (row): NotificationEvent => ({
              sessionId,
              seq: row.seq,
              kind: row.kind as NotificationEvent["kind"],
              ts: row.ts,
              payload: row.payload ?? {},
            }),
          ),
        )
      : [];
  const replay = [...app.pty.listEvents(), ...persisted, ...buffered]
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
    if (
      isSeenMessage(parsed) &&
      (opts?.seenFilter ? opts.seenFilter(parsed.sessionId) : matchesFilter(parsed.sessionId))
    ) {
      const advanced = app.pty.markEventsSeen(String(parsed.sessionId), parsed.seq);
      if (advanced) opts?.onSeenAdvanced?.(parsed.sessionId, parsed.seq);
    }
  });

  socket.on("close", () => {
    unsubscribe();
    unsubscribeRemote?.();
  });
}

// Issue #1459 — the two frame-type prefixes relayRemoteEventsHost's own
// message handler (below) checks for before paying for a JSON.parse. Both
// are built by JSON.stringify()ing an object literal with `type` as its
// first key (attachCursorsAndSeenBroadcast's `cursors` send, and this same
// file's "seen" broadcast payload) — a plain NotificationEvent never starts
// this way (its own field order is `{seq, sessionId, kind, ts, payload}`,
// see pty-manager.ts), so this prefix check can never false-positive on the
// hot path's actual majority case (ordinary event frames).
//
// Hermes review, PR #1493 — kept as `Buffer`s, compared directly against
// the raw frame via `.subarray(...).equals(...)`, rather than the string
// prefixes this started as: `data.toString("utf8")` on every single
// incoming frame just to run `startsWith` on ~16 bytes would allocate a
// full UTF-8 string of EVERY plain event frame too (the hot path's actual
// majority case) — a real per-frame cost pre-#1459 never had. `.equals()`
// does a byte-for-byte compare with no allocation; `data.toString("utf8")`
// (and the subsequent `JSON.parse`) now only run for the rare frame that
// already matched one of these two prefixes.
export const CURSORS_FRAME_PREFIX = Buffer.from('{"type":"cursors"');
export const SEEN_FRAME_PREFIX = Buffer.from('{"type":"seen"');

// `data` here is `ws`'s own `RawData` (`Buffer | ArrayBuffer | Buffer[]`) —
// narrowed with `Buffer.isBuffer` rather than typed as `Buffer` outright,
// since this channel's payload is a Buffer in practice (see the isBinary
// comment above) but the type itself doesn't guarantee it. Anything else
// (a fragmented/streamed frame arriving as `ArrayBuffer`/`Buffer[]`, which
// shouldn't happen for this JSON-only channel) simply doesn't match either
// prefix and falls through to the unparsed forward path below.
export function startsWithPrefix(data: Buffer | ArrayBuffer | Buffer[], prefix: Buffer): boolean {
  return (
    Buffer.isBuffer(data) &&
    data.length >= prefix.length &&
    data.subarray(0, prefix.length).equals(prefix)
  );
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
