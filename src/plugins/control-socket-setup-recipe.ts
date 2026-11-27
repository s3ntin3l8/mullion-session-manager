/**
 * #3592 — `projects.get_setup_recipe` / `projects.set_setup_recipe`: an agent
 * session reads and sets its OWN project's setup recipe (`projects.setup_recipe`,
 * #2245), the shell command that installs dependencies in a fresh worktree or
 * checkout. Mirrors the dock-config ops (control-socket-dock-config.ts):
 *
 *  - The project comes from `resolveTargetProjectId` — the session's own at
 *    session scope (naming another is a 403), a required `projectId` at full
 *    scope.
 *  - The write forwards to `PATCH /api/projects/:id` with a body built here
 *    (`{setupRecipe}` and nothing else, so a session cannot reach any other
 *    project field), so validation is the Settings editor's: at most
 *    SETUP_RECIPE_MAX_LENGTH, trimmed, blank = null.
 *  - A successful write rings a `project` doorbell on the tasks channel, so an
 *    open Edit project dialog refetches the project list and shows it.
 *
 * `run: true` is an optional dry run: after saving, the recipe runs once in the
 * target session's working directory, on that session's host, through the same
 * runner a fresh worktree uses (runSetupOnHost), and the reply carries the exit
 * code and the log's tail. The session is the caller's own at session scope; at
 * full scope `sessionId` is required. The log key is the session id, so the run
 * replaces that session's own setup log, and its setup status badge follows.
 */
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import { extractIdField, resolveTargetProjectId } from "../services/control-session-authority.js";
import {
  executionContextErrorStatus,
  resolveExecutionContext,
} from "../services/execution-context.js";
import {
  SETUP_RECIPE_MAX_LENGTH,
  readSessionSetupLog,
  runSetupOnHost,
} from "../services/setup-recipe.js";
import { broadcastTaskEvent } from "../services/task-events.js";
import {
  buildAuthHeaders,
  injectAndShape,
  jsonHeaders,
  type OpContext,
  type OpSpec,
  type ReplyPayload,
} from "./control-socket-core.js";

const bad = (status: number, error: string): ReplyPayload => ({ ok: false, status, error });

/** How much of the dry run's log the reply carries: enough for the failing
 * command's output, small enough for a tool reply. */
export const DRY_RUN_LOG_TAIL_CHARS = 4000;

/** Narrows a project route's reply to the one field this op is about. */
function shape(reply: ReplyPayload, projectId: string): ReplyPayload {
  if (!reply.ok) return reply;
  const row = reply.result as { setupRecipe?: string | null } | null;
  return {
    ok: true,
    status: 200,
    result: { projectId: Number(projectId), setupRecipe: row?.setupRecipe ?? null },
  };
}

/** The session a dry run runs in: the caller's own at session scope (never a
 * body field), `body.sessionId` at full scope. */
function dryRunSessionId(
  ctx: OpContext,
): { ok: true; id: string } | { ok: false; reply: ReplyPayload } {
  if (ctx.conn.scope === "session") return { ok: true, id: ctx.conn.sessionId! };
  const id = extractIdField(ctx.body, "sessionId");
  return id === null
    ? { ok: false, reply: bad(400, "'sessionId' is required for 'run' at full scope") }
    : { ok: true, id };
}

