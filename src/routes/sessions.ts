import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { getStoredSettings } from "../services/settings.js";
import { resolveBackend } from "../services/session-backend.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import type { SessionInfo } from "../services/pty-manager.js";
import {
  MAX_UPLOAD_BYTES,
  extensionForMime,
  matchesMagicBytes,
} from "../services/session-upload.js";

// Issue #271 — the launcher's opt-in "isolate this session" toggle: when
// present, the session is created inside a fresh worktree instead of
// `cwd ?? project.cwd` directly. `baseRef` is the base-ref picker's chosen
// value (the roadmap's "picker, not one hardcoded rule" for the interactive
// path — see git-worktree.ts). `branchName` is optional; when omitted, a
// branch name is derived from a generated seed.
export interface WorktreeIntent {
  baseRef: string;
  branchName?: string;
}

interface CreateSessionBody {
  projectId: number;
  command: string;
  name?: string;
  // Overrides the parent project's cwd for this session only — e.g. a
  // launcher/action (src/services/project-config.ts) targeting a monorepo
  // subdirectory. Falls back to the project's own cwd when omitted. Ignored
  // when `worktree` is present — the worktree's own path is the effective
  // cwd in that case.
  cwd?: string;
  // "dock" for a session spawned from a project's dock controls (see
  // GET /api/projects/:id/dock) rather than a normal launcher/manual
  // session — lets the client keep dock terminals out of the regular
  // per-project session list. Defaults to "terminal" (the schema default).
  kind?: "terminal" | "dock";
  worktree?: WorktreeIntent;
}

interface RenameSessionBody {
  name: string;
}

interface ReviewGateBody {
  decision: "approved" | "denied";
  reason?: string;
}

const worktreeIntentSchema = {
  type: "object",
  required: ["baseRef"],
  additionalProperties: false,
  properties: {
    baseRef: { type: "string", minLength: 1 },
    branchName: { type: "string" },
  },
} as const;

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
      worktree: worktreeIntentSchema,
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

// Issue #178 — the minimal review gate's one write endpoint: delivers a
// human's Approve/Deny decision (NotificationBell.tsx) to whichever open
// hook connection is currently blocked waiting for one.
const reviewGateSchema = {
  body: {
    type: "object",
    required: ["decision"],
    additionalProperties: false,
    properties: {
      decision: { type: "string", enum: ["approved", "denied"] },
      reason: { type: "string" },
    },
  },
};

interface PromoteSessionBody {
  baseRef: string;
  branchName?: string;
  seedPrompt?: string;
}

interface DeclinePromoteBody {
  reason?: string;
}

// Issue #271 — option 2's "promote an existing session" action: creates a
// worktree, moves work into a NEW session there (seeded with `seedPrompt`
// if given), and kills the source session. Used both by a human's kebab-menu
// action (no pending agent request) and to resolve an agent-triggered
// `promote_request` (see hooks.ts's pendingPromotes) — the route can't tell
// which case it is until it checks app.pty for a pending request on this id.
const promoteSessionSchema = {
  body: {
    type: "object",
    required: ["baseRef"],
    additionalProperties: false,
    properties: {
      baseRef: { type: "string", minLength: 1 },
      branchName: { type: "string" },
      seedPrompt: { type: "string" },
    },
  },
};

const declinePromoteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: { type: "string" },
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
    // Issue: sidebar worktree display — the shell's OSC-7-announced cwd, if
    // any has arrived yet; null falls through to the frontend's own
    // `session.cwd ?? project.cwd` fallback (see Sidebar.tsx), same posture
    // as every other live-only field here.
    liveCwd: info?.liveCwd ?? null,
    attention: info?.attention ?? false,
    attentionAt: info?.attentionAt ?? null,
    lastTitle: info?.lastTitle ?? null,
    // Issue #178 — same live/in-memory, host-tracked-only fallback as every
    // other field above.
    gateState: info?.gateState ?? "idle",
    gatePrompt: info?.gatePrompt ?? null,
    // Issue #271 — same live/in-memory, host-tracked-only fallback shape.
    promoteState: info?.promoteState ?? "idle",
    promoteSummary: info?.promoteSummary ?? null,
    promoteSuggestedBaseRef: info?.promoteSuggestedBaseRef ?? null,
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

