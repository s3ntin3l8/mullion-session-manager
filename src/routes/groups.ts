import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { groups } from "../db/schema.js";

interface CreateGroupBody {
  name: string;
}

interface UpdateGroupBody {
  name?: string;
  icon?: string | null;
  color?: string | null;
  collapsed?: boolean;
  position?: number;
}

const createGroupSchema = {
  body: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
    },
  },
};

const updateGroupSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1 },
      icon: { type: ["string", "null"] },
      color: { type: ["string", "null"] },
      collapsed: { type: "boolean" },
      position: { type: "integer" },
    },
  },
};

export async function groupsRoute(app: FastifyInstance) {
  app.get("/api/groups", async () => {
    return app.db.select().from(groups).all();
  });

  app.post<{ Body: CreateGroupBody }>(
    "/api/groups",
    { schema: createGroupSchema },
    async (request, reply) => {
      const [created] = app.db.insert(groups).values({ name: request.body.name }).returning().all();
      reply.code(201);
      return created;
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateGroupBody }>(
    "/api/groups/:id",
    { schema: updateGroupSchema },
    async (request, reply) => {
      const groupId = Number(request.params.id);
      if (!Number.isInteger(groupId)) return reply.badRequest("Invalid group id");

      const { name, icon, color, collapsed, position } = request.body;
      const updated = app.db
        .update(groups)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(icon !== undefined ? { icon } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(collapsed !== undefined ? { collapsed } : {}),
          ...(position !== undefined ? { position } : {}),
        })
        .where(eq(groups.id, groupId))
        .returning()
        .all();
      if (updated.length === 0) return reply.notFound();
      return updated[0];
    },
  );

  // Hard delete — a group is pure view metadata (like a workspace). Its
  // member workspaces' groupId is set null by the schema's ON DELETE SET
  // NULL, so they survive ungrouped rather than being deleted.
  app.delete<{ Params: { id: string } }>("/api/groups/:id", async (request, reply) => {
    const groupId = Number(request.params.id);
    if (!Number.isInteger(groupId)) return reply.badRequest("Invalid group id");

    const deleted = app.db.delete(groups).where(eq(groups.id, groupId)).returning().all();
    if (deleted.length === 0) return reply.notFound();
    reply.code(204);
  });
}
