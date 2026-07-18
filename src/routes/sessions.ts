import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { getStoredSettings } from "../services/settings.js";
import { resolveBackend } from "../services/session-backend.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import type { SessionInfo } from "../services/pty-manager.js";

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

function withLiveInfo(row: typeof sessions.$inferSelect, info: SessionInfo | null | undefined) {
  return {
    ...row,
    alive: info?.alive ?? false,
    subscriberCount: info?.subscriberCount ?? 0,
    // Live-only (in-memory PtyManager state on whichever host owns this
    // session, local or remote — see pty-manager.ts's SessionInfo doc
    // comments for what each means and WS-6's "collect the signals, don't
    // over-promise the classifier" scope). Falls back to idle/no-signal
    // defaults for a session this process hasn't tracked yet (e.g. right
    // after a restart, before anything has re-attached) or whose host is
    // currently unreachable (issue #26 — never a 500, just stale defaults).
    activity: info?.activity ?? "idle",
    lastActivityAt: info?.lastActivityAt ?? null,
    attention: info?.attention ?? false,
    attentionAt: info?.attentionAt ?? null,
    lastTitle: info?.lastTitle ?? null,
  };
}

/** hostId of the project a session row belongs to — "local" for any row
 * whose project is missing (shouldn't happen; projectId is a required FK)
 * or genuinely local, keeping every call site's fallback identical. */
function resolveProjectHostId(app: FastifyInstance, projectId: number): string {
  const [project] = app.db
    .select({ hostId: projects.hostId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .all();
  return project?.hostId ?? LOCAL_HOST_ID;
}

async function withLiveStatus(
  app: FastifyInstance,
  row: typeof sessions.$inferSelect,
  idleThresholdMs: number,
  hostId: string,
) {
  let info: SessionInfo | null = null;
  try {
    const map = await resolveBackend(app, hostId).liveStatus([String(row.id)], idleThresholdMs);
    info = map[String(row.id)] ?? null;
  } catch (err) {
    app.log.warn(
      { hostId, sessionId: row.id, err },
      "host unreachable, reporting default live status",
    );
  }
  return withLiveInfo(row, info);
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
      // Settings -> Notifications & status' "Idle threshold" (default 30s) —
      // read once per request, not per row.
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      if (rows.length === 0) return [];

      // Batch by host so a remote agent gets exactly one bulkLiveStatus
      // call for this whole list, not one HTTP round trip per session (see
      // remote-host-client.ts's short-TTL cache for the same concern when
      // several requests like this land close together). Only the projects
      // these rows actually reference, not a full table scan.
      const projectIds = [...new Set(rows.map((row) => row.projectId))];
      const projectHostIds = new Map(
        app.db
          .select({ id: projects.id, hostId: projects.hostId })
          .from(projects)
          .where(inArray(projects.id, projectIds))
          .all()
          .map((p) => [p.id, p.hostId] as const),
      );
      const idsByHost = new Map<string, string[]>();
      for (const row of rows) {
        const hostId = projectHostIds.get(row.projectId) ?? LOCAL_HOST_ID;
        const ids = idsByHost.get(hostId) ?? [];
        ids.push(String(row.id));
        idsByHost.set(hostId, ids);
      }

      const liveByHost = new Map<string, Record<string, SessionInfo | null>>();
      await Promise.all(
        [...idsByHost.entries()].map(async ([hostId, ids]) => {
          try {
            liveByHost.set(
              hostId,
              await resolveBackend(app, hostId).liveStatus(ids, idleThresholdMs),
            );
          } catch (err) {
            app.log.warn(
              { hostId, err },
              "host unreachable, reporting default live status for its sessions",
            );
            liveByHost.set(hostId, Object.create(null));
          }
        }),
      );

      return rows.map((row) => {
        const hostId = projectHostIds.get(row.projectId) ?? LOCAL_HOST_ID;
        const info = liveByHost.get(hostId)?.[String(row.id)];
        return withLiveInfo(row, info);
      });
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

      try {
        await resolveBackend(app, project.hostId).spawn({
          id: String(created.id),
          cwd: cwd ?? project.cwd,
          command,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        });
      } catch (err) {
        // Remote-spawn rollback (issue #26): a local spawn() never throws
        // this way (see session-backend.ts's LocalBackend doc comment), so
        // this path is only reachable for a remote host — leaving the row
        // behind would be DB litter for a session that was never actually
        // spawned anywhere.
        app.db.delete(sessions).where(eq(sessions.id, created.id)).run();
        app.log.error({ err, hostId: project.hostId }, "session spawn failed, rolled back row");
        return reply.badGateway("Failed to spawn session on host");
      }

      reply.code(201);
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      return withLiveStatus(app, created, idleThresholdMs, project.hostId);
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
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      const hostId = resolveProjectHostId(app, updated[0].projectId);
      return withLiveStatus(app, updated[0], idleThresholdMs, hostId);
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

    const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    if (!row) return reply.notFound();

    const hostId = resolveProjectHostId(app, row.projectId);
    await resolveBackend(app, hostId).terminate(String(sessionId));

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
