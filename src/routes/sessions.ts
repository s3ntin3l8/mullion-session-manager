import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";

interface CreateSessionBody {
  projectId: number;
  command: string;
  name?: string;
  // Overrides the parent project's cwd for this session only — e.g. a
  // launcher/action (src/services/project-config.ts) targeting a monorepo
  // subdirectory. Falls back to the project's own cwd when omitted.
  cwd?: string;
  // "dock" for a session spawned from a project's dock controls (see
  // GET /api/projects/:id/dock) rather than a normal launcher/manual
  // session — lets the client keep dock terminals out of the regular
  // per-project session list. Defaults to "terminal" (the schema default).
  kind?: "terminal" | "dock";
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
      cwd: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["terminal", "dock"] },
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
  const info = live?.toInfo();
  return {
    ...row,
    alive: info?.alive ?? false,
    subscriberCount: info?.subscriberCount ?? 0,
    // Live-only (in-memory PtyManager state, same as alive/subscriberCount
    // above) — see pty-manager.ts's SessionInfo doc comments for what each
    // means and WS-6's "collect the signals, don't over-promise the
    // classifier" scope. Falls back to idle/no-signal defaults for a
    // session this process hasn't tracked yet (e.g. right after a restart,
    // before anything has re-attached).
    activity: info?.activity ?? "idle",
    lastActivityAt: info?.lastActivityAt ?? null,
    attention: info?.attention ?? false,
    attentionAt: info?.attentionAt ?? null,
    lastTitle: info?.lastTitle ?? null,
  };
}

export async function sessionsRoute(app: FastifyInstance) {
  app.get<{ Querystring: { projectId?: string; kind?: string } }>(
    "/api/sessions",
    async (request, reply) => {
      const { kind } = request.query;
      if (kind !== undefined && kind !== "terminal" && kind !== "dock") {
        return reply.badRequest("kind must be 'terminal' or 'dock'");
      }

      const conditions = [
        request.query.projectId !== undefined
          ? eq(sessions.projectId, Number(request.query.projectId))
          : undefined,
        kind !== undefined ? eq(sessions.kind, kind) : undefined,
      ].filter((c) => c !== undefined);

      const rows =
        conditions.length > 0
          ? app.db
              .select()
              .from(sessions)
              .where(and(...conditions))
              .all()
          : app.db.select().from(sessions).all();
      return rows.map((row) => withLiveStatus(app, row));
    },
  );

  // Creates the DB row and spawns the session immediately (not lazily on
  // first WS attach) — "New Session" should mean "running now," matching
  // what a user watching a project's session list would expect to see.
  app.post<{ Body: CreateSessionBody }>(
    "/api/sessions",
    { schema: createSessionSchema },
    async (request, reply) => {
      const { projectId, command, name, cwd, kind } = request.body;

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.badRequest("Unknown projectId");

      const [created] = app.db
        .insert(sessions)
        .values({
          projectId,
          command,
          name: name ?? null,
          cwd: cwd ?? null,
          ...(kind !== undefined ? { kind } : {}),
        })
        .returning()
        .all();

      app.pty.getOrCreate({
        id: String(created.id),
        cwd: cwd ?? project.cwd,
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
