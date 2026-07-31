// Issue #431 — Agent Rules Editor. Every route here — including a
// global-scope target's PUT/DELETE — follows the exact hostId-branching
// triple every other project-scoped filesystem route in this repo uses
// (see projects.ts's /api/projects/:id/actions and .../dock): primary
// reads/writes locally, a remote-hosted project proxies through
// /internal/agent-rules on that host. A "global" CLAUDE.md/AGENTS.md/
// GEMINI.md is a property of whichever filesystem it's read from, so a
// remote-hosted project's global targets must round-trip through that same
// host, not the primary's — there is deliberately no standalone
// primary-host-only global route anymore (Hermes review, PR #458: the
// project-scoped GET already listed a remote-hosted project's global
// targets by resolving them on that project's own host, but the earlier
// version of this file's PUT/DELETE rejected global-scope ids and forced
// the frontend through a primary-host-only route instead — silently
// writing a remote project's global file to the *primary's* filesystem).
import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
import {
  listAgentRules,
  getAgentRule,
  writeAgentRule,
  deleteAgentRule,
  resolveTarget,
  AgentRuleTooLargeError,
  AgentRuleSymlinkError,
  AgentRulesTimeoutError,
  isTransientReadError,
} from "../services/agent-rules.js";

// Hermes review, PR #458 — a remote host's 4xx (symlink refusal, oversized
// content, an unknown target) used to be flattened into the same 503 "Host
// unreachable" as a genuine connectivity failure. The host isn't
// unreachable here — it responded and said no — so forward its real status
// and the reason it gave, the same way a local-host failure already does.
function forwardHostRequestError(reply: FastifyReply, err: HostRequestError) {
  // Independent review, PR #458 — a 401/403 from the agent means its own
  // bearer-token check rejected us (a rotated MULLION_AGENT_TOKEN, e.g.) —
  // an infrastructure/config problem, not something about THIS specific
  // edit. Forwarding it raw would read to a browser like "you need to log
  // in," which it isn't (and no other RemoteHostClient caller in this repo
  // forwards a HostRequestError's status verbatim at all — this is the
  // first place that does, precisely because the OTHER 4xx classes here
  // genuinely are request-specific and worth showing as-is).
  if (err.statusCode === 401 || err.statusCode === 403) {
    return reply.serviceUnavailable("Host rejected the request — check its agent token");
  }
  let message = err.message;
  try {
    const parsed: unknown = JSON.parse(err.body);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      message = (parsed as { message: string }).message;
    }
  } catch {
    // Not a JSON body — fall back to HostRequestError's own message.
  }
  return reply.code(err.statusCode).send({ message });
}

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
          if (isTransientReadError(err)) {
            app.log.warn({ projectId, err }, "agent-rules read permission denied");
            return reply.serviceUnavailable("Permission denied reading agent rule files");
          }
          throw err;
        }
      }
      try {
        return await getRemoteHostClient(app, project.hostId).resolveAgentRules(project.cwd);
      } catch (err) {
        if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, agent rules unavailable");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  // PUT /api/projects/:id/agent-rules/:target — writes either a project- or
  // global-scope target, routed to project.hostId either way (see file
  // header). The read-back (getAgentRule) is wrapped in the same try/catch
  // as the write itself — Hermes review, PR #458: it used to sit outside,
  // so a hung read on the immediate read-back surfaced as an uncaught 500
  // instead of the 503 the GET route already maps AgentRulesTimeoutError to.
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

      if (project.hostId === LOCAL_HOST_ID) {
        try {
          writeAgentRule(target, project.cwd, request.body.content);
          return await getAgentRule(target, project.cwd);
        } catch (err) {
          if (err instanceof AgentRuleTooLargeError) return reply.badRequest(err.message);
          if (err instanceof AgentRuleSymlinkError) return reply.badRequest(err.message);
          if (err instanceof AgentRulesTimeoutError) {
            return reply.serviceUnavailable("Timed out reading agent rule file");
          }
          // Independent review, PR #458 — the round-6 fix's own comment
          // said the point was giving EACCES a clean 503 "instead of a raw
          // unstructured 500," but only carried that through to the GET
          // routes. A root-owned or otherwise-unwritable rule file hits
          // this exact path too.
          if (isTransientReadError(err)) {
            return reply.serviceUnavailable("Permission denied accessing agent rule file");
          }
          throw err;
        }
      }
      try {
        return await getRemoteHostClient(app, project.hostId).writeAgentRule(
          project.cwd,
          target.id,
          request.body.content,
        );
      } catch (err) {
        if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
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

      if (project.hostId === LOCAL_HOST_ID) {
        try {
          deleteAgentRule(target, project.cwd);
        } catch (err) {
          // Independent review, PR #458 — same EACCES-to-503 gap as the
          // write path: this had no try/catch at all before.
          if (isTransientReadError(err)) {
            return reply.serviceUnavailable("Permission denied accessing agent rule file");
          }
          throw err;
        }
        reply.code(204);
        return;
      }
      try {
        await getRemoteHostClient(app, project.hostId).deleteAgentRule(project.cwd, target.id);
        reply.code(204);
      } catch (err) {
        if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
        app.log.warn(
          { hostId: project.hostId, err },
          "host unreachable, could not delete agent rule",
        );
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );
}
