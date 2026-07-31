// Issue #432 — Visual Skills Manager, discovery slice. Read-only: no
// enable/disable (see skills.ts's own header for why that's deferred).
// Mirrors agent-rules.ts's project-scoped GET route shape (hostId
// branching, the same 503-on-transient-failure posture) minus the
// PUT/DELETE half, since this slice never writes anything.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
import { forwardHostRequestError } from "./agent-rules.js";
import {
  listGlobalSkills,
  listProjectSkills,
  SkillsTimeoutError,
  isTransientReadError,
} from "../services/skills.js";

const SKILLS_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

export async function skillsRoute(app: FastifyInstance) {
  // Global + builtin skills only — deliberately primary-host-only (see
  // skills.ts's listGlobalSkills doc comment): a remote host's own global
  // skill dirs aren't reachable from here without a host selector this
  // slice doesn't add yet.
  app.get("/api/skills", SKILLS_RATE_LIMIT, async (_request, reply) => {
    try {
      return await listGlobalSkills();
    } catch (err) {
      if (err instanceof SkillsTimeoutError) {
        return reply.serviceUnavailable("Timed out reading skill directories");
      }
      if (isTransientReadError(err)) {
        return reply.serviceUnavailable("Permission denied reading skill directories");
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/skills",
    SKILLS_RATE_LIMIT,
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      if (project.hostId === LOCAL_HOST_ID) {
        try {
          return await listProjectSkills(project.cwd);
        } catch (err) {
          if (err instanceof SkillsTimeoutError) {
            return reply.serviceUnavailable("Timed out reading skill directories");
          }
          if (isTransientReadError(err)) {
            return reply.serviceUnavailable("Permission denied reading skill directories");
          }
          throw err;
        }
      }
      try {
        return await getRemoteHostClient(app, project.hostId).resolveSkills(project.cwd);
      } catch (err) {
        if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, skills unavailable");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );
}
