import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";

interface CreateSessionBody {
  projectId: number;
  command: string;
  name?: string;
}

interface RenameSessionBody {
  name: string;
}

const createSessionSchema = {
  body: {
    type: "object",
    required: ["projectId", "command"],
    additionalProperties: false,
    properties: {
      projectId: { type: "integer" },
      command: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
    },
  },
};

const renameSessionSchema = {
  body: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
    },
  },
};

// Default terminal size for a session that hasn't had a browser attach yet
// to report its real dimensions — the first WS attach immediately resizes
// to whatever the client actually has (see terminal.ts).
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function withLiveStatus(app: FastifyInstance, row: typeof sessions.$inferSelect) {
  const live = app.pty.get(String(row.id));
  return {
    ...row,
    alive: live?.isAlive ?? false,
    subscriberCount: live?.subscriberCount ?? 0,
  };
}

export async function sessionsRoute(app: FastifyInstance) {
  app.get<{ Querystring: { projectId?: string } }>("/api/sessions", async (request) => {
    const rows = request.query.projectId
      ? app.db
          .select()
          .from(sessions)
          .where(eq(sessions.projectId, Number(request.query.projectId)))
          .all()
      : app.db.select().from(sessions).all();
    return rows.map((row) => withLiveStatus(app, row));
  });

  // Creates the DB row and spawns the session immediately (not lazily on
  // first WS attach) — "New Session" should mean "running now," matching
  // what a user watching a project's session list would expect to see.
  app.post<{ Body: CreateSessionBody }>(
    "/api/sessions",
    { schema: createSessionSchema },
    async (request, reply) => {
      const { projectId, command, name } = request.body;

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.badRequest("Unknown projectId");

      const [created] = app.db
        .insert(sessions)
        .values({ projectId, command, name: name ?? null })
        .returning()
        .all();

      app.pty.getOrCreate({
        id: String(created.id),
        cwd: project.cwd,
        command,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });

      reply.code(201);
      return withLiveStatus(app, created);
    },
  );

  app.patch<{ Params: { id: string }; Body: RenameSessionBody }>(
    "/api/sessions/:id",
    { schema: renameSessionSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const updated = app.db
        .update(sessions)
        .set({ name: request.body.name })
        .where(eq(sessions.id, sessionId))
        .returning()
        .all();
      if (updated.length === 0) return reply.notFound();
      return withLiveStatus(app, updated[0]);
    },
  );

  // Fully ends the session (attach-client, dtach master, and the program
  // itself — see PtyManager.terminate()) and marks the row killed rather
  // than deleting it, so it still shows in history/list. A killed session
  // can never be re-attached (terminal.ts's preValidation rejects it), so
  // leaving the master running would just orphan it forever.
  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const sessionId = Number(request.params.id);
    if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

    await app.pty.terminate(String(sessionId));

    const updated = app.db
      .update(sessions)
      .set({ status: "killed" })
      .where(eq(sessions.id, sessionId))
      .returning()
      .all();
    if (updated.length === 0) return reply.notFound();
    reply.code(204);
  });
}
