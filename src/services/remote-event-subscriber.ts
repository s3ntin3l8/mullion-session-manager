import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket } from "ws";
import { listHosts } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { getStoredSettings } from "./settings.js";
import type { NotificationEvent } from "./pty-manager.js";

// Issue #213 cross-host capture — the piece that makes session_events
// genuinely "unified" rather than primary-local-only (see event-store.ts's
// and event-history.ts's own doc comments). Maintains one long-lived
// `/internal/ws/events` subscription per enrolled, non-local host
// (RemoteHostClient.openEventsStream(), remote-host-client.ts) and feeds
// every event it receives into the caller-supplied `onEvent` — in practice
// startEventWriter's own `pushEvent` (plugins/event-store.ts wires the
// two together), so a remote host's events are captured the moment they're
// emitted, independent of any browser tab being open — unlike
// relayRemoteEventsHost (routes/events.ts), whose upstreams live and die
// with a browser's own `/ws/events` socket.
//
// Deliberately NOT driven by HostHeartbeatTracker (host-heartbeat.ts): its
// health states are poll-derived, `app.hostHeartbeatTracker` is optional
// and can be `undefined` before its first sweep, and "pending" (not
// "online") is its pre-sweep state for every host — gating subscribe on
// `status === "online"` would subscribe to nothing at boot. A WS
// connection's own open/close/error events are a more direct liveness
// signal for what this module actually needs. `listHosts(app)` is still the
// right enumeration primitive (it's what the heartbeat's own sweep uses
// too, filtered to non-local hosts).

// Mirrors agent-enrollment.ts's REGISTER_RETRY_DELAYS_MS shape — an agent
// host being briefly unreachable (restart, redeploy) must not need any
// external nudge to reconnect. Repeats at the last (30s) delay
// indefinitely.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

// openEventsStream() has no connect timeout of its own (documented gap,
// remote-host-client.ts's openPreviewWs comment notes the same gap for a
// sibling method) — bounded here so a half-open handshake can't stall this
// host's history capture indefinitely.
const CONNECT_TIMEOUT_MS = 10_000;

function isNotificationEvent(value: unknown): value is NotificationEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "number" &&
    typeof v.seq === "number" &&
    typeof v.kind === "string" &&
    typeof v.ts === "number"
  );
}

interface HostSubscription {
  hostId: string;
  stopped: boolean;
  socket: NodeWebSocket | null;
  attempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectTimeoutTimer: ReturnType<typeof setTimeout> | null;
}

export interface RemoteEventSubscriberHandle {
  /**
   * Reconciles open per-host subscriptions against the current `hosts`
   * table and `sessions.eventPersistence` setting: opens one for every
   * newly-enrolled non-local host, closes one for every host that's gone
   * (deleted, or persistence just turned off), and leaves an already-open,
   * still-desired subscription untouched — UNLESS its id is in
   * `forceReconnect`, which tears it down and reopens it immediately even
   * though it's still desired (a rotated token/baseUrl means the open
   * socket is using stale credentials that only a fresh
   * getRemoteHostClient() call would pick up).
   *
   * Idempotent and cheap to call often — from the boot `onReady` hook, from
   * every retention-sweep tick (the hazard-5 fallback, event-store.ts's
   * `onTick`), and explicitly from routes/hosts.ts, routes/enrollment.ts,
   * and routes/settings.ts on any mutation that could change the desired
   * set.
   */
  reconcile: (opts?: { forceReconnect?: Iterable<string> }) => void;
  /** Closes every open/pending subscription and stops all reconnect
   * attempts. Call from the plugin's `onClose` hook. */
  stop: () => void;
}

/**
 * `onEvent` is called for every event received on any open host
 * subscription, tagged with the reporting host's id — the caller
 * (plugins/event-store.ts) is responsible for buffering/persisting it
 * (startEventWriter's `pushEvent`), including the host-ownership check
 * (event-store.ts's `filterHostOwnership`) that verifies the event's
 * `sessionId` actually resolves to a project on `sourceHostId` before it's
 * allowed to persist. This module does not itself touch `app.db` — it is
 * purely the WS connection lifecycle.
 */
