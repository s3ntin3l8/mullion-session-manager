import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { resolveProjectDock } from "./project-config.js";
import { isPortInUse } from "./port-probe.js";
import { findSessionHoldingPort } from "./dev-server-detect.js";

// Issue #2069 — Mullion never picks a dev-server port, so two dock sessions
// for one control (two worktrees, a second tab, MCP, the CLI) silently race
// for it and the loser only shows a bind error inside its PTY. This is the
// look-before-you-spawn half; the after-the-fact half is dev-server-detect's
// parsePortInUse.

export interface DockPortConflict {
  port: number;
  /** A live Mullion session whose output announced this port as its dev
   * server's. Absent = an external process (or a Mullion session that never
   * printed a recognisable banner). */
  holderSessionId?: number;
  message: string;
}

const BARE_PORT = /^\d{1,5}$/;

export function portInUseMessage(port: number, holderSessionId?: number): string {
  return holderSessionId !== undefined
    ? `Port ${port} is in use by session ${holderSessionId}`
    : `Port ${port} is in use by another process`;
}

/**
 * Returns the conflict that should block spawning a `kind: "dock"` session
 * running `command` in `projectId`, or null to let it through.
 *
 * The control is found by its `command` (the one thing every launcher — the
 * UI, `mullion dock start`, MCP — sends unchanged from the control). The
 * port is the control's own `port`; failing that, the project's bare-port
 * `devServerUrl`, but only for a control that plausibly IS the dev server (the
 * preview-flagged one, or the project's only control) so a git-status or logs
 * control is not refused because the dev server is up. Local-host projects
 * only: the probe is a loopback bind on this machine.
 */
export async function checkDockPortConflict(
  app: FastifyInstance,
  projectId: number,
  command: string,
): Promise<DockPortConflict | null> {
  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  if (!project || project.hostId !== LOCAL_HOST_ID) return null;

  const controls = resolveProjectDock(project.cwd, app.config.CRS_CONFIG_DIR).filter(
    (c) => !c.docker,
  );
  const control = controls.find((c) => c.command === command);
  if (!control) return null;

  let port = control.port;
  if (
    port === undefined &&
    project.devServerUrl &&
    BARE_PORT.test(project.devServerUrl) &&
    (control.preview === true || controls.length === 1)
  ) {
    port = Number(project.devServerUrl);
  }
  if (port === undefined || port < 1 || port > 65535) return null;

  if (!(await isPortInUse(port))) return null;

  const active = app.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.status, "active"))
    .all();
  const holder = findSessionHoldingPort(
    app,
    active.map((r) => String(r.id)),
    port,
  );
  const holderSessionId = holder !== null ? Number(holder) : undefined;
  return { port, holderSessionId, message: portInUseMessage(port, holderSessionId) };
}
