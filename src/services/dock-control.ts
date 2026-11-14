/**
 * #2494 — server-side start/stop/list of a project's dock controls, so an
 * agent session (which cannot use the full-scope `sessions.create`) can
 * operate its own project's dock through the narrow `docks.*` control-socket
 * ops. The dashboard keeps launching through `POST /api/sessions`; this
 * service reuses that very route for the launch (port-conflict probe, host
 * placement, worktree intent) instead of growing a second spawn path.
 *
 * A dock session is matched to its control by `sessions.dock_control_id`
 * only — never by comparing `sessions.command`, which stays an opaque blob.
 * A dock session started before that column existed is therefore not found
 * (it shows as not running); stop it from the dashboard once.
 */
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import type { DockControl } from "../shared/types.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { resolveProjectDock } from "./project-config.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { getProjectRow } from "./session-host.js";
import { killSession } from "./session-lifecycle.js";
import { withLiveStatus } from "./session-live-info.js";
import { isSiblingWorktreeCwd } from "./session-cwd.js";
import { getStoredSettings } from "./settings.js";

export interface DockControlView {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  port?: number;
  preview?: boolean;
  running: { sessionId: number; status: string; cwd: string | null } | null;
}

export type DockControlResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string; body?: Record<string, unknown> };

const fail = (status: number, message: string, body?: Record<string, unknown>) =>
  ({ ok: false, status, message, ...(body ? { body } : {}) }) as const;

/** The project's configured (`.crs/dock.json` + global) controls. Docker-
 * discovered controls are not agent-controllable (see listing note). */
async function configuredControls(
  app: FastifyInstance,
  projectId: number,
): Promise<DockControlResult<DockControl[]>> {
  const project = getProjectRow(app, projectId);
  if (!project) return fail(404, "Project not found");
  if (project.hostId === LOCAL_HOST_ID) {
    return { ok: true, value: resolveProjectDock(project.cwd, app.config.CRS_CONFIG_DIR) };
  }
  try {
    return {
      ok: true,
      value: await getRemoteHostClient(app, project.hostId).resolveDock(project.cwd),
    };
  } catch (err) {
    app.log.warn({ hostId: project.hostId, err }, "host unreachable, dock unavailable");
    return fail(503, `Host ${project.hostId} is unreachable`);
  }
}

/** The active dock session launched from `controlId`, newest first. */
export function findRunningDockSession(
  app: FastifyInstance,
  projectId: number,
  controlId: string,
): typeof sessions.$inferSelect | undefined {
  return app.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        eq(sessions.kind, "dock"),
        eq(sessions.status, "active"),
        eq(sessions.dockControlId, controlId),
      ),
    )
    .orderBy(desc(sessions.id))
    .get();
}

export async function listDockControls(
  app: FastifyInstance,
  projectId: number,
): Promise<DockControlResult<DockControlView[]>> {
  const controls = await configuredControls(app, projectId);
  if (!controls.ok) return controls;
  const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
  const project = getProjectRow(app, projectId)!;
  const views: DockControlView[] = [];
  for (const control of controls.value) {
    const row = findRunningDockSession(app, projectId, control.id);
    let running: DockControlView["running"] = null;
    if (row) {
      const live = await withLiveStatus(app, row, idleThresholdMs, row.hostId ?? project.hostId);
      running = { sessionId: row.id, status: live.sessionStatus, cwd: row.cwd };
    }
    views.push({
      id: control.id,
      title: control.title,
      command: control.command,
      ...(control.cwd !== undefined ? { cwd: control.cwd } : {}),
      ...(control.port !== undefined ? { port: control.port } : {}),
      ...(control.preview !== undefined ? { preview: control.preview } : {}),
      running,
    });
  }
  return { ok: true, value: views };
}

/** A control the caller may not act on is reported exactly like a missing one. */
async function resolveControl(
  app: FastifyInstance,
  projectId: number,
  controlId: string,
): Promise<DockControlResult<DockControl>> {
  const controls = await configuredControls(app, projectId);
  if (!controls.ok) return controls;
  const control = controls.value.find((c) => c.id === controlId && c.source !== "docker");
  return control ? { ok: true, value: control } : fail(404, "Dock control not found");
}

/** Where to run the control: a branch (preview worktree) or an existing
 * worktree path of the project; neither means the control's own cwd. */
export interface StartTarget {
  branch?: string;
  worktreePath?: string;
}

