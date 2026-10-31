import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startHostHeartbeat } from "../services/host-heartbeat.js";
import { pushTerminalPaletteToHost } from "../services/terminal-palette-sync.js";
import { autoFillHostCwds } from "../services/host-checkout-detect.js";
import { runPreProvisionSweep } from "../services/pre-provision.js";
import { refreshRemoteHostAgents } from "../services/host-agents.js";

/** How often the primary looks for checkouts to pre-provision. */
const PRE_PROVISION_SWEEP_MS = 10 * 60_000;

// Primary-only, same role gate as githubPRPollerPlugin/gitFetcherPlugin —
// an agent has no `hosts` table to sweep (see src/app.ts's agent branch).
export const hostHeartbeatPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  let cleanup: (() => void) | null = null;

  // Issue #1719 (roadmap 8.5) — a host that just came back was most likely
  // ASLEEP. macOS suspends a laptop's processes and severs its network
  // without a FIN, so the primary's socket to that host is half-open: it
  // reports OPEN forever and never emits "close", which is the only event the
  // events subscription's reconnect loop re-arms on. The heartbeat is the one
  // thing that notices the host came back, so it forces the reconnect here.
  //
  // The two connections are NOT in the same position, and the difference
  // matters:
  //
  //   - The EVENTS subscription (remote-event-subscriber.ts) has no ongoing
  //     liveness ping, so a half-open socket stays wedged indefinitely.
  //     This force-reconnect is the only thing that fixes it.
  //   - The SSH-agent fan-out runs over the mux (ssh-agent-mux.ts), which
  //     PINGs every 15s and terminates a connection whose PONG does not
  //     arrive within 10s — so its socket DOES get torn down, and the
  //     fan-out's own reconnect picks it up within ~25s. The force-reconnect
  //     here is belt-and-braces: it recovers sooner, and it does not rely on
  //     the mux's own liveness detection.
  function onHostRecovered(hostId: string): void {
    void pushTerminalPaletteToHost(app, hostId);
    app.log.info({ hostId }, "[host-heartbeat] host recovered — forcing a reconnect");
    app.reconfigureRemoteEventSubscriptions?.({ forceReconnect: [hostId] });
    app.reconfigureSshAgentFanout?.({ forceReconnect: [hostId] });
    app.reconfigureControlRelayFanout?.({ forceReconnect: [hostId] });
  }

  // Issue #2090 — a host coming online is when the opt-in "map projects onto
  // this host's matching clones" sweep runs. Fire-and-forget: it is
  // best-effort bookkeeping and must never hold up (or fail) the heartbeat.
  const detecting = new Set<string>();
  function onHostOnline(hostId: string): void {
    // A host that was asleep, offline or restarted has lost (or never got) the
    // palette its sessions' startup color queries are answered from.
    void pushTerminalPaletteToHost(app, hostId);
    // Issue #2240 — a host that came back may have been updated or had a CLI
    // installed while it was away: re-read its agent list and version.
    void refreshRemoteHostAgents(app, hostId).catch((err: unknown) => {
      app.log.warn({ err, hostId }, "[host-heartbeat] reading the host's agent list failed");
    });
    // Pre-provisioned checkouts: start the clone jobs this host is selected for.
    void runPreProvisionSweep(app, { onlyHostId: hostId }).catch((err: unknown) => {
      app.log.warn({ err, hostId }, "[host-heartbeat] pre-provisioning checkouts failed");
    });
    // One run per host at a time: a run that outlasts the sweep interval must
    // not be stacked on by the next "came online".
    if (detecting.has(hostId)) return;
    detecting.add(hostId);
    void autoFillHostCwds(app, { hostId })
      .catch((err: unknown) => {
        app.log.warn({ err, hostId }, "[host-heartbeat] auto-detecting checkouts failed");
      })
      .finally(() => detecting.delete(hostId));
  }

  // The periodic half of pre-provisioning: a project edited to pre-provision
  // (or a host that stayed online) is picked up without waiting for a host to
  // come back. Primary-only like everything in this plugin; jobs are deduped.
  let sweepTimer: NodeJS.Timeout | null = null;
  let sweeping = false;
  function sweepPreProvision(): void {
    if (sweeping) return;
    sweeping = true;
    void runPreProvisionSweep(app)
      .catch((err: unknown) => {
        app.log.warn({ err }, "[host-heartbeat] pre-provisioning checkouts failed");
      })
      .finally(() => {
        sweeping = false;
      });
  }

  app.addHook("onReady", () => {
    cleanup = startHostHeartbeat(app, undefined, undefined, onHostRecovered, onHostOnline);
    sweepTimer = setInterval(sweepPreProvision, PRE_PROVISION_SWEEP_MS);
    sweepTimer.unref();
  });

  app.addHook("onClose", () => {
    if (sweepTimer) clearInterval(sweepTimer);
    if (cleanup) cleanup();
  });
});
