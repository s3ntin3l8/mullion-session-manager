import type { FastifyInstance } from "fastify";
import { getProjectById } from "../services/project-records.js";
import {
  createProjectUrl,
  deleteProjectUrl,
  findProjectUrl,
  listProjectUrlIds,
  listProjectUrls,
  reorderProjectUrls,
  updateProjectUrl,
} from "../services/project-urls-store.js";

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
  const project = getProjectById(app.db, projectId);
  return project ?? null;
}

export async function projectUrlsRoute(app: FastifyInstance) {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/urls",
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(app, projectId)) return reply.notFound("Project not found");

      return listProjectUrls(app.db, projectId);
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

      const created = createProjectUrl(app.db, projectId, { label, url, favorite });
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

      const existing = findProjectUrl(app.db, projectId, urlId);
      if (!existing) return reply.notFound();

      const { label, url, favorite } = request.body;
      if (url !== undefined && !isValidUrl(url)) {
        return reply.badRequest("url must be a valid http(s) URL");
      }

      const updated = updateProjectUrl(app.db, urlId, { label, url, favorite });
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

      const existing = findProjectUrl(app.db, projectId, urlId);
      if (!existing) return reply.notFound();

      deleteProjectUrl(app.db, urlId);
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

      if (new Set(ids).size !== ids.length) {
        return reply.badRequest("ids must not contain duplicates");
      }

      const existingIds = new Set(listProjectUrlIds(app.db, projectId));
      for (const id of ids) {
        if (!existingIds.has(id)) {
          return reply.badRequest(`URL id ${id} does not belong to this project`);
        }
      }

      reorderProjectUrls(app.db, ids);

      reply.code(204);
    },
  );
}
