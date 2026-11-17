import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { readCodexRateLimitSignal } from "../hooks/codex-rollout.mjs";
import { sessionEvents, sessions, tasks } from "../db/schema.js";
import { killSession } from "./session-lifecycle.js";
import { parseCodexResetTime } from "./codex-reset-time.js";
import { parseRelativeResetDuration } from "./relative-reset-duration.js";
import { failReviewingGate } from "./task-gate-failure.js";
import { resolveBackend } from "./session-backend.js";
import { resolveSessionHostId } from "./session-host.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { isTaskInRateLimitGrace } from "./task-rate-limit-grace.js";
import { recordTaskTransition } from "./task-state.js";
import { syncTaskTransition } from "./task-github-sync.js";
import { getProjectById } from "./project-store.js";

const PARK_REASON = "rate limited; held until the provider reset";

/** Statuses where the turn is already over, so a park cannot kill a live
 * one. `deriveSessionStatus` checks `compacting`, `subagent`, `background`
 * and `working` — and every `awaiting_*` prompt — before `idle`. */
export const PARKABLE_RATE_LIMIT_STATUSES: ReadonlySet<string> = new Set([
  "api_error",
  "finished",
  "idle",
  "needs_input",
]);

type ParkTask = typeof tasks.$inferSelect;

/** The session's latest persisted `stop_failure` event: the hook's own `error`
 * text and when it fired. agy states its reset there ("Resets in 102h16m12s",
 * relative to `at`); every CLI's text is what the card quotes. Read from
 * `session_events`, which outlives the session's in-memory error state. */
function readStopFailure(
  app: FastifyInstance,
  sessionId: number,
): { message: string | null; at: number } | null {
  const event = app.db
    .select()
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.kind, "stop_failure")))
    .orderBy(desc(sessionEvents.id))
    .limit(1)
    .get();
  if (!event) return null;
  try {
    const error = (JSON.parse(event.payload ?? "{}") as { error?: unknown }).error;
    return { message: typeof error === "string" && error ? error : null, at: event.ts };
  } catch {
    return { message: null, at: event.ts };
  }
}

