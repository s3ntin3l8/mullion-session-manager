import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { DEFAULT_SETTINGS, getStoredSettings } from "../services/settings.js";
import { syncBundleContent, removeBundleContent } from "../services/bundle-sync.js";

// Mirrors pty.ts's readInjectAgentGuide/readInjectMullionBundle exactly —
// same db-absent-safe closure shape, same multi-host "agent" role fallback
// (no settings DB on an agent host, so DEFAULT_SETTINGS is the only
// sensible answer).
function readInjectMullionBundle(app: FastifyInstance): boolean {
  return app.db
    ? getStoredSettings(app.db).sessions.injectMullionBundle
    : DEFAULT_SETTINGS.sessions.injectMullionBundle;
}

async function runBundleSync(app: FastifyInstance): Promise<void> {
  if (readInjectMullionBundle(app)) {
    const result = syncBundleContent();
    app.log.info({ changed: result.changed }, "bundle-sync: boot sync complete");
  } else {
    removeBundleContent();
  }
}

// Issue #941 — boots the host-local bundle sync ONCE per process start,
// replacing per-session delivery for the CLIs that have gained a global
// install (see bundle-sync.ts's own header comment for the full picture,
// and claude-code.ts's/opencode.ts's isBundleSyncedFor() fallback checks for
// the other half of this).
//
// Registered on BOTH role branches in app.ts (primary AND
// MULLION_ROLE === "agent"): an agent host returns early from buildApp()
// but still registers ptyPlugin (app.ts's own comment on that branch) —
// meaning it spawns sessions and owns a filesystem too. A primary-only
// registration would silently never sync the bundle on a remote agent
// host, which is exactly the host whose Claude Code/opencode sessions need
// the global install to fall back on.
//
// Fire-and-forget onReady, matching task-watcher.ts's own established
// idiom (see that file's own comment for why: awaiting slow filesystem
// work in onReady delays the actual listen() call). The `.catch()` here is
// load-bearing, not decorative — an uncaught throw from onReady would crash
// boot entirely, and syncBundleContent/removeBundleContent do real
// filesystem I/O (permissions, disk-full, a target path that's secretly a
// file — anything is possible on a real host).
//
// Test-isolation guard (distinct from AGENTS.md's three protected
// NODE_ENV=test guards — this is a fourth, new, narrowly-scoped one
// specific to this plugin, flagged here explicitly for review): buildApp()
// runs many times per test worker (see app.ts's own comment on that), and
// this plugin's manifest/install paths are all os.homedir()-based. Without
// this guard, every test run touching buildApp() — which is most of the
// suite — would read and write the real developer's or CI runner's own
// `~/.mullion/bundle-sync.json` and skill/agent directories under
// `~/.claude`, `~/.agents`, `~/.gemini`, `~/.config/opencode`. Skipping
// registration entirely here (rather than gating inside runBundleSync)
// means no onReady hook is even added under test — syncBundleContent/
// removeBundleContent themselves stay fully testable directly, against a
// HOME redirected the same way agy.test.ts/codex.test.ts already do for
// their own os.homedir()-derived paths.
export const bundleSyncPlugin = fp(async (app: FastifyInstance) => {
  if (process.env.NODE_ENV === "test") return;

  app.addHook("onReady", () => {
    void runBundleSync(app).catch((err) => {
      app.log.warn({ err }, "bundle-sync: boot sync threw");
    });
  });
});
