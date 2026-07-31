// Issue #432 — Visual Skills Manager, discovery slice. Mirrors
// agent-rules.ts's project-scoped GET route shape (hostId branching, the
// same 503-on-transient-failure posture).
//
// Issue #463 — the PUT half. Body-only, deliberately no `:agent`/`:name`
// path params — same "the client never sends a path, only {agent, name}"
// contract as the plan's write-half decision; the server re-resolves
// everything via toggleSkillEnabled (skills.ts), which re-runs discovery
// itself rather than trusting anything the caller sent beyond that pair.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
import { forwardHostRequestError } from "./agent-rules.js";
import {
  listGlobalSkills,
  listProjectSkills,
  toggleSkillEnabled,
  classifySkillToggleError,
  SkillsTimeoutError,
  isTransientReadError,
  type SkillAgent,
} from "../services/skills.js";

const SKILLS_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

interface ToggleSkillBody {
  agent: SkillAgent;
  name: string;
  enabled: boolean;
}

const toggleSkillSchema = {
  body: {
    type: "object",
    required: ["agent", "name", "enabled"],
    additionalProperties: false,
    properties: {
      agent: { type: "string", enum: ["claude-code", "codex", "opencode", "agy"] },
      name: { type: "string", minLength: 1 },
      enabled: { type: "boolean" },
    },
  },
};

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
        app.log.warn({ err }, "global skills read timed out");
        return reply.serviceUnavailable("Timed out reading skill directories");
      }
      if (isTransientReadError(err)) {
        app.log.warn({ err }, "global skills read permission denied");
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
            app.log.warn({ projectId, err }, "project skills read timed out");
            return reply.serviceUnavailable("Timed out reading skill directories");
          }
          if (isTransientReadError(err)) {
            app.log.warn({ projectId, err }, "project skills read permission denied");
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

  // Issue #463 — enable/disable. `{agent, name, enabled}` in the body only
  // (see this file's own header on why) — routed to project.hostId either
  // way, same posture as agent-rules.ts's PUT (a "toggle this skill" action
  // is a property of whichever filesystem the skill actually lives on).
  app.put<{ Params: { id: string }; Body: ToggleSkillBody }>(
    "/api/projects/:id/skills",
    { ...SKILLS_RATE_LIMIT, schema: toggleSkillSchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      const { agent, name, enabled } = request.body;

      if (project.hostId === LOCAL_HOST_ID) {
        try {
          return await toggleSkillEnabled(project.cwd, agent, name, enabled);
        } catch (err) {
          const classified = classifySkillToggleError(err);
          if (classified)
            return reply.code(classified.statusCode).send({ message: classified.message });
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
        return await getRemoteHostClient(app, project.hostId).writeSkillEnabled(
          project.cwd,
          agent,
          name,
          enabled,
        );
      } catch (err) {
        if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, could not toggle skill");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );
}
