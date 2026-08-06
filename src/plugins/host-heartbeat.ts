import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startHostHeartbeat } from "../services/host-heartbeat.js";

// Primary-only, same role gate as githubPRPollerPlugin/gitFetcherPlugin —
// an agent has no `hosts` table to sweep (see src/app.ts's agent branch).
export const hostHeartbeatPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  let cleanup: (() => void) | null = null;

  app.addHook("onReady", () => {
    cleanup = startHostHeartbeat(app);
  });

  app.addHook("onClose", () => {
    if (cleanup) cleanup();
  });
});