export function startRemoteEventSubscriber(
  app: FastifyInstance,
  onEvent: (event: NotificationEvent, sourceHostId: string) => void,
): RemoteEventSubscriberHandle {
  const subscriptions = new Map<string, HostSubscription>();
  let stopped = false;

  function closeSubscription(sub: HostSubscription): void {
    sub.stopped = true;
    if (sub.reconnectTimer !== null) clearTimeout(sub.reconnectTimer);
    if (sub.connectTimeoutTimer !== null) clearTimeout(sub.connectTimeoutTimer);
    sub.reconnectTimer = null;
    sub.connectTimeoutTimer = null;
    const socket = sub.socket;
    sub.socket = null;
    if (socket && (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)) {
      socket.close();
    }
  }

  function scheduleReconnect(sub: HostSubscription): void {
    if (sub.stopped || stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(sub.attempt, RECONNECT_DELAYS_MS.length - 1)];
    sub.attempt++;
    sub.reconnectTimer = setTimeout(() => {
      sub.reconnectTimer = null;
      connect(sub);
    }, delay);
    sub.reconnectTimer.unref();
  }

  // Plain, synchronous function — deliberately not `async`. Every step here
  // (openEventsStream, the socket.on registrations) is synchronous with no
  // await point, so `sub`/`stopped` can't change mid-call; an `async`
  // signature would invite an unreachable "did we get stopped while this
  // was in flight?" re-check that nothing could ever actually trigger.
  function connect(sub: HostSubscription): void {
    if (sub.stopped || stopped) return;

    let socket: NodeWebSocket;
    try {
      // Fetched fresh on EVERY attempt — never cached across reconnects.
      // getRemoteHostClient's own cache self-invalidates against the live
      // `hosts` row (remote-host-client.ts), which is what picks up a
      // rotated session credential after a stale-token failure; holding a
      // client/socket across reconnects would defeat that (hazard 4).
      socket = getRemoteHostClient(app, sub.hostId).openEventsStream();
    } catch (err) {
      // Throws synchronously for a deleted/baseUrl-less host row
      // (host-heartbeat.ts's sweep() and relayRemoteEventsHost both already
      // catch this same way) — not fatal, just retry.
      app.log.warn(
        { err, hostId: sub.hostId },
        "[remote-event-subscriber] failed to open events stream, will retry",
      );
      scheduleReconnect(sub);
      return;
    }
    sub.socket = socket;

    sub.connectTimeoutTimer = setTimeout(() => {
      app.log.warn(
        { hostId: sub.hostId },
        "[remote-event-subscriber] connect timed out, terminating and retrying",
      );
      socket.terminate();
    }, CONNECT_TIMEOUT_MS);
    sub.connectTimeoutTimer.unref();

    socket.on("open", () => {
      if (sub.connectTimeoutTimer !== null) clearTimeout(sub.connectTimeoutTimer);
      sub.connectTimeoutTimer = null;
      sub.attempt = 0; // reset backoff on a successful connect
    });

    // Read-only subscription: this deliberately never calls `socket.send()`
    // anywhere in this module. Sending a "seen" cursor upstream (the way
    // attachLocalEventsSocket's browser-facing counterpart does,
    // routes/events.ts) would silently advance a real user's read cursor on
    // the remote host — asserted directly in
    // test/services/remote-event-subscriber.test.ts.
    socket.on("message", (data, isBinary) => {
      // Symmetry with scheduleReconnect's own guard (Hermes review, PR #564
      // round 4): a frame can arrive in the narrow window between
      // closeSubscription()'s socket.close() and the actual "close" event
      // firing. Without this, a late frame after stop() could still call
      // onEvent -> pushEvent, re-arming the writer's (unref'd, so harmless)
      // flush timers post-shutdown — caught and logged there regardless,
      // but there is no reason to let it through at all once stopped.
      if (sub.stopped || stopped) return;
      if (isBinary) return; // this channel is JSON-only, see events.ts
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        app.log.warn(
          { hostId: sub.hostId },
          "[remote-event-subscriber] dropped malformed events frame",
        );
        return;
      }
      if (!isNotificationEvent(parsed)) return;
      onEvent(parsed, sub.hostId);
    });

    socket.on("error", (err) => {
      app.log.warn({ err, hostId: sub.hostId }, "[remote-event-subscriber] events ws error");
      // "close" always follows "error" for a ws client socket — reconnect
      // is scheduled from the "close" handler below, not duplicated here.
    });

    socket.on("close", () => {
      if (sub.connectTimeoutTimer !== null) clearTimeout(sub.connectTimeoutTimer);
      sub.connectTimeoutTimer = null;
      sub.socket = null;
      scheduleReconnect(sub);
    });
  }

  // Tri-state, not boolean: `null` means "couldn't confirm" (a transient
  // settings-read failure), distinct from a confirmed `false`. reconcile()
  // treats these very differently (Hermes review, PR #564) — a confirmed
  // `false` tears down every subscription (persistence is genuinely off),
  // but `null` must NOT: event-store.ts's flush() can fail closed on one
  // bounded batch with no lasting effect, while doing the same here would
  // close every HEALTHY subscription fleet-wide on one blip, and the next
  // reconcile() may be up to EVENT_RETENTION_SWEEP_INTERVAL_MS (1h) away.
  function readEventPersistence(): boolean | null {
    try {
      return getStoredSettings(app.db).sessions.eventPersistence;
    } catch (err) {
      app.log.error(
        { err },
        "[remote-event-subscriber] failed to read sessions.eventPersistence; leaving existing subscriptions as-is",
      );
      return null;
    }
  }

  function reconcile(opts?: { forceReconnect?: Iterable<string> }): void {
    if (stopped) return;

    const persistence = readEventPersistence();
    if (persistence === false) {
      for (const sub of subscriptions.values()) closeSubscription(sub);
      subscriptions.clear();
      return;
    }

    const desiredIds = new Set(
      listHosts(app)
        // baseUrl is only ever null for "local" today (enrollHost/claimHost
        // always set it atomically, host-registry.ts's own doc comment) —
        // this second filter is the same defensive-for-any-future-row
        // posture host-heartbeat.ts's sweep() already takes (Hermes review,
        // PR #564). Without it, a baseUrl-less non-local row would make
        // getRemoteHostClient throw synchronously on every attempt
        // (remote-host-client.ts), parked in an infinite 30s warn+retry
        // loop that can never succeed.
        .filter((h) => !h.isLocal && h.baseUrl !== null)
        .map((h) => h.id),
    );
    const forceReconnect = new Set(opts?.forceReconnect ?? []);

    // Closing a stale/removed/rotated-credential subscription is always
    // safe regardless of `persistence`'s value — it never persists
    // anything wrong, unlike opening one. Runs even when persistence is
    // `null` (unconfirmed) so a deleted host's subscription doesn't linger
    // forever just because this one read happened to fail.
    for (const [hostId, sub] of subscriptions) {
      if (!desiredIds.has(hostId) || forceReconnect.has(hostId)) {
        closeSubscription(sub);
        subscriptions.delete(hostId);
      }
    }

    // Unconfirmed — never OPEN a subscription (new or force-reconnected) on
    // an unverified "it might be on" guess; the removal pass above already
    // ran, which is the asymmetry this function exists for. A forced host
    // stays closed until a later reconcile() confirms persistence is on
    // again — see this function's own doc comment.
    if (persistence === null) return;

    for (const hostId of desiredIds) {
      if (subscriptions.has(hostId)) continue;
      const sub: HostSubscription = {
        hostId,
        stopped: false,
        socket: null,
        attempt: 0,
        reconnectTimer: null,
        connectTimeoutTimer: null,
      };
      subscriptions.set(hostId, sub);
      connect(sub);
    }
  }

  function stop(): void {
    stopped = true;
    for (const sub of subscriptions.values()) closeSubscription(sub);
    subscriptions.clear();
  }

  return { reconcile, stop };
}
