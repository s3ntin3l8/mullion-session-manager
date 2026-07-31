// Issue #431 — Agent Rules Editor. Project-scoped routes follow the exact
// hostId-branching triple every other project-scoped filesystem route in
// this repo uses (see projects.ts's /api/projects/:id/actions and .../dock)
// — primary reads locally, a remote-hosted project proxies through
// /internal/agent-rules on that host. The standalone global routes
// (/api/agent-rules/global/:target) are deliberately PRIMARY-HOST-ONLY: a
// "global" CLAUDE.md/AGENTS.md/GEMINI.md is a property of whichever
// filesystem it's read from, and this repo's existing global-config
// precedent (CRS_CONFIG_DIR, resolveGlobalPresets) is already
// primary-host-scoped the same way — extending this to per-remote-host
// global config is out of scope for this slice (see the plan).
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import {
  listAgentRules,
  getAgentRule,
  writeAgentRule,
  deleteAgentRule,
  resolveTarget,
  AgentRuleTooLargeError,
  AgentRulesTimeoutError,
} from "../services/agent-rules.js";

const RULES_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

const writeRuleSchema = {
  body: {
    type: "object",
    required: ["content"],
    additionalProperties: false,
    properties: {
      content: { type: "string" },
    },
  },
};

const targetParamsSchema = {
  params: {
    type: "object",
    required: ["target"],
    properties: { target: { type: "string" } },
  },
};

export async function agentRulesRoute(app: FastifyInstance) {
  function getProjectOr404(projectId: number) {
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    return project ?? null;
  }

  // GET /api/projects/:id/agent-rules — the full target list (all agents,
  // both scopes) with content inlined for whatever exists. 204 is
  // deliberately never used here (unlike actions/dock/git-status): an
  // empty-of-files project is still a normal, valid response — the target
  // LIST itself is never empty, only individual targets' `exists` flags
  // are. 503 is reserved for genuine transient failures (host unreachable,
  // an AgentRulesTimeoutError on a hung mount).
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/agent-rules",
    RULES_RATE_LIMIT,
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(projectId);
      if (!project) return reply.notFound();

      if (project.hostId === LOCAL_HOST_ID) {
        try {
          return await listAgentRules(project.cwd);
        } catch (err) {
          if (err instanceof AgentRulesTimeoutError) {
            app.log.warn({ projectId, err }, "agent-rules read timed out");
            return reply.serviceUnavailable("Timed out reading agent rule files");
          }
          throw err;
        }
      }
      try {
        return await getRemoteHostClient(app, project.hostId).resolveAgentRules(project.cwd);
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, agent rules unavailable");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  // PUT /api/projects/:id/agent-rules/:target — writes a PROJECT-scope
  // target only; a global-scope target id here is a 400 (use the
  // standalone /api/agent-rules/global/:target route instead — see this
  // file's header for why global is never project-nested).
  app.put<{ Params: { id: string; target: string }; Body: { content: string } }>(
    "/api/projects/:id/agent-rules/:target",
    { ...RULES_RATE_LIMIT, schema: { ...targetParamsSchema, ...writeRuleSchema } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(projectId);
      if (!project) return reply.notFound();

      const target = resolveTarget(request.params.target);
      if (!target) return reply.badRequest("Unknown agent-rules target");
      if (target.scope !== "project") {
        return reply.badRequest(
          "This target is global-scoped — use /api/agent-rules/global/:target",
        );
      }

      if (project.hostId === LOCAL_HOST_ID) {
        try {
          writeAgentRule(target, project.cwd, request.body.content);
        } catch (err) {
          if (err instanceof AgentRuleTooLargeError) return reply.badRequest(err.message);
          throw err;
        }
        return await getAgentRule(target, project.cwd);
      }
      try {
        return await getRemoteHostClient(app, project.hostId).writeAgentRule(
          project.cwd,
          target.id,
          request.body.content,
        );
      } catch (err) {
        app.log.warn(
          { hostId: project.hostId, err },
          "host unreachable, could not write agent rule",
        );
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  app.delete<{ Params: { id: string; target: string } }>(
    "/api/projects/:id/agent-rules/:target",
    { ...RULES_RATE_LIMIT, schema: targetParamsSchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(projectId);
      if (!project) return reply.notFound();

      const target = resolveTarget(request.params.target);
      if (!target) return reply.badRequest("Unknown agent-rules target");
      if (target.scope !== "project") {
        return reply.badRequest(
          "This target is global-scoped — use /api/agent-rules/global/:target",
        );
      }

      if (project.hostId === LOCAL_HOST_ID) {
        deleteAgentRule(target, project.cwd);
        reply.code(204);
        return;
      }
      try {
        await getRemoteHostClient(app, project.hostId).deleteAgentRule(project.cwd, target.id);
        reply.code(204);
      } catch (err) {
        app.log.warn(
          { hostId: project.hostId, err },
          "host unreachable, could not delete agent rule",
        );
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  // Standalone global-scope routes — primary-host-only, see file header.
  app.get<{ Params: { target: string } }>(
    "/api/agent-rules/global/:target",
    { ...RULES_RATE_LIMIT, schema: targetParamsSchema },
    async (request, reply) => {
      const target = resolveTarget(request.params.target);
      if (!target) return reply.badRequest("Unknown agent-rules target");
      if (target.scope !== "global") return reply.badRequest("This target is project-scoped");
      try {
        return await getAgentRule(target);
      } catch (err) {
        if (err instanceof AgentRulesTimeoutError) {
          return reply.serviceUnavailable("Timed out reading agent rule file");
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { target: string }; Body: { content: string } }>(
    "/api/agent-rules/global/:target",
    { ...RULES_RATE_LIMIT, schema: { ...targetParamsSchema, ...writeRuleSchema } },
    async (request, reply) => {
      const target = resolveTarget(request.params.target);
      if (!target) return reply.badRequest("Unknown agent-rules target");
      if (target.scope !== "global") return reply.badRequest("This target is project-scoped");
      try {
        writeAgentRule(target, "/", request.body.content);
      } catch (err) {
        if (err instanceof AgentRuleTooLargeError) return reply.badRequest(err.message);
        throw err;
      }
      return await getAgentRule(target);
    },
  );

  app.delete<{ Params: { target: string } }>(
    "/api/agent-rules/global/:target",
    { ...RULES_RATE_LIMIT, schema: targetParamsSchema },
    async (request, reply) => {
      const target = resolveTarget(request.params.target);
      if (!target) return reply.badRequest("Unknown agent-rules target");
      if (target.scope !== "global") return reply.badRequest("This target is project-scoped");
      deleteAgentRule(target, "/");
      reply.code(204);
    },
  );
}
