import type { FastifyInstance } from "fastify";
import {
  getOrCreateVapidKeys,
  removeSubscription,
  upsertSubscription,
} from "../services/push-store.js";

interface SubscribeBody {
  endpoint: string;
  // Present on the standard PushSubscription.toJSON() shape the frontend's
  // pushClient will post directly (JSON.stringify(subscription) invokes
  // this) — accepted and ignored, not persisted (web-push doesn't need it
  // for sending; the push service enforces its own expiry independently).
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

const subscribeSchema = {
  body: {
    type: "object",
    required: ["endpoint", "keys"],
    additionalProperties: false,
    properties: {
      endpoint: { type: "string", minLength: 1 },
      // See SubscribeBody's own comment — required by the real Push API
      // shape a browser sends, even though this route doesn't use it.
      expirationTime: { type: ["number", "null"] },
      keys: {
        type: "object",
        required: ["p256dh", "auth"],
        additionalProperties: false,
        properties: {
          p256dh: { type: "string", minLength: 1 },
          auth: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

interface UnsubscribeBody {
  endpoint: string;
}

const unsubscribeSchema = {
  body: {
    type: "object",
    required: ["endpoint"],
    additionalProperties: false,
    properties: {
      endpoint: { type: "string", minLength: 1 },
    },
  },
};

// No route-level auth hook here — consistent with every other route in this
// app (see settingsRoute's own comment on the two-layer model). Mounting
// under /api/push/* is enough for src/plugins/auth.ts's global onRequest
// hook to gate these behind a session when in-process auth is enabled;
// unlike /api/auth/*, /api/internal/register, or /api/webhooks/github, push
// has no reason to be its own auth boundary — the browser calls these with
// its normal session cookie, so it isn't added to auth.ts's exemption ladder.
export async function pushRoute(app: FastifyInstance) {
  app.get("/api/push/vapid-public-key", async (_request, reply) => {
    const { publicKey } = getOrCreateVapidKeys(app);
    return reply.send({ publicKey });
  });

  app.post<{ Body: SubscribeBody }>(
    "/api/push/subscribe",
    { schema: subscribeSchema },
    async (request, reply) => {
      const { endpoint, keys } = request.body;
      upsertSubscription(app, {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: request.headers["user-agent"] ?? null,
      });
      return reply.code(204).send();
    },
  );

  app.delete<{ Body: UnsubscribeBody }>(
    "/api/push/unsubscribe",
    { schema: unsubscribeSchema },
    async (request, reply) => {
      removeSubscription(app, request.body.endpoint);
      return reply.code(204).send();
    },
  );
}
