// Issue #3194 — "Start fresh": the operator's way out of a retry that waits
// for a host that never comes back.
//
// A queued retry waits when its ORIGINAL host is offline and the task's
// branch is not on origin: the branch (with the worker's commits) lives on
// that host, so the retry cannot start anywhere else — and it is
// deliberately not failed after 6h either, because failing it would free
// nothing.
//
// "Start fresh" is the deliberate alternative: it ABANDONS the preserved
// branch (it stays where it is, on that host — the commits are not thrown
// away, they are simply not where this task runs any more) and re-queues the
// task as a NEW claim, which derives its own branch and worktree.

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, tasks } from "../db/schema.js";
import {
  abandonedBranchesOf,
  serializeAbandonedBranches,
  type AbandonedBranch,
} from "../shared/abandoned-branches.js";
import { enqueueTask } from "./task-claim.js";
import { recordTaskTransition } from "./task-state.js";

export type StartFreshOutcome =
  { ok: true } | { ok: false; reason: "not-found" | "not-waiting"; detail?: string };

/**
 * Abandons a waiting retry's preserved branch and re-queues the task as a
 * new claim.
 *
 * Only a task that is actually WAITING for a host can be started fresh (a
 * `claimed` row with `resumeQueued` set and `retryHostId` naming the host it
 * waits for — its original worker's host). Anything else is refused: starting
 * a task that is running, or one whose branch is still where the worker left
 * it, would throw work away that nobody asked to abandon.
 *
 * The wait does not have to be a CONFIRMED-stranded one: a wait whose origin
 * state could not be confirmed (a local-only repository, a project with no
 * GitHub token) offers the same escape, because that is exactly the wait that
 * would otherwise never end.
 */
export async function startFreshTask(
  app: FastifyInstance,
  taskId: number,
): Promise<StartFreshOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task) return { ok: false, reason: "not-found" };
  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-found" };

  const reset = app.db.transaction((tx) => {
    const [current] = tx.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (
      !current ||
      current.status !== "claimed" ||
      !current.resumeQueued ||
      current.retryHostId === null
    ) {
      return { reset: false as const };
    }
    // Issue #3229 — the abandoned branch is recorded ON THE ROW, not only in
    // the transition context below: the claim path reads it (so the new
    // claim derives a branch name of its own instead of colliding with this
    // one) and the orphan-clear reads it (so it never deletes this branch —
    // the only copy of the worker's commits). The list is APPENDED to: a
    // second "Start fresh" must not make the first one's branch reusable.
    const abandoned: AbandonedBranch[] = abandonedBranchesOf(current);
    if (current.branchName !== null && current.branchName.length > 0) {
      abandoned.push({ hostId: current.retryHostId, branch: current.branchName });
    }
    tx.update(tasks)
      .set({
        status: "ready",
        resumeQueued: false,
        retryHostId: null,
        retryStrandedOnHost: false,
        dispatchHeld: false,
        dispatchFailingSince: null,
        failureReason: null,
        failureDiagnostics: null,
        // The preserved branch and its worktree STAY on the host that owns
        // them — that is the whole point of the action: the commits are not
        // deleted, they are just not where this task runs any more. The new
        // claim derives its own branch name and worktree path.
        branchName: null,
        worktreePath: null,
        abandonedBranches:
          abandoned.length > 0 ? serializeAbandonedBranches(abandoned) : current.abandonedBranches,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
      .run();
    return {
      reset: true as const,
      abandonedHost: current.retryHostId,
      abandonedBranch: current.branchName,
    };
  });

  if (!reset.reset) {
    return {
      ok: false,
      reason: "not-waiting",
      detail: "This task is not waiting for a host — nothing to start fresh",
    };
  }

  recordTaskTransition(app, {
    taskId,
    projectId: project.id,
    from: "claimed",
    to: "ready",
    via: "start-fresh",
    // The host the preserved branch was abandoned on — the operator needs to
    // know where those commits are — and the branch's NAME, because that is
    // what a human needs to clear it (or to find it) on that host: nothing
    // else keeps it, and the row moves on to a fresh branch.
    context: {
      abandonedHost: reset.abandonedHost,
      abandonedBranch: reset.abandonedBranch,
    },
  });

  // Re-queue it as a NEW claim (the same path a manual claim takes): it
  // joins the queue, and the dispatch sweep starts it when a slot is free.
  const queued = await enqueueTask(app, taskId, { auto: false });
  if (!queued.ok) {
    app.log.warn(
      { taskId, reason: queued.reason, detail: queued.detail },
      "task start-fresh: could not re-queue the task as a new claim",
    );
    return {
      ok: false,
      reason: "not-waiting",
      detail: queued.detail ?? "Could not re-queue the task as a new claim",
    };
  }
  return { ok: true };
}
