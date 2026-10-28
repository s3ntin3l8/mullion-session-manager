import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startControlRelayFanout } from "../services/control-relay-fanout.js";

// Issue #1656 — primary role. Dials each enrolled agent host's
// `/internal/ws/control-relay` so sessions there can use the control surface.
// Reconciled at the same points as the SSH-agent fan-out (host enrollment
// changes, host-heartbeat recovery) and once at boot.
export const controlRelayFanoutPlugin = fp(async (app: FastifyInstance) => {
  const fanout = startControlRelayFanout(app);

  app.decorate("reconfigureControlRelayFanout", (opts?: { forceReconnect?: string[] }) => {
    fanout.reconcile({ forceReconnect: opts?.forceReconnect });
  });

  app.addHook("onReady", async () => {
    fanout.reconcile();
  });

  app.addHook("onClose", async () => {
    fanout.stop();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    reconfigureControlRelayFanout: (opts?: { forceReconnect?: string[] }) => void;
  }
}
