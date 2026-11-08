// The primary half of the control relay (issue #1656) — the fanout that
// dials every enrolled agent host, and the fastify plugin that wires it.
//
// It lives in plugins/ rather than services/ because it runs a relayed
// connection through the CONTROL SOCKET's own connection handler
// (plugins/control-socket.ts), and a service importing a plugin inverts the
// layering (routes -> services -> db, plugins above both) — issue #2413's
// whole subject. The deeper fix, splitting the handler out of the
// 3,200-line control-socket.ts, belongs to #2402; moving the fanout up is
// the move that fits here.

import fp from "fastify-plugin";
import type net from "node:net";
import { hasReachablePath, isStreamChannelDown } from "../services/agent-channel-tunnel.js";
import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket } from "ws";
import { handleConnection, relayedSessionDenied } from "./control-socket.js";
import {
  createDuplexPair,
  MAX_RELAY_HEADER_BYTES,
  MAX_RELAYED_CONNECTIONS,
  parseRelayHeader,
  relayErrorFrame,
} from "../services/control-relay.js";
import { listHosts } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import {
  createMuxConnection,
  pipeNetSocketToChannel,
  type MuxChannel,
  type MuxConnection,
} from "../services/ssh-agent-mux.js";
import { noteHostReachable, warnHostThrottled } from "../services/host-warn-throttle.js";

// Issue #1656 — the primary half of the control relay. One
// `/internal/ws/control-relay` connection per enrolled, non-local agent host
// (the primary dials in, as for the SSH-agent bridge: an agent never dials
// out). Each session connection an agent opens arrives as a mux channel whose
// first line names the session; the primary pins a SESSION-scope connection to
// it, never full scope, and runs it through the control socket's own
// connection handler.
//
// Unlike the SSH-agent fan-out this stays connected whether or not anything is
// using it: a session may issue its first op at any moment, and a relay that
// only dials on demand would make that first op wait for a handshake.
//
// Structurally mirrors ssh-agent-fanout.ts (reconnect/backoff, fresh client per
// attempt, connect timeout, periodic failure re-log).

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const FAILURE_RELOG_INTERVAL = 5;
const CONNECT_TIMEOUT_MESSAGE =
  "[control-relay-fanout] connect timed out, terminating and retrying";
const CONNECT_TIMEOUT_MS = 10_000;
/** How long a denied channel may linger before the primary closes it. */
const DENIED_CHANNEL_LINGER_MS = 5_000;
/** An agent that answered the upgrade with 404 predates the relay: probe it
 * again this rarely, so an upgraded agent is picked up without a restart. */
const UNSUPPORTED_RETRY_MS = 10 * 60_000;

interface HostFanout {
  hostId: string;
  stopped: boolean;
  socket: NodeWebSocket | null;
  mux: MuxConnection | null;
  attempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectTimeoutTimer: ReturnType<typeof setTimeout> | null;
  consecutiveFailureCount: number;
  /** Relayed connections currently open on this host. */
  open: number;
  /** The last upgrade was a 404: an agent without the relay. */
  unsupported: boolean;
}

export interface ControlRelayFanoutHandle {
  /** Reconciles open connections against the enrolled hosts; idempotent. */
  reconcile: (opts?: { forceReconnect?: Iterable<string> }) => void;
  stop: () => void;
}

/** Answers a relay channel with an error frame and half-closes it. EOF, not
 * close: a close would make the agent destroy the local socket before the
 * frame is flushed to it; the agent closes the channel once its client is done. */
function deny(channel: MuxChannel, status: number, error: string): void {
  if (!channel.closed) {
    channel.send(relayErrorFrame(status, error));
    channel.eof();
    // The agent closes its end once its client is done; this is the backstop
    // for one that never does, so a denied channel cannot hold its slot.
    setTimeout(() => channel.close(), DENIED_CHANNEL_LINGER_MS).unref();
  }
}

/**
 * Serves one relayed connection: reads the header the AGENT wrote after
 * validating the session's token, checks the session really is active and
 * hosted by `hostId`, then runs the connection through the control socket's
 * own handler. The header is the only place the session is named; nothing
 * later on the channel can re-pin it, and a `token` in a later frame is
 * ignored (the handler never looks for one on a relayed connection).
 */
