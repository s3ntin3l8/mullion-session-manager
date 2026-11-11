import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { readCodexRateLimitSignal } from "../hooks/codex-rollout.mjs";
import { sessions, tasks } from "../db/schema.js";
import { killSession } from "./session-lifecycle.js";
import { parseCodexResetTime } from "./codex-reset-time.js";
import { resolveBackend } from "./session-backend.js";
import { resolveSessionHostId } from "./session-host.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { isTaskInRateLimitGrace } from "./task-rate-limit-grace.js";
import { recordTaskTransition } from "./task-state.js";

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

/**
 * #2940 — kill a rate-limited in_progress worker and park the task `ready`
 * until the reset Codex wrote into its rollout. Returns false (and changes
 * nothing) when there is no future reset to wait for, terminate failed, or
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

  const reset = readReset(app, sessionId);
  if (reset === null) return false;

  const row = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) return false;
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
    context: { sessionId, rateLimitUntil: reset.toISOString() },
  });
  return true;
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
