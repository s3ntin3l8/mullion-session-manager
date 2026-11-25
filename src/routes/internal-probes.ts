import type { FastifyInstance } from "fastify";
import { localProtocolInfo } from "../shared/agent-protocol.js";
import { getSessionEnvInfo } from "../services/user-shell-env.js";
import { getCachedCapabilities, warmCapabilities } from "../services/host-capabilities.js";

/**
 * The agent's small "what are you" probes. Registered from `internalRoutes` so
 * they sit behind its auth hook and share its rate limit.
 */
export function registerProbeRoutes(app: FastifyInstance, rateLimit: object): void {
  // Issue #2306 — what this host can do beyond agent CLIs (Xcode, an Android
  // emulator). Its own route: /internal/agents answers a bare array.
  // #3511: probe at startup, not on the first request — the Xcode probe takes
  // seconds on a Mac, and a cold cache made the first answer slow or empty.
  app.addHook("onReady", () => {
    warmCapabilities(app);
  });
  app.get("/internal/capabilities", rateLimit, async () => {
    return { capabilities: await getCachedCapabilities(app) };
  });

  // Issue #2248 — the protocol handshake. Answers from the shared registry
  // (src/shared/agent-protocol.ts) the primary also reads, so the two cannot
  // disagree about what exists.
  app.get("/internal/protocol", rateLimit, async () => localProtocolInfo());

  // Issue #3156 — the environment a new session on this host gets, for the
  // Hosts settings page and a failed task's diagnostics. Names and PATH
  // entries only, never a variable's value. Reads the resolver's cached state.
  app.get("/internal/session-env", rateLimit, async () => getSessionEnvInfo());
}
