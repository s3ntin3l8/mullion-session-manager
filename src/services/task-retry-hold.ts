// Issue #3194 — the "waiting retry" hold.
//
// A queued retry that cannot start yet (its original host is offline and the
// preserved branch is not on origin) stays `claimed` with the reason on the
// row: the board card and the task sidebar show it, and the "Start fresh"
// action is offered against the host it waits for.
//
// Unlike every other hold, this one is NOT bounded by the dispatch give-up
// (DISPATCH_GIVE_UP_AFTER_MS in task-dispatch.ts): the branch is on that
// host, so failing the task after 6h would free nothing — it would only
// throw the work away.

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tasks } from "../db/schema.js";
import type { projects } from "../db/schema.js";
import { broadcastTaskEvent } from "./task-events.js";

/**
 * Issue #3194 — holds a QUEUED RETRY that cannot start yet: its original
 * host is offline and the preserved branch is not on origin, so there is
 * nowhere else to run it.
 *
 * The task stays `claimed` with the reason on the row (the board card and
 * the task sidebar show it), and `tasks.retryHostId` names the host it waits
 * for — that is what the "Start fresh" action is offered against.
 *
 * Unlike every other hold, this one is NOT bounded by the dispatch give-up
 * (DISPATCH_GIVE_UP_AFTER_MS in task-dispatch.ts): the branch is on that
 * host, so failing the task after 6h would free nothing — it would only
 * throw the work away.
 */
export function holdRetry(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  detail: string,
  hostId: string,
  requirementJson: string | null,
): void {
  const unchanged =
    task.failureReason === detail && task.retryHostId === hostId && task.dispatchHeld;
  if (unchanged) return;
  const written = app.db
    .update(tasks)
    .set({
      failureReason: detail,
      dispatchHeld: true,
      dispatchFailingSince: task.dispatchFailingSince ?? new Date(),
      placementRequirement: requirementJson,
      retryHostId: hostId,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
    .run();
  if (written.changes > 0) {
    app.log.info({ taskId: task.id, hostId }, `task retry: ${detail} — holding the retry`);
    broadcastTaskEvent({
      taskId: task.id,
      projectId: project.id,
      kind: "dispatch",
      ts: Date.now(),
    });
  }
}