async function dryRun(
  ctx: OpContext,
  projectId: string,
  sessionIdRaw: string,
  recipe: string,
): Promise<{ ok: true; run: Record<string, unknown> } | { ok: false; reply: ReplyPayload }> {
  const sessionId = Number(sessionIdRaw);
  if (!Number.isInteger(sessionId)) return { ok: false, reply: bad(400, "Invalid session id") };
  const resolved = await resolveExecutionContext(ctx.app, {
    projectId: Number(projectId),
    sessionId,
  });
  if (!resolved.ok) {
    const status = executionContextErrorStatus(resolved.error.code);
    return { ok: false, reply: bad(status, resolved.error.message) };
  }
  const { hostId, cwd } = resolved.context;
  const result = await runSetupOnHost(ctx.app, hostId, {
    cwd,
    recipe,
    logKey: String(sessionId),
  });
  // The run is this session's setup run now: keep its badge in step with the
  // log it replaced (a busy run started nothing, so it changes neither).
  if (result.outcome !== "busy") {
    ctx.app.db
      .update(sessions)
      .set({
        setupStatus: result.outcome,
        ...(result.logPath ? { setupLogPath: result.logPath } : {}),
      })
      .where(eq(sessions.id, sessionId))
      .run();
    broadcastTaskEvent({ taskId: 0, projectId: Number(projectId), kind: "setup", ts: Date.now() });
  }
  // A busy run started nothing, so the log on disk is someone else's run.
  const log =
    result.outcome === "busy" ? null : await readSessionSetupLog(ctx.app, hostId, sessionId);
  const content = log?.content ?? "";
  return {
    ok: true,
    run: {
      outcome: result.outcome,
      exitCode: result.exitCode,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
      cwd,
      hostId,
      logTail: content.slice(-DRY_RUN_LOG_TAIL_CHARS),
      logTruncated: (log?.truncated ?? false) || content.length > DRY_RUN_LOG_TAIL_CHARS,
    },
  };
}

async function setSetupRecipe(ctx: OpContext): Promise<ReplyPayload> {
  const project = resolveTargetProjectId(ctx.app, ctx.conn, ctx.body);
  if (!project.ok) return project.reply;
  const recipe = ctx.body?.recipe;
  if (recipe !== null && typeof recipe !== "string") {
    return bad(400, "'recipe' must be a string, or null to clear it");
  }
  if (typeof recipe === "string" && recipe.length > SETUP_RECIPE_MAX_LENGTH) {
    return bad(400, `'recipe' must be at most ${SETUP_RECIPE_MAX_LENGTH} characters`);
  }
  const run = ctx.body?.run;
  if (run !== undefined && typeof run !== "boolean") return bad(400, "'run' must be a boolean");
  // Validate everything a dry run needs before writing, so a refused run saves nothing.
  const session = run === true ? dryRunSessionId(ctx) : null;
  if (session && !session.ok) return session.reply;
  if (run === true && (recipe === null || recipe.trim() === "")) {
    return bad(400, "'run' needs a recipe to run");
  }

  const saved = shape(
    await injectAndShape(ctx.app, {
      method: "PATCH",
      url: `/api/projects/${encodeURIComponent(project.id)}`,
      headers: jsonHeaders(ctx.app),
      payload: JSON.stringify({ setupRecipe: recipe }),
    }),
    project.id,
  );
  if (!saved.ok) return saved;
  broadcastTaskEvent({ taskId: 0, projectId: Number(project.id), kind: "project", ts: Date.now() });
  if (!session) return saved;

  const savedRecipe = (saved.result as { setupRecipe: string }).setupRecipe;
  const ran = await dryRun(ctx, project.id, session.id, savedRecipe);
  // The recipe is saved either way; a run that could not start says why.
  if (!ran.ok) {
    return {
      ...ran.reply,
      error: `recipe saved, but the dry run could not start: ${ran.reply.error}`,
    };
  }
  return {
    ok: true,
    status: 200,
    result: { ...(saved.result as Record<string, unknown>), run: ran.run },
  };
}

export const setupRecipeOps: Record<string, OpSpec> = {
  "projects.get_setup_recipe": {
    scopes: ["full", "session"],
    handler: async (ctx) => {
      const project = resolveTargetProjectId(ctx.app, ctx.conn, ctx.body);
      if (!project.ok) return ctx.reply(project.reply);
      const reply = await injectAndShape(ctx.app, {
        method: "GET",
        url: `/api/projects/${encodeURIComponent(project.id)}`,
        headers: buildAuthHeaders(ctx.app),
      });
      ctx.reply(shape(reply, project.id));
    },
  },
  "projects.set_setup_recipe": {
    scopes: ["full", "session"],
    handler: async (ctx) => ctx.reply(await setSetupRecipe(ctx)),
  },
};
