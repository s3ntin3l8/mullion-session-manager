/**
 * #3050 — `projects.get_dock_config` / `projects.set_dock_config`: an agent
 * session reads and edits its OWN project's `.crs/dock.json` (the file behind
 * Settings → Dock). Both forward to `GET`/`PUT /api/projects/:id/dock/config`,
 * so validation (unknown keys, duplicate ids, reserved env keys), the symlink
 * and size guards and remote-host proxying are exactly the UI's.
 *
 * At session scope the project comes from the session record
 * (resolveTargetProjectId) and the route is told the caller's own session with
 * `?sessionId=<conn.sessionId>` — never a body field. That selects the
 * session's HOST: the file is the project's `.crs/dock.json` on that host (the
 * one the dock reads), not a separate worktree's copy. Full scope names the
 * project, and may pass `sessionId` to pick the host a session runs on.
 */
import type { DockControl } from "../shared/types.js";
import { extractIdField, resolveTargetProjectId } from "../services/control-session-authority.js";
import {
  buildAuthHeaders,
  injectAndShape,
  jsonHeaders,
  type OpContext,
  type OpSpec,
  type ReplyPayload,
} from "./control-socket-core.js";

const bad = (status: number, error: string): ReplyPayload => ({ ok: false, status, error });

/** Which session's checkout the config is read from or written to: the
 * caller's own at session scope (never a body field); at full scope the
 * optional `body.sessionId`, a string or a number like every id on this
 * socket. A present but unusable value is a 400, not a silent fallback to the
 * project's default checkout. */
function targetSessionId(
  ctx: OpContext,
): { ok: true; id: string | null } | { ok: false; reply: ReplyPayload } {
  if (ctx.conn.scope === "session") return { ok: true, id: ctx.conn.sessionId };
  if (ctx.body?.sessionId === undefined) return { ok: true, id: null };
  const id = extractIdField(ctx.body, "sessionId");
  return id === null
    ? { ok: false, reply: bad(400, "'sessionId' must be a non-empty string or a number") }
    : { ok: true, id };
}

/** `/api/projects/:id/dock/config`, aimed at `sessionId`'s checkout when given. */
function configUrl(projectId: string, sessionId: string | null): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/dock/config`;
  return sessionId ? `${base}?sessionId=${encodeURIComponent(sessionId)}` : base;
}

function readConfig(
  ctx: OpContext,
  projectId: string,
  sessionId: string | null,
): Promise<ReplyPayload> {
  return injectAndShape(ctx.app, {
    method: "GET",
    url: configUrl(projectId, sessionId),
    headers: buildAuthHeaders(ctx.app),
  });
}

function isControl(value: unknown): value is DockControl {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function setDockConfig(ctx: OpContext): Promise<ReplyPayload> {
  const project = resolveTargetProjectId(ctx.app, ctx.conn, ctx.body);
  if (!project.ok) return project.reply;
  const session = targetSessionId(ctx);
  if (!session.ok) return session.reply;
  const { controls, upsert, remove } = ctx.body ?? {};
  const forms = [controls, upsert, remove].filter((v) => v !== undefined).length;
  if (forms !== 1) return bad(400, "pass exactly one of 'controls', 'upsert' or 'remove'");

  let next: unknown[];
  if (controls !== undefined) {
    if (!Array.isArray(controls)) return bad(400, "'controls' must be an array");
    next = controls;
  } else {
    // Read-modify-write, so adding one control cannot clobber the user's others.
    const current = await readConfig(ctx, project.id, session.id);
    if (!current.ok) return current;
    const doc = current.result as { controls?: DockControl[]; invalid?: boolean; reason?: string };
    if (doc.invalid === true) {
      return bad(
        409,
        `dock.json is invalid (${doc.reason ?? "unparseable"}); fix it or pass 'controls'`,
      );
    }
    const existing = doc.controls ?? [];
    if (upsert !== undefined) {
      if (!isControl(upsert) || typeof upsert.id !== "string") {
        return bad(400, "'upsert' must be a control object with an 'id'");
      }
      const at = existing.findIndex((c) => c.id === upsert.id);
      next = at === -1 ? [...existing, upsert] : existing.map((c, i) => (i === at ? upsert : c));
    } else {
      if (typeof remove !== "string") return bad(400, "'remove' must be a control id");
      if (!existing.some((c) => c.id === remove)) return bad(404, "Dock control not found");
      next = existing.filter((c) => c.id !== remove);
    }
  }
  return injectAndShape(ctx.app, {
    method: "PUT",
    url: configUrl(project.id, session.id),
    headers: jsonHeaders(ctx.app),
    payload: JSON.stringify({ controls: next }),
  });
}

export const dockConfigOps: Record<string, OpSpec> = {
  "projects.get_dock_config": {
    scopes: ["full", "session"],
    handler: async (ctx) => {
      const project = resolveTargetProjectId(ctx.app, ctx.conn, ctx.body);
      const session = targetSessionId(ctx);
      if (!project.ok) return ctx.reply(project.reply);
      if (!session.ok) return ctx.reply(session.reply);
      ctx.reply(await readConfig(ctx, project.id, session.id));
    },
  },
  "projects.set_dock_config": {
    scopes: ["full", "session"],
    handler: async (ctx) => ctx.reply(await setDockConfig(ctx)),
  },
};
