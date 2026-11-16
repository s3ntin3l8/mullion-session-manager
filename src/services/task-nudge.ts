import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import type { SessionInfo } from "./pty-manager.js";
import { promptLiveTaskWorker } from "./task-reseed.js";
import { isTaskInRateLimitGrace } from "./task-rate-limit-grace.js";
import { resolveTaskMasterConfig } from "./task-config.js";

// A Task Master worker runs unattended, and ending its turn is what signals
// "done" (task-prompt.ts). A turn that ends with NO commits — a summary that
// announces the next step instead of taking it, an offer to continue, a
// question nobody will answer — fails the task outright (checkReviewingGate).
// Anthropic's Opus 5.5 guide: treat a text-only end of turn as a report, not as
// proof the task is done, and send one short continuation before giving up.
//
// This runs from failReviewingGate, i.e. only once the gate has ALREADY found no
// commits past base, so it never touches a worker that has something to review.

/** How many continuations one in_progress spell gets before the task fails as it always did. */
export const MAX_WORKER_NUDGES = 2;

/** How long to wait for a nudged turn to start AND finish before failing anyway. */
export const NUDGE_TURN_GRACE_MS = 10 * 60_000;

// Same tolerance as task-reconciler's turnFinishedSinceClaim: clocks of a
// remote-hosted worker's own host may differ slightly from this process's.
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

export function buildContinuationNudge(branchName: string | null): string {
  return (
    `Your turn ended, but nothing is committed${branchName ? ` on ${branchName}` : ""} yet, so ` +
    "this task would fail now. Nobody is available to answer questions. Continue the work " +
    "the issue asks for: decide, implement it, run the repo's checks and commit. If " +
    "something truly blocks you, say what in one line, commit what is useful and end your turn."
  );
}

type NudgeTask = Pick<
  typeof tasks.$inferSelect,
  | "id"
  | "claimedAt"
  | "nudgeCount"
  | "lastNudgedAt"
  | "lastRateLimitAt"
  | "branchName"
  | "sessionId"
>;

/** The nudges already sent in the task's CURRENT in_progress spell. */
export function nudgesThisSpell(
  task: Pick<NudgeTask, "claimedAt" | "nudgeCount" | "lastNudgedAt">,
): number {
  if (task.lastNudgedAt === null || task.claimedAt === null) return 0;
  return task.lastNudgedAt.getTime() >= task.claimedAt.getTime() ? task.nudgeCount : 0;
}

/**
 * Decides whether a "turn ended with no commits" gate failure should instead
 * be answered with a continuation. Returns `true` when the caller must NOT fail
 * the task this tick (a nudge was just typed, or a nudged turn is still
 * running); `false` to fail exactly as before.
 *
 * - Never on a rate-limit/api error: those have their own grace and park paths.
 * - Never without a finished turn to react to.
 * - After a nudge the worker's latch still reads "finished" until its next turn
 *   starts, so a finish that does not postdate the last nudge is the SAME turn:
 *   wait (bounded by NUDGE_TURN_GRACE_MS) instead of burning the next nudge.
 * - If the live worker cannot be typed into, fail without counting a nudge.
 */
export async function nudgeInsteadOfFailing(
  app: FastifyInstance,
  task: NudgeTask,
  info: SessionInfo | null,
  now: Date,
): Promise<boolean> {
  if (info === null || info.workFinishedAt === null || info.errorState === "api_error") {
    return false;
  }
  if (isTaskInRateLimitGrace(task, resolveTaskMasterConfig(app).rateLimitGraceMinutes))
    return false;

  const sent = nudgesThisSpell(task);
  if (sent > 0 && task.lastNudgedAt !== null) {
    const nudgedAt = task.lastNudgedAt.getTime();
    if (info.workFinishedAt <= nudgedAt + CLOCK_SKEW_TOLERANCE_MS) {
      return now.getTime() - nudgedAt < NUDGE_TURN_GRACE_MS;
    }
  }
  if (sent >= MAX_WORKER_NUDGES) return false;

  // `task` is the tick's start-of-tick snapshot and typing cannot be undone:
  // re-read the row so a Reject/Retry that landed meanwhile gets no continuation.
  const [fresh] = app.db
    .select({ status: tasks.status, sessionId: tasks.sessionId })
    .from(tasks)
    .where(eq(tasks.id, task.id))
    .all();
  if (!fresh || fresh.status !== "in_progress" || fresh.sessionId !== task.sessionId) return true;

  const outcome = await promptLiveTaskWorker(
    app,
    task,
    buildContinuationNudge(task.branchName),
    "task nudge",
  );
  if (outcome !== "typed") return false;

  app.db
    .update(tasks)
    .set({ nudgeCount: sent + 1, lastNudgedAt: now })
    .where(eq(tasks.id, task.id))
    .run();
  app.log.info(
    { taskId: task.id, nudge: sent + 1, max: MAX_WORKER_NUDGES },
    "task nudge: worker ended its turn with no commits — typed a continuation instead of failing",
  );
  return true;
}
