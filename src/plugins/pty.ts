import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { DEFAULT_SETTINGS, getStoredSettings } from "../services/settings.js";
import { PtyManager } from "../services/pty-manager.js";
import { resolveSshAuthSock } from "../services/ssh-agent-socket.js";
import { reconcileExitedSessions } from "../services/session-reconciler.js";
import { reconcileTasks } from "../services/task-reconciler.js";

const DEFAULT_RECONCILE_INTERVAL_MS = DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds * 1000;
const MIN_RECONCILE_INTERVAL_MS = 1000;

function readReconcileIntervalMs(app: FastifyInstance): number {
  return getStoredSettings(app.db).sessions.reconcileIntervalSeconds * 1000;
}

// Issue #437c — same "read fresh, don't cache" shape as
// readReconcileIntervalMs above, passed to PtyManager as a closure (see its
// own getInjectAgentGuide doc comment) rather than a value computed once
// here, since sessions.injectAgentGuide is toggleable at runtime and this
// closure is called on every new session, not just once at plugin
// registration. Unlike readReconcileIntervalMs (only ever invoked from the
// primary-role settings-patch path), this closure is invoked from inside
// PtyManager.getOrCreate() on every spawn — including the multi-host
// "agent" role, where app.db is genuinely absent (see hooks.ts's own
// `app.db ? ... : DEFAULT_SETTINGS` guard for the same reason). Falling
// back to DEFAULT_SETTINGS there mirrors hooks.ts exactly.
function readInjectAgentGuide(app: FastifyInstance): boolean {
  return app.db
    ? getStoredSettings(app.db).sessions.injectAgentGuide
    : DEFAULT_SETTINGS.sessions.injectAgentGuide;
}

