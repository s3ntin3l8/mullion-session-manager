import type { FastifyInstance } from "fastify";
import {
  DEFAULT_WORKSPACE_NAME,
  createWorkspace,
  deleteWorkspace,
  listWorkspacesSeeded,
  updateWorkspace,
  type WorkspaceRow,
} from "../services/workspaces-store.js";

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

function serialize(row: WorkspaceRow) {
  return {
    ...row,
    layout: row.layout ? (JSON.parse(row.layout) as Record<string, unknown>) : null,
  };
}

// Re-exported so existing importers keep their path.
export { DEFAULT_WORKSPACE_NAME };

export async function workspacesRoute(app: FastifyInstance) {
  // Issue #1618 — a fresh (or fully emptied) database must never list zero
  // workspaces: the frontend's layout-change subscription and autosave are
  // keyed on an active workspace id, so an empty list left the first tiled
  // session behind the "Nothing tiled here yet" overlay with nothing
  // persisted. The common (non-empty) case is a plain WAL snapshot read and
  // never touches the write lock. Only an empty read enters an `immediate`
  // transaction, which takes the write lock BEFORE re-checking, so the
  // check-then-insert is atomic against a second connection to the same
  // file too (within this process the synchronous better-sqlite3 calls
  // can't interleave anyway). If another connection already holds the write
  // lock past busy_timeout (src/db/client.ts, `busy_timeout = 5000`), this
  // `immediate` transaction throws SQLITE_BUSY and the route returns 500.
  // The dashboard retries that (App.tsx's bounded workspace load). The one
  // bare client does not: `scripts/demo/seed.mjs` (its fetch wrapper has no
  // retry; issue #1638). The `mullion` CLI never calls this route. Note this
  // makes a GET write (at most this one fixed row) — a documented exception
  // to auth.ts's "a bare GET can't mutate state" premise; see the note there.
  app.get("/api/workspaces", async () => {
    const rows = listWorkspacesSeeded(app.db);
    return rows.map(serialize);
  });

  app.post<{ Body: CreateWorkspaceBody }>(
    "/api/workspaces",
    { schema: createWorkspaceSchema },
    async (request, reply) => {
      const created = createWorkspace(app.db, request.body.name);
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
      const updated = updateWorkspace(app.db, workspaceId, {
        name,
        layout: layout !== undefined ? JSON.stringify(layout) : undefined,
        groupId,
        position,
      });
      if (!updated) return reply.notFound();
      return serialize(updated);
    },
  );

  // Hard delete — a workspace is pure view metadata (a saved layout), not a
  // durable process like a session, so there's nothing to orphan by removing
  // the row outright (unlike sessions.ts's killed tombstone).
  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    const workspaceId = Number(request.params.id);
    if (!Number.isInteger(workspaceId)) return reply.badRequest("Invalid workspace id");

    if (!deleteWorkspace(app.db, workspaceId)) return reply.notFound();
    reply.code(204);
  });
}
