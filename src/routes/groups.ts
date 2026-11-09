import type { FastifyInstance } from "fastify";
import { createGroup, deleteGroup, listGroups, updateGroup } from "../services/groups-store.js";

interface CreateGroupBody {
  name: string;
  color?: string | null;
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
      // Optional so the create-group modal can set the chosen swatch in one
      // call instead of create-then-PATCH; color remains independently
      // settable afterward via PATCH.
      color: { type: ["string", "null"] },
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
    return listGroups(app.db);
  });

  app.post<{ Body: CreateGroupBody }>(
    "/api/groups",
    { schema: createGroupSchema },
    async (request, reply) => {
      const { name, color } = request.body;
      const created = createGroup(app.db, { name, color });
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
      const updated = updateGroup(app.db, groupId, { name, icon, color, collapsed, position });
      if (!updated) return reply.notFound();
      return updated;
    },
  );

  // Hard delete — a group is pure view metadata (like a workspace). Its
  // member workspaces' groupId is set null by the schema's ON DELETE SET
  // NULL, so they survive ungrouped rather than being deleted.
  app.delete<{ Params: { id: string } }>("/api/groups/:id", async (request, reply) => {
    const groupId = Number(request.params.id);
    if (!Number.isInteger(groupId)) return reply.badRequest("Invalid group id");

    if (!deleteGroup(app.db, groupId)) return reply.notFound();
    reply.code(204);
  });
}
