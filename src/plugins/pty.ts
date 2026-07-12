import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { PtyManager } from "../services/pty-manager.js";
import { reconcileExitedSessions } from "../services/session-reconciler.js";

// How often to check every "active" session's systemd scope for a program
// that exited on its own — see session-reconciler.ts. Not latency-critical
// (a session sitting "active" for up to this long after it actually exited
// just means one extra silent-respawn window, the exact pre-existing M2
// gap this closes), so a fairly relaxed interval is fine.
const RECONCILE_INTERVAL_MS = 30_000;

// Decorates app.pty with the session manager (see src/services/pty-manager.ts
// for what it actually does and why). Attach-clients it spawns are only
// killed on process shutdown here — never on browser disconnect, which is
// the whole point of the tool.
export const ptyPlugin = fp(async (app: FastifyInstance) => {
  const manager = new PtyManager({ sessionsDir: app.config.SESSIONS_DIR });

  app.decorate("pty", manager);

  // unref() so this timer alone never keeps the process (or, in tests, a
  // fastify instance that's about to be closed) alive — reconciliation is
  // opportunistic housekeeping, not core request-serving work.
  const reconcileTimer = setInterval(() => {
    reconcileExitedSessions(app).catch((err) => {
      app.log.error({ err }, "session reconciliation failed");
    });
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();

  app.addHook("onClose", () => {
    clearInterval(reconcileTimer);
    manager.killAll();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    pty: PtyManager;
  }
}
