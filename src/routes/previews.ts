import type { FastifyInstance } from "fastify";
import {
  UnknownProjectError,
  createExternalPreview,
  deletePreviewBySlug,
  getOrCreateProjectPreview,
  getPreviewBySlug,
} from "../services/preview-registry.js";
import { isAllowedHttpUrl } from "../services/url-guard.js";

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

// Full SSRF-range validation (issue #28 phase 5) — the opposite policy from
// hosts.ts's own use of the same underlying check (services/url-guard.ts):
// this path is driven by whatever URL a user types into a browser pane's
// address bar, a real privilege boundary this server crosses on the
// caller's behalf (it fetches the target and serves the response back),
// not an admin-trust config action. Loopback and RFC1918/ULA private
// ranges are rejected on top of the link-local/shared-NAT/cloud-IMDS
// ranges hosts.ts already blocks unconditionally.
function isAllowedExternalUrl(value: string): boolean {
  return isAllowedHttpUrl(value, { allowLoopback: false, allowPrivate: false });
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
      if (typeof url !== "string" || !isAllowedExternalUrl(url)) {
        return reply.badRequest('url must be a valid, non-private http(s) URL for kind "external"');
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
