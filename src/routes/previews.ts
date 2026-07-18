import type { FastifyInstance } from "fastify";
import {
  UnknownProjectError,
  createExternalPreview,
  deletePreviewBySlug,
  getOrCreateProjectPreview,
  getPreviewBySlug,
} from "../services/preview-registry.js";

interface CreatePreviewBody {
  kind: "project" | "external";
  projectId?: number;
  url?: string;
}

const createPreviewSchema = {
  body: {
    type: "object",
    required: ["kind"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["project", "external"] },
      projectId: { type: "number" },
      url: { type: "string", minLength: 1 },
    },
  },
};

// Only a well-formedness check — full SSRF-range validation (blocking
// loopback/private/link-local targets) is issue #28 phase 5, which extracts
// and re-polarizes the guard already in src/routes/hosts.ts (that one
// deliberately *allows* loopback for admin-trust host config; this path
// needs the opposite policy since it's driven by whatever URL a user types
// into a pane). Nothing acts on `previews.externalUrl` yet in this phase —
// no proxy route exists until phase 2/5 — so this row is otherwise inert.
function isWellFormedHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function previewsRoute(app: FastifyInstance) {
  // Opt-in feature (see plugins/env.ts): with no base host configured, a
  // created preview row could never resolve to a working "preview-<slug>"
  // subdomain, so don't register these routes — creation must 404 rather
  // than silently succeed into a dead end.
  if (app.config.PREVIEW_BASE_HOST.trim() === "") return;

  app.post<{ Body: CreatePreviewBody }>(
    "/api/previews",
    { schema: createPreviewSchema },
    async (request, reply) => {
      const { kind } = request.body;

      if (kind === "project") {
        const { projectId } = request.body;
        if (typeof projectId !== "number" || !Number.isInteger(projectId)) {
          return reply.badRequest('projectId is required for kind "project"');
        }
        try {
          const preview = getOrCreateProjectPreview(app, projectId);
          reply.code(201);
          return preview;
        } catch (err) {
          if (err instanceof UnknownProjectError) return reply.notFound(err.message);
          throw err;
        }
      }

      const { url } = request.body;
      if (typeof url !== "string" || !isWellFormedHttpUrl(url)) {
        return reply.badRequest('url must be a valid http(s) URL for kind "external"');
      }
      const preview = createExternalPreview(app, url);
      reply.code(201);
      return preview;
    },
  );

  app.get<{ Params: { slug: string } }>("/api/previews/:slug", async (request, reply) => {
    const preview = getPreviewBySlug(app, request.params.slug);
    if (!preview) return reply.notFound();
    return preview;
  });

  app.delete<{ Params: { slug: string } }>("/api/previews/:slug", async (request, reply) => {
    const deleted = deletePreviewBySlug(app, request.params.slug);
    if (!deleted) return reply.notFound();
    reply.code(204);
  });
}
