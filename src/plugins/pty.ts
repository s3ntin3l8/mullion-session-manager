import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { DEFAULT_SETTINGS, getStoredSettings } from "../services/settings.js";
import { PtyManager } from "../services/pty-manager.js";
import { reconcileExitedSessions } from "../services/session-reconciler.js";

const DEFAULT_RECONCILE_INTERVAL_MS = DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds * 1000;
const MIN_RECONCILE_INTERVAL_MS = 1000;

function readReconcileIntervalMs(app: FastifyInstance): number {
  return getStoredSettings(app.db).sessions.reconcileIntervalSeconds * 1000;
}

// Decorates app.pty with the session manager (see src/services/pty-manager.ts
// for what it actually does and why). Attach-clients it spawns are only
// killed on process shutdown here — never on browser disconnect, which is
// the whole point of the tool.
export const ptyPlugin = fp(async (app: FastifyInstance) => {
  const manager = new PtyManager({
    sessionsDir: app.config.SESSIONS_DIR,
    reviewGateEnabled: app.config.MULLION_REVIEW_GATE_ENABLED,
  });

  app.decorate("pty", manager);

  let reconcileTimer: ReturnType<typeof setInterval> | null = null;

  // Re-armable: PATCH /api/settings calls this after a write that changes
  // sessions.reconcileIntervalSeconds, so the new interval takes effect
  // immediately rather than only after a process restart.
  function armReconcileTimer(intervalMs: number) {
    if (reconcileTimer) clearInterval(reconcileTimer);
    // Defense-in-depth floor: services/settings.ts's sanitizeSettings
    // already keeps a persisted reconcileIntervalSeconds sane, but a
    // non-finite or sub-second value here would otherwise reach
    // setInterval directly — 0/NaN coerces to a ~1ms busy-loop.
    const safeIntervalMs =
      Number.isFinite(intervalMs) && intervalMs >= MIN_RECONCILE_INTERVAL_MS
        ? intervalMs
        : DEFAULT_RECONCILE_INTERVAL_MS;
    // unref() so this timer alone never keeps the process (or, in tests, a
    // fastify instance that's about to be closed) alive — reconciliation is
    // opportunistic housekeeping, not core request-serving work.
    reconcileTimer = setInterval(() => {
      reconcileExitedSessions(app).catch((err) => {
        app.log.error({ err }, "session reconciliation failed");
      });
    }, safeIntervalMs);
    reconcileTimer.unref();
  }

  // Reconciliation reads DB intent (readReconcileIntervalMs -> getStoredSettings
  // -> app.db) and writes DB status — both meaningless on a DB-less "agent"
  // process (issue #26), which registers this plugin before dbPlugin is ever
  // registered (see src/app.ts's role branch, which skips dbPlugin for agent
  // entirely). An agent still gets app.pty for local session spawn/attach;
  // it just isn't the one deciding "exited" for anything.
  if (app.config.MULLION_ROLE === "primary") {
    armReconcileTimer(readReconcileIntervalMs(app));
    app.decorate("reconfigureReconciler", (intervalSeconds: number) => {
      armReconcileTimer(intervalSeconds * 1000);
    });
  }

  app.addHook("onClose", () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    manager.killAll();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    pty: PtyManager;
    reconfigureReconciler: (intervalSeconds: number) => void;
  }
}
