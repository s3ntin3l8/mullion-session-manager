import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { BrowserManager } from "../services/browser-manager.js";
import { loadStoredCookiesForProject } from "../services/browser-cookies.js";
import { resolveBrowserMaxInstances } from "../services/runtime-config.js";
import { DEFAULT_SETTINGS, getStoredSettings } from "../services/settings.js";

// Cheap, idempotent housekeeping — see BrowserManager.healthCheck's own
// comment on why this evicts rather than proactively relaunches.
const HEALTH_CHECK_INTERVAL_MS = 30_000;

// Decorates app.browser with the Playwright browser-pool manager (Phase 3,
// issue #179 — see src/services/browser-manager.ts for what it actually
// does). Modeled on src/plugins/pty.ts: a single long-lived manager
// instance, an unref()'d timer for background housekeeping, and teardown on
// onClose. Registers regardless of BROWSER_ENABLED — the manager itself
// stays inert (every method throws) when the flag is off, so callers (the
// 3.2 WS route, 3.5 automation API) get a clear, consistent error rather
// than a missing decorator.
export const browserPlugin = fp(async (app: FastifyInstance) => {
  const dataDir = app.config.BROWSER_DATA_DIR;
  // Pool size is fixed at boot: a Settings override (read here, after
  // dbPlugin) only applies after a restart. Agent hosts have no settings DB
  // and use the env value.
  const maxInstances = resolveBrowserMaxInstances(
    app.db ? getStoredSettings(app.db) : DEFAULT_SETTINGS,
    app,
  );
  app.decorate("bootBrowserMaxInstances", maxInstances);
  const manager = new BrowserManager({
    enabled: app.config.BROWSER_ENABLED,
    maxInstances,
    dataDir: path.isAbsolute(dataDir) ? dataDir : path.resolve(dataDir),
    loadCookies: app.db ? (projectId) => loadStoredCookiesForProject(app, projectId) : undefined,
    onCookieLoadError: (projectId, err) => {
      app.log.warn({ err, projectId }, "failed to apply stored browser cookies on launch");
    },
    // Issue #381 (3.10) — mirrors onCookieLoadError just above: BrowserManager
    // itself stays DB/logger-agnostic, so a real failure is surfaced here
    // rather than thrown from inside its own page.on("download") event
    // handler. Two distinct failure modes share this one callback (saving a
    // freshly completed download, and deleting an evicted one's file once
    // it ages out of the 50-entry buffer) — the log label says "download
    // handling" rather than naming just one of them (Hermes review, PR #434).
    onDownloadError: (projectId, err) => {
      app.log.warn(
        { err, projectId },
        "browser download handling failed (save or eviction cleanup)",
      );
    },
  });

  app.decorate("browser", manager);

  let healthTimer: ReturnType<typeof setInterval> | null = null;
  if (app.config.BROWSER_ENABLED) {
    healthTimer = setInterval(() => {
      manager.healthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
    // unref() so this timer alone never keeps the process (or, in tests, a
    // fastify instance that's about to be closed) alive.
    healthTimer.unref();
  }

  app.addHook("onClose", async () => {
    if (healthTimer) clearInterval(healthTimer);
    await manager.closeAll();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    browser: BrowserManager;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** Pool size this process booted with (env default or Settings override). */
    bootBrowserMaxInstances: number;
  }
}
