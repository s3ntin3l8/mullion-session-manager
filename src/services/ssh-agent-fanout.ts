import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket } from "ws";
import { listHosts } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { createMuxConnection, PONG_TIMEOUT_MS, type MuxConnection } from "./ssh-agent-mux.js";
import { pipeFilteredChannelToChannel } from "./ssh-agent-relay.js";

// Issue #820 — the primary-side subscriber that finally CONNECTS the two
// ends PR5a (relay + local socket) and PR5b (agent route + connectedBridges
// mux wrapping) only made CAPABLE. One `/internal/ws/ssh-agent` connection
// per enrolled, non-local agent host, opened only while at least one
// bridge is connected — see connect()'s own guard, which is the load-
// bearing invariant routes/internal.ts's `/internal/ws/ssh-agent` doc
// comment documents from the agent side: dialing for any OTHER reason
// (health check, eager connect) would defeat that route's local socket's
// fail-fast "no bridge reachable" behavior.
//
// Structurally mirrors remote-event-subscriber.ts (reconnect/backoff,
// fresh-client-per-attempt, connect timeout) — see that module's own doc
// comments for the reasoning behind each of those, not repeated here.
// Diverges in one respect: remote-event-subscriber's desired set is a
// plain filter over `listHosts()`; this one is that same filter CROSSED
// with "is any bridge currently connected" (`app.connectedBridges.size >
// 0`), because the `bridges` table has no per-host scoping — any live
// bridge serves every enrolled agent host (see `pickBridge` below) — so
// the desired set collapses to empty the instant the last bridge
// disconnects, not just when a host is removed.

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

// openSshAgentStream() has no connect timeout of its own (same documented
// gap as openEventsStream() — remote-host-client.ts) — bounded here so a
// half-open handshake can't stall this host's fan-out indefinitely.
const CONNECT_TIMEOUT_MS = 10_000;

interface HostFanout {
  hostId: string;
  stopped: boolean;
  socket: NodeWebSocket | null;
  mux: MuxConnection | null;
  attempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectTimeoutTimer: ReturnType<typeof setTimeout> | null;
  hasLoggedFailure: boolean;
}

export interface SshAgentFanoutHandle {
  /**
   * Reconciles open per-host fan-out connections against the current
   * `hosts` table AND `app.connectedBridges`: opens one for every
   * newly-enrolled non-local host once at least one bridge is connected,
   * closes every one the instant the LAST bridge disconnects (even though
   * no host was removed — the desired set depends on bridge state, not
   * just host enrollment), and leaves an already-open, still-desired
   * connection untouched.
   *
   * Idempotent and cheap to call often — from the boot `onReady` hook, and
   * explicitly from routes/agent-bridge.ts (bridge connect/disconnect) and
   * routes/hosts.ts / routes/enrollment.ts (host enrollment mutations),
   * mirroring startRemoteEventSubscriber's own call-site convention.
   */
  reconcile: () => void;
  /** Closes every open/pending fan-out connection and stops all reconnect
   * attempts. Call from the plugin's `onClose` hook. */
  stop: () => void;
}

/**
 * Picks which connected bridge a freshly-opened agent channel should be
 * routed to. The `bridges` table has no `hostId` (bridge-registry.ts) — a
 * bridge isn't scoped to one agent host, so ANY live bridge serves EVERY
 * enrolled agent host.
 *
 * Issue #1051 — selection is now health-aware: a bridge whose underlying
 * WebSocket has gone half-open (laptop sleep, network drop without a
 * clean FIN) reports OPEN until the mux's own PING/PONG timeout fires up
 * to `PONG_TIMEOUT_MS` after the next ping. Without a health check here,
 * pickBridge could choose such a bridge, the `openChannel()` call below
 * would stall against it, and the SSH client on the far end would hang
 * for the same window — defeating the no-bridge-reachable fail-fast path
 * in routes/internal.ts's `/internal/ws/ssh-agent` handler. So we
 * partition the candidates into "healthy" (lastPongAt within
 * `PONG_TIMEOUT_MS` of now) and "stale" (no PONG yet, or last PONG older
 * than the window), prefer any healthy bridge (most-recently-PONG'd
 * within that set, with `connectedAt` as the tiebreaker), and fall back
 * to the most-recently-connected among ALL bridges when no healthy
 * bridge is connected — never return `null` when at least one bridge
 * entry exists, even if every entry is stale.
 *
 * Deliberately pure/stateless — no logging here. The ambiguous-pick log
 * (onChannel below) is throttled per-fanout-instance, which needs state
 * this function has no natural place to hold without becoming a stateful
 * singleton every caller (including this module's own tests) would share.
 */
