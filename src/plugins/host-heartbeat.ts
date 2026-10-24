import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startHostHeartbeat } from "../services/host-heartbeat.js";

// Primary-only, same role gate as githubPRPollerPlugin/gitFetcherPlugin —
// an agent has no `hosts` table to sweep (see src/app.ts's agent branch).
export const hostHeartbeatPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  let cleanup: (() => void) | null = null;

  // Issue #1719 (roadmap 8.5) — a host that just came back was most likely
  // ASLEEP. macOS suspends a laptop's processes and severs its network
  // without a FIN, so the primary's sockets to that host are half-open: they
  // report OPEN forever and never emit "close", which is the only event
  // either reconnect loop re-arms on. The heartbeat is the one thing that
  // notices the host came back, so it forces the reconnect here.
  //
  // Both connections matter: the events subscription (so the primary sees
  // what happens on the Mac again) and the ssh-agent fan-out (so an SSH
  // session can reach the Mac's agent again).
  function onHostRecovered(hostId: string): void {
    app.log.info({ hostId }, "[host-heartbeat] host recovered — forcing a reconnect");
    app.reconfigureRemoteEventSubscriptions?.({ forceReconnect: [hostId] });
    app.reconfigureSshAgentFanout?.({ forceReconnect: [hostId] });
  }

  app.addHook("onReady", () => {
    cleanup = startHostHeartbeat(app, undefined, undefined, onHostRecovered);
  });

  app.addHook("onClose", () => {
    if (cleanup) cleanup();
  });
});
