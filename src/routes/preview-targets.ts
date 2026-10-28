import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { projectPreviewTargets, projects } from "../db/schema.js";
import { normalizePreviewDestination } from "../services/preview-targets.js";

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
  const read = (projectId: number) => ({
    devServerUrl: app.db.select().from(projects).where(eq(projects.id, projectId)).get()!
      .devServerUrl,
    targets: app.db
      .select()
      .from(projectPreviewTargets)
      .where(eq(projectPreviewTargets.projectId, projectId))
      .orderBy(asc(projectPreviewTargets.order))
      .all(),
  });
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/preview-targets",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || !app.db.select().from(projects).where(eq(projects.id, id)).get())
        return reply.notFound("Project not found");
      return read(id);
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
      if (!Number.isInteger(id) || !app.db.select().from(projects).where(eq(projects.id, id)).get())
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
        const existing = app.db
          .select()
          .from(projectPreviewTargets)
          .where(eq(projectPreviewTargets.id, target.id))
          .get();
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
      app.db.transaction((tx) => {
        tx.update(projects)
          .set({
            devServerUrl: rawDefault && /^\d+$/.test(rawDefault) ? rawDefault : normalizedDefault,
          })
          .where(eq(projects.id, id))
          .run();
        const old = tx
          .select()
          .from(projectPreviewTargets)
          .where(eq(projectPreviewTargets.projectId, id))
          .all();
        // Update in place: retained target IDs keep their existing preview slugs.
        old
          .filter((target) => !ids.has(target.id))
          .forEach((target) =>
            tx.delete(projectPreviewTargets).where(eq(projectPreviewTargets.id, target.id)).run(),
          );
        normalized.forEach((target, order) =>
          tx
            .insert(projectPreviewTargets)
            .values({ ...target, projectId: id, order })
            .onConflictDoUpdate({ target: projectPreviewTargets.id, set: { ...target, order } })
            .run(),
        );
      });
      return read(id);
    },
  );
}