export function pickBridge(app: FastifyInstance): { bridgeId: string; mux: MuxConnection } | null {
  const healthCutoff = Date.now() - PONG_TIMEOUT_MS;
  let bestHealthy: {
    bridgeId: string;
    connectedAt: number;
    mux: MuxConnection;
    lastPongAt: number;
  } | null = null;
  let bestAny: { bridgeId: string; connectedAt: number; mux: MuxConnection } | null = null;
  for (const [bridgeId, bridge] of app.connectedBridges) {
    // A PONG within the health window makes the bridge demonstrably live;
    // an undefined lastPongAt (just tracked, first PING not yet due) or a
    // PONG older than the window leaves it in the "stale" partition.
    const lastPongAt = bridge.lastPongAt;
    if (bestAny === null || bridge.connectedAt > bestAny.connectedAt) {
      bestAny = { bridgeId, connectedAt: bridge.connectedAt, mux: bridge.mux };
    }
    if (lastPongAt !== undefined && lastPongAt >= healthCutoff) {
      // Within the healthy set, prefer the bridge with the most-recent
      // PONG (the actual liveness signal — "most recently connected" is
      // only meaningful when no bridge has any PONG yet). Tie on
      // lastPongAt falls back to connectedAt for a deterministic choice.
      if (
        bestHealthy === null ||
        lastPongAt > bestHealthy.lastPongAt ||
        (lastPongAt === bestHealthy.lastPongAt && bridge.connectedAt > bestHealthy.connectedAt)
      ) {
        bestHealthy = { bridgeId, connectedAt: bridge.connectedAt, mux: bridge.mux, lastPongAt };
      }
    }
  }
  // Healthy wins; otherwise fall back to the most-recently-connected
  // among ALL bridges (never return null when a bridge entry exists —
  // ssh hangs on SSH_AUTH_SOCK until either this resolves or the
  // connection drops, so a "no good options, give up" outcome is the
  // exact stall we're trying to avoid).
  return bestHealthy ?? bestAny;
}

