import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { getStoredSettings } from "../services/settings.js";
import { runBundleSyncExclusive } from "../services/bundle-sync.js";
import { readAgentBundleDisabled } from "../services/agent-bundle-state.js";

// Issue #1089 — used to mirror pty.ts's readInjectAgentGuide/
// readInjectMullionBundle exactly (same db-absent-safe closure shape,
// same multi-host "agent" role fallback to DEFAULT_SETTINGS). That
// fallback was wrong HERE specifically: DEFAULT_SETTINGS.sessions.
// injectMullionBundle is unconditionally `true`, so an agent host had no
// way to remember "stay uninstalled" across a restart — the very next
// boot-time sync (this plugin's own onReady, below) would silently
// reinstall everything /api/bundle-sync/remove's fan-out had just removed.
// An agent host now consults its own persisted flag (agent-bundle-state.ts)
// instead — see that module's own header comment for the file it reads and
// why it's a SEPARATE file from bundle-sync.ts's own manifest. pty.ts's
// identically-shaped closure (feeding a per-session spawn-time default, not
// this boot-time sync) gets the SAME fix, for a related but distinct
// reason: it was originally assumed to be a version-skew-only backstop
// since session-lifecycle.ts sends an explicit resolved value on every
// ordinary spawn — but a dtach-master-died respawn (routes/terminal.ts's
// attachSocketToSession, reached via the primary's own /ws/terminal or the
// agent's /internal/ws/attach) never sets opts.injectMullionBundle, making
// that closure a real, live path too. See pty.ts's own comment on
// readInjectMullionBundle for the fuller writeup.
function readInjectMullionBundle(app: FastifyInstance): boolean {
  return app.db
    ? getStoredSettings(app.db).sessions.injectMullionBundle
    : !readAgentBundleDisabled();
}

// Issue #944 — dispatch itself now lives in bundle-sync.ts's own
// runBundleSyncExclusive (sync-vs-remove, single-source, serialized against
// the new HTTP re-sync/remove routes) rather than being duplicated here;
// this function is just the "what's the current setting, and log the
// result" wrapper around it.
async function runBundleSync(app: FastifyInstance): Promise<void> {
  const enabled = readInjectMullionBundle(app);
  const result = await runBundleSyncExclusive(enabled);
  app.log.info({ enabled, changed: result.changed }, "bundle-sync: boot sync complete");
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
// Issue #1089 (A9) — named explicitly (unlike this repo's other `fp(...)`
// plugins) so `app.hasPlugin("bundle-sync")` works: Fastify's own plugin
// registry keys off this name, not the wrapped function's (anonymous, here)
// `.name`. This exists purely for buildApp()-level registration tests (see
// test/plugins/bundle-sync-registration.test.ts) — this plugin's own onReady
// dispatch is gated behind the NODE_ENV=test guard below specifically so a
// buildApp()-level test never does real filesystem I/O (see that guard's own
// comment), which means a test going through buildApp() can't observe
// registration via a fired dispatch the way test/plugins/bundle-sync.test.ts's
// bare-Fastify unit tests do. `hasPlugin` sidesteps that entirely: it reflects
// registration itself, independent of NODE_ENV, so a test can prove BOTH of
// src/app.ts's registration call sites (primary and agent role) are actually
// reached with no I/O risk at all.
export const bundleSyncPlugin = fp(
  async (app: FastifyInstance) => {
    if (process.env.NODE_ENV === "test") return;

    app.addHook("onReady", () => {
      void runBundleSync(app).catch((err) => {
        app.log.warn({ err }, "bundle-sync: boot sync threw");
      });
    });
  },
  { name: "bundle-sync" },
);