/** Launches a session exactly as the dashboard does (`POST /api/sessions`).
 * Supplied by the route, so this service does not depend on the plugin layer. */
export type LaunchSession = (
  payload: Record<string, unknown>,
) => Promise<{ statusCode: number; body: { id?: number; message?: string; code?: unknown } }>;

/** A bad target is refused before anything is stopped or launched. */
async function validateTarget(
  app: FastifyInstance,
  projectId: number,
  target: StartTarget,
): Promise<DockControlResult<never> | null> {
  if (target.branch !== undefined && target.worktreePath !== undefined) {
    return fail(400, "pass either branch or worktreePath, not both");
  }
  if (target.worktreePath === undefined) return null;
  // The dashboard offers only the project's checkout and its git worktrees;
  // nothing else may become a dock session's cwd (a session has no parent
  // here, so createSessionRecord's child-cwd containment does not apply).
  const project = getProjectRow(app, projectId)!;
  const resolved = path.resolve(target.worktreePath);
  const root = path.resolve(project.cwd);
  const ok =
    resolved === root ||
    resolved.startsWith(root + path.sep) ||
    (await isSiblingWorktreeCwd({ cwd: project.cwd, hostId: project.hostId }, resolved));
  return ok
    ? null
    : fail(400, "worktreePath must be the project checkout or one of its git worktrees");
}

export async function startDockControl(
  app: FastifyInstance,
  projectId: number,
  controlId: string,
  target: StartTarget,
  launch: LaunchSession,
): Promise<DockControlResult<{ sessionId: number }>> {
  const control = await resolveControl(app, projectId, controlId);
  if (!control.ok) return control;
  const running = findRunningDockSession(app, projectId, controlId);
  if (running) {
    // The row says active, but its process may have died before the
    // reconciler noticed: decide on live state, and reap a dead row.
    const project = getProjectRow(app, projectId)!;
    const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
    const live = await withLiveStatus(
      app,
      running,
      idleThresholdMs,
      running.hostId ?? project.hostId,
    );
    if (live.sessionStatus !== "exited") {
      return fail(409, "Dock control is already running", { sessionId: running.id });
    }
    await killSession(app, running.id, "detach");
  }
  const c = control.value;
  const invalid = await validateTarget(app, projectId, target);
  if (invalid) return invalid;
  const worktreeRefresh =
    c.worktreeRefresh ?? getStoredSettings(app.db).dock?.defaultWorktreeRefresh ?? false;
  const payload = {
    projectId,
    command: c.command,
    kind: "dock",
    dockControlId: c.id,
    name: c.title,
    ...(target.branch !== undefined
      ? { worktree: { branch: target.branch }, worktreeRefresh }
      : target.worktreePath !== undefined
        ? { cwd: target.worktreePath }
        : c.cwd
          ? { cwd: c.cwd }
          : {}),
    ...(c.env ? { env: c.env } : {}),
  };
  const { statusCode, body } = await launch(payload);
  if (statusCode !== 201 || typeof body.id !== "number") {
    return fail(statusCode >= 400 ? statusCode : 502, body.message ?? "Failed to start", {
      ...(body.code !== undefined ? { code: body.code } : {}),
    });
  }
  return { ok: true, value: { sessionId: body.id } };
}

export async function stopDockControl(
  app: FastifyInstance,
  projectId: number,
  controlId: string,
): Promise<DockControlResult<{ sessionId: number | null }>> {
  const control = await resolveControl(app, projectId, controlId);
  if (!control.ok) return control;
  const running = findRunningDockSession(app, projectId, controlId);
  if (!running) return { ok: true, value: { sessionId: null } };
  await killSession(app, running.id, "detach");
  return { ok: true, value: { sessionId: running.id } };
}

/** Stops the control if it is running, then starts it on `target`. */
export async function switchDockControl(
  app: FastifyInstance,
  projectId: number,
  controlId: string,
  target: StartTarget,
  launch: LaunchSession,
): Promise<DockControlResult<{ sessionId: number }>> {
  if (target.branch === undefined && target.worktreePath === undefined) {
    return fail(400, "pass branch or worktreePath");
  }
  const control = await resolveControl(app, projectId, controlId);
  if (!control.ok) return control;
  // Validate before stopping: a bad target must not kill a healthy server.
  const invalid = await validateTarget(app, projectId, target);
  if (invalid) return invalid;
  const stopped = await stopDockControl(app, projectId, controlId);
  if (!stopped.ok) return stopped;
  return startDockControl(app, projectId, controlId, target, launch);
}
