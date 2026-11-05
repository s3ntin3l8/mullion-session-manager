import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { WebSocket as NodeWebSocket } from "ws";
import { AgentChannelCloseCode } from "../shared/agent-channel.js";
import type { MuxConnection } from "../services/ssh-agent-mux.js";

// Issue #2450 — decorates `app.agentChannels` (routes/agent-channel.ts
// populates it). Must be a real fastify-plugin so the decoration is visible
// outside the route's encapsulated context (routes/hosts.ts reads it), same
// reasoning as plugins/agent-bridge.ts. Primary role only.

/** A live, authenticated outbound channel from one execution agent. */
export interface ConnectedAgentChannel {
  readonly hostId: string;
  readonly socket: NodeWebSocket;
  readonly mux: MuxConnection;
  readonly connectedAt: number;
  readonly protocolVersion: number;
  readonly negotiatedOperations: readonly string[];
  /** See AgentChannelReadyFrame.carriedOperations. */
  readonly carriedOperations: readonly string[];
  /** Set by `close` when the primary ended the channel because the host's
   * identity was revoked / deleted or its credential expired (#2451), so an
   * in-flight operation can fail as rejected rather than unreachable. */
  terminal: "revoked" | "expired" | null;
  /** Closes the socket with an application code. */
  close(code: number, reason: string): void;
}

export const agentChannelPlugin = fp(async (app: FastifyInstance) => {
  const channels = new Map<string, ConnectedAgentChannel>();
  app.decorate("agentChannels", channels);
  app.addHook("onClose", async () => {
    for (const channel of channels.values())
      channel.close(AgentChannelCloseCode.Shutdown, "primary shutting down");
    channels.clear();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    /** Every connected agent channel, keyed by host id (at most one each). */
    agentChannels: Map<string, ConnectedAgentChannel>;
  }
}
