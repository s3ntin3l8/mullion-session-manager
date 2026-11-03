import type { FastifyInstance } from "fastify";
import { localProtocolInfo } from "../shared/agent-protocol.js";
import { getCachedCapabilities } from "../services/host-capabilities.js";

/**
 * The agent's small "what are you" probes. Registered from `internalRoutes` so
 * they sit behind its auth hook and share its rate limit.
 */
export function registerProbeRoutes(app: FastifyInstance, rateLimit: object): void {
  // Issue #2306 — what this host can do beyond agent CLIs (Xcode, an Android
  // emulator). Its own route: /internal/agents answers a bare array.
  app.get("/internal/capabilities", rateLimit, async () => {
    return { capabilities: await getCachedCapabilities(app) };
  });

  // Issue #2248 — the protocol handshake. Answers from the shared registry
  // (src/shared/agent-protocol.ts) the primary also reads, so the two cannot
  // disagree about what exists.
  app.get("/internal/protocol", rateLimit, async () => localProtocolInfo());
}