function formatResetUtc(reset: Date): string {
  return reset.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * #2940 — kill a rate-limited in_progress worker and park the task `ready`
 * until the provider's reset. The reset comes from Codex's rollout or, for agy
 * (#3234), from the "Resets in …" duration in the latest stop_failure event.
 *
 * #3234 — the park is capped at `rateLimitMaxParkHours`, for every source: a
 * reset further out ends the task `failed` with `needsHumanReason:
 * "rate-limited"` (reset and provider text on the row) instead of holding it
 * for days. Returns true when the task left grace either way.
 *
 * Returns false (and changes nothing) when there is no future reset to wait for, terminate failed, or
 * the task is not an in_progress worker still inside grace. Reviewing tasks
 * are never parked. A false result leaves the #2930 grace path alone,
 * including the budget skip.
 *
 * `killSession` flips the row to `killed` before terminate and swallows a
 * terminate error, so its return value is not a success flag. An `active`
 * session is terminated first; a throw leaves the row `active` and the task
 * on grace. Already-dead rows still go through `killSession` (an `exited`
 * row is dismissed to `killed`).
 *
 * Local sessions only: the reset is read from this process's Codex rollout
 * index, the same boundary as `detectCodexRateLimits`. A remote-host worker
 * is left on grace.
 */
export async function parkRateLimitedTask(
  app: FastifyInstance,
  task: ParkTask,
  sessionId: number,
  projectId: number,
): Promise<boolean> {
  if (task.status !== "in_progress" || task.sessionId === null) return false;
  if (!isTaskInRateLimitGrace(task, resolveTaskMasterConfig(app).rateLimitGraceMinutes))
    return false;

  const failure = readStopFailure(app, sessionId);
  const message = failure?.message ?? task.rateLimitMessage;
  const reset =
    readReset(app, sessionId) ??
    (failure ? parseRelativeResetDuration(failure.message, new Date(failure.at)) : null);
  if (reset === null || reset.getTime() <= Date.now()) return false;

  const row = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) return false;

  const maxParkMs = resolveTaskMasterConfig(app).rateLimitMaxParkHours * 3_600_000;
  if (reset.getTime() - Date.now() > maxParkMs) {
    return failBeyondCap(app, task, row, projectId, reset, message);
  }
  if (row.status === "active") {
    try {
      await resolveBackend(app, resolveSessionHostId(app, row)).terminate(String(sessionId));
    } catch (err) {
      app.log.warn(
        { err, taskId: task.id, sessionId },
        "task rate-limit park: terminate failed, leaving the session on grace",
      );
      return false;
    }
  }

  let killed: Awaited<ReturnType<typeof killSession>>;
  try {
    killed = await killSession(app, sessionId);
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id, sessionId },
      "task rate-limit park: kill failed, leaving the session on grace",
    );
    return false;
  }
  if (!killed) return false;

  const updated = app.db
    .update(tasks)
    .set({
      status: "ready",
      sessionId: null,
      claimedAt: null,
      startedAt: null,
      rateLimitUntil: reset,
      rateLimitMessage: message,
      resumeQueued: task.branchName !== null,
      failureReason: PARK_REASON,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "in_progress")))
    .run();
  if (updated.changes === 0) return false;

  recordTaskTransition(app, {
    taskId: task.id,
    projectId,
    from: "in_progress",
    to: "ready",
    via: "rate-limit-park",
    context: { sessionId, rateLimitUntil: reset.toISOString(), message },
  });

  // Tell the issue why the task went quiet. Best-effort and never throws
  // (syncTaskTransition swallows GitHub failures), so it cannot undo the park.
  const project = getProjectById(app, projectId);
  if (project) {
    await syncTaskTransition(
      app,
      {
        ...task,
        status: "ready",
        sessionId: null,
        failureReason: PARK_REASON,
        rateLimitUntil: reset,
      },
      project,
      "rate_limited",
      { resumeAt: reset, message: message ?? undefined },
    );
  }
  return true;
}

/** #3234 — the reset is beyond the park cap: fail the task, naming the quota
 * and when it returns. Runs behind the same guards as the park (in_progress,
 * inside grace, a turn already over, per the caller). Reuses the no-commits
 * failure path, so the WIP is salvaged, the session killed and the issue told.
 * Not a success flag from `failReviewingGate` (it returns void): the row is
 * re-read to see whether the task actually failed. */
async function failBeyondCap(
  app: FastifyInstance,
  task: ParkTask,
  row: typeof sessions.$inferSelect,
  projectId: number,
  reset: Date,
  message: string | null,
): Promise<boolean> {
  const project = getProjectById(app, projectId);
  if (!project) return false;
  const maxHours = resolveTaskMasterConfig(app).rateLimitMaxParkHours;
  const failureReason = `Provider quota exhausted${message ? `: ${message}` : ""} — resets ${formatResetUtc(reset)}, beyond the ${maxHours}h park limit. Retry once the quota is back.`;
  await failReviewingGate(
    app,
    task,
    row,
    project,
    resolveBackend(app, resolveSessionHostId(app, row)),
    "in_progress",
    failureReason,
    new Date(),
    null,
    { needsHumanReason: "rate-limited", rateLimitUntil: reset, rateLimitMessage: message },
  );
  const after = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
  return after?.status === "failed" && after.needsHumanReason === "rate-limited";
}

function readReset(app: FastifyInstance, sessionId: number): Date | null {
  let transcriptSessions: Array<{ id: string; transcriptPath: string; codexHome: string }>;
  try {
    transcriptSessions = app.pty.codexTranscriptPathSessions();
  } catch {
    return null;
  }
  const found = transcriptSessions.find((session) => session.id === String(sessionId));
  if (!found) return null;
  let signal;
  try {
    signal = readCodexRateLimitSignal(found.transcriptPath, { codexHome: found.codexHome });
  } catch {
    return null;
  }
  if (!signal?.rateLimited || signal.message === null) return null;
  return parseCodexResetTime(signal.message);
}
