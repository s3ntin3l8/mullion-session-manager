import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { workspaces } from "../db/schema.js";

interface CreateWorkspaceBody {
  name: string;
}

interface UpdateWorkspaceBody {
  name?: string;
  // Accepted as an opaque JSON object (dockview's own api.toJSON() shape) —
  // this route never inspects it, just stringifies/parses it. Same
  // philosophy as sessions.command being an opaque string.
  layout?: Record<string, unknown>;
  // null ungroups the workspace; omit to leave its group membership as-is.
  groupId?: number | null;
  position?: number;
}

const createWorkspaceSchema = {
  body: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
    },
  },
};

const updateWorkspaceSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1 },
      layout: { type: "object", additionalProperties: true },
      groupId: { type: ["integer", "null"] },
      position: { type: "integer" },
    },
  },
};

function serialize(row: typeof workspaces.$inferSelect) {
  return {
    ...row,
    layout: row.layout ? (JSON.parse(row.layout) as Record<string, unknown>) : null,
  };
}

export async function workspacesRoute(app: FastifyInstance) {
  app.get("/api/workspaces", async () => {
    return app.db.select().from(workspaces).all().map(serialize);
  });

  app.post<{ Body: CreateWorkspaceBody }>(
    "/api/workspaces",
    { schema: createWorkspaceSchema },
    async (request, reply) => {
      const [created] = app.db
        .insert(workspaces)
        .values({ name: request.body.name, layout: null })
        .returning()
        .all();
      reply.code(201);
      return serialize(created);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateWorkspaceBody }>(
    "/api/workspaces/:id",
    { schema: updateWorkspaceSchema },
    async (request, reply) => {
      const workspaceId = Number(request.params.id);
      if (!Number.isInteger(workspaceId)) return reply.badRequest("Invalid workspace id");

      const { name, layout, groupId, position } = request.body;
      const updated = app.db
        .update(workspaces)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(layout !== undefined ? { layout: JSON.stringify(layout) } : {}),
          ...(groupId !== undefined ? { groupId } : {}),
          ...(position !== undefined ? { position } : {}),
        })
        .where(eq(workspaces.id, workspaceId))
        .returning()
        .all();
      if (updated.length === 0) return reply.notFound();
      return serialize(updated[0]);
    },
  );

  // Hard delete — a workspace is pure view metadata (a saved layout), not a
  // durable process like a session, so there's nothing to orphan by removing
  // the row outright (unlike sessions.ts's killed tombstone).
  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    const workspaceId = Number(request.params.id);
    if (!Number.isInteger(workspaceId)) return reply.badRequest("Invalid workspace id");

    const deleted = app.db
      .delete(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .returning()
      .all();
    if (deleted.length === 0) return reply.notFound();
    reply.code(204);
  });
}
