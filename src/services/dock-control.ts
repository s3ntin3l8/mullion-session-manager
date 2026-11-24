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
import { realpathSync } from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import type { DockControl } from "../shared/types.js";
import { parseHostCwds } from "./host-cwds.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { projectCwdOnHost } from "./placement.js";
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

/** The checkout a control is resolved and launched against: the project's own,
 * or its checkout on the host a start names (`StartTarget.hostId`). */
interface LaunchBase {
  hostId: string;
  cwd: string;
}

/** The project's checkout on `hostId` (its own host when none is named). A host
 * the project is not on is refused rather than guessed at: `dock.json` is read
 * from the checkout there, and the session runs in it. */
function resolveLaunchBase(
  project: { hostId: string; cwd: string; hostCwds: string | null },
  hostId: string | undefined,
): DockControlResult<LaunchBase> {
  if (hostId === undefined || hostId === project.hostId) {
    return { ok: true, value: { hostId: project.hostId, cwd: project.cwd } };
  }
  const cwd = projectCwdOnHost(project, hostId, parseHostCwds(project.hostCwds));
  if (cwd === null) {
    return fail(409, `The project has no checkout on host ${hostId}`, {
      code: "no_checkout_on_host",
    });
  }
  return { ok: true, value: { hostId, cwd } };
}

/** The project's configured (`.crs/dock.json` + global) controls, read from its
 * checkout on `hostId` (default: the project's own host). Docker-discovered
 * controls are not agent-controllable (see listing note). */
