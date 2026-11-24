/**
 * Which host a project's dev server runs on (#3425). A dock control can be
 * started on any host the project has a checkout on, so "the project's host" is
 * only the default: a preview or a dev-server status probe with no session of
 * its own follows the running preview control instead.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import { pickPreviewControl } from "./branch-preview.js";
import { configuredControls } from "./dock-control.js";

// The preview control's id per project and host. Reading it can mean a round
// trip to that host (its dock.json), and a preview request is per asset, so it
// is held briefly — including a failed read, so an unreachable host costs one
// attempt per window, not one per request. A stale id costs at most one window
// of following the old control.
const CONTROL_ID_TTL_MS = 5_000;
const FAILED_READ_TTL_MS = 2_000;
const controlIds = new Map<string, { at: number; ttl: number; controlId: string | null }>();
const inFlight = new Map<string, Promise<string | null>>();

/** Drops the cached control ids (a test, or a dock config that just changed). */
export function clearDevServerHostCache(): void {
  controlIds.clear();
  inFlight.clear();
}

async function previewControlId(
  app: FastifyInstance,
  projectId: number,
  hostId: string,
): Promise<string | null> {
  const key = `${projectId}:${hostId}`;
  const hit = controlIds.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.controlId;
  // One read at a time per key: a cold cache under a burst of asset requests
  // must not fan out into one remote round trip each.
  const pending = inFlight.get(key);
  if (pending) return pending;
  const read = (async () => {
    const controls = await configuredControls(app, projectId, hostId);
    const controlId = controls.ok ? (pickPreviewControl(controls.value)?.id ?? null) : null;
    controlIds.set(key, {
      at: Date.now(),
      ttl: controls.ok ? CONTROL_ID_TTL_MS : FAILED_READ_TTL_MS,
      controlId,
    });
    return controlId;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, read);
  return read;
}

/**
 * The host of the project's running preview control, else the project's own
 * host. A project whose dock sessions all run on its own host never reads a
 * dock config here. Newest running session first; each control is judged by the
 * dock.json of the host it runs on. Never throws: any doubt falls back to the
 * project's host, which is what every caller did before.
 */
export async function resolveDevServerHostId(
  app: FastifyInstance,
  project: { id: number; hostId: string },
): Promise<string> {
  try {
    const running = app.db
      .select({ hostId: sessions.hostId, dockControlId: sessions.dockControlId })
      .from(sessions)
      .where(
        and(
          eq(sessions.projectId, project.id),
          eq(sessions.kind, "dock"),
          eq(sessions.status, "active"),
        ),
      )
      .orderBy(desc(sessions.id))
      .all();
    // Nothing runs elsewhere: the project's host, with no config read.
    if (!running.some((r) => r.hostId && r.hostId !== project.hostId)) return project.hostId;
    for (const row of running) {
      if (!row.dockControlId) continue;
      const hostId = row.hostId ?? project.hostId;
      if ((await previewControlId(app, project.id, hostId)) === row.dockControlId) return hostId;
    }
    return project.hostId;
  } catch (err) {
    app.log.warn({ err, projectId: project.id }, "dev-server host lookup failed");
    return project.hostId;
  }
}
