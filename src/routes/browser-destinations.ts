import type { FastifyInstance } from "fastify";
import type { BrowserDestinations } from "../shared/types.js";
import {
  listBrowserDestinations,
  openRunningDestinationPreview,
} from "../services/browser-destinations.js";
import { sessionBrowserHost } from "../services/browser-handoff.js";

// #3003 — the Browser pane's quick pick (docs/browser-previews.md, "Quick
// pick"). The list is read-only; opening a running service in the preview
// creates (or reuses) the preview that serves its port.

interface OpenBody {
  key: string;
}

const openSchema = {
  body: {
    type: "object",
    required: ["key"],
    additionalProperties: false,
    properties: { key: { type: "string", minLength: 1, maxLength: 512 } },
  },
};

function parseProjectId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

export async function browserDestinationsRoute(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { sessionId?: string } }>(
    "/api/projects/:id/browser-destinations",
    // Shells out to `docker` for a local project, like the Dock route, and
    // shares its sizing: the 10s discovery cache keeps the real cost flat.
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = parseProjectId(request.params.id);
      if (projectId === null) return reply.badRequest("Invalid project id");
      const result = await listBrowserDestinations(app, projectId);
      if (!result) return reply.notFound("Project not found");
      // `?sessionId=`: where that session's browser runs, resolved as ⇄
      // resolves it, so the pane knows which `localhost` entries it can load.
      let agentBrowser: BrowserDestinations["agentBrowser"] = null;
      const rawSession = request.query.sessionId;
      if (rawSession !== undefined) {
        const sessionId = Number(rawSession);
        if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");
        const host = await sessionBrowserHost(app, sessionId);
        if (!host || host.projectId !== projectId) {
          return reply.notFound("Session not found in this project");
        }
        agentBrowser = host.result.ok
          ? { hostId: host.result.hostId, reason: null }
          : { hostId: null, reason: host.result.reason };
      }
      const body: BrowserDestinations = { ...result, agentBrowser };
      return body;
    },
  );

  app.post<{ Params: { id: string }; Body: OpenBody }>(
    "/api/projects/:id/browser-destinations/preview",
    { schema: openSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = parseProjectId(request.params.id);
      if (projectId === null) return reply.badRequest("Invalid project id");
      // Without the proxy a preview row could never be served (previews.ts
      // registers no create route then either); the pane embeds the address.
      if (app.config.PREVIEW_BASE_HOST.trim() === "") {
        return reply.conflict("Previews of a running service need PREVIEW_BASE_HOST");
      }
      const result = await openRunningDestinationPreview(app, projectId, request.body.key);
      if (!result) return reply.notFound("Project not found");
      if (!result.ok) return reply.notFound(result.message);
      return { slug: result.slug, label: result.label };
    },
  );
}
