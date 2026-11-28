import type { FastifyInstance } from "fastify";
import {
  claimHost,
  clearHostSession,
  recordHostSelfReport,
  renewMachineCredential,
  rotateSession,
  verifyHostSession,
  type HostRegistration,
  type RegisterAgentInput,
} from "../services/host-registry.js";
import { refreshHostProtocolSoon } from "../services/host-agents.js";
import { hostUrlPolicy, isAllowedHttpUrl } from "../services/url-guard.js";
import { getRawRemoteAddress } from "../services/raw-remote-address.js";

// Issue #245 / roadmap 7.1 — the primary-side half of agent-initiated
// registration — plus, below, issue #248 / roadmap 7.3's graceful
// deregistration. Primary-only (registered from src/app.ts's primary branch
// only — an agent has no `hosts` table to register other agents into).
//
// One route, two very different things it can mean, disambiguated by
// whether `hostId` is present:
//   - No hostId: a fresh registration. `token` is a per-host bootstrap
//     credential to claim an existing host row (its own authTokenEnc).
//     (Fleet-secret enrollment via MULLION_ENROLLMENT_SECRET was removed in
//     #3535.)
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
  // Absent only when `machineCredential` is presented instead (issue #2568).
  token?: string;
  hostId?: string;
  // Issue #2568 — the agent's persisted machine credential; with `hostId` it
  // re-registers the agent by identity, not by bootstrap token.
  machineCredential?: string;
  // Issue #2568 — the agent persists an identity and wants a credential
  // issued on this (first) registration.
  wantsMachineCredential?: boolean;
  // Issue #2572 — omitted by an outbound-capable agent with no address to
  // advertise; required of one that gets no machine identity.
  baseUrl?: string;
  hostname: string;
  name?: string;
  capabilities?: unknown;
  // Issue #1721 / roadmap 8.7 — the agent's own platform ("darwin" |
  // "linux" | …), free-form and informational. Optional: an agent build
  // that predates the field does not send it, and the column stays null.
  platform?: string;
}

const registerSchema = {
  body: {
    type: "object",
    required: ["hostname"],
    additionalProperties: false,
    properties: {
      token: { type: "string", minLength: 1 },
      hostId: { type: "string", minLength: 1 },
      machineCredential: { type: "string", minLength: 1 },
      wantsMachineCredential: { type: "boolean" },
      baseUrl: { type: "string", minLength: 1 },
      hostname: { type: "string", minLength: 1 },
      name: { type: "string" },
      capabilities: {},
      // Issue #1721 — DECLARED, because the schema below is
      // `additionalProperties: false` and Fastify's `removeAdditional`
      // strips an undeclared key before the handler ever sees it. That is
      // the same version-skew mechanism the taskId/initialPromptApplied
      // fields rely on — except here the field is additive, so an OLD
      // primary (which strips it) and a NEW agent (which sends it) simply
      // mean "no platform recorded", never a failed registration.
      platform: { type: "string" },
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
    // Issue #2568 — omitted (not null) when none was issued, so a legacy
    // agent's response is byte-for-byte what it was.
    ...(result.machineCredential ? { machine_credential: result.machineCredential } : {}),
  };
}

export async function enrollmentRoute(app: FastifyInstance) {
  app.post<{ Body: RegisterBody }>(
    "/api/internal/register",
    { schema: registerSchema, config: { rateLimit: REGISTER_RATE_LIMIT } },
    async (request, reply) => {
      const {
        token,
        hostId,
        machineCredential,
        wantsMachineCredential,
        baseUrl,
        hostname,
        name,
        capabilities,
        platform,
      } = request.body;

      if (
        baseUrl !== undefined &&
        !isAllowedHttpUrl(baseUrl, hostUrlPolicy(app.config.MULLION_ALLOW_TAILNET_HOSTS))
      ) {
        return reply.badRequest("baseUrl must be a valid http(s) URL");
      }
      if (baseUrl === undefined && !machineCredential && !wantsMachineCredential) {
        return reply.badRequest("baseUrl is required unless a machine identity is used");
      }
      const input: RegisterAgentInput = {
        baseUrl,
        hostname,
        name,
        capabilities,
        platform,
        wantsMachineCredential,
      };

      // Issue #2568 — re-registration by persistent identity. Matched by host
      // id, never by baseUrl; a revoked, expired or unknown credential is a
      // plain 401 and the agent is expected NOT to retry with its bootstrap
      // token (the operator clears its state file to re-enroll).
      if (machineCredential) {
        if (!hostId) return reply.badRequest("machineCredential requires hostId");
        const renewed = renewMachineCredential(app, hostId, machineCredential, input);
        if (!renewed) return reply.unauthorized("machine credential rejected");
        app.reconfigureRemoteEventSubscriptions({ forceReconnect: [renewed.hostId] });
        app.reconfigureSshAgentFanout();
        app.reconfigureControlRelayFanout();
        return respond(renewed);
      }
      if (!token) return reply.badRequest("token or machineCredential is required");

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
        // Issue #1721 — the renewal path re-presents the agent's own
        // self-report, so the platform is refreshed here too (it used to
        // ignore the body entirely, so a host could never update it after
        // its first enrollment). Written separately from the credential
        // rotation: the self-report is informational state, the session is
        // the credential, and neither depends on the other.
        recordHostSelfReport(app, renewed.hostId, { platform });
        app.reconfigureRemoteEventSubscriptions({ forceReconnect: [renewed.hostId] });
        refreshHostProtocolSoon(app, renewed.hostId);
        // Issue #820 — no forceReconnect equivalent yet (see hosts.ts's
        // PATCH handler for the same documented gap): an already-open
        // ssh-agent-fanout connection for this host keeps its old
        // credential until it errors out on its own. Still correct to
        // call — a no-op unless this host's fan-out connection isn't open
        // yet, in which case this is what opens it.
        app.reconfigureSshAgentFanout();
        app.reconfigureControlRelayFanout();
        return respond(renewed);
      }

      const peer = getRawRemoteAddress(request) || null;

      // Fresh registration — try claiming an existing row by its per-host
      // token. Fleet-secret enrollment was removed (#3535), so any other token
      // falls through to 401.
      const claimed = claimHost(app, token, input, peer);
      if (claimed) {
        app.reconfigureRemoteEventSubscriptions({ forceReconnect: [claimed.hostId] });
        refreshHostProtocolSoon(app, claimed.hostId);
        app.reconfigureSshAgentFanout();
        app.reconfigureControlRelayFanout();
        return respond(claimed);
      }

      return reply.unauthorized("invalid registration credential");
    },
  );

  // Issue #248 / roadmap 7.3 — graceful deregistration. Called by an
  // agent's own onClose hook (agent-enrollment.ts) as it shuts down, so the
  // Settings host list reflects "offline" within this request's own
  // round-trip instead of waiting on host-heartbeat.ts's 3-missed-ping
  // window. Authenticated by the caller's own current session credential —
  // never a bootstrap token — via the same read-only check rotateSession
  // uses (verifyHostSession), just without minting a new session (the whole
  // point of this call is "I'm going away," not "give me a fresh
  // credential"). A manually-registered, static-Bearer-only agent has no
  // session and therefore never calls this at all (agent-enrollment.ts's
  // plugin body is a no-op without MULLION_PRIMARY_URL + a stored
  // agent-identity.json) — it degrades to heartbeat-only detection with no
  // error, per #248's own verification requirement.
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
  // though: clearHostSession() is free — a self-registered agent holds a
  // machine identity and re-establishes a brand-new session from it on its
  // very next boot, so nothing depends on the outgoing one staying valid,
  // and leaving it live would mean a session
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
