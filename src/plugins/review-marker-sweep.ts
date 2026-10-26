import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { sweepOpenReviewMarkers } from "../services/hermes-review.js";

// Periodic close of the review relay's in-flight markers (the "Hermes review"
// check run). The marker is otherwise closed only when something polls the
// run's status after it finished, so a review whose verdict is already on the
// pull request kept a pending check forever.
//
// Primary-only, same role gate as bridgeCleanupPlugin: the run index lives on
// the primary, which is the only role that dispatches reviews.
const SWEEP_INTERVAL_MS = 60 * 1000;

export const reviewMarkerSweepPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  let timer: ReturnType<typeof setInterval> | null = null;
  // A pass can outlast the interval (one Hermes read per open marker): never
  // start a second one on top of it.
  let running = false;

  app.addHook("onReady", () => {
    timer = setInterval(() => {
      if (running) return;
      running = true;
      sweepOpenReviewMarkers(app)
        .catch((err: unknown) => {
          app.log.error({ err }, "[review-marker-sweep] sweep failed");
        })
        .finally(() => {
          running = false;
        });
    }, SWEEP_INTERVAL_MS);
    timer.unref();
  });

  app.addHook("onClose", () => {
    if (timer) clearInterval(timer);
  });
});
