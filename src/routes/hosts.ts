import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import {
  LOCAL_HOST_ID,
  HostHasProjectsError,
  UnknownHostError,
  createHost,
  deleteHost,
  getHostRow,
  listHosts,
  updateHost,
} from "../services/host-registry.js";
import { resolveBackend } from "../services/session-backend.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
import { isAllowedHttpUrl } from "../services/url-guard.js";
import { forwardHostRequestError } from "./agent-rules.js";
import { buildAgentConfig } from "./internal.js";

interface CreateHostBody {
  name: string;
  baseUrl: string;
  token: string;
}

interface UpdateHostBody {
  name?: string;
  baseUrl?: string;
  token?: string;
}

const createHostSchema = {
  body: {
    type: "object",
    required: ["name", "baseUrl", "token"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      baseUrl: { type: "string", minLength: 1 },
      token: { type: "string", minLength: 1 },
    },
  },
};

const updateHostSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1 },
      baseUrl: { type: "string", minLength: 1 },
      token: { type: "string", minLength: 1 },
    },
  },
};

// Loopback and private ranges are deliberately still allowed: this is an
// admin-only, authenticated-boundary config action (same trust level as
// editing PROJECTS_ROOTS), not user input crossing a privilege boundary,
// and a loopback/private baseUrl is a legitimate, common case (e.g. the
// dev/test setup this repo's own integration test uses). The accepted
// trust boundary is: whoever can call POST/PATCH /api/hosts can already
// point this process's bearer token at any http(s) URL they choose —
// that's the deploy's admin, not an arbitrary caller. Link-local/shared-NAT
// ranges are rejected regardless, though: 169.254.169.254 (every major
// cloud's instance metadata service) sits inside 169.254.0.0/16, and a
// baseUrl pointed at it would make this process hand its own agent bearer
// token — and any response body — to whatever's listening there, which is
// a real credential-leak path even under the admin-trust rationale above.
// See services/url-guard.ts for the shared classification logic this
// policy sits on top of — issue #28 phase 5's external-preview validation
// uses the same logic with the opposite allowLoopback/allowPrivate policy.
function isValidHttpUrl(value: string): boolean {
  return isAllowedHttpUrl(value, { allowLoopback: true, allowPrivate: true });
}

