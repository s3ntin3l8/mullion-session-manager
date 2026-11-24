import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { resolveSessionHostId } from "./session-live-info.js";
import { resolveProjectDock } from "./project-config.js";
import { isPortInUse } from "./port-probe.js";
import { findSessionHoldingPort } from "./dev-server-detect.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { parseHostCwds, projectCwdOnHost } from "./placement.js";

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

function portInUseMessage(port: number, holderSessionId?: number): string {
  return holderSessionId !== undefined
    ? `Port ${port} is in use by session ${holderSessionId}`
    : `Port ${port} is in use by another process`;
}

/**
 * The host-agnostic core: given the checkout `cwd` ON THE HOST WHERE THE
 * PROBE RUNS, the launch `command`, the project's `devServerUrl` and the ids of
 * that host's live sessions, returns the conflict or null.
 *
 * The control is found by its `command` (the one thing every launcher — the
 * UI, `mullion dock start`, MCP — sends unchanged from the control). The
 * port is the control's own `port`; failing that, the project's bare-port
 * `devServerUrl`, but only for a control that plausibly IS the dev server (the
 * preview-flagged one, or the project's only control) so a git-status or logs
 * control is not refused because the dev server is up. The probe is a
 * loopback bind on THIS machine, so the caller is the host that will run the
 * session: the primary for a local launch, the agent (via
 * `POST /internal/dock-port-check`) for a remote one.
 */
export async function findDockPortConflict(
  app: FastifyInstance,
  opts: {
    cwd: string;
    command: string;
    devServerUrl: string | null | undefined;
    sessionIds: string[];
  },
): Promise<DockPortConflict | null> {
  const controls = resolveProjectDock(opts.cwd, app.config.CRS_CONFIG_DIR).filter((c) => !c.docker);
  const control = controls.find((c) => c.command === opts.command);
  if (!control) return null;

  let port = control.port;
  if (
    port === undefined &&
    opts.devServerUrl &&
    BARE_PORT.test(opts.devServerUrl) &&
    (control.preview === true || controls.length === 1)
  ) {
    port = Number(opts.devServerUrl);
  }
  if (port === undefined || port < 1 || port > 65535) return null;

  if (!(await isPortInUse(port))) return null;

  const holder = findSessionHoldingPort(app, opts.sessionIds, port);
  const holderSessionId = holder !== null ? Number(holder) : undefined;
  return { port, holderSessionId, message: portInUseMessage(port, holderSessionId) };
}

/**
 * Returns the conflict that should block spawning a `kind: "dock"` session
 * running `command` in `projectId`, or null to let it through.
 *
 * `hostId` is the host the session will actually run on (an explicit launch
 * target); it defaults to the project's host. A local target is probed here
 * against the project's checkout on this host (`projectCwdOnHost`; none there
 * means no conflict). A remote target is probed ON THAT HOST: the agent runs
 * the same core against its own checkout and ports (issue #3426), and only
 * holders on the target host count — the same port elsewhere is no conflict.
 * An agent that cannot answer (old build, unreachable) never blocks a launch:
 * the spawn that follows reports an unreachable host itself.
 */
export async function checkDockPortConflict(
  app: FastifyInstance,
  projectId: number,
  command: string,
  hostId?: string,
): Promise<DockPortConflict | null> {
  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  if (!project) return null;
  const targetHostId = hostId ?? project.hostId;

  // The dock config is read from the project's checkout on the TARGET host: a
  // remote project launched locally has its local checkout in `hostCwds`, not
  // at `project.cwd` (a path on the remote host). No checkout there, no probe.
  const cwd = projectCwdOnHost(project, targetHostId, parseHostCwds(project.hostCwds));
  if (cwd === null || cwd === "") return null;

  if (targetHostId !== LOCAL_HOST_ID) {
    try {
      const answer = await getRemoteHostClient(app, targetHostId).resolveDockPortCheck({
        cwd,
        command,
        devServerUrl: project.devServerUrl ?? null,
      });
      if (!answer) return null;
      // The agent's pty ids ARE the primary's session ids (the spawn carries
      // the id), so the holder maps to the primary's row; a holder the primary
      // has no row for is reported as "another process".
      let holderSessionId = answer.holderSessionId;
      if (
        holderSessionId !== undefined &&
        app.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, holderSessionId))
          .all().length === 0
      ) {
        holderSessionId = undefined;
      }
      return {
        port: answer.port,
        holderSessionId,
        message: portInUseMessage(answer.port, holderSessionId),
      };
    } catch (err) {
      app.log.warn({ err, hostId: targetHostId }, "dock port check on agent host failed");
      return null;
    }
  }

  const active = app.db
    .select({ id: sessions.id, projectId: sessions.projectId, hostId: sessions.hostId })
    .from(sessions)
    .where(eq(sessions.status, "active"))
    .all()
    .filter((r) => resolveSessionHostId(app, r) === LOCAL_HOST_ID);
  return findDockPortConflict(app, {
    cwd,
    command,
    devServerUrl: project.devServerUrl,
    sessionIds: active.map((r) => String(r.id)),
  });
}
