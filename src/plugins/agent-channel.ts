import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { AgentChannelCloseCode } from "../shared/agent-channel.js";

// Issue #2450 — decorates `app.agentChannels` (routes/agent-channel.ts
// populates it). Must be a real fastify-plugin so the decoration is visible
// outside the route's encapsulated context (routes/hosts.ts reads it), same
// reasoning as plugins/agent-bridge.ts. Primary role only.

// The connected-channel type lives in src/shared/agent-channel.ts: two
// SERVICES consume it, and a service importing a plugin inverts the layering
// (issue #2413). Re-exported here so every existing importer keeps its path.
import type { ConnectedAgentChannel } from "../shared/agent-channel.js";
export type { ConnectedAgentChannel };

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
