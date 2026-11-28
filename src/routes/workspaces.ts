import type { FastifyInstance } from "fastify";
import {
  DEFAULT_WORKSPACE_NAME,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspacesSeeded,
  updateWorkspace,
  type WorkspaceRow,
} from "../services/workspaces-store.js";
import {
  listPendingOpens,
  recordPendingOpen,
  removePendingOpen,
  workspaceExists,
  type PendingOpenRow,
} from "../services/workspace-pending-opens.js";
import {
  pinnedProjectIds,
  pinnedProjectIdsByWorkspace,
  replacePinnedProjects,
  unknownProjectIds,
} from "../services/workspace-pinned-projects.js";

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
  // #3537 — replaces the workspace's pinned projects (in this order); omit to
  // leave them as-is, [] to clear them. Duplicates are dropped.
  pinnedProjectIds?: number[];
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
      pinnedProjectIds: { type: "array", items: { type: "integer" } },
    },
  },
};

const recordPendingOpenSchema = {
  body: {
    type: "object",
    required: ["sessionId"],
    additionalProperties: false,
    properties: {
      sessionId: { type: "integer" },
      referenceSessionId: { type: ["integer", "null"] },
    },
  },
};

function serializePendingOpen(row: PendingOpenRow) {
  return {
    sessionId: row.sessionId,
    referenceSessionId: row.referenceSessionId,
    createdAt: row.createdAt.toISOString(),
  };
}

function serialize(row: WorkspaceRow, pinned: number[]) {
  return {
    ...row,
    layout: row.layout ? (JSON.parse(row.layout) as Record<string, unknown>) : null,
    // #3537 — ordered by position.
    pinnedProjectIds: pinned,
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
    const pins = pinnedProjectIdsByWorkspace(app.db);
    return rows.map((row) => serialize(row, pins.get(row.id) ?? []));
  });

  app.post<{ Body: CreateWorkspaceBody }>(
    "/api/workspaces",
    { schema: createWorkspaceSchema },
    async (request, reply) => {
      const created = createWorkspace(app.db, request.body.name);
      reply.code(201);
      return serialize(created, []);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateWorkspaceBody }>(
    "/api/workspaces/:id",
    { schema: updateWorkspaceSchema },
    async (request, reply) => {
      const workspaceId = Number(request.params.id);
      if (!Number.isInteger(workspaceId)) return reply.badRequest("Invalid workspace id");

      const { name, layout, groupId, position, pinnedProjectIds: pins } = request.body;
      const hasWorkspaceFields =
        name !== undefined ||
        layout !== undefined ||
        groupId !== undefined ||
        position !== undefined;
      // One transaction: an unknown project id is refused before anything is
      // written, so a 400 leaves the name, layout and pins as they were. A
      // missing workspace is a 404 first, whatever the pin list says.
      const result = app.db.transaction((tx) => {
        if (pins !== undefined) {
          if (!getWorkspace(tx, workspaceId)) return { kind: "not-found" as const };
          const unknown = unknownProjectIds(tx, pins);
          if (unknown.length > 0) return { kind: "unknown-projects" as const, unknown };
        }
        // A pins-only PATCH never runs an empty UPDATE ... SET; it reads the
        // row instead, which doubles as the 404 check.
        const row = hasWorkspaceFields
          ? updateWorkspace(tx, workspaceId, {
              name,
              layout: layout !== undefined ? JSON.stringify(layout) : undefined,
              groupId,
              position,
            })
          : getWorkspace(tx, workspaceId);
        if (!row) return { kind: "not-found" as const };
        if (pins !== undefined) replacePinnedProjects(tx, workspaceId, pins);
        return { kind: "ok" as const, row, pinned: pinnedProjectIds(tx, workspaceId) };
      });
      if (result.kind === "unknown-projects") {
        return reply.badRequest(`Unknown project id(s): ${result.unknown.join(", ")}`);
      }
      if (result.kind === "not-found") return reply.notFound();
      return serialize(result.row, result.pinned);
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

  // #3033 — sessions opened in this workspace on the fold or the phone, which
  // never save the layout. A desktop client lists them, adds each pane with
  // its own dockview API, then acknowledges it. None of these routes reads or
  // writes `workspaces.layout`.
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/pending-opens",
    async (request, reply) => {
      const workspaceId = Number(request.params.id);
      if (!Number.isInteger(workspaceId)) return reply.badRequest("Invalid workspace id");
      if (!workspaceExists(app.db, workspaceId)) return reply.notFound();
      return listPendingOpens(app.db, workspaceId).map(serializePendingOpen);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { sessionId: number; referenceSessionId?: number | null };
  }>(
    "/api/workspaces/:id/pending-opens",
    { schema: recordPendingOpenSchema },
    async (request, reply) => {
      const workspaceId = Number(request.params.id);
      if (!Number.isInteger(workspaceId)) return reply.badRequest("Invalid workspace id");
      const { sessionId, referenceSessionId = null } = request.body;
      const result = recordPendingOpen(app.db, workspaceId, sessionId, referenceSessionId);
      if (!result.ok) {
        if (result.reason === "killed") return reply.conflict("Session was killed");
        return reply.notFound(
          result.reason === "workspace" ? "Workspace not found" : "Session not found",
        );
      }
      // One code for a new open and a re-record (an upsert): telling them
      // apart would cost a racy extra read for a status code nobody uses.
      reply.code(201);
      return serializePendingOpen(result.row);
    },
  );

  // Acknowledge: the desktop applied the open (or found nothing to add). One
  // atomic delete, so of two desktop tabs only one reads `acknowledged: true`;
  // a second acknowledge is a no-op that reads false.
  app.post<{ Params: { id: string; sessionId: string } }>(
    "/api/workspaces/:id/pending-opens/:sessionId/ack",
    async (request, reply) => {
      const workspaceId = Number(request.params.id);
      const sessionId = Number(request.params.sessionId);
      if (!Number.isInteger(workspaceId) || !Number.isInteger(sessionId)) {
        return reply.badRequest("Invalid id");
      }
      if (!workspaceExists(app.db, workspaceId)) return reply.notFound();
      return { acknowledged: removePendingOpen(app.db, workspaceId, sessionId) };
    },
  );

  // Withdraw: the pane was closed on the fold or the phone before the desk
  // applied it. Idempotent.
  app.delete<{ Params: { id: string; sessionId: string } }>(
    "/api/workspaces/:id/pending-opens/:sessionId",
    async (request, reply) => {
      const workspaceId = Number(request.params.id);
      const sessionId = Number(request.params.sessionId);
      if (!Number.isInteger(workspaceId) || !Number.isInteger(sessionId)) {
        return reply.badRequest("Invalid id");
      }
      if (!workspaceExists(app.db, workspaceId)) return reply.notFound();
      removePendingOpen(app.db, workspaceId, sessionId);
      reply.code(204);
    },
  );
}
