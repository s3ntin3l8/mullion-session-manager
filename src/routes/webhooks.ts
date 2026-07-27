import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getWebhookSecret } from "../services/github-webhook.js";

const HUB_SIGNATURE_256 = "x-hub-signature-256";
const HUB_EVENT = "x-github-event";

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
  return timingSafeEqual(expected, signature);
}

export async function webhookRoutes(app: FastifyInstance) {
  // No route-level auth — HMAC-SHA256 is the trust mechanism. GitHub can't
  // send custom auth headers. The webhook handler is unauthenticated at the
  // app level and relies entirely on signature verification.
  app.post("/api/webhooks/github", async (request, reply) => {
    const secret = getWebhookSecret(app);
    if (!secret) {
      return reply.code(401).send({ error: "webhook not configured" });
    }

    const signature = request.headers[HUB_SIGNATURE_256] as string | undefined;
    if (!signature) {
      return reply.code(401).send({ error: "missing signature" });
    }

    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    if (!verifySignature(rawBody, signature, secret)) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const event = request.headers[HUB_EVENT] as string | undefined;
    // Silent 200 for unknown event types — safe to add events later.
    if (!event) {
      return reply.code(200).send({ ok: true });
    }

    // Known event types - log and acknowledge delivery.
    const knownEvents = new Set([
      "pull_request",
      "check_run",
      "check_suite",
      "push",
      "issues",
      "workflow_run",
      "release",
      "status",
    ]);
    if (knownEvents.has(event)) {
      app.log.info({ event }, "webhook received");
    }

    return reply.code(200).send({ ok: true });
  });
}