export async function configuredControls(
  app: FastifyInstance,
  projectId: number,
  hostId?: string,
): Promise<DockControlResult<DockControl[]>> {
  const project = getProjectRow(app, projectId);
  if (!project) return fail(404, "Project not found");
  const base = resolveLaunchBase(project, hostId);
  if (!base.ok) return base;
  if (base.value.hostId === LOCAL_HOST_ID) {
    return { ok: true, value: resolveProjectDock(base.value.cwd, app.config.CRS_CONFIG_DIR) };
  }
  try {
    return {
      ok: true,
      value: await getRemoteHostClient(app, base.value.hostId).resolveDock(base.value.cwd),
    };
  } catch (err) {
    app.log.warn({ hostId: base.value.hostId, err }, "host unreachable, dock unavailable");
    return fail(503, `Host ${base.value.hostId} is unreachable`);
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
  hostId?: string,
): Promise<DockControlResult<DockControl>> {
  const controls = await configuredControls(app, projectId, hostId);
  if (!controls.ok) return controls;
  const control = controls.value.find((c) => c.id === controlId && c.source !== "docker");
  return control ? { ok: true, value: control } : fail(404, "Dock control not found");
}

/** Where to run the control: a branch (preview worktree) or an existing
 * worktree path of the project; neither means the control's own cwd. */
export interface StartTarget {
  branch?: string;
  worktreePath?: string;
  /** Run on this host (the project must have a checkout there). Omitted: the
   * project's own placement, as before. Never stored: it is per launch. */
  hostId?: string;
}

/** Launches a session exactly as the dashboard does (`POST /api/sessions`).
 * Supplied by the route, so this service does not depend on the plugin layer. */
export type LaunchSession = (
  payload: Record<string, unknown>,
) => Promise<{ statusCode: number; body: LaunchOutcome }>;

/** The only parts of the launch response this service passes on: numbers and a
 * known code. Upstream message text is deliberately not echoed to the caller. */
export interface LaunchOutcome {
  id?: number;
  code?: "port_in_use";
  port?: number;
  holderSessionId?: number;
}

const LAUNCH_FAILURE: Record<number, string> = {
  400: "The launch was refused as invalid.",
  404: "Project not found.",
  409: "The control is already running, or its port is in use.",
  429: "Too many live sessions.",
  502: "Failed to spawn the session.",
  503: "The spawn outcome is unknown; check the dock.",
};

/** A relative `worktreePath` is anchored at the project checkout (what a
 * session user means), never at the Mullion process's cwd. */
function resolveTargetPath(projectCwd: string, worktreePath: string): string {
  return path.resolve(projectCwd, worktreePath);
}

/** `realpath` that tolerates a path that does not exist yet: the deepest
 * existing ancestor is resolved and the rest appended, so a symlink inside the
 * checkout cannot make an outside directory look like it is inside. */
function realpathLoose(p: string): string {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...missing.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** A distinct shape from DockControlResult on purpose: the validated path
 * (`cwd`) is for the launch only and never travels in a reply value. */
type TargetCheck =
  { ok: true; cwd: string | undefined } | { ok: false; error: DockControlResult<never> };

/** A bad target is refused before anything is stopped or launched. On success
 * the value is the cwd to launch in (the validated path itself), or undefined
 * when the target is a branch or nothing. */
async function validateTarget(
  app: FastifyInstance,
  projectId: number,
  target: StartTarget,
): Promise<TargetCheck> {
  if (target.branch !== undefined && target.worktreePath !== undefined) {
    return { ok: false, error: fail(400, "pass either branch or worktreePath, not both") };
  }
  if (target.worktreePath === undefined) {
    // No path to check, but a named host still has to hold the checkout.
    const project = getProjectRow(app, projectId)!;
    const base = resolveLaunchBase(project, target.hostId);
    return base.ok ? { ok: true, cwd: undefined } : { ok: false, error: base };
  }
  // The dock session's cwd must be the project checkout, a directory inside it
  // (a monorepo package), or one of its git worktrees; nothing else (a session
  // has no parent here, so createSessionRecord's child-cwd containment does
  // not apply). On the local host symlinks are resolved first.
  const project = getProjectRow(app, projectId)!;
  const base = resolveLaunchBase(project, target.hostId);
  if (!base.ok) return { ok: false, error: base };
  const { hostId, cwd: baseCwd } = base.value;
  const local = hostId === LOCAL_HOST_ID;
  const fix = (p: string) => (local ? realpathLoose(p) : p);
  const root = fix(path.resolve(baseCwd));
  const resolved = fix(resolveTargetPath(path.resolve(baseCwd), target.worktreePath));
  const ok =
    resolved === root ||
    resolved.startsWith(root + path.sep) ||
    (await isSiblingWorktreeCwd({ cwd: baseCwd, hostId }, resolved));
  return ok
    ? { ok: true, cwd: resolved }
    : {
        ok: false,
        error: fail(
          400,
          "worktreePath must be the project checkout, a directory inside it, or one of its git worktrees",
        ),
      };
}

export async function startDockControl(
  app: FastifyInstance,
  projectId: number,
  controlId: string,
  target: StartTarget,
  launch: LaunchSession,
): Promise<DockControlResult<{ sessionId: number }>> {
  const control = await resolveControl(app, projectId, controlId, target.hostId);
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
  const checked = await validateTarget(app, projectId, target);
  if (!checked.ok) return checked.error;
  const worktreeRefresh =
    c.worktreeRefresh ?? getStoredSettings(app.db).dock?.defaultWorktreeRefresh ?? false;
  const payload = {
    projectId,
    command: c.command,
    kind: "dock",
    dockControlId: c.id,
    name: c.title,
    ...(target.hostId !== undefined ? { targetHostId: target.hostId } : {}),
    ...(target.branch !== undefined
      ? { worktree: { branch: target.branch }, worktreeRefresh }
      : target.worktreePath !== undefined
        ? { cwd: checked.cwd }
        : c.cwd
          ? { cwd: c.cwd }
          : {}),
    ...(c.env ? { env: c.env } : {}),
  };
  const { statusCode, body } = await launch(payload);
  if (statusCode !== 201 || typeof body.id !== "number") {
    const status = statusCode >= 400 ? statusCode : 502;
    return fail(status, LAUNCH_FAILURE[status] ?? `Failed to start (HTTP ${status}).`, {
      ...(body.code !== undefined ? { code: body.code } : {}),
      ...(body.port !== undefined ? { port: body.port } : {}),
      ...(body.holderSessionId !== undefined ? { holderSessionId: body.holderSessionId } : {}),
    });
  }
  return { ok: true, value: { sessionId: body.id } };
}

export async function stopDockControl(
  app: FastifyInstance,
  projectId: number,
  controlId: string,
  // The host a switch is about to start the control on: with nothing running,
  // the control is looked up there, not in the project host's dock.json.
  hostIdWhenStopped?: string,
): Promise<DockControlResult<{ sessionId: number | null }>> {
  // A control started on another host is defined by THAT host's dock.json, so
  // it is checked there (#3425), not against the project host's.
  const running = findRunningDockSession(app, projectId, controlId);
  const project = getProjectRow(app, projectId);
  const runningHostId = running
    ? running.hostId && project && running.hostId !== project.hostId
      ? running.hostId
      : undefined
    : hostIdWhenStopped;
  const control = await resolveControl(app, projectId, controlId, runningHostId);
  if (!control.ok) return control;
  if (!running) return { ok: true, value: { sessionId: null } };
  await killSession(app, running.id, "detach");
  return { ok: true, value: { sessionId: running.id } };
}

/** Stops the control if it is running, then starts it on `target` (a stopped
 * control is simply started there). */
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
  const control = await resolveControl(app, projectId, controlId, target.hostId);
  if (!control.ok) return control;
  // Validate before stopping: a bad target must not kill a healthy server.
  const checked = await validateTarget(app, projectId, target);
  if (!checked.ok) return checked.error;
  const stopped = await stopDockControl(app, projectId, controlId, target.hostId);
  if (!stopped.ok) return stopped;
  const started = await startDockControl(app, projectId, controlId, target, launch);
  if (started.ok || stopped.value.sessionId === null) return started;
  // The old session is already stopped: say so, so the caller knows to start
  // it again. A constant message (plus the numeric status and the machine
  // `code`), not the upstream text echoed back.
  return {
    ...started,
    message: `The control was stopped but could not be restarted (HTTP ${started.status}); start it again.`,
  };
}
