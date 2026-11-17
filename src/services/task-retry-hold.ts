// Issue #3194 — the "waiting retry" hold.
//
// A queued retry that cannot start yet (its original host is offline and the
// preserved branch is not on origin) stays `claimed` with the reason on the
// row: the board card and the task sidebar show it, and the "Start fresh"
// action is offered against the host it waits for.
//
// Two kinds of wait end up here, and they are NOT alike:
//
//   - the branch is CONFIRMED to be only on the original host (GitHub's 404):
//     nothing is freed by failing the task — the work is on that host, and
//     it is there for good — so this wait is exempt from the dispatch
//     give-up (DISPATCH_GIVE_UP_AFTER_MS in task-dispatch.ts) and the host it
//     waits for is recorded in `tasks.retryHostId`;
//   - the branch is on origin (or its origin state could not be confirmed):
//     this is an ordinary placement wait. It keeps the 6-hour give-up like
//     every other wait, and `retryHostId` stays null — there is nothing
//     stranded to abandon, so "Start fresh" is not offered.
//
// Either way the retry's PRESERVED branch survives the hold: `branchName`
// and `worktreePath` are the branch the worker left behind, and a later
// Retry has to be able to resume them.

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tasks } from "../db/schema.js";
import type { projects } from "../db/schema.js";
import { broadcastTaskEvent } from "./task-events.js";

/**
 * Issue #3194 — holds a QUEUED RETRY that cannot start yet: no host can take
 * it right now, and the reason is on the row (the board card and the task
 * sidebar show it).
 *
 * `retryHostId` names the host the task waits for, and it is set ONLY when
 * the preserved branch is confirmed to be stranded on that host — its
 * presence is what exempts the wait from the 6-hour give-up (failing the
 * task would free nothing) and what the "Start fresh" action is offered
 * against. A wait with no stranded branch keeps the give-up.
 */
export function holdRetry(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  detail: string,
  hostId: string,
  requirementJson: string | null,
  /**
   * The host the task is waiting FOR — the one whose preserved branch the
   * retry resumes, and the one the "Start fresh" action abandons that branch
   * on. It is `tasks.retryHostId`, and its presence is what EXEMPTS this wait
   * from the 6-hour give-up (the branch is on that host, so failing the task
   * would free nothing).
   *
   * It is null for a wait that is NOT about the original host — a checkout
   * being prepared on the replacement host, or a wait whose branch is safely
   * on origin. Nothing is stranded on the original host then, so that wait
   * keeps the 6-hour give-up like every other placement wait.
   */
  retryHostId: string | null,
): void {
  const unchanged =
    task.failureReason === detail && task.retryHostId === retryHostId && task.dispatchHeld;
  if (unchanged) return;
  const written = app.db
    .update(tasks)
    .set({
      failureReason: detail,
      // `dispatchHeld` says "this task is waiting for a host, not for a slot".
      // It keeps the task out of the auto-claim pacing budget
      // (task-watcher.ts's countOccupiedSlots: one sleeping host must not
      // stall every unrelated ready task). It is NOT what makes the give-up
      // behave: the give-up reads `retryHostId` (the stranded branch) and
      // `resumeQueued` (a retry keeps its preserved branch), never this flag.
      dispatchHeld: true,
      dispatchFailingSince: task.dispatchFailingSince ?? new Date(),
      placementRequirement: requirementJson,
      retryHostId,
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
