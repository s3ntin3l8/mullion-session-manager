import type { FastifyInstance } from "fastify";
import {
  issueHostPairingCode,
  listHostPairings,
  redeemHostPairingCode,
  revokeHostPairing,
} from "../services/host-pairing.js";
import { refreshHostProtocolSoon } from "../services/host-agents.js";
import { isAllowedHttpUrl } from "../services/url-guard.js";
import { requestScheme } from "../services/request-scheme.js";
import { createFailureRateLimiter } from "../services/failure-rate-limiter.js";
import {
  buildPairingLink,
  normalizePairingOrigin,
  PAIRING_CODE_PATTERN,
} from "../shared/pairing-link.js";
import type { HostRegistration } from "../services/host-registry.js";

// Issue #2449 — one-time execution-host pairing. The dashboard half
// (POST/GET/DELETE /api/host-pairings) sits behind normal auth; the redeem
// half (POST /api/internal/pair) is public, authenticated by the code itself.
// The wire contract is documented in docs/multi-host.md.

// The authenticated issue route has its own bucket (the per-route config makes
// it a separate counter from the redeem route and the app-wide default).
const ISSUE_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };
// The unauthenticated redeem counts FAILED attempts only (401/400): a success
// consumes a one-time code and unrelated traffic is not counted, so neither can
// exhaust it. Keyed on the raw peer, which behind a reverse proxy is the proxy
// (docs/auth.md, "Current limitations"), hence the count of failures only.
const REDEEM_FAILURE_LIMIT = { max: 20, windowMs: 60_000 };

interface CreateBody {
  label?: string;
}

interface RedeemBody {
  code: string;
  requestId: string;
  hostname: string;
  name?: string;
  baseUrl?: string;
  platform?: string;
  capabilities?: unknown;
}

const createSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: { label: { type: "string", maxLength: 80 } },
  },
};

const redeemSchema = {
  body: {
    type: "object",
    required: ["code", "requestId", "hostname"],
    additionalProperties: false,
    properties: {
      code: { type: "string", minLength: 1, maxLength: 256 },
      // The Helper's per-attempt id, persisted before the first call so a
      // retry after a lost response lands on the same host.
      requestId: { type: "string", minLength: 8, maxLength: 128 },
      hostname: { type: "string", minLength: 1, maxLength: 255 },
      name: { type: "string", maxLength: 120 },
      // Optional: an outbound-only Helper has no URL to advertise.
      baseUrl: { type: "string", minLength: 1, maxLength: 2048 },
      platform: { type: "string", maxLength: 64 },
      capabilities: {
        type: "array",
        maxItems: 64,
        items: { type: "string", maxLength: 64 },
      },
    },
  },
};

function respond(result: HostRegistration) {
  return {
    host_id: result.hostId,
    session_id: result.sessionId,
    session_secret: result.sessionSecret,
    expires_at: result.expiresAt.toISOString(),
    machine_credential: result.machineCredential,
  };
}

export async function hostPairingRoute(app: FastifyInstance) {
  const redeemFailures = createFailureRateLimiter(REDEEM_FAILURE_LIMIT);

  app.post<{ Body: CreateBody }>(
    "/api/host-pairings",
    { schema: createSchema, config: { rateLimit: ISSUE_RATE_LIMIT } },
    async (request) => {
      const pairing = issueHostPairingCode(app, { label: request.body?.label });
      // MULLION_PUBLIC_URL (validated at boot) wins: behind a proxy the Host
      // header and scheme may not be what a Helper can reach.
      const url =
        (app.config.MULLION_PUBLIC_URL && normalizePairingOrigin(app.config.MULLION_PUBLIC_URL)) ||
        `${requestScheme(request)}://${request.headers.host}`;
      return {
        id: pairing.id,
        // The link and code are shown to the operator once; they are never
        // logged and never stored in plaintext.
        pairing_link: buildPairingLink({ url, code: pairing.code }),
        url,
        code: pairing.code,
        expires_at: pairing.expiresAt.toISOString(),
      };
    },
  );

  app.get("/api/host-pairings", async () =>
    listHostPairings(app).map((p) => ({
      id: p.id,
      label: p.label,
      state: p.state,
      expires_at: p.expiresAt.toISOString(),
      created_at: p.createdAt.toISOString(),
      host_id: p.hostId,
    })),
  );

  app.delete<{ Params: { id: string } }>("/api/host-pairings/:id", async (request, reply) => {
    if (!revokeHostPairing(app, request.params.id)) return reply.notFound();
    reply.code(204);
  });

  app.post<{ Body: RedeemBody }>(
    "/api/internal/pair",
    {
      schema: redeemSchema,
      // Replaces the plugin's every-request counter with the failure-only one.
      config: { rateLimit: false },
      preValidation: async (request, reply) => {
        if (!redeemFailures.isBlocked(request.ip)) return;
        reply.header("retry-after", String(redeemFailures.retryAfterSeconds(request.ip)));
        return reply.tooManyRequests("too many failed pairing attempts");
      },
      onResponse: async (request, reply) => {
        if (reply.statusCode === 400 || reply.statusCode === 401) {
          redeemFailures.recordFailure(request.ip);
        }
      },
    },
    async (request, reply) => {
      const { code, requestId, hostname, name, baseUrl, platform, capabilities } = request.body;
      // A malformed code can never match; reject before touching the table.
      if (!PAIRING_CODE_PATTERN.test(code)) return reply.unauthorized("invalid pairing code");
      if (baseUrl && !isAllowedHttpUrl(baseUrl, { allowLoopback: true, allowPrivate: true })) {
        return reply.badRequest("baseUrl must be a valid http(s) URL");
      }
      const result = redeemHostPairingCode(app, code, {
        requestId,
        hostname,
        name,
        baseUrl,
        platform,
        capabilities,
      });
      // Uniform answer for unknown, expired, revoked and replayed codes.
      if (!result) return reply.unauthorized("invalid pairing code");
      app.reconfigureRemoteEventSubscriptions({ forceReconnect: [result.hostId] });
      refreshHostProtocolSoon(app, result.hostId);
      app.reconfigureSshAgentFanout();
      app.reconfigureControlRelayFanout();
      return respond(result);
    },
  );
}
