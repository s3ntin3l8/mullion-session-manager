import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startWebhookReconciler } from "../services/webhook-reconciler.js";

export const webhookReconcilerPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  let cleanup: (() => void) | null = null;

  app.addHook("onReady", () => {
    cleanup = startWebhookReconciler(app);
  });

  app.addHook("onClose", () => {
    if (cleanup) cleanup();
  });
});
