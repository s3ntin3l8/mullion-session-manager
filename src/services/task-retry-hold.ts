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
//     give-up (DISPATCH_GIVE_UP_AFTER_MS in task-dispatch.ts);
//   - the branch is on origin (or its origin state could not be confirmed):
//     this is an ordinary placement wait. It keeps the 6-hour give-up like
//     every other wait.
//
// The confirmation in the first case is a STANDING fact about the wait
// (issue #3232): a later sweep whose origin lookup degraded (a 502, a rate
// limit, a missing token) says nothing about the branch, so it does not
// withdraw it — the exemption lasts as long as the wait does, and ends with
// it (the retry starts, or the operator starts the task fresh).
//
// Either way the retry WAITS FOR A HOST, so either way the host it waits for
// is recorded (`tasks.retryHostId`) and "Start fresh" is offered — the
// operator's way out of a wait that never ends, and the only escape for a
// project whose origin can never be confirmed.
//
// The two answers live in two COLUMNS on purpose (`tasks.retryHostId` and
// `tasks.retryStrandedOnHost`): one says where the retry waits, the other
// says whether the branch is provably stranded there. Folding them into one
// took the escape away from exactly the waits that needed it most.
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
 */
export function holdRetry(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  opts: {
    /** The reason shown on the card. */
    detail: string;
    /**
     * The host the task is waiting FOR — the one whose preserved branch the
     * retry resumes, and the one the "Start fresh" action abandons that
     * branch on. It is `tasks.retryHostId`, and its presence is what offers
     * "Start fresh" (the operator's way out of a wait that never ends).
     *
     * It is null for a wait that is NOT about the original host — a checkout
     * being prepared on the replacement host. Nothing is stranded on the
     * original host then, and that wait keeps the 6-hour give-up like every
     * other placement wait.
     */
    waitHostId: string | null;
    /**
     * The preserved branch is CONFIRMED to be only on `waitHostId` (GitHub's
     * 404 for the branch's ref): it is not on origin, so the work exists
     * nowhere else. THAT is what exempts the wait from the 6-hour give-up —
     * failing the task would free nothing, because the commits stay on that
     * host.
     *
     * It is `tasks.retryStrandedOnHost`, and it is deliberately NOT the same
     * thing as `waitHostId`: a wait whose origin state could not be
     * confirmed still waits for a host (and still offers "Start fresh"), but
     * its branch may well be on origin, so the give-up still applies to it.
     *
     * Issue #3232 — the value written here is the wait's EFFECTIVE one: a
     * confirmation this wait already holds survives a sweep whose origin
     * lookup degraded (a 502, a rate limit, a missing token), because such a
     * lookup says nothing about the branch. The caller
     * (task-retry-host.ts's `decideRetryHost`) decides that, from the origin
     * state and the row's standing confirmation.
     */
    strandedOnHost: boolean;
    /** The task's placement requirement, stored for the re-placement. */
    requirementJson: string | null;
  },
): void {
  const { detail, waitHostId, strandedOnHost, requirementJson } = opts;
  const unchanged =
    task.failureReason === detail &&
    task.retryHostId === waitHostId &&
    task.retryStrandedOnHost === strandedOnHost &&
    task.dispatchHeld;
  if (unchanged) return;
  const written = app.db
    .update(tasks)
    .set({
      failureReason: detail,
      // `dispatchHeld` says "this task is waiting for a host, not for a slot".
      // It keeps the task out of the auto-claim pacing budget
      // (task-watcher.ts's countOccupiedSlots: one sleeping host must not
      // stall every unrelated ready task). It is NOT what makes the give-up
      // behave: the give-up reads `retryStrandedOnHost` (the branch is
      // provably stranded on the wait host) and `resumeQueued` (a retry keeps
      // its preserved branch), never this flag.
      dispatchHeld: true,
      dispatchFailingSince: task.dispatchFailingSince ?? new Date(),
      placementRequirement: requirementJson,
      retryHostId: waitHostId,
      retryStrandedOnHost: strandedOnHost,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
    .run();
  if (written.changes > 0) {
    app.log.info(
      { taskId: task.id, hostId: waitHostId },
      `task retry: ${detail} — holding the retry`,
    );
    broadcastTaskEvent({
      taskId: task.id,
      projectId: project.id,
      kind: "dispatch",
      ts: Date.now(),
    });
  }
}