// Exported for routes/tasks.ts's claim endpoint (issue #216), which returns
// the same "session row + live status" shape every other session-returning
// endpoint in this file does.
export async function withLiveStatus(
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

// Issue #271 — resolves a WorktreeIntent into an actual worktree path,
// routed to whichever host owns `baseCwd`'s filesystem (resolveBackend).
// `seed` drives both the branch name and the worktree's own directory name
// (git-worktree.ts) — a typed `branchName` when given, else a generated,
// session-scoped label so two worktrees created in the same second never
// collide.
async function resolveWorktreeCwd(
  app: FastifyInstance,
  hostId: string,
  baseCwd: string,
  intent: WorktreeIntent,
  seedHint: string,
): Promise<string | null> {
  const seed = intent.branchName && intent.branchName.length > 0 ? intent.branchName : seedHint;
  const result = await resolveBackend(app, hostId).createWorktree(
    baseCwd,
    intent.baseRef,
    seed,
    intent.branchName,
  );
  return result?.path ?? null;
}

export type CreateSessionParams = CreateSessionBody;

export type CreateSessionResult =
  | { ok: true; row: typeof sessions.$inferSelect; project: typeof projects.$inferSelect }
  | { ok: false; reason: "unknown-project" }
  | { ok: false; reason: "worktree-failed" }
  | { ok: false; reason: "spawn-failed" };

// Shared by POST /api/sessions (the launcher's worktree toggle, option 1),
// POST /api/sessions/:id/promote (option 2), and POST /api/tasks/:id/claim
// (Phase 2.5's 2.5.2 — issue #216) — all three ultimately need "insert a
// session row and spawn it," optionally inside a freshly created worktree
// first. Rolls the DB row back on a spawn failure, same as the original
// inline POST /api/sessions handler did. Exported for routes/tasks.ts to
// reuse rather than re-implementing worktree-then-spawn-then-rollback.
export async function createSessionRecord(
  app: FastifyInstance,
  params: CreateSessionParams,
): Promise<CreateSessionResult> {
  const { projectId, command, name, kind, worktree } = params;
  let cwd = params.cwd;

  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  if (!project) return { ok: false, reason: "unknown-project" };

  if (worktree) {
    const worktreePath = await resolveWorktreeCwd(
      app,
      project.hostId,
      cwd ?? project.cwd,
      worktree,
      `session-${Date.now()}`,
    );
    if (!worktreePath) return { ok: false, reason: "worktree-failed" };
    cwd = worktreePath;
  }

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
    // Remote-spawn rollback (issue #26): a local spawn() never throws this
    // way (see session-backend.ts's LocalBackend doc comment), so this path
    // is only reachable for a remote host — leaving the row behind would be
    // DB litter for a session that was never actually spawned anywhere.
    app.db.delete(sessions).where(eq(sessions.id, created.id)).run();
    app.log.error({ err, hostId: project.hostId }, "session spawn failed, rolled back row");
    return { ok: false, reason: "spawn-failed" };
  }

  return { ok: true, row: created, project };
}

