import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { controlRelaySocketPath } from "../services/control-relay.js";
import {
  materializeControlRelaySocket,
  type ControlRelayAgentHandle,
} from "../services/control-relay-agent.js";
import type { MuxConnection } from "../services/ssh-agent-mux.js";

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

export const controlRelayPlugin = fp(async (app: FastifyInstance) => {
  const holder: ControlRelayHolder = { current: null, handle: null };
  app.decorate("controlRelayConnection", holder);
  if (!app.controlRelayExpected) return;

  holder.handle = await materializeControlRelaySocket({
    socketPath: controlRelaySocketPath(app.pty.sessionsDir),
    resolveToken: (token) => app.pty.resolveToken(token),
    getMux: () => holder.current,
    log: app.log,
  });
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
