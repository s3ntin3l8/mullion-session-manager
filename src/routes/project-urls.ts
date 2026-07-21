import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, projectUrls } from "../db/schema.js";

interface CreateProjectUrlBody {
  label: string;
  url: string;
  favorite?: boolean;
}

interface UpdateProjectUrlBody {
  label?: string;
  url?: string;
  favorite?: boolean;
}

interface ReorderBody {
  ids: number[];
}

const createUrlSchema = {
  body: {
    type: "object",
    required: ["label", "url"],
    additionalProperties: false,
    properties: {
      label: { type: "string", minLength: 1 },
      url: { type: "string", minLength: 1 },
      favorite: { type: "boolean" },
    },
  },
};

const updateUrlSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      label: { type: "string", minLength: 1 },
      url: { type: "string", minLength: 1 },
      favorite: { type: "boolean" },
    },
  },
};

const reorderSchema = {
  body: {
    type: "object",
    required: ["ids"],
    additionalProperties: false,
    properties: {
      ids: { type: "array", items: { type: "number" }, minItems: 1 },
    },
  },
};

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getProjectOr404(app: FastifyInstance, projectId: number) {
  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  return project ?? null;
}

export async function projectUrlsRoute(app: FastifyInstance) {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/urls",
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(app, projectId)) return reply.notFound("Project not found");

      return app.db
        .select()
        .from(projectUrls)
        .where(eq(projectUrls.projectId, projectId))
        .orderBy(projectUrls.order)
        .all();
    },
  );

  app.post<{ Params: { projectId: string }; Body: CreateProjectUrlBody }>(
    "/api/projects/:projectId/urls",
    { schema: createUrlSchema },
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(app, projectId)) return reply.notFound("Project not found");

      const { label, url, favorite } = request.body;
      if (!isValidUrl(url)) {
        return reply.badRequest("url must be a valid http(s) URL");
      }

      const existing = app.db
        .select({ order: projectUrls.order })
        .from(projectUrls)
        .where(eq(projectUrls.projectId, projectId))
        .all();
      const nextOrder = existing.length > 0 ? Math.max(...existing.map((r) => r.order)) + 1 : 0;

      const [created] = app.db
        .insert(projectUrls)
        .values({ projectId, label, url, favorite: favorite ?? false, order: nextOrder })
        .returning()
        .all();
      reply.code(201);
      return created;
    },
  );

  app.patch<{ Params: { projectId: string; urlId: string }; Body: UpdateProjectUrlBody }>(
    "/api/projects/:projectId/urls/:urlId",
    { schema: updateUrlSchema },
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      const urlId = Number(request.params.urlId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!Number.isInteger(urlId)) return reply.badRequest("Invalid url id");

      const [existing] = app.db
        .select()
        .from(projectUrls)
        .where(and(eq(projectUrls.id, urlId), eq(projectUrls.projectId, projectId)))
        .all();
      if (!existing) return reply.notFound();

      const { label, url, favorite } = request.body;
      if (url !== undefined && !isValidUrl(url)) {
        return reply.badRequest("url must be a valid http(s) URL");
      }

      const [updated] = app.db
        .update(projectUrls)
        .set({
          ...(label !== undefined ? { label } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(favorite !== undefined ? { favorite } : {}),
        })
        .where(eq(projectUrls.id, urlId))
        .returning()
        .all();
      if (!updated) return reply.notFound();
      return updated;
    },
  );

  app.delete<{ Params: { projectId: string; urlId: string } }>(
    "/api/projects/:projectId/urls/:urlId",
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      const urlId = Number(request.params.urlId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!Number.isInteger(urlId)) return reply.badRequest("Invalid url id");

      const [existing] = app.db
        .select()
        .from(projectUrls)
        .where(and(eq(projectUrls.id, urlId), eq(projectUrls.projectId, projectId)))
        .all();
      if (!existing) return reply.notFound();

      app.db.delete(projectUrls).where(eq(projectUrls.id, urlId)).run();
      reply.code(204);
    },
  );

  app.patch<{ Params: { projectId: string }; Body: ReorderBody }>(
    "/api/projects/:projectId/urls/reorder",
    { schema: reorderSchema },
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(app, projectId)) return reply.notFound("Project not found");

      const { ids } = request.body;

      const existingIds = new Set(
        app.db
          .select({ id: projectUrls.id })
          .from(projectUrls)
          .where(eq(projectUrls.projectId, projectId))
          .all()
          .map((r) => r.id),
      );
      for (const id of ids) {
        if (!existingIds.has(id)) {
          return reply.badRequest(`URL id ${id} does not belong to this project`);
        }
      }

      for (let i = 0; i < ids.length; i++) {
        app.db.update(projectUrls).set({ order: i }).where(eq(projectUrls.id, ids[i])).run();
      }

      reply.code(204);
    },
  );
}
