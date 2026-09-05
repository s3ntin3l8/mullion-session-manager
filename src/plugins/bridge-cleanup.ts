import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { cleanupExpiredPairingCodes } from "../services/bridge-registry.js";

// Issue #1052 — periodic cleanup of the `bridges` table. `issuePairingCode`
// inserts a fresh row every Settings interaction, and rows whose pairing
// code (or, after redemption, session) has expired are dead weight — the
// redemption/verify paths already filter them out at query time, so a row
// stuck past expiry serves no purpose except occupying space and carrying
// encrypted secrets.
//
// Primary-only, same role gate as hostHeartbeatPlugin: an agent has no
// `bridges` table (intent lives only on the primary, see src/app.ts's role
// split), so there's nothing for a periodic sweep to do on the agent role.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export const bridgeCleanupPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  let timer: ReturnType<typeof setInterval> | null = null;

  app.addHook("onReady", () => {
    timer = setInterval(() => {
      try {
        cleanupExpiredPairingCodes(app);
      } catch (err) {
        app.log.error({ err }, "[bridge-cleanup] sweep failed");
      }
    }, CLEANUP_INTERVAL_MS);
    timer.unref();
  });

  app.addHook("onClose", () => {
    if (timer) clearInterval(timer);
  });
});
