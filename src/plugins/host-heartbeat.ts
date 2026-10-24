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
