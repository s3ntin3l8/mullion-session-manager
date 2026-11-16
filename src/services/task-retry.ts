import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, tasks } from "../db/schema.js";
import { killSession } from "./session-lifecycle.js";
import { recordTaskTransition } from "./task-state.js";
import { syncTaskTransition } from "./task-github-sync.js";
import { agentChangeModelClears, SUPERSEDED_RETRY_DETAIL } from "./task-claim.js";

export type EnqueueRetryOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "not-found" | "not-failed" | "superseded";
      detail?: string;
    };

/**
 * Queues a retry of a `failed` task (#483). The retry is never refused for
 * lack of a free slot: the row goes `failed -> claimed` with `resumeQueued`
 * set, and the dispatch sweep (task-dispatch.ts) resumes the task's preserved
 * branch through `dispatchQueuedRetry` (task-claim.ts) once the concurrency
 * cap has room, the same way a fresh claim waits in the queue.
 *
 * Always human-initiated, so — like a manual claim — it never refuses on an
 * unseedable agent. #2292 still applies: a copy a project merge superseded is
 * refused, because resuming it would start a duplicate worker.
 *
 * A failed task with no recorded branch never got a worktree, so there is
 * nothing to resume: the retry resets it to `ready` instead (a plain claim
 * then starts it fresh).
 *
 * `worktreePath`/`branchName` are left as they are: they are the deterministic
 * values the dispatch resumes onto.
 */
export async function enqueueRetry(
  app: FastifyInstance,
  taskId: number,
  opts: { agent?: string | null; reviewAgent?: string | null } = {},
): Promise<EnqueueRetryOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task) return { ok: false, reason: "not-found" };
  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-found" };

  // Issue #2491 — the same agent-change revalidation as enqueueTask; the
  // queued retry then runs with the surviving task-level choice.
  const agentChangeModelPatch = agentChangeModelClears(app, task, project, opts);

  // The old worker must be gone before the retry is dispatchable, or a sweep
  // could resume the branch under it. So: validate what we can, kill, then make
  // ONE atomic write that re-checks everything (the row never shows `claimed`
  // with a live session). A failed task's session is meant to be dead anyway,
  // so killing it ahead of a (racing) refusal costs nothing. Best-effort — a
  // kill failure must not block the retry.
  if (
    task.status === "failed" &&
    task.sessionId !== null &&
    task.supersededAt === null &&
    task.branchName
  ) {
    try {
      await killSession(app, task.sessionId, "detach");
    } catch (err) {
      app.log.warn(
        { err, taskId, sessionId: task.sessionId },
        "task retry: failed to kill the previous session, leaving it as-is",
      );
    }
  }

  const reservation = app.db.transaction((tx) => {
    const [current] = tx.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (!current || current.status !== "failed") {
      return { reserved: false as const, currentStatus: current?.status };
    }
    // #2292 — checked before the branch gate: "superseded" is the true
    // diagnosis; a branchless copy would otherwise just reset to ready.
    if (current.supersededAt !== null) {
      return { reserved: false as const, superseded: true as const };
    }
    const hasBranch = Boolean(current.branchName);
    const patch: Partial<typeof tasks.$inferInsert> = {
      // No branch means the run died before it ever got a worktree (e.g. no
      // agent host could take it), so there is nothing to resume: put the task
      // back to "ready" and let a normal claim start it fresh, rather than
      // refusing a retry the user can't otherwise perform.
      status: hasBranch ? "claimed" : "ready",
      ...(hasBranch ? { queuedAt: new Date() } : {}),
      // A human retry resumes the same branch with a worker that may well
      // rebase this time: a spent auto-rebase budget must not outlive it
      // (same reasoning as the Reject route in routes/tasks.ts).
      rebaseAttempts: 0,
      // Spelled out so the reset below never reads as a queued resume.
      resumeQueued: hasBranch,
      // Clear the prior attempt's leftovers so the retry carries no old
      // failure text, stale PR link or dead session id. prUrl and prNumber are
      // cleared together, never one alone (#972).
      failureReason: null,
      failureDiagnostics: null,
      // Issue #1997 — a retry starts a fresh queue spell.
      dispatchFailingSince: null,
      dispatchHeld: false,
      completedAt: null,
      claimedAt: null,
      startedAt: null,
      sessionId: null,
      // Stale "needs a human" markers from the failed run (give-up from review).
      autoReturnCapAnnouncedAt: null,
      needsHumanReason: null,
      approvalCarriedAt: null,
      prUrl: null,
      prNumber: null,
      // Review fix (#1015) — resuming a failed task must un-hide it, or it
      // vanishes from the board while it waits for a slot.
      archivedAt: null,
    };
    if (opts.agent !== undefined) patch.agent = opts.agent;
    if (opts.reviewAgent !== undefined) patch.reviewAgent = opts.reviewAgent;
    Object.assign(patch, agentChangeModelPatch);
    tx.update(tasks)
      .set(patch)
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "failed")))
      .run();
    return { reserved: true as const, resetToReady: !hasBranch };
  });

  if (!reservation.reserved) {
    if ("superseded" in reservation && reservation.superseded) {
      app.log.info(
        { taskId },
        "task retry: refused — the task copy was superseded by a project merge",
      );
      return { ok: false, reason: "superseded", detail: SUPERSEDED_RETRY_DETAIL };
    }
    return {
      ok: false,
      reason: "not-failed",
      detail: `Task is not failed (status: ${reservation.currentStatus ?? "unknown"})`,
    };
  }

  if (reservation.resetToReady) {
    recordTaskTransition(app, {
      taskId,
      projectId: project.id,
      from: "failed",
      to: "ready",
      via: "retry-reset",
    });
    return { ok: true };
  }

  // Recorded AFTER the write: the transition listener (task-dispatch.ts)
  // schedules a dispatch sweep on any move into "claimed", so a free slot
  // starts the retry immediately.
  recordTaskTransition(app, {
    taskId,
    projectId: project.id,
    from: "failed",
    to: "claimed",
    via: "retry-queue",
  });

  void syncTaskTransition(app, { ...task, status: "claimed" }, project, "claimed");
  return { ok: true };
}
