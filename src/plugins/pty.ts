import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
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

// Rich statuses — the errorState TTL backstop reads its own threshold fresh
// on every tick (not just once at arm-time), same "PATCH /api/settings takes
// effect immediately" posture the reconcile interval itself has, at
// negligible cost since this is a settings-table read already happening
// every tick for the interval above.
function readStaleErrorMs(app: FastifyInstance): number {
  return getStoredSettings(app.db).sessions.staleErrorSeconds * 1000;
}

// Issue #320 follow-up — busy latches (compactState/subagentCount) get their
// own, longer-default TTL distinct from staleErrorMs (see AppSettings.sessions.
// staleBusySeconds' own doc comment for why).
function readStaleBusyMs(app: FastifyInstance): number {
  return getStoredSettings(app.db).sessions.staleBusySeconds * 1000;
}

// Linux's struct sockaddr_un limits sun_path to 108 bytes. Worktree paths
// (.mullion-worktrees/<branch>/, .wt/<branch>/, or any deep server CWD) can
// push the socket path over this limit. When that happens, redirect the
// entire sessionsDir to a deterministic short path under /tmp/ so Unix
// socket creation always succeeds regardless of project layout.
function resolveSessionsDir(configured: string): string {
  const resolved = path.resolve(configured);
  const testPath = path.join(resolved, "hooks.sock");
  if (Buffer.byteLength(testPath, "utf8") <= 100) return resolved;

  const hash = createHash("md5").update(resolved).digest("hex").slice(0, 8);
  const fallback = `/tmp/ms-${hash}`;
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

// Decorates app.pty with the session manager (see src/services/pty-manager.ts
// for what it actually does and why). Attach-clients it spawns are only
// killed on process shutdown here — never on browser disconnect, which is
// the whole point of the tool.
export const ptyPlugin = fp(async (app: FastifyInstance) => {
  const sessionsDir = resolveSessionsDir(app.config.SESSIONS_DIR);
  if (sessionsDir !== path.resolve(app.config.SESSIONS_DIR)) {
    app.log.info(
      { from: app.config.SESSIONS_DIR, to: sessionsDir },
      "sessionsDir socket path exceeds 100 bytes, using short fallback",
    );
  }
  const manager = new PtyManager({
    sessionsDir,
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
      // Rich statuses — local-only (see PtyManager.sweepStaleErrors' doc
      // comment), so this piggybacks on the same primary-role, same-interval
      // timer as the exited-session reconciliation above rather than
      // needing its own.
      const staleErrorMs = readStaleErrorMs(app);
      const clearedErrors = manager.sweepStaleErrors(staleErrorMs);
      if (clearedErrors.length > 0) {
        app.log.info({ sessionIds: clearedErrors }, "cleared stale errorState past its TTL");
      }
      // Issue #320 — the general blocked/busy-state staleness sweep: blocked
      // latches (permission/plan/gate/promote/elicitation) use staleErrorMs,
      // busy latches (compact/subagent) use their own, longer staleBusyMs —
      // see readStaleBusyMs's doc comment for why they need different TTLs.
      const staleBusyMs = readStaleBusyMs(app);
      const clearedBlocked = manager.sweepStaleStates(staleErrorMs, staleBusyMs);
      if (clearedBlocked.length > 0) {
        app.log.info(
          { sessionIds: clearedBlocked },
          "cleared stale blocked/busy states past their TTL",
        );
      }
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
