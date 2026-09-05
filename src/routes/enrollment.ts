import type { FastifyInstance } from "fastify";
import {
  claimHost,
  clearHostSession,
  enrollHost,
  rotateSession,
  verifyHostSession,
  type HostRegistration,
  type RegisterAgentInput,
} from "../services/host-registry.js";
import { isAllowedHttpUrl } from "../services/url-guard.js";
import { timingSafeTokenMatch } from "../services/crypto-utils.js";
import { getRawRemoteAddress } from "../services/raw-remote-address.js";

// Issue #245 / roadmap 7.1 — the primary-side half of agent-initiated
// registration — plus, below, issue #248 / roadmap 7.3's graceful
// deregistration. Primary-only (registered from src/app.ts's primary branch
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

interface DeregisterBody {
  hostId: string;
  sessionId: string;
}

const deregisterSchema = {
  body: {
    type: "object",
    required: ["hostId", "sessionId"],
    additionalProperties: false,
    properties: {
      hostId: { type: "string", minLength: 1 },
      sessionId: { type: "string", minLength: 1 },
    },
  },
};

// Same rate-limit posture as REGISTER_RATE_LIMIT, same reasoning.
const DEREGISTER_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

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
    // bitsStr must be present and purely digits — Number("") is 0, which
    // would otherwise turn a trailing-slash typo like "10.0.0.0/" into a
    // /0 mask that matches every IP, exactly the opposite of fail-closed.
    if (!bitsStr || !/^\d{1,2}$/.test(bitsStr)) continue;
    const bits = Number(bitsStr);
    if (baseValue === null || bits > 32) continue;
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

      // Issue #213 cross-host capture: every path below issues a fresh
      // session credential (host-registry.ts's issueSession), which
      // remote-host-client.ts's client cache will pick up on its own on
      // this host's NEXT reconnect attempt regardless — but forcing that
      // reconnect right now, rather than waiting on whatever's left of the
      // old session's backoff/TTL, means the events subscription starts
      // using the fresh credential immediately instead of leaving a window
      // where it's needlessly still running on the old one.
      if (hostId) {
        const renewed = rotateSession(app, hostId, token);
        if (!renewed) return reply.unauthorized("session renewal rejected");
        app.reconfigureRemoteEventSubscriptions({ forceReconnect: [renewed.hostId] });
        // Issue #820 — no forceReconnect equivalent yet (see hosts.ts's
        // PATCH handler for the same documented gap): an already-open
        // ssh-agent-fanout connection for this host keeps its old
        // credential until it errors out on its own. Still correct to
        // call — a no-op unless this host's fan-out connection isn't open
        // yet, in which case this is what opens it.
        app.reconfigureSshAgentFanout();
        return respond(renewed);
      }

      // Fresh registration — try claiming an existing (admin-provisioned)
      // row first; it doesn't depend on MULLION_ENROLLMENT_SECRET being
      // configured at all.
      const claimed = claimHost(app, token, input);
      if (claimed) {
        app.reconfigureRemoteEventSubscriptions({ forceReconnect: [claimed.hostId] });
        app.reconfigureSshAgentFanout();
        return respond(claimed);
      }

      const enrollmentSecret = app.config.MULLION_ENROLLMENT_SECRET;
      // Issue #1059 — both fixed-length (server-configured secret vs
      // inbound bearer); same assumption as auth.ts / internal.ts.
      if (enrollmentSecret && timingSafeTokenMatch(token, enrollmentSecret)) {
        const allowedCidrs = app.config.MULLION_ENROLLMENT_ALLOWED_CIDRS;
        // request.raw.socket.remoteAddress, not request.ip — see
        // getRawRemoteAddress's own doc comment. `.ip` is XFF-forgeable the
        // moment trustProxy is enabled, which would let any external caller
        // bypass this CIDR gate on a grant env.ts itself calls "arbitrary-
        // command-execution trust" (AS7).
        if (allowedCidrs && !isIpAllowed(getRawRemoteAddress(request), allowedCidrs)) {
          return reply.forbidden("peer address not in MULLION_ENROLLMENT_ALLOWED_CIDRS");
        }
        const enrolled = enrollHost(app, input);
        app.reconfigureRemoteEventSubscriptions({ forceReconnect: [enrolled.hostId] });
        app.reconfigureSshAgentFanout();
        return respond(enrolled);
      }

      return reply.unauthorized("invalid registration credential");
    },
  );

  // Issue #248 / roadmap 7.3 — graceful deregistration. Called by an
  // agent's own onClose hook (agent-enrollment.ts) as it shuts down, so the
  // Settings host list reflects "offline" within this request's own
  // round-trip instead of waiting on host-heartbeat.ts's 3-missed-ping
  // window. Authenticated by the caller's own current session credential —
  // never the bootstrap token — via the same read-only check rotateSession
  // uses (verifyHostSession), just without minting a new session (the whole
  // point of this call is "I'm going away," not "give me a fresh
  // credential"). A manually-registered, static-Bearer-only agent has no
  // session and therefore never calls this at all (agent-enrollment.ts's
  // plugin body is a no-op without MULLION_PRIMARY_URL +
  // MULLION_ENROLLMENT_TOKEN) — it degrades to heartbeat-only detection
  // with no error, per #248's own verification requirement.
  //
  // Deliberately status-only: this marks the host offline immediately but
  // does NOT cascade-terminate its live sessions the way
  // DELETE /api/hosts/:id?cascade=true does. Every dtach session an agent
  // hosts is bootstrapped into its own systemd-run scope specifically so it
  // survives an agent process restart (see mullion-agent.service's own doc
  // comment, and AGENTS.md's "non-obvious session model" invariant) — and this endpoint fires
  // on *every* graceful SIGTERM an agent receives, including a routine
  // `systemctl --user restart` during a redeploy, not just a permanent
  // decommission. Cascade-killing live sessions on every restart would
  // defeat the exact guarantee that native (non-container) architecture
  // exists for. An admin who actually wants a host's sessions terminated —
  // real decommissioning, not a restart — already has that path.
  //
  // The session credential itself IS revoked here (Hermes review, PR #530),
  // though: clearHostSession() is free — a self-registered agent is
  // stateless and always re-establishes a brand-new session from its
  // bootstrap credential on its very next boot, so nothing depends on the
  // outgoing one staying valid, and leaving it live would mean a session
  // that just said "I'm going away" stays a usable inbound credential for
  // up to its full 24h TTL. This is credential hygiene, not session
  // termination — it revokes the agent's ability to authenticate, not any
  // dtach process it's currently running.
  app.post<{ Body: DeregisterBody }>(
    "/api/internal/deregister",
    { schema: deregisterSchema, config: { rateLimit: DEREGISTER_RATE_LIMIT } },
    async (request, reply) => {
      const { hostId, sessionId } = request.body;
      if (!verifyHostSession(app, hostId, sessionId)) {
        return reply.unauthorized("invalid session credential");
      }
      app.hostHeartbeatTracker?.markOffline(hostId);
      clearHostSession(app, hostId);
      reply.code(204);
    },
  );
}
