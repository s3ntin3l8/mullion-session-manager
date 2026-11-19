import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import type { SessionInfo } from "./pty-manager.js";
import { promptLiveTaskWorker } from "./task-reseed.js";
import { isTaskInRateLimitGrace } from "./task-rate-limit-grace.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { broadcastTaskEvent } from "./task-events.js";

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

// Older agent builds omit agentTurnInFlight. Keep their timestamp fallback
// tolerant of clock skew between a remote worker and this process.
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

const SHELL_JOB_DESC_MAX_CHARS = 200;

export function buildContinuationNudge(branchName: string | null): string {
  return (
    `Your turn ended, but nothing is committed${branchName ? ` on ${branchName}` : ""} yet, so ` +
    "this task would fail now. Nobody is available to answer questions. Continue the work " +
    "the issue asks for: decide, implement it, run the repo's checks and commit. If " +
    "something truly blocks you, say what in one line, commit what is useful and end your turn."
  );
}

function formatShellJobDescription(info: SessionInfo): string {
  const raw = info.outstandingBackgroundTasks.find((t) => t.description)?.description?.trim() ?? "";
  if (!raw) return "(unnamed shell job)";
  return raw.length <= SHELL_JOB_DESC_MAX_CHARS
    ? raw
    : `${raw.slice(0, SHELL_JOB_DESC_MAX_CHARS)}…`;
}

export function buildShellTailNudge(branchName: string | null, jobDescription: string): string {
  return (
    `A background shell job (${jobDescription}) has been running since your turn ended, and ` +
    `nothing is committed${branchName ? ` on ${branchName}` : ""} yet. Check the job; if it is ` +
    "a wait loop that cannot finish (for example `pgrep -f` matching its own command line), " +
    "kill it. Then carry on with the task, run the repo's checks, and commit."
  );
}

type NudgeTask = Pick<
  typeof tasks.$inferSelect,
  | "id"
  | "projectId"
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

type NudgeGuardResult =
  | { action: "send"; sent: number }
  | { action: "wait" }
  | { action: "stop" }
  | { action: "stale_row" };

function evaluateNudgeGuard(
  app: FastifyInstance,
  task: NudgeTask,
  info: SessionInfo | null,
  now: Date,
  requireNewTurnFinish: boolean,
): NudgeGuardResult {
  if (info === null || info.workFinishedAt === null || info.errorState === "api_error") {
    return { action: "stop" };
  }
  if (isTaskInRateLimitGrace(task, resolveTaskMasterConfig(app).rateLimitGraceMinutes)) {
    return { action: "stop" };
  }

  const sent = nudgesThisSpell(task);
  if (sent > 0 && task.lastNudgedAt !== null) {
    const nudgedAt = task.lastNudgedAt.getTime();
    const sameTurn = info.workFinishedAt <= nudgedAt + CLOCK_SKEW_TOLERANCE_MS;
    const turnInFlight = info.agentTurnInFlight ?? sameTurn;
    if (turnInFlight) {
      return now.getTime() - nudgedAt < NUDGE_TURN_GRACE_MS
        ? { action: "wait" }
        : { action: "stop" };
    }
    if (requireNewTurnFinish && sameTurn) {
      return { action: "wait" };
    }
  }
  if (sent >= MAX_WORKER_NUDGES) return { action: "stop" };

  // `task` is the tick's start-of-tick snapshot and typing cannot be undone:
  // re-read the row so a Reject/Retry that landed meanwhile gets no continuation.
  const [fresh] = app.db
    .select({ status: tasks.status, sessionId: tasks.sessionId })
    .from(tasks)
    .where(eq(tasks.id, task.id))
    .all();
  if (!fresh || fresh.status !== "in_progress" || fresh.sessionId !== task.sessionId) {
    return { action: "stale_row" };
  }

  return { action: "send", sent };
}

async function sendWorkerNudge(
  app: FastifyInstance,
  task: NudgeTask,
  sent: number,
  now: Date,
  message: string,
  label: string,
): Promise<boolean> {
  const outcome = await promptLiveTaskWorker(app, task, message, label);
  if (outcome !== "typed") return false;

  app.db
    .update(tasks)
    .set({ nudgeCount: sent + 1, lastNudgedAt: now })
    .where(eq(tasks.id, task.id))
    .run();
  broadcastTaskEvent({ taskId: task.id, projectId: task.projectId, kind: "nudge", ts: Date.now() });
  return true;
}

/**
 * Decides whether a "turn ended with no commits" gate failure should instead
 * be answered with a continuation. Returns `true` when the caller must NOT fail
 * the task this tick (a nudge was just typed, or a nudged turn is still
 * running); `false` to fail exactly as before.
 *
 * - Never on a rate-limit/api error: those have their own grace and park paths.
 * - Never without a finished turn to react to.
 * - After a nudge, wait while agentTurnInFlight is true (bounded by
 *   NUDGE_TURN_GRACE_MS), instead of spending the next nudge on a stale finish.
 *   Older agents without that signal fall back to the finish timestamp.
 * - If the live worker cannot be typed into, fail without counting a nudge.
 */
export async function nudgeInsteadOfFailing(
  app: FastifyInstance,
  task: NudgeTask,
  info: SessionInfo | null,
  now: Date,
): Promise<boolean> {
  const guard = evaluateNudgeGuard(app, task, info, now, false);
  if (guard.action === "wait" || guard.action === "stale_row") return true;
  if (guard.action === "stop") return false;

  const typed = await sendWorkerNudge(
    app,
    task,
    guard.sent,
    now,
    buildContinuationNudge(task.branchName),
    "task nudge",
  );
  if (!typed) return false;

  app.log.info(
    { taskId: task.id, nudge: guard.sent + 1, max: MAX_WORKER_NUDGES },
    "task nudge: worker ended its turn with no commits — typed a continuation instead of failing",
  );
  return true;
}

/**
 * Nudges a no-commit worker whose turn ended behind a still-running background
 * shell job past `SHELL_TAIL_NUDGE_MS`, without failing the task if the nudge
 * is skipped or cannot be delivered (the budget stays the backstop).
 *
 * Shares the `MAX_WORKER_NUDGES` budget, rate-limit/api_error refusals, and
 * stale-row guard with `nudgeInsteadOfFailing`, and never re-nudges behind the
 * same job until a new turn ends.
 */
export async function nudgeShellTailWorker(
  app: FastifyInstance,
  task: NudgeTask,
  info: SessionInfo | null,
  now: Date,
): Promise<boolean> {
  const guard = evaluateNudgeGuard(app, task, info, now, true);
  if (guard.action !== "send" || info === null) return false;

  const jobDescription = formatShellJobDescription(info);
  const typed = await sendWorkerNudge(
    app,
    task,
    guard.sent,
    now,
    buildShellTailNudge(task.branchName, jobDescription),
    "task shell-tail nudge",
  );
  if (!typed) return false;

  app.log.info(
    { taskId: task.id, nudge: guard.sent + 1, max: MAX_WORKER_NUDGES, jobDescription },
    "task shell-tail nudge: worker stuck behind a background shell job with no commits — typed a nudge",
  );
  return true;
}
