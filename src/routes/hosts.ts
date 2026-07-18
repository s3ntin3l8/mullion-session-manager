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
import { getRemoteHostClient } from "../services/remote-host-client.js";

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

// Loopback is deliberately still allowed: this is an admin-only,
// authenticated-boundary config action (same trust level as editing
// PROJECTS_ROOTS), not user input crossing a privilege boundary, and a
// loopback baseUrl is a legitimate, common case (e.g. the dev/test setup
// this repo's own integration test uses). The accepted trust boundary is:
// whoever can call POST/PATCH /api/hosts can already point this process's
// bearer token at any http(s) URL they choose — that's the deploy's admin,
// not an arbitrary caller. Link-local/shared-NAT ranges are rejected
// regardless, though: 169.254.169.254 (every major cloud's instance
// metadata service) sits inside 169.254.0.0/16, and a baseUrl pointed at
// it would make this process hand its own agent bearer token — and any
// response body — to whatever's listening there, which is a real
// credential-leak path even under the admin-trust rationale above.
const LINK_LOCAL_OR_SHARED_NAT_IPV4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

function isLinkLocalOrSharedNatIPv4(hostname: string): boolean {
  const match = hostname.match(LINK_LOCAL_OR_SHARED_NAT_IPV4);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a > 255 || b > 255) return false;
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, cloud IMDS)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (RFC 6598 shared NAT)
  return false;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return !isLinkLocalOrSharedNatIPv4(url.hostname);
  } catch {
    return false;
  }
}

export async function hostsRoute(app: FastifyInstance) {
  app.get("/api/hosts", async () => {
    return listHosts(app);
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
      reply.code(204);
    },
  );
}
