import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { getStoredSettings } from "../services/settings.js";
import { runBundleSyncExclusive } from "../services/bundle-sync.js";
import { readAgentBundleDisabled, removeHostBundle } from "../services/agent-bundle-state.js";
import { listHosts } from "../services/host-registry.js";

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

// Issue #1128 — the counterpart to routes/bundle-sync.ts's own
// POST /api/bundle-sync/remove fan-out. That route flips
// sessions.injectMullionBundle off and writes EVERY registered agent
// host's own persisted "disabled" flag (agent-bundle-state.ts) — durable,
// because an agent host has no settings DB of its own to re-read the
// primary's live setting from (see that file's own header comment). But
// re-enabling the setting had no matching fan-out: an agent host's own
// persisted flag, once set, had no way to clear itself again short of
// hand-editing the file on that host or a future fan-out calling
// removeHostBundle(app, hostId, false) — this is that fan-out, wired to
// settings.ts's applySettingsPatch (below) on the injectMullionBundle
// false->true edge.
//
// Deliberately does NOT also resync the PRIMARY's own bundle here.
// readInjectMullionBundle's live settings-table read means the primary was
// never STUCK the way an agent host's persisted flag makes it stuck — its
// own next boot-time sync or a manual "Re-sync now" click already picks the
// new value up, so there is nothing here for this function to unstick. An
// earlier version of this also fired the primary's own
// `runBundleSyncExclusive(true)`, fire-and-forget; that call queues into
// runBundleSyncExclusive's own module-level serialization and can still be
// in flight (or freshly landed with a false `changed`) when a later,
// unrelated call to POST /api/bundle-sync/resync runs in the same process —
// exactly what test/routes/bundle-sync.test.ts's own resync tests
// exercise. It was cut, not fixed, because #1128's own scope is the agent
// fan-out below; keep it that way rather than reintroducing that shared-
// mutex hazard for a primary-side convenience #1128 never asked for.
//
// Fire-and-forget (returns `void`, not a `Promise`) so applySettingsPatch —
// synchronous by design, same as every other live-reconfigure hook it
// already calls (reconfigureReconciler/reconfigureGitFetcher/
// reconfigureEventRetention, settings.ts) — never has to become async just
// for this. Best-effort per host, same posture as `/remove`'s own fan-out:
// an unreachable or version-skewed agent is logged and skipped, never lets
// one bad host block another or the setting write that already happened
// before this runs.
function reenableAgentBundles(app: FastifyInstance): void {
  // Same `!h.isLocal && h.baseUrl !== null` filter as routes/bundle-sync.ts's
  // own `/remove` fan-out — every registered host except the primary itself
  // (handled directly above) and any legacy row with no baseUrl at all
  // (pre-#245, never actually reachable).
  const agentHosts = listHosts(app).filter((h) => !h.isLocal && h.baseUrl !== null);
  for (const host of agentHosts) {
    void removeHostBundle(app, host.id, false)
      .then((hostResult) => {
        if (hostResult.ok) {
          app.log.info(
            { hostId: host.id },
            "bundle-sync: re-enabled bundle sync on registered agent host",
          );
          return;
        }
        if (hostResult.reason === "unsupported") {
          app.log.warn(
            { hostId: host.id },
            "bundle-sync: agent host predates the /internal/bundle-sync/remove route — its bundle stays disabled until the agent build is updated",
          );
        } else {
          app.log.warn(
            { hostId: host.id, detail: hostResult.detail },
            "bundle-sync: could not reach agent host to re-enable bundle sync — its own next boot-time sync will still consult its stale disabled flag",
          );
        }
      })
      .catch((err) => {
        app.log.warn(
          { hostId: host.id, err },
          "bundle-sync: re-enable fan-out threw for this host",
        );
      });
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
    // Decorated unconditionally, on both role branches, same as this
    // plugin's own registration (see the header comment above) — harmless
    // on the agent role, whose own app.db-less applySettingsPatch call
    // never exists to invoke it; only ever actually called from the
    // primary's settings.ts.
    app.decorate("reenableAgentBundles", () => reenableAgentBundles(app));

    if (process.env.NODE_ENV === "test") return;

    app.addHook("onReady", () => {
      void runBundleSync(app).catch((err) => {
        app.log.warn({ err }, "bundle-sync: boot sync threw");
      });
    });
  },
  { name: "bundle-sync" },
);

declare module "fastify" {
  interface FastifyInstance {
    reenableAgentBundles: () => void;
  }
}