export async function hostsRoute(app: FastifyInstance) {
  // Merges DB-recorded intent (name/baseUrl/token — listHosts) with the
  // heartbeat tracker's live liveness state (see host-heartbeat.ts's own
  // doc comment for why that split exists), the same "DB row = intent,
  // in-memory map = live state, route merges the two" split CLAUDE.md
  // documents for sessions. hostHeartbeatTracker is undefined on an agent
  // (hostHeartbeatPlugin never registers there) — every host then reports
  // "pending", which this route never hits since /api/hosts itself is a
  // primary-only route.
  app.get("/api/hosts", async () => {
    return listHosts(app).map((host) => {
      const health = app.hostHeartbeatTracker?.getHealth(host.id) ?? {
        status: "pending" as const,
        lastSeenAt: null,
        lastCheckedAt: null,
      };
      const toIso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
      return {
        ...host,
        health: health.status,
        lastSeenAt: toIso(health.lastSeenAt),
        lastCheckedAt: toIso(health.lastCheckedAt),
      };
    });
  });

  app.post<{ Body: CreateHostBody }>(
    "/api/hosts",
    { schema: createHostSchema },
    async (request, reply) => {
      const { name, baseUrl, token } = request.body;
      if (!isValidHttpUrl(baseUrl)) {
        return reply.badRequest("baseUrl must be a valid http(s) URL");
      }
      const created = createHost(app, { name, baseUrl, token });
      // Issue #213 cross-host capture: opens this host's events
      // subscription immediately rather than waiting up to
      // EVENT_RETENTION_SWEEP_INTERVAL_MS for the hazard-5 fallback tick.
      // A freshly-created row has no session yet (createHost's manual-token
      // path, unlike enrollHost/claimHost) — the connection attempts will
      // fail-auth (401, the agent hasn't presented this token yet) until it
      // registers, cycling connect()'s own reconnect/backoff loop (bounded
      // by the same 1s→30s ceiling every other reconnect uses) until then.
      // The failure warn itself only logs once per failure streak
      // (hasLoggedFailure, remote-event-subscriber.ts, Hermes review, PR
      // #564 round 5), not on every attempt.
      app.reconfigureRemoteEventSubscriptions();
      reply.code(201);
      return created;
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateHostBody }>(
    "/api/hosts/:id",
    { schema: updateHostSchema },
    async (request, reply) => {
      const { id } = request.params;
      if (id === LOCAL_HOST_ID) return reply.badRequest("the local host cannot be edited");
      if (request.body.baseUrl !== undefined && !isValidHttpUrl(request.body.baseUrl)) {
        return reply.badRequest("baseUrl must be a valid http(s) URL");
      }
      const updated = updateHost(app, id, request.body);
      if (!updated) return reply.notFound();
      // A changed baseUrl/token means the old health verdict no longer
      // means anything (it was measured against a different URL/agent) —
      // drop it so the row shows "pending" until the next real sweep,
      // instead of a stale status lingering for up to
      // HOST_HEARTBEAT_INTERVAL_SECONDS.
      if (request.body.baseUrl !== undefined || request.body.token !== undefined) {
        app.hostHeartbeatTracker?.invalidateHost(id);
        // Same staleness reasoning as invalidateHost above, applied to the
        // events subscription: an open socket built from the old
        // baseUrl/token must not be left running until it happens to error
        // out on its own — force it closed and reopened with the fresh row.
        app.reconfigureRemoteEventSubscriptions({ forceReconnect: [id] });
      }
      return updated;
    },
  );

  // Connection-test ping for the Settings hosts panel — `local` is always
  // considered online (it's this same process); a remote host's token/
  // baseUrl are read from the DB row, so this also implicitly validates
  // that a just-saved token/baseUrl pair actually works.
  app.post<{ Params: { id: string } }>("/api/hosts/:id/ping", async (request, reply) => {
    const { id } = request.params;
    if (id === LOCAL_HOST_ID) return { online: true };
    if (!getHostRow(app, id)) return reply.notFound();
    const online = await getRemoteHostClient(app, id).ping();
    return { online };
  });

  // Issue #247 / roadmap 7.4 — per-agent effective-config visibility for the
  // Settings host-detail panel. `local` has no /internal/config to call
  // (the primary never registers internalRoutes — see src/app.ts's role
  // branch), so it's built via the same buildAgentConfig() the agent-side
  // route itself calls, instead of round-tripping through RemoteHostClient
  // — one shared function, not two independently-maintained object
  // literals that could drift apart (independent review, PR #527).
  app.get<{ Params: { id: string } }>("/api/hosts/:id/config", async (request, reply) => {
    const { id } = request.params;
    if (id === LOCAL_HOST_ID) return buildAgentConfig(app);
    if (!getHostRow(app, id)) return reply.notFound();
    try {
      return await getRemoteHostClient(app, id).resolveConfig();
    } catch (err) {
      // The agent responded and said no — a build too old to have
      // /internal/config yet (404) forwards verbatim; a rotated
      // MULLION_AGENT_TOKEN (401/403) still folds into the same 503 as a
      // genuine connectivity failure (forwardHostRequestError's own #458
      // anti-login-confusion precedent) since raw-forwarding it would read
      // to a browser like "you need to log in," which it isn't. Either way
      // this is not a misleading "Host X is unreachable" for a host that's
      // actually perfectly reachable (Hermes review, PR #527, same
      // distinction issue #244 already makes in projects.ts).
      if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
      app.log.warn({ hostId: id, err }, "host unreachable, config unavailable");
      return reply.serviceUnavailable(`Host ${id} is unreachable`);
    }
  });

  // A remote host with projects 409s by default (client must move/delete
  // them first); `?cascade=true` instead best-effort terminates every live
  // session under this host's projects before deleting rows, so a deleted
  // host never orphans a running master on the agent. Cascade is
  // best-effort by design: an already-unreachable agent can't be told to
  // terminate anything, and that must not block removing the (now useless)
  // host row.
  app.delete<{ Params: { id: string }; Querystring: { cascade?: string } }>(
    "/api/hosts/:id",
    async (request, reply) => {
      const { id } = request.params;
      if (id === LOCAL_HOST_ID) return reply.badRequest("the local host cannot be deleted");
      const cascade = request.query.cascade === "true";

      if (cascade) {
        const hostProjects = app.db.select().from(projects).where(eq(projects.hostId, id)).all();
        const backend = resolveBackend(app, id);
        for (const project of hostProjects) {
          const projectSessions = app.db
            .select()
            .from(sessions)
            .where(eq(sessions.projectId, project.id))
            .all();
          await Promise.all(
            projectSessions.map((session) =>
              backend.terminate(String(session.id)).catch((err) => {
                app.log.warn(
                  { hostId: id, sessionId: session.id, err },
                  "cascade host delete: best-effort session terminate failed",
                );
              }),
            ),
          );
        }
        // Rows, not just the live processes above: a project's ON DELETE
        // CASCADE (schema.ts) takes its sessions with it, so the host row
        // below is never left referenced by a dangling project.
        for (const project of hostProjects) {
          app.db.delete(projects).where(eq(projects.id, project.id)).run();
        }
      }

      try {
        deleteHost(app, id, { cascade });
      } catch (err) {
        if (err instanceof UnknownHostError) return reply.notFound();
        if (err instanceof HostHasProjectsError) {
          return reply.conflict(
            `host still has ${err.projectCount} project(s) — pass ?cascade=true`,
          );
        }
        // "cannot delete the local host"
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }
      // Issue #213 cross-host capture: closes this host's events
      // subscription immediately — otherwise it would keep reconnecting
      // (and failing, since getHostRow(app, id) now returns undefined)
      // until the next fallback reconcile tick.
      app.reconfigureRemoteEventSubscriptions();
      reply.code(204);
    },
  );
}
