import type { FastifyInstance } from "fastify";
import {
  assertReviewerConfigured,
  listHermesReviews,
  stopHermesReview,
} from "../services/hermes-review.js";
import { replyReviewError } from "./review-relay.js";

// Operator-facing view of the review runs this Mullion dispatched (Settings →
// Integrations → Review relay → Recent reviews). Behind the normal auth gate;
// unlike the per-session ops in review-request.ts this isn't pinned to a
// session, so the operator can stop any tracked run.

export async function reviewsRoute(app: FastifyInstance) {
  app.get("/api/reviews", async (_request, reply) => {
    try {
      assertReviewerConfigured(app);
      return { runs: await listHermesReviews(app) };
    } catch (err) {
      return replyReviewError(reply, err);
    }
  });

  app.post<{ Params: { runId: string } }>(
    "/api/reviews/:runId/stop",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        return await stopHermesReview(app, request.params.runId);
      } catch (err) {
        return replyReviewError(reply, err);
      }
    },
  );
}
