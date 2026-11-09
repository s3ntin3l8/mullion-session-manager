import type { FastifyInstance } from "fastify";
import { normalizePreviewDestination } from "../services/preview-targets.js";
import {
  getPreviewTarget,
  readProjectPreviewTargets,
  saveProjectPreviewTargets,
} from "../services/preview-registry.js";

interface TargetInput {
  id: string;
  name: string;
  destination: string;
  connectionOrigin: "project" | "primary";
}
interface TargetsBody {
  devServerUrl: string | null;
  targets: TargetInput[];
}

export async function previewTargetsRoute(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/preview-targets",
    async (request, reply) => {
      const id = Number(request.params.id);
      const current = Number.isInteger(id) ? readProjectPreviewTargets(app, id) : undefined;
      if (!current) return reply.notFound("Project not found");
      return current;
    },
  );
  app.put<{ Params: { id: string }; Body: TargetsBody }>(
    "/api/projects/:id/preview-targets",
    {
      schema: {
        body: {
          type: "object",
          required: ["devServerUrl", "targets"],
          properties: {
            devServerUrl: { type: ["string", "null"] },
            targets: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                required: ["id", "name", "destination", "connectionOrigin"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" },
                  name: { type: "string", minLength: 1, maxLength: 128 },
                  destination: { type: "string", minLength: 1, maxLength: 4096 },
                  connectionOrigin: { type: "string", enum: ["project", "primary"] },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || !readProjectPreviewTargets(app, id))
        return reply.notFound("Project not found");
      const { targets } = request.body;
      const rawDefault = request.body.devServerUrl?.trim() || null;
      const normalizedDefault = rawDefault ? normalizePreviewDestination(rawDefault) : null;
      if (rawDefault && !normalizedDefault)
        return reply.badRequest("Dev server must be a port or an HTTP(S) destination");
      const ids = new Set<string>();
      const normalized: TargetInput[] = [];
      for (const target of targets) {
        const destination = normalizePreviewDestination(target.destination);
        if (!destination || !target.name.trim() || ids.has(target.id))
          return reply.badRequest(
            "Targets need unique IDs, nonempty names and valid HTTP(S) destinations",
          );
        const existing = getPreviewTarget(app, target.id);
        if (existing && existing.projectId !== id)
          return reply.badRequest("Target belongs to another project");
        ids.add(target.id);
        normalized.push({
          id: target.id,
          name: target.name.trim(),
          destination,
          connectionOrigin: target.connectionOrigin,
        });
      }
      saveProjectPreviewTargets(
        app,
        id,
        rawDefault && /^\d+$/.test(rawDefault) ? rawDefault : normalizedDefault,
        normalized,
      );
      return readProjectPreviewTargets(app, id)!;
    },
  );
}
