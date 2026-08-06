import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { NonceStore } from "../services/nonce-store.js";

// Issue #249 / roadmap 7.5 — agent-role-only, same role gate as
// hostHeartbeatPlugin/agentEnrollmentPlugin's own inverse: the primary
// signs outbound requests but never verifies an inbound one, so it has no
// use for a nonce store at all.
const SWEEP_INTERVAL_MS = 60_000;

export const requestNoncePlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "agent") return;

  const store = new NonceStore();
  app.requestNonceStore = store;

  const timer = setInterval(() => store.sweep(), SWEEP_INTERVAL_MS);
  timer.unref();

  app.addHook("onClose", () => {
    clearInterval(timer);
    app.requestNonceStore = undefined;
  });
});

declare module "fastify" {
  interface FastifyInstance {
    // Issue #249 / roadmap 7.5 — replay-protection state for HMAC-signed
    // requests, checked in routes/internal.ts's onRequest hook. undefined
    // on the primary role (this plugin never registers there).
    requestNonceStore?: NonceStore;
  }
}