export function serveRelayChannel(
  app: FastifyInstance,
  hostId: string,
  channel: MuxChannel,
  openSockets: Set<net.Socket>,
  counter: { open: number },
): void {
  if (counter.open >= MAX_RELAYED_CONNECTIONS) {
    deny(channel, 503, "too many relayed connections from this host");
    return;
  }
  let buffer = Buffer.alloc(0);
  // "header": reading the first line. "wait": the pipe is not attached yet;
  // chunks are held. "piped": pipeNetSocketToChannel owns the channel's data.
  let phase: "header" | "wait" | "piped" = "header";
  const held: Buffer[] = [];
  channel.onData((chunk) => {
    if (phase === "piped") return;
    if (phase === "wait") {
      held.push(chunk);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) {
      if (buffer.length > MAX_RELAY_HEADER_BYTES) {
        phase = "wait";
        deny(channel, 400, "relay header too large");
      }
      return;
    }
    phase = "wait";
    const header =
      newline <= MAX_RELAY_HEADER_BYTES
        ? parseRelayHeader(buffer.subarray(0, newline).toString("utf8"))
        : null;
    if (header === null) {
      deny(channel, 400, "malformed relay header");
      return;
    }
    const binding = { hostId, sessionId: header.sessionId };
    const denied = relayedSessionDenied(app, binding);
    if (denied !== null) {
      deny(channel, 403, denied);
      return;
    }
    // Bytes the agent sent after the header belong to the first request.
    const rest = buffer.subarray(newline + 1);
    channel.acknowledgeConsumed(newline + 1);
    const [serverEnd, clientEnd] = createDuplexPair();
    counter.open++;
    serverEnd.once("close", () => {
      counter.open--;
    });
    handleConnection(app, serverEnd as unknown as net.Socket, openSockets, binding);
    if (rest.length > 0) {
      clientEnd.write(rest, () => channel.acknowledgeConsumed(rest.length));
    }
    // Attached on a later tick, not here: a listener added while this chunk is
    // being dispatched would be handed the same chunk, header line included.
    queueMicrotask(() => {
      if (channel.closed) {
        clientEnd.destroy();
        return;
      }
      pipeNetSocketToChannel(clientEnd as unknown as net.Socket, channel);
      phase = "piped";
      for (const chunk of held.splice(0)) {
        clientEnd.write(chunk, () => channel.acknowledgeConsumed(chunk.length));
      }
    });
  });
}