export function startSshAgentFanout(app: FastifyInstance): SshAgentFanoutHandle {
  const fanouts = new Map<string, HostFanout>();
  let stopped = false;
  // Throttles the "multiple bridges connected" info log to once per
  // ambiguity streak (Hermes review, PR #864) — without this, sustained
  // channel-open traffic (an `ansible --forks=N`-style fan-out, or just a
  // busy `ssh` user) with two paired machines would log on every single
  // channel open. Reset the moment a channel opens while unambiguous
  // again, so a LATER ambiguity streak still logs — same "streak, not
  // call count" shape as remote-event-subscriber.ts's own
  // hasLoggedFailure.
  let hasLoggedBridgeAmbiguity = false;

  function closeFanout(f: HostFanout): void {
    f.stopped = true;
    if (f.reconnectTimer !== null) clearTimeout(f.reconnectTimer);
    if (f.connectTimeoutTimer !== null) clearTimeout(f.connectTimeoutTimer);
    f.reconnectTimer = null;
    f.connectTimeoutTimer = null;
    // MuxConnection.close() closes every open channel on this connection
    // AND the underlying socket — a bare socket.close() would leave any
    // already-paired agent<->bridge channels dangling with no onClose ever
    // firing for their own cleanup (same reasoning as trackBridge's own
    // supersede path, routes/agent-bridge.ts).
    if (f.mux) f.mux.close();
    f.mux = null;
    const socket = f.socket;
    f.socket = null;
    if (socket && (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)) {
      socket.close();
    }
  }

  function scheduleReconnect(f: HostFanout): void {
    if (f.stopped || stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(f.attempt, RECONNECT_DELAYS_MS.length - 1)];
    f.attempt++;
    f.reconnectTimer = setTimeout(() => {
      f.reconnectTimer = null;
      connect(f);
    }, delay);
    f.reconnectTimer.unref();
  }

  // Plain, synchronous function — same reasoning as remote-event-
  // subscriber.ts's own connect(): every step here is synchronous with no
  // await point, so `f`/`stopped` can't change mid-call.
  function connect(f: HostFanout): void {
    if (f.stopped || stopped) return;
    // The load-bearing invariant (see this module's own header comment):
    // only dial when a bridge is ACTUALLY connected right now, checked
    // fresh on every attempt (not just at the reconcile() call that
    // created this HostFanout) — a bridge that disconnects between
    // scheduling a reconnect and this attempt firing must not dial in
    // anyway just because it looked live a few seconds ago.
    if (app.connectedBridges.size === 0) return;

    let socket: NodeWebSocket;
    try {
      // Fetched fresh on EVERY attempt — never cached across reconnects,
      // same hazard-4 reasoning as remote-event-subscriber.ts's own
      // connect(): a rotated agent token only takes effect on a fresh
      // getRemoteHostClient() call.
      socket = getRemoteHostClient(app, f.hostId).openSshAgentStream();
    } catch (err) {
      app.log.warn(
        { err, hostId: f.hostId },
        "[ssh-agent-fanout] failed to open ssh-agent stream, will retry",
      );
      scheduleReconnect(f);
      return;
    }
    f.socket = socket;

    f.connectTimeoutTimer = setTimeout(() => {
      app.log.warn(
        { hostId: f.hostId },
        "[ssh-agent-fanout] connect timed out, terminating and retrying",
      );
      socket.terminate();
    }, CONNECT_TIMEOUT_MS);
    f.connectTimeoutTimer.unref();

    socket.on("open", () => {
      if (f.connectTimeoutTimer !== null) clearTimeout(f.connectTimeoutTimer);
      f.connectTimeoutTimer = null;
      f.attempt = 0; // reset backoff on a successful connect
      f.hasLoggedFailure = false;

      // Primary dials OUT here — "odd" to match the agent's own "even" pin
      // (routes/internal.ts's `/internal/ws/ssh-agent` handler, PR5b). A
      // mismatch would be a silent misroute, not an error — see that
      // route's own comment on why the two connections' parity pairings
      // are independent (this one vs. /ws/agent-bridge's).
      const mux = createMuxConnection(socket, { channelIdParity: "odd" });
      f.mux = mux;

      // Fired once per agent-accepted local SSH client connection
      // (ssh-agent-socket.ts, PR5a) — pair it with a fresh channel toward
      // whichever bridge is currently live.
      mux.onChannel((agentChannel) => {
        // Same defensive posture as remote-event-subscriber.ts's own
        // message handler (Hermes review, PR #564 round 4): a channel-open
        // can in principle arrive in the narrow window between this
        // HostFanout (or the whole subscriber) being torn down and this
        // listener actually being removed — `f.mux.close()` closing the
        // underlying connection normally prevents further onChannel firing
        // on its own, but this guard doesn't rely on that being airtight.
        if (f.stopped || stopped) {
          agentChannel.close();
          return;
        }
        const bridge = pickBridge(app);
        if (bridge === null) {
          // Raced with the last bridge disconnecting between the agent's
          // Open frame arriving and this handler running — the agent
          // channel is already open (OpenAck already sent, MuxConnection's
          // own doc), so it must be closed immediately rather than left
          // dangling: the SSH client on the far end blocks on its agent
          // socket until this resolves one way or the other.
          agentChannel.close();
          return;
        }
        if (app.connectedBridges.size > 1) {
          if (!hasLoggedBridgeAmbiguity) {
            app.log.info(
              { bridgeId: bridge.bridgeId, connectedBridgeCount: app.connectedBridges.size },
              "[ssh-agent-fanout] multiple bridges connected, routing to the most recently connected",
            );
            hasLoggedBridgeAmbiguity = true;
          }
        } else {
          hasLoggedBridgeAmbiguity = false;
        }
        bridge.mux
          .openChannel()
          .then((bridgeChannel) => {
            // Re-checked after the await: stopped (or the agent channel
            // itself closed) while this was pending is a real possibility
            // for the same reason the guard above exists — piping a
            // freshly-opened bridge channel into an already-dead pairing
            // would just leak it.
            if (f.stopped || stopped || agentChannel.closed) {
              bridgeChannel.close();
              agentChannel.close();
              return;
            }
            pipeFilteredChannelToChannel(agentChannel, bridgeChannel);
          })
          .catch((err: unknown) => {
            // The bridge's own connection cap, or it died mid-open — same
            // "must not leave the agent channel dangling" reasoning as the
            // no-bridge-connected case above.
            app.log.warn(
              { err, hostId: f.hostId, bridgeId: bridge.bridgeId },
              "[ssh-agent-fanout] failed to open a matching bridge channel",
            );
            agentChannel.close();
          });
      });
    });

    socket.on("error", (err) => {
      if (!f.hasLoggedFailure) {
        app.log.warn({ err, hostId: f.hostId }, "[ssh-agent-fanout] ws error");
        f.hasLoggedFailure = true;
      }
      // "close" always follows "error" for a ws client socket — reconnect
      // is scheduled from the "close" handler below, not duplicated here.
    });

    socket.on("close", () => {
      if (f.connectTimeoutTimer !== null) clearTimeout(f.connectTimeoutTimer);
      f.connectTimeoutTimer = null;
      f.socket = null;
      // The connection's own teardown already cascaded a closeLocally()
      // to every channel opened on it (ssh-agent-mux.ts) — no channel
      // bookkeeping to clear here, and a fresh connect() below builds an
      // entirely new MuxConnection, so nothing from this one can be
      // resurrected.
      f.mux = null;
      scheduleReconnect(f);
    });
  }

  function reconcile(): void {
    if (stopped) return;

    const desiredIds =
      app.connectedBridges.size > 0
        ? new Set(
            listHosts(app)
              .filter((h) => !h.isLocal && h.baseUrl !== null)
              .map((h) => h.id),
          )
        : new Set<string>();

    for (const [hostId, f] of fanouts) {
      if (!desiredIds.has(hostId)) {
        closeFanout(f);
        fanouts.delete(hostId);
      }
    }

    for (const hostId of desiredIds) {
      if (fanouts.has(hostId)) continue;
      const f: HostFanout = {
        hostId,
        stopped: false,
        socket: null,
        mux: null,
        attempt: 0,
        reconnectTimer: null,
        connectTimeoutTimer: null,
        hasLoggedFailure: false,
      };
      fanouts.set(hostId, f);
      connect(f);
    }
  }

  function stop(): void {
    stopped = true;
    for (const f of fanouts.values()) closeFanout(f);
    fanouts.clear();
  }

  return { reconcile, stop };
}
