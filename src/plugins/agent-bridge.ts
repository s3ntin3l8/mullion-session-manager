import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket } from "ws";
import type { MuxConnection } from "../services/ssh-agent-mux.js";

// Issue #820 — decorates `app.connectedBridges` (routes/agent-bridge.ts
// populates and reads it). A plain routes/ file's own `app.decorate()`
// call stays scoped to that file's own encapsulated registration context
// (Fastify/avvio's default) — this has to be a real plugin, wrapped in
// fastify-plugin, so the decoration is visible on the ROOT instance every
// other module (and the test suite) holds a reference to. See
// src/routes/internal.ts's own comment on the opposite, deliberate choice
// (staying scoped) for why "plain routes/ file" is the default to reach
// for, not this — this decoration specifically needs to be visible
// outside routes/agent-bridge.ts's own context, which is what makes it the
// exception. Registered before agentBridgeRoute in src/app.ts.
export const agentBridgePlugin = fp(async (app: FastifyInstance) => {
  app.decorate("connectedBridges", new Map<string, ConnectedBridge>());
});

/** A live, authenticated bridge connection — both the raw socket (identity
 * for the close-tracking dance in routes/agent-bridge.ts's `trackBridge`)
 * and the `MuxConnection` wrapping it (what a later PR's fan-out logic
 * actually calls `.openChannel()` on to pair an agent-side SSH-client
 * channel with one toward this bridge). Two fields, not just the
 * `MuxConnection` alone, because `trackBridge`'s own superseded-socket
 * check needs the raw socket identity — `MuxConnection` has no identity
 * of its own to compare against the `NodeWebSocket` a "close" listener
 * fires on. */
export interface ConnectedBridge {
  readonly socket: NodeWebSocket;
  readonly mux: MuxConnection;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Every currently-connected, authenticated bridge — keyed by
     * bridgeId. Populated by routes/agent-bridge.ts on a successful
     * handshake; entries are removed on socket close. Consumed by a later
     * PR's fan-out logic; nothing reads `.mux` yet besides this PR's own
     * tests. */
    connectedBridges: Map<string, ConnectedBridge>;
  }
}
