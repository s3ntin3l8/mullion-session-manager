import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { controlRelaySocketPath } from "../services/control-relay.js";
import {
  materializeControlRelaySocket,
  type ControlRelayAgentHandle,
} from "../services/control-relay-agent.js";
import type { WebSocket } from "ws";
import { createMuxConnection, type MuxConnection } from "../services/ssh-agent-mux.js";

// Issue #1656 — agent role only. Serves the local `relay.sock` the sessions on
// this host reach the primary's control surface through; the primary's
// `/internal/ws/control-relay` dial-in (routes/internal.ts) fills `holder`.
// Registered before internalRoutes, which reads/writes the decoration.
// Windows agents keep the MULLION_CONTROL_UNAVAILABLE marker (plugins/pty.ts):
// the CLI's named-pipe path has no relay yet.

export interface ControlRelayHolder {
  current: MuxConnection | null;
  /** Set once the socket is up; `relayDown` is what the route calls on a drop. */
  handle: ControlRelayAgentHandle | null;
}

/**
 * Adopts the primary's dial-in as THE relay connection (superseding any
 * earlier one). Relayed clients are told the relay dropped from the raw
 * socket's own "close", registered before the mux's: the mux's teardown closes
 * every channel first, and a channel close ends the local socket (after
 * flushing its own notice, see notifyOnPeerClose), so by the time
 * `mux.onClose` fires there is no one left to tell. Either notice may win a
 * drop; the other sees a socket that is already ending and does nothing.
 */
export function acceptControlRelayConnection(
  app: Pick<FastifyInstance, "controlRelayConnection" | "log">,
  socket: WebSocket,
): void {
  const holder = app.controlRelayConnection;
  // Superseding, not accumulating: a reconnect that lands before the old
  // connection notices it is dead must not leave its channels orphaned.
  holder.current?.close();
  let mux: MuxConnection | null = null;
  socket.on("close", () => {
    if (mux !== null && holder.current === mux) holder.handle?.relayDown("connection closed");
  });
  mux = createMuxConnection(socket, { channelIdParity: "even" });
  holder.current = mux;
  app.log.debug({}, "control-relay: primary<->agent connection established");
  const accepted = mux;
  accepted.onClose((reason) => {
    // A newer connection may already have superseded this one.
    if (holder.current !== accepted) return;
    holder.current = null;
    app.log.debug({ reason }, "control-relay: primary<->agent connection closed");
  });
}

export const controlRelayPlugin = fp(async (app: FastifyInstance) => {
  const holder: ControlRelayHolder = { current: null, handle: null };
  app.decorate("controlRelayConnection", holder);
  if (!app.controlRelayExpected) return;

  const socketPath = controlRelaySocketPath(app.pty.sessionsDir);
  try {
    holder.handle = await materializeControlRelaySocket({
      socketPath,
      resolveToken: (token) => app.pty.resolveToken(token),
      getMux: () => holder.current,
      log: app.log,
    });
  } catch (err) {
    // Optional feature: the agent keeps serving its sessions; they just cannot
    // reach the primary's control surface until this is fixed.
    app.log.error({ err, socketPath }, "failed to serve the control relay socket");
  }
  app.addHook("onClose", async () => {
    await holder.handle?.close();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    /** The `MuxConnection` wrapping the primary's most recent
     * `/internal/ws/control-relay` dial-in, or null while it is not connected. */
    controlRelayConnection: ControlRelayHolder;
  }
}
