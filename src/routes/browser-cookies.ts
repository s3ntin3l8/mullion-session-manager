import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import {
  importCookieProfile,
  listCookieProfiles,
  deleteCookieProfile,
} from "../services/browser-cookies.js";

// Phase 3, issue #184 — Settings -> Integrations "Import Browser Cookies"
// UI's backend. Read-and-store only: importing runs synchronously against a
// host file path an operator already has access to (same trust level as
// everything else here — gated by the existing global auth gate, not a new
// authorization model). GET never returns decrypted cookie values, only
// summaries — see browser-cookies.ts's own comment on why.

interface ImportCookiesBody {
  browser: "chrome" | "firefox";
  profilePath: string;
  label: string;
}

const importCookiesSchema = {
  body: {
    type: "object",
    required: ["browser", "profilePath", "label"],
    additionalProperties: false,
    properties: {
      browser: { type: "string", enum: ["chrome", "firefox"] },
      profilePath: { type: "string", minLength: 1 },
      label: { type: "string", minLength: 1 },
    },
  },
};

function getProjectOr404(app: FastifyInstance, projectId: number) {
  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  return project ?? null;
}

export async function browserCookiesRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/browser-cookies",
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(app, projectId)) return reply.notFound("Project not found");

      return listCookieProfiles(app, projectId);
    },
  );

  app.post<{ Params: { projectId: string }; Body: ImportCookiesBody }>(
    "/api/projects/:projectId/browser-cookies/import",
    { schema: importCookiesSchema },
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(app, projectId)) return reply.notFound("Project not found");

      try {
        const summary = importCookieProfile(app, projectId, request.body);
        reply.code(201);
        return summary;
      } catch (err) {
        app.log.warn(
          { err, projectId, browser: request.body.browser, label: request.body.label },
          "browser cookie import failed",
        );
        return reply.badRequest((err as Error).message);
      }
    },
  );

  app.delete<{ Params: { projectId: string; id: string } }>(
    "/api/projects/:projectId/browser-cookies/:id",
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      const id = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!Number.isInteger(id)) return reply.badRequest("Invalid cookie profile id");

      const deleted = deleteCookieProfile(app, projectId, id);
      if (!deleted) return reply.notFound();
      reply.code(204);
    },
  );
}
