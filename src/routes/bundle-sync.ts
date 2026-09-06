import type { FastifyInstance } from "fastify";
import { getCachedAgents } from "../services/agent-detect.js";
import {
  getBundleSyncStatus,
  runBundleSyncExclusive,
  uninstallBundleContent,
  type BundleSyncCli,
} from "../services/bundle-sync.js";
import { applySettingsPatch, getStoredSettings } from "../services/settings.js";
import { removeHostBundle } from "../services/agent-bundle-state.js";
import { listHosts } from "../services/host-registry.js";

// Issue #944 — this whole route file is host-local functionality: it
// reports/mutates THIS process's own boot-time bundle sync (bundle-sync.ts,
// #941), which is inherently about the filesystem this Mullion process
// itself is running on. #944's own issue text raises multi-host routing as
// a concern, but the concrete precedent it cites (project-setup.ts's
// hostId === LOCAL_HOST_ID branching) is for a PROJECT-scoped action on a
// project that might live on a remote agent host — these routes have no
// project/hostId concept at all, so there's nothing to branch on. Scoping
// decision, made explicit per #944's own "don't leave it implicit" ask:
// this surface answers "is MY OWN host's bundle synced," not "is some
// remote agent host's." Querying a remote agent host's own sync status is
// a real, separate capability now (RemoteHostClient/`/internal/agents` was
// the existing precedent for the shape) — see /api/bundle-sync/remove's own
// doc comment below for the one action (#1089) actually wired to fan out to
// every registered agent host; status/resync above remain local-only, still
// a real, documented gap rather than a silently dropped one.
//
// Registered only under MULLION_ROLE === "primary" (see app.ts, right
// alongside agentsRoute/projectSetupRoute) — an agent-role process returns
// early from buildApp() before this point, so no runtime role check is
// needed inside this file itself; the registration site IS the gate, same
// posture as every other route registered in that same block.
export async function bundleSyncRoute(app: FastifyInstance) {
  function readInjectMullionBundle(): boolean {
    return getStoredSettings(app.db).sessions.injectMullionBundle;
  }

  // Detected CLIs are looked up here (not inside bundle-sync.ts itself,
  // which is not Fastify-aware and has no business shelling out to
  // agent-detect.ts's login-shell probes) and passed into
  // getBundleSyncStatus as a plain Set — see that function's own doc
  // comment for why.
  async function detectedClis(): Promise<Set<BundleSyncCli>> {
    const agents = await getCachedAgents();
    const availableIds = new Set(
      agents.filter((agent) => agent.available).map((agent) => agent.id),
    );
    const byCli: Record<BundleSyncCli, string> = {
      "claude-code": "agent:claude",
      codex: "agent:codex",
      agy: "agent:agy",
      opencode: "agent:opencode",
    };
    const result = new Set<BundleSyncCli>();
    for (const cli of Object.keys(byCli) as BundleSyncCli[]) {
      if (availableIds.has(byCli[cli])) result.add(cli);
    }
    return result;
  }

  app.get("/api/bundle-sync/status", async (_request, reply) => {
    const status = getBundleSyncStatus({
      enabled: readInjectMullionBundle(),
      detectedClis: await detectedClis(),
    });
    reply.type("application/json");
    return status;
  });

  // Troubleshooting action, not a gate (#944's own scope text) — re-runs
  // the exact same sync `runBundleSyncExclusive` already performs at boot,
  // serialized against any other in-flight sync/remove so this can never
  // race the boot-time onReady hook or a concurrent request.
  app.post("/api/bundle-sync/resync", async (_request, reply) => {
    if (!readInjectMullionBundle()) {
      return reply.code(409).send({ error: "disabled" });
    }
    const result = await runBundleSyncExclusive(true);
    reply.type("application/json");
    return { changed: result.changed };
  });

  // Issue #945 — "remove Mullion bundle content from a host." Flips
  // sessions.injectMullionBundle off FIRST, through the exact same write
  // path PATCH /api/settings itself uses (applySettingsPatch), so this is
  // durable ON THE PRIMARY: without this, the next boot (or the next
  // codex/agy session's own per-launch managedInstall) would silently
  // reinstall everything, since both fall back to re-syncing/re-installing
  // whenever this setting reads true (its default). Removal itself runs
  // AFTER the flip, via uninstallBundleContent's manifest-driven removal
  // plus its legacy sweep (mullion-bundle.ts's marker-checked
  // uninstallBundleSkills) and agy's own MCP-entry removal.
  //
  // Issue #1089 — no longer primary-host-only: this now ALSO fans out to
  // every registered agent host (agent-bundle-state.ts's removeHostBundle,
  // over RemoteHostClient), since an agent host's own boot-time global sync
  // (bundle-sync.ts's plugin, onReady) has no per-session moment to receive
  // a settings-DB flip the way a session-spawn-time gate does — it needs
  // its OWN persisted flag (agent-bundle-state.ts) instead, and this is
  // what writes it. Best-effort per host: an unreachable/version-skewed
  // agent is logged and skipped, never lets a bad host block the primary's
  // own removal (which has already happened by the time the fan-out below
  // even starts) or block any OTHER host in the loop.
  app.post("/api/bundle-sync/remove", async (_request, reply) => {
    applySettingsPatch(app, { sessions: { injectMullionBundle: false } });
    const result = await uninstallBundleContent();

    // Same `!h.isLocal && h.baseUrl !== null` filter as ssh-agent-fanout.ts's
    // own reconcile() — every registered host except the primary itself
    // (which this route just handled directly, above) and any legacy row
    // with no baseUrl at all (pre-#245, never actually reachable).
    const agentHosts = listHosts(app).filter((h) => !h.isLocal && h.baseUrl !== null);
    await Promise.all(
      agentHosts.map(async (host) => {
        const hostResult = await removeHostBundle(app, host.id, true);
        if (hostResult.ok) {
          app.log.info(
            { hostId: host.id, removed: hostResult.value.removed },
            "bundle-sync: removed bundle content on registered agent host",
          );
          return;
        }
        if (hostResult.reason === "unsupported") {
          app.log.warn(
            { hostId: host.id },
            "bundle-sync: agent host predates the /internal/bundle-sync/remove route — its bundle will silently resync on its own next boot",
          );
        } else {
          app.log.warn(
            { hostId: host.id, detail: hostResult.detail },
            "bundle-sync: could not reach agent host to remove bundle content — its own next boot-time sync will retry",
          );
        }
      }),
    );

    reply.type("application/json");
    return {
      removed: result.removed,
      legacySwept: result.legacySwept,
      settingDisabled: true as const,
    };
  });
}
