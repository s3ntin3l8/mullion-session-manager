import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startSshAgentFanout } from "../services/ssh-agent-fanout.js";

// Issue #820 — thin Fastify wiring around ssh-agent-fanout.ts's plain,
// directly-testable connection-lifecycle logic, mirroring
// plugins/event-store.ts's own split from remote-event-subscriber.ts.
// Primary-only (registered in src/app.ts's primary branch, between
// agentBridgePlugin and agentBridgeRoute — needs app.connectedBridges to
// exist, and agentBridgeRoute needs the decoration this plugin provides).
export const sshAgentFanoutPlugin = fp(async (app: FastifyInstance) => {
  const fanout = startSshAgentFanout(app);

  // Issue #820 — the seam routes/agent-bridge.ts (bridge connect/
  // disconnect) and routes/hosts.ts / routes/enrollment.ts (host
  // enrollment mutations) call on any change that could affect the
  // desired fan-out set, mirroring app.reconfigureRemoteEventSubscriptions'
  // own convention (plugins/event-store.ts).
  app.decorate("reconfigureSshAgentFanout", () => {
    fanout.reconcile();
  });

  // Boot-time reconcile: a server that starts with a bridge already
  // enrolled (a restart, not a fresh pairing) shouldn't wait for the next
  // bridge connect/host mutation to pick it up. In practice this reconciles
  // to an empty desired set at this point (no bridge has connected yet,
  // since routes/agent-bridge.ts's own handshake is what populates
  // connectedBridges) — harmless, and correct: there is nothing to fan out
  // to until a bridge actually dials in and its own reconfigureSshAgentFanout()
  // call takes it from there.
  app.addHook("onReady", async () => {
    fanout.reconcile();
  });

  app.addHook("onClose", async () => {
    fanout.stop();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    reconfigureSshAgentFanout: () => void;
  }
}
