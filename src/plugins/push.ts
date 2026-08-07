import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { registerPushDelivery } from "../services/push-delivery.js";

// Issue #95 — wires push-delivery.ts's registerPushDelivery into the same
// manager-level fan-out /ws/events and event-store.ts's eventStorePlugin
// both use (app.pty.onEvent, pty-manager.ts). Registered after both
// dbPlugin (needs app.db for settings/subscriptions/VAPID keys) and
// ptyPlugin (needs app.pty.onEvent to subscribe to and app.pty.get to read
// live session state) — see src/app.ts's own ordering comment on
// eventStorePlugin for the identical rationale.
//
// PRIMARY-LOCAL ONLY SCOPE, same caveat as eventStorePlugin: app.pty.onEvent
// only ever sees events from sessions THIS process spawned, so a
// remote-hosted session's events never reach this listener and never
// trigger a push. No-op on the agent role (no app.db there — see
// src/app.ts's role branch).
export const pushPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  const unsubscribe = registerPushDelivery(app);

  app.addHook("onClose", () => {
    unsubscribe();
  });
});
