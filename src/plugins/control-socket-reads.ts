/**
 * Session-scope, read-only views of sessions and Task Master tasks
 * (`sessions.list`, `tasks.list`, `tasks.get`).
 *
 * Full scope is unchanged: the same REST read, no filtering. At session scope
 * each row is decided by `crossProjectAllowed(callerProject, rowProject)`, the
 * rule that already gates cross-project children: the caller's own project is
 * always visible; another project only when the caller's project is a
 * coordinator that reaches it AND the target accepts the caller. A project that
 * is out of reach or refuses is indistinguishable from one that does not exist
 * (omitted from lists, the same 404 as a missing id on `tasks.get`).
 *
 * Replies at session scope also drop the fields that can carry credentials:
 * a session's `command` and `env`, a task's `agentCommand`.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { crossProjectAllowed } from "../services/cross-project.js";
import { extractIdField, sessionRowIsActive } from "../services/control-session-authority.js";
import {
  bad,
  buildAuthHeaders,
  buildQueryUrl,
  injectAndShape,
  routeOp,
  type OpContext,
  type OpSpec,
  type ReplyPayload,
} from "./control-socket-core.js";
import {
  CONTROL_SOCKET_VIA_HEADER,
  CONTROL_SOCKET_VIA_TOKEN,
} from "../services/internal-request.js";
import { enc } from "./control-socket-support.js";

/** Session fields withheld at session scope (may carry credentials). */
export const SESSION_SECRET_FIELDS = ["command", "env"] as const;
/** Task fields withheld at session scope. */
export const TASK_SECRET_FIELDS = ["agentCommand"] as const;

/** The answer for a task id that does not exist, which an unreachable one must match. */
const TASK_NOT_FOUND = (): ReplyPayload => bad(404, "Not Found");

function omit(row: unknown, fields: readonly string[]): unknown {
  if (typeof row !== "object" || row === null) return row;
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const f of fields) delete copy[f];
  return copy;
}

/** The ids of every project the caller's session may read, or a refusal. */
function readableProjectIds(
  app: FastifyInstance,
  sessionId: string,
): { ok: true; ids: Set<number> } | { ok: false; reply: ReplyPayload } {
  if (!sessionRowIsActive(app, sessionId)) {
    return { ok: false, reply: bad(403, "this session is no longer active") };
  }
  const row = app.db
    .select({ projectId: sessions.projectId })
    .from(sessions)
    .where(eq(sessions.id, Number(sessionId)))
    .get();
  const all = app.db.select().from(projects).all();
  const source = all.find((p) => p.id === row?.projectId);
  return {
    ok: true,
    ids: new Set(all.filter((p) => crossProjectAllowed(source, p)).map((p) => p.id)),
  };
}

function forward(ctx: OpContext, url: string): Promise<ReplyPayload> {
  return injectAndShape(ctx.app, {
    method: "GET",
    url,
    headers: {
      ...buildAuthHeaders(ctx.app),
      [CONTROL_SOCKET_VIA_HEADER]: CONTROL_SOCKET_VIA_TOKEN,
    },
  });
}

/**
 * A read op: full scope runs `full` as before; session scope forwards the same
 * REST read and hands the result to `filter` with the readable project ids.
 */
function readOp(
  full: OpSpec,
  urlOf: (body: Record<string, unknown> | undefined) => string | ReplyPayload,
  filter: (result: unknown, ids: Set<number>) => ReplyPayload,
): OpSpec {
  return {
    scopes: ["full", "session"],
    handler: async (ctx) => {
      if (ctx.conn.scope === "full") return full.handler(ctx);
      const readable = readableProjectIds(ctx.app, ctx.conn.sessionId!);
      if (!readable.ok) return ctx.reply(readable.reply);
      const url = urlOf(ctx.body);
      if (typeof url !== "string") return ctx.reply(url);
      const res = await forward(ctx, url);
      ctx.reply(res.ok ? filter(res.result, readable.ids) : res);
    },
  };
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? (result as Record<string, unknown>[]) : [];

export const readOps: Record<string, OpSpec> = {
  "sessions.list": readOp(
    routeOp(["full"], ({ body }) => ({ method: "GET", url: buildQueryUrl("/api/sessions", body) })),
    (body) => buildQueryUrl("/api/sessions", body),
    (result, ids) => ({
      ok: true,
      status: 200,
      result: rowsOf(result)
        .filter((r) => ids.has(r.projectId as number))
        .map((r) => omit(r, SESSION_SECRET_FIELDS)),
    }),
  ),
  "tasks.list": readOp(
    routeOp(["full"], ({ body }) => ({ method: "GET", url: buildQueryUrl("/api/tasks", body) })),
    (body) => buildQueryUrl("/api/tasks", body),
    (result, ids) => ({
      ok: true,
      status: 200,
      result: rowsOf(result)
        .filter((r) => ids.has(r.projectId as number))
        .map((r) => omit(r, TASK_SECRET_FIELDS)),
    }),
  ),
  "tasks.get": readOp(
    routeOp(["full"], ({ body }) => {
      const id = extractIdField(body, "taskId");
      return id === null
        ? bad(400, "'taskId' is required")
        : { method: "GET", url: `/api/tasks/${enc(id)}` };
    }),
    (body) => {
      const id = extractIdField(body, "taskId");
      return id === null ? bad(400, "'taskId' is required") : `/api/tasks/${enc(id)}`;
    },
    (result, ids) => {
      const projectId = (result as { projectId?: unknown } | null)?.projectId;
      return typeof projectId === "number" && ids.has(projectId)
        ? { ok: true, status: 200, result: omit(result, TASK_SECRET_FIELDS) }
        : TASK_NOT_FOUND();
    },
  ),
};