// Mirrors readInjectAgentGuide immediately above, exactly — same closure
// shape, same multi-host "agent" role app.db-absent fallback — for the
// independent sessions.injectProjectBriefing setting.
function readInjectProjectBriefing(app: FastifyInstance): boolean {
  return app.db
    ? getStoredSettings(app.db).sessions.injectProjectBriefing
    : DEFAULT_SETTINGS.sessions.injectProjectBriefing;
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

// Issue #404 — a fixed, non-user-configurable cadence for the dev-server
// detection sweep below, deliberately its OWN timer rather than piggybacked
// onto the reconcile timer's user-configurable reconcileIntervalSeconds
// (5..3600s, see settings.ts's sanitizeSettings): coupling the two would mean
// a large reconcileIntervalSeconds silently starves this feature for
// minutes, and a small one re-`toString("utf8")`s + regex-scans every
// eligible session's up-to-1MiB scrollback (SCROLLBACK_MAX_BYTES,
// scrollback-buffer.ts) far more often than a once-per-startup banner needs. 10s
// is much LESS frequent than the 500ms attention-eval tick (issue #404 asks
// for throttling well below that tick's rate, i.e. a much longer interval
// between scans, not a faster one).
const DEV_SERVER_DETECT_INTERVAL_MS = 10_000;

// Issue #404 — the DB-side half of the plain-session dev-server-detection
// feature: finds every session eligible for a rescan (kind !== "dock" — a
// dock session's own devServerUrl pre-fill is the existing, separate
// GET /api/projects-driven feature in dev-server-detect.ts/routes/
// projects.ts — active, and whose project (a) is on this same local host
// (app.pty, and therefore Session.getScrollback(), only ever tracks a
// session this process itself spawned/attached — see dev-server-detect.ts's
// own scoping comment) and (b) has no devServerUrl set yet. Returns a
// sessionId -> projectId map, exactly the shape PtyManager.
// sweepDevServerDetection expects — see that method's doc comment for why
// Session/PtyManager can't do this DB join themselves.
function findEligibleDevServerSessions(app: FastifyInstance): Map<string, number | null> {
  const rows = app.db
    .select({ id: sessions.id, projectId: sessions.projectId })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(
      and(
        eq(sessions.kind, "terminal"),
        eq(sessions.status, "active"),
        eq(projects.hostId, LOCAL_HOST_ID),
        isNull(projects.devServerUrl),
      ),
    )
    .all();
  return new Map(rows.map((row) => [String(row.id), row.projectId]));
}

function runDevServerDetectionSweep(app: FastifyInstance, manager: PtyManager): void {
  if (getStoredSettings(app.db).dock.autoDetectDevServer !== "ask") return;
  const eligible = findEligibleDevServerSessions(app);
  if (eligible.size === 0) return;
  const detected = manager.sweepDevServerDetection(eligible);
  if (detected.length > 0) {
    app.log.info({ detected }, "detected a dev server in a plain session");
  }
}

// Linux's struct sockaddr_un limits sun_path to 108 bytes. Worktree paths
// (.mullion-worktrees/<branch>/, .wt/<branch>/, or any deep server CWD) can
// push the socket path over this limit. When that happens, redirect the
// entire sessionsDir to a deterministic short path under /tmp/ so Unix
// socket creation always succeeds regardless of project layout.
function ensureSessionsDir(configured: string): string {
  const resolved = path.resolve(configured);
  // Check worst-case socket path: hooks.sock (10 bytes) or a 12-digit
  // session-ID socket (15 bytes + ".sock"). If both fit within 1 byte of
  // the 108-byte sun_path limit, the original path is safe.
  const longestSocket = Math.max(
    Buffer.byteLength(path.join(resolved, "hooks.sock"), "utf8"),
    // Phase 4 (#185) — the control socket (mullion.sock) lives in the same
    // directory; its name is longer than hooks.sock but shorter than the
    // session-id case below, so it can never actually be the max — included
    // explicitly anyway so this stays correct if either name ever changes.
    Buffer.byteLength(path.join(resolved, "mullion.sock"), "utf8"),
    Buffer.byteLength(path.join(resolved, "999999999999.sock"), "utf8"),
  );
  if (longestSocket <= 107) return resolved;

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
  const sessionsDir = ensureSessionsDir(app.config.SESSIONS_DIR);
  if (sessionsDir !== path.resolve(app.config.SESSIONS_DIR)) {
    app.log.info(
      { from: app.config.SESSIONS_DIR, to: sessionsDir },
      "sessionsDir socket path approaches 108-byte sun_path limit, using short fallback",
    );
  }
  // Issue #820 PR5d — see resolveSshAuthSock's own doc comment for the full
  // precedence (configured > ambient > bridge-materialized). Read once here,
  // at boot: PtyManager freezes this into every Session it spawns for the
  // life of this process (see pty-manager.ts's own sshAuthSock field
  // comments), so there is no later point where re-reading it would matter.
  // materializesBridgeSocket mirrors app.ts's own sshAgentPlugin
  // registration condition below (agent-role-only today; a primary-local
  // bridge socket is a later PR) — this can't read app.sshAgentBridgeConnection
  // directly instead, since sshAgentPlugin registers after ptyPlugin.
  const manager = new PtyManager({
    sessionsDir,
    sshAuthSock: resolveSshAuthSock({
      configured: app.config.MULLION_SSH_AUTH_SOCK,
      ambient: process.env.SSH_AUTH_SOCK,
      materializesBridgeSocket: app.config.MULLION_ROLE === "agent",
      sessionsDir,
    }),
    controlSocketPath: app.config.MULLION_SOCKET_PATH || undefined,
    getInjectAgentGuide: () => readInjectAgentGuide(app),
    getInjectProjectBriefing: () => readInjectProjectBriefing(app),
  });

  app.decorate("pty", manager);

  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // Re-entrancy guards (6.4/#217) — both reconcilers now make GitHub round
  // trips (reconcileExitedSessions via its #282 task-failed hook,
  // reconcileTasks via its transition syncs), on top of the liveStatus/
  // isMasterAlive calls they already made, so a slow GitHub makes
  // overlapping ticks meaningfully more likely than before this PR. Same
  // shape as task-watcher.ts's own `running` guard. Each reconciler's own
  // DB writes are already status-guarded against a stacked call actually
  // double-applying (session-reconciler.ts's #282 write is
  // `WHERE status IN ('claimed','in_progress')`, so a losing overlapped
  // call's UPDATE just matches zero rows) — these guards are the
  // network-request-volume backstop on top of that, not the correctness
  // mechanism itself.
  let sessionReconcileRunning = false;
  let taskReconcileRunning = false;

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
      if (!sessionReconcileRunning) {
        sessionReconcileRunning = true;
        reconcileExitedSessions(app)
          .catch((err) => {
            app.log.error({ err }, "session reconciliation failed");
          })
          .finally(() => {
            sessionReconcileRunning = false;
          });
      }
      // Phase 6 Task Master (6.2/#215) — piggybacks on this same primary-
      // role, same-interval timer rather than a dedicated one, matching
      // this codebase's own convention for related periodic housekeeping
      // (see the stale-error/stale-state sweeps just below).
      //
      // Deliberately UNGATED on Task Master's enabled state (independent
      // review, PR #480) — reconcileTasks is a safety-NET for tasks that
      // are ALREADY claimed/in_progress (budget force-fail, claimed ->
      // in_progress -> reviewing progression), not new autonomous work the
      // "enabled" toggle is meant to gate (that's the watcher's auto-claim
      // and this route's own claim endpoint). Gating it on "enabled" used
      // to mean: flip the toggle off while a task is running (now a
      // one-click Settings action, not just a restart-time env edit) and
      // its time budget stops being enforced, it never progresses past
      // claimed/in_progress, and it permanently occupies a concurrency-cap
      // slot — the exact opposite of what a safety toggle should do.
      // `reconcileTasks` itself still checks "enabled" per-pass wherever a
      // pass would do new autonomous work (the → reviewing transition,
      // `retryStrandedDraftPRs`, `processPendingReviewSpawns`'s review-agent
      // spawn) — this outer call is ungated only so the always-safe passes
      // (budget force-fail, status sync) still run while those are skipped.
      if (!taskReconcileRunning) {
        taskReconcileRunning = true;
        reconcileTasks(app)
          .catch((err) => {
            app.log.error({ err }, "task reconciliation failed");
          })
          .finally(() => {
            taskReconcileRunning = false;
          });
      }
      // Rich statuses — local-only (see PtyManager.sweepStaleErrors' doc
      // comment), so this piggybacks on the same primary-role, same-interval
      // timer as the exited-session reconciliation above rather than
      // needing its own.
      //
      // Unlike the two reconcilers above (which are async and already
      // `.catch()`-guarded), these reads/sweeps are synchronous — a bare
      // throw here (e.g. `readStaleErrorMs`'s `app.db` query landing after
      // the DB has closed: onClose hooks fire in reverse registration
      // order, so a normal app.close() always clears this timer before
      // dbPlugin's own onClose runs, but an app whose boot failed after
      // this plugin registered — e.g. a later plugin's register() rejecting
      // — never gets a close() call at all, leaving this same interval
      // armed against a since-recycled db) would otherwise become an
      // uncaught exception straight out of a bare Timeout callback, with no
      // promise chain to catch it. Same defensive wrapping as
      // devServerDetectTimer's own sweep just below — one missed tick is
      // harmless opportunistic housekeeping either way.
      try {
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
      } catch (err) {
        app.log.error({ err }, "stale-state sweep failed");
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
  let devServerDetectTimer: ReturnType<typeof setInterval> | null = null;
  if (app.config.MULLION_ROLE === "primary") {
    armReconcileTimer(readReconcileIntervalMs(app));
    app.decorate("reconfigureReconciler", (intervalSeconds: number) => {
      armReconcileTimer(intervalSeconds * 1000);
    });

    // Issue #404 — same DB-less-"agent"-role reasoning as the reconciler
    // just above: this timer reads app.db (settings + the sessions/projects
    // join in findEligibleDevServerSessions), so it must stay inside this
    // "primary" branch too, not run unconditionally the way PtyManager's own
    // in-memory attentionEvalTimer does.
    devServerDetectTimer = setInterval(() => {
      try {
        runDevServerDetectionSweep(app, manager);
      } catch (err) {
        app.log.error({ err }, "dev-server detection sweep failed");
      }
    }, DEV_SERVER_DETECT_INTERVAL_MS);
    devServerDetectTimer.unref();
  }

  // Dismissed in GHAS as alert #124 (js/missing-rate-limiting) — CodeQL
  // treats any app.addHook(...) callback as a candidate route handler, but
  // "onClose" is a Fastify lifecycle hook that fires once at process
  // shutdown, not a request handler. (See dock-config.ts's isSymlinkPath for
  // why a `codeql[...]` line comment here wouldn't have dismissed this on
  // its own — this repo's codeql.yml has no step that turns a SARIF
  // suppression into an actual Security-tab dismissal.)
  app.addHook("onClose", () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (devServerDetectTimer) clearInterval(devServerDetectTimer);
    manager.killAll();
    if (sessionsDir.startsWith("/tmp/ms-")) {
      try {
        rmSync(sessionsDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

declare module "fastify" {
  interface FastifyInstance {
    pty: PtyManager;
    reconfigureReconciler: (intervalSeconds: number) => void;
  }
}