// Shared by DELETE /api/sessions/:id and POST /api/sessions/:id/promote (the
// latter kills the source session after the new worktree session is up).
// Returns null when the row doesn't exist; otherwise always flips it to
// "killed" (even if the host-side terminate call itself failed — see the
// inline comment this was factored out of for why that's still correct).
async function killSession(
  app: FastifyInstance,
  sessionId: number,
): Promise<typeof sessions.$inferSelect | null> {
  const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!row) return null;

  const hostId = resolveProjectHostId(app, row.projectId);
  try {
    await resolveBackend(app, hostId).terminate(String(sessionId));
  } catch (err) {
    // Best-effort: an unreachable host or an agent-side 4xx must never
    // surface as a 500, and the row must still flip to "killed" below
    // regardless — leaving it "active" would mean terminal.ts keeps
    // offering to re-attach to a master this call couldn't actually confirm
    // was stopped. Tradeoff: if the host was genuinely unreachable (not just
    // a 4xx), its dtach master may still be running while this row now
    // reads "killed" — a killed row is never re-offered for reattach and the
    // reconciler doesn't revive one, so that master would be orphaned until
    // an operator notices.
    app.log.warn(
      { hostId, sessionId, err },
      "session terminate: host call failed, marking killed anyway",
    );
  }

  const [updated] = app.db
    .update(sessions)
    .set({ status: "killed" })
    .where(eq(sessions.id, sessionId))
    .returning()
    .all();
  return updated ?? null;
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
      const result = await createSessionRecord(app, request.body);
      if (!result.ok) {
        if (result.reason === "unknown-project") return reply.badRequest("Unknown projectId");
        if (result.reason === "worktree-failed") {
          return reply.badGateway("Failed to create worktree for this session");
        }
        return reply.badGateway("Failed to spawn session on host");
      }

      reply.code(201);
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      return withLiveStatus(app, result.row, idleThresholdMs, result.project.hostId);
    },
  );

  // Issue #271, option 2 — "promote an existing session": creates a
  // worktree, moves work into a NEW session there (same command as the
  // source, seeded with `seedPrompt` if given), and kills the source
  // session. Also resolves a pending agent-triggered `promote_request`
  // (app.pty.resolvePendingPromote) if one exists for this session — see
  // hooks.ts's pendingPromotes. Works identically for a human-initiated
  // promote (the SessionRow kebab menu), which never has one pending.
  app.post<{ Params: { id: string }; Body: PromoteSessionBody }>(
    "/api/sessions/:id/promote",
    { schema: promoteSessionSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();
      if (row.status !== "active") return reply.conflict("Session is not active");

      const [project] = app.db.select().from(projects).where(eq(projects.id, row.projectId)).all();
      if (!project) return reply.notFound();

      const { baseRef, branchName, seedPrompt } = request.body;
      const worktreePath = await resolveWorktreeCwd(
        app,
        project.hostId,
        row.cwd ?? project.cwd,
        { baseRef, branchName },
        `promote-${sessionId}-${Date.now()}`,
      );
      if (!worktreePath) return reply.badGateway("Failed to create worktree for this session");

      const created = await createSessionRecord(app, {
        projectId: row.projectId,
        command: row.command,
        name: row.name ?? undefined,
        cwd: worktreePath,
        kind: row.kind,
      });
      if (!created.ok) return reply.badGateway("Failed to spawn the promoted session");

      if (seedPrompt && seedPrompt.length > 0) {
        await resolveBackend(app, project.hostId).stashSeed(String(created.row.id), seedPrompt);
      }
      await resolveBackend(app, project.hostId).resolvePendingPromote(String(sessionId), {
        decision: "accepted",
        worktreePath,
        newSessionId: created.row.id,
      });

      await killSession(app, sessionId);

      reply.code(201);
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      return withLiveStatus(app, created.row, idleThresholdMs, project.hostId);
    },
  );

  // Declines a pending agent-triggered promote request without creating
  // anything — the model's `promote_to_worktree` MCP tool call unblocks with
  // a "declined" result and the agent continues on the main checkout.
  app.post<{ Params: { id: string }; Body: DeclinePromoteBody }>(
    "/api/sessions/:id/promote/decline",
    { schema: declinePromoteSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();

      const hostId = resolveProjectHostId(app, row.projectId);
      const ok = await resolveBackend(app, hostId).resolvePendingPromote(String(sessionId), {
        decision: "declined",
        reason: request.body.reason,
      });
      if (!ok) return reply.conflict("No promote request is currently pending for this session");
      reply.code(204);
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
        // nameLocked pins this title against live OSC title updates (issue
        // #69) — only an explicit rename through this route sets it; a
        // launch-time name pattern (CommandPalette) never does.
        .set({ name: request.body.name, nameLocked: true })
        .where(eq(sessions.id, sessionId))
        .returning()
        .all();
      if (updated.length === 0) return reply.notFound();
      const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
      const hostId = resolveProjectHostId(app, updated[0].projectId);
      return withLiveStatus(app, updated[0], idleThresholdMs, hostId);
    },
  );

  // Issue #178 — delivers a human decision to a pending review gate, routed
  // (via resolveBackend, same as terminate/uploadImage) to whichever host
  // actually holds the open hook connection. 409, not 404/500, when nothing
  // is pending: the session and its host are both perfectly valid, there's
  // just no gate left to answer (already resolved, timed out, or the
  // connection died — see hooks.ts's resolvePendingGate).
  app.post<{ Params: { id: string }; Body: ReviewGateBody }>(
    "/api/sessions/:id/review-gate",
    { schema: reviewGateSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();

      const hostId = resolveProjectHostId(app, row.projectId);
      const { decision, reason } = request.body;
      let ok: boolean;
      try {
        ok = await resolveBackend(app, hostId).resolveReviewGate(
          String(sessionId),
          decision,
          reason,
        );
      } catch (err) {
        app.log.error({ err, sessionId, hostId }, "review-gate decision failed to reach host");
        return reply.badGateway("Failed to deliver decision to host");
      }
      if (!ok) return reply.conflict("No review is currently pending for this session");
      reply.code(204);
    },
  );

  // Issue #68: a pasted/attached image can't travel the terminal's own byte
  // stream (no Sixel/Kitty/iTerm2 support, and the CLI in the PTY couldn't
  // read inline image bytes off stdin even if it could parse them) — this
  // takes the image over an ordinary HTTP request instead, writes it under
  // the session's own cwd (on whichever host actually runs its CLI — see
  // resolveBackend/uploadImage), and returns that path for the frontend to
  // inject into the terminal exactly like a paste. Scoped to this plugin's
  // own encapsulated context, so it never affects how any other route file
  // parses its own request bodies.
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/uploads",
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!row) return reply.notFound();
      const [project] = app.db.select().from(projects).where(eq(projects.id, row.projectId)).all();
      if (!project) return reply.notFound();

      // Hermes review (PR #106): a bare exact-key match against the raw
      // header would 400 a real image whose Content-Type happens to carry a
      // `; charset=...` (or other) parameter — browsers send bare blob
      // types today, but stripping params costs nothing and removes the
      // footgun.
      const rawContentType = request.headers["content-type"];
      const mime = rawContentType?.split(";")[0]?.trim();
      if (!mime || !extensionForMime(mime)) {
        return reply.badRequest(`Unsupported image type: ${rawContentType ?? "(missing)"}`);
      }
      if (!Buffer.isBuffer(request.body)) return reply.badRequest("expected a raw image body");
      // Content check, not just Content-Type: rejects a body whose actual
      // leading bytes don't match the claimed image format — a client can't
      // smuggle arbitrary content onto disk under an image mime type.
      if (!matchesMagicBytes(request.body, mime)) {
        return reply.badRequest("File content does not match the declared image type");
      }

      try {
        return await resolveBackend(app, project.hostId).uploadImage(
          row.cwd ?? project.cwd,
          request.body,
          mime,
        );
      } catch (err) {
        // Same posture as POST /api/sessions' own spawn-rollback catch above:
        // an unreachable host or an agent-side rejection is a gateway
        // failure, never a 500 — there's no row here to roll back.
        app.log.error({ err, sessionId, hostId: project.hostId }, "session image upload failed");
        return reply.badGateway("Failed to upload image to host");
      }
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

    const updated = await killSession(app, sessionId);
    if (!updated) return reply.notFound();

    reply.code(204);
  });
}
