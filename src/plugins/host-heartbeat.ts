import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startHostHeartbeat } from "../services/host-heartbeat.js";
import { pushTerminalPaletteToHost } from "../services/terminal-palette-sync.js";
import { autoFillHostCwds } from "../services/host-checkout-detect.js";
import { refreshRemoteHostAgents } from "../services/host-agents.js";

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

  app.addHook("onReady", () => {
    cleanup = startHostHeartbeat(app, undefined, undefined, onHostRecovered, onHostOnline);
  });

  app.addHook("onClose", () => {
    if (cleanup) cleanup();
  });
});