export function startControlRelayFanout(app: FastifyInstance): ControlRelayFanoutHandle {
  const fanouts = new Map<string, HostFanout>();
  const openSockets = new Set<net.Socket>();
  let stopped = false;

  function closeFanout(f: HostFanout): void {
    f.stopped = true;
    if (f.reconnectTimer !== null) clearTimeout(f.reconnectTimer);
    if (f.connectTimeoutTimer !== null) clearTimeout(f.connectTimeoutTimer);
    f.reconnectTimer = null;
    f.connectTimeoutTimer = null;
    f.mux?.close();
    f.mux = null;
    const socket = f.socket;
    f.socket = null;
    if (socket && (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)) {
      socket.close();
    }
  }

  function scheduleReconnect(f: HostFanout): void {
    if (f.stopped || stopped) return;
    const delay = f.unsupported
      ? UNSUPPORTED_RETRY_MS
      : RECONNECT_DELAYS_MS[Math.min(f.attempt, RECONNECT_DELAYS_MS.length - 1)];
    f.attempt++;
    f.reconnectTimer = setTimeout(() => {
      f.reconnectTimer = null;
      connect(f);
    }, delay);
    f.reconnectTimer.unref();
  }

  function connect(f: HostFanout): void {
    if (f.stopped || stopped) return;
    // A bound host whose channel is down can only fail this stream; wait for
    // the channel-up reconcile (routes/agent-channel.ts) rather than retry.
    if (isStreamChannelDown(app, f.hostId)) {
      app.log.debug(
        { hostId: f.hostId },
        "[control-relay-fanout] channel down, waiting for it to come up",
      );
      return;
    }
    let socket: NodeWebSocket;
    try {
      socket = getRemoteHostClient(app, f.hostId).openControlRelayStream();
    } catch (err) {
      app.log.warn(
        { err, hostId: f.hostId },
        "[control-relay-fanout] failed to open the relay stream, will retry",
      );
      scheduleReconnect(f);
      return;
    }
    f.socket = socket;

    f.connectTimeoutTimer = setTimeout(() => {
      warnHostThrottled(app.log, f.hostId, {}, CONNECT_TIMEOUT_MESSAGE);
      socket.terminate();
    }, CONNECT_TIMEOUT_MS);
    f.connectTimeoutTimer.unref();

    socket.on("unexpected-response", (_req, res) => {
      // A 404 is an agent that predates the relay (the route does not exist).
      f.unsupported = res.statusCode === 404;
      if (f.unsupported) {
        app.log.info(
          { hostId: f.hostId },
          "[control-relay-fanout] this agent has no control relay (update it); sessions there keep reporting the control socket unavailable",
        );
      }
      res.resume();
      socket.terminate();
    });

    socket.on("open", () => {
      if (f.connectTimeoutTimer !== null) clearTimeout(f.connectTimeoutTimer);
      noteHostReachable(app.log, f.hostId, CONNECT_TIMEOUT_MESSAGE);
      f.connectTimeoutTimer = null;
      f.attempt = 0;
      f.consecutiveFailureCount = 0;
      f.unsupported = false;
      const mux = createMuxConnection(socket, { channelIdParity: "odd" });
      f.mux = mux;
      mux.onChannel((channel) => {
        if (f.stopped || stopped) {
          channel.close();
          return;
        }
        const counter = {
          get open() {
            return f.open;
          },
          set open(value: number) {
            f.open = value;
          },
        };
        serveRelayChannel(app, f.hostId, channel, openSockets, counter);
      });
    });

    socket.on("error", (err) => {
      f.consecutiveFailureCount++;
      if (
        f.consecutiveFailureCount === 1 ||
        f.consecutiveFailureCount % FAILURE_RELOG_INTERVAL === 0
      ) {
        app.log.warn(
          { err, hostId: f.hostId, consecutiveFailureCount: f.consecutiveFailureCount },
          "[control-relay-fanout] ws error",
        );
      }
    });

    socket.on("close", () => {
      if (f.connectTimeoutTimer !== null) clearTimeout(f.connectTimeoutTimer);
      f.connectTimeoutTimer = null;
      f.socket = null;
      f.mux = null;
      scheduleReconnect(f);
    });
  }

  function reconcile(opts?: { forceReconnect?: Iterable<string> }): void {
    if (stopped) return;
    const desiredIds = new Set(
      listHosts(app)
        .filter((h) => !h.isLocal && hasReachablePath(app, h))
        .map((h) => h.id),
    );
    const forceReconnect = new Set(opts?.forceReconnect ?? []);
    for (const [hostId, f] of fanouts) {
      if (!desiredIds.has(hostId) || forceReconnect.has(hostId)) {
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
        consecutiveFailureCount: 0,
        open: 0,
        unsupported: false,
      };
      fanouts.set(hostId, f);
      connect(f);
    }
  }

  function stop(): void {
    stopped = true;
    for (const f of fanouts.values()) closeFanout(f);
    fanouts.clear();
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
  }

  return { reconcile, stop };
}

// Issue #1656 — primary role. Dials each enrolled agent host's
// `/internal/ws/control-relay` so sessions there can use the control surface.
// Reconciled at the same points as the SSH-agent fan-out (host enrollment
// changes, host-heartbeat recovery) and once at boot.
export const controlRelayFanoutPlugin = fp(async (app: FastifyInstance) => {
  const fanout = startControlRelayFanout(app);

  app.decorate("reconfigureControlRelayFanout", (opts?: { forceReconnect?: string[] }) => {
    fanout.reconcile({ forceReconnect: opts?.forceReconnect });
  });

  app.addHook("onReady", async () => {
    fanout.reconcile();
  });

  app.addHook("onClose", async () => {
    fanout.stop();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    reconfigureControlRelayFanout: (opts?: { forceReconnect?: string[] }) => void;
  }
}
