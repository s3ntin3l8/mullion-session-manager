import type { FastifyInstance } from "fastify";
import {
  claimHost,
  enrollHost,
  rotateSession,
  type HostRegistration,
  type RegisterAgentInput,
} from "../services/host-registry.js";
import { isAllowedHttpUrl } from "../services/url-guard.js";
import { timingSafeTokenMatch } from "../services/crypto-utils.js";

// Issue #245 / roadmap 7.1 — the primary-side half of agent-initiated
// registration. Primary-only (registered from src/app.ts's primary branch
// only — an agent has no `hosts` table to register other agents into).
//
// One route, two very different things it can mean, disambiguated by
// whether `hostId` is present:
//   - No hostId: a fresh registration. `token` is a bootstrap credential,
//     tried against D1's two paths in order — claim an existing host row
//     (its own authTokenEnc), then enroll a brand-new one
//     (MULLION_ENROLLMENT_SECRET).
//   - hostId present: a renewal. `token` is the agent's CURRENT session id
//     (never the bootstrap credential again — see host-registry.ts's own
//     doc comments on why sessionIdEnc is itself the full inbound
//     credential a registered session authenticates with).
//
// Dual-mode auth stays intact throughout: nothing here touches or is
// touched by internal.ts's static-Bearer onRequest gate. A manually
// registered host that never calls this route keeps working exactly as it
// does today.

interface RegisterBody {
  token: string;
  hostId?: string;
  baseUrl: string;
  hostname: string;
  name?: string;
  capabilities?: unknown;
}

const registerSchema = {
  body: {
    type: "object",
    required: ["token", "baseUrl", "hostname"],
    additionalProperties: false,
    properties: {
      token: { type: "string", minLength: 1 },
      hostId: { type: "string", minLength: 1 },
      baseUrl: { type: "string", minLength: 1 },
      hostname: { type: "string", minLength: 1 },
      name: { type: "string" },
      capabilities: {},
    },
  },
};

// A shared-secret check endpoint — much tighter than internal.ts's
// INTERNAL_RATE_LIMIT (1000/min), same posture as routes/auth.ts's own
// LOGIN_RATE_LIMIT for the identical reason (CodeQL's
// js/missing-rate-limiting query, and because this is exactly the kind of
// endpoint worth bounding regardless).
const REGISTER_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

function respond(result: HostRegistration) {
  return {
    host_id: result.hostId,
    session_id: result.sessionId,
    session_secret: result.sessionSecret,
    expires_at: result.expiresAt.toISOString(),
  };
}

// IPv4-only, deliberately — this is an optional, additional narrowing on
// top of MULLION_ENROLLMENT_SECRET (the actual security boundary), not a
// second independent one, so keeping it simple and failing closed on
// anything it can't parse (including a real IPv6 peer address) is the
// right tradeoff over supporting every address form.
function parseIpv4(ip: string): number | null {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function isIpAllowed(ip: string, cidrsCsv: string): boolean {
  const value = parseIpv4(ip);
  if (value === null) return false;
  for (const range of cidrsCsv
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)) {
    const [base, bitsStr] = range.split("/");
    const baseValue = parseIpv4(base);
    const bits = Number(bitsStr);
    if (baseValue === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return true;
  }
  return false;
}

export async function enrollmentRoute(app: FastifyInstance) {
  app.post<{ Body: RegisterBody }>(
    "/api/internal/register",
    { schema: registerSchema, config: { rateLimit: REGISTER_RATE_LIMIT } },
    async (request, reply) => {
      const { token, hostId, baseUrl, hostname, name, capabilities } = request.body;

      if (!isAllowedHttpUrl(baseUrl, { allowLoopback: true, allowPrivate: true })) {
        return reply.badRequest("baseUrl must be a valid http(s) URL");
      }
      const input: RegisterAgentInput = { baseUrl, hostname, name, capabilities };

      if (hostId) {
        const renewed = rotateSession(app, hostId, token);
        if (!renewed) return reply.unauthorized("session renewal rejected");
        return respond(renewed);
      }

      // Fresh registration — try claiming an existing (admin-provisioned)
      // row first; it doesn't depend on MULLION_ENROLLMENT_SECRET being
      // configured at all.
      const claimed = claimHost(app, token, input);
      if (claimed) return respond(claimed);

      const enrollmentSecret = app.config.MULLION_ENROLLMENT_SECRET;
      if (enrollmentSecret && timingSafeTokenMatch(token, enrollmentSecret)) {
        const allowedCidrs = app.config.MULLION_ENROLLMENT_ALLOWED_CIDRS;
        if (allowedCidrs && !isIpAllowed(request.ip, allowedCidrs)) {
          return reply.forbidden("peer address not in MULLION_ENROLLMENT_ALLOWED_CIDRS");
        }
        return respond(enrollHost(app, input));
      }

      return reply.unauthorized("invalid registration credential");
    },
  );
}
