import { eq } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import type { FastifyInstance } from "fastify";

/**
 * Decides whether to grace a task that landed in `errorState === "api_error"`
 * (the value `stop_failure` sets) after a rate-limit-class error — skip this
 * reconciler tick rather than fail. Returns `true` ONLY when every condition
 * holds; on `false`, the caller falls through to its normal fail path.
 *
 * Conditions, all required: `errorState === "api_error"`, `graceMinutes > 0`,
 * `hasCommitsPastBase === false` (if the task made progress, don't delay —
 * let the normal path succeed), the durable `task.lastRateLimitAt !== null`
 * (set by `recordRateLimitEvent` below; this is the authoritative window
 * anchor, NOT `info.errorAt` — see "Why lastRateLimitAt and not errorAt"
 * below), `errorDetail` exactly `"rate_limit"` (the short classification
 * label `stop_failure` sets via the wire-level `errorType` field, populated
 * onto `SessionInfo.errorDetail` in `hook-handlers.ts`; `null` means no
 * classification, free-text detail carries no signal — fail fast rather
 * than grace an unknown error that could be a permanent failure like auth),
 * and the window itself
 * (`Date.now() - lastRateLimitAt < graceMinutes * 60_000`).
 *
 * ## Why lastRateLimitAt and not errorAt
 *
 * Session-level `errorState`/`errorAt`/`errorDetail` are TTL-cleared by
 * `PtyManager.clearStaleErrorIfOlderThan` at `staleErrorSeconds` (default
 * 1800s/30min). A `stop_failure` never sets `lastTurnEndedAt`, so once
 * cleared, the session derives to a non-`api_error`/non-`finished` status
 * that fails the outer `(finished || api_error)` gate in
 * `task-reconciler.ts` and strands the task in_progress even with a high
 * `rateLimitGraceMinutes`. The task-level `lastRateLimitAt` column is
 * durable (no TTL, no in-memory sweep), so the grace window works for any
 * value up to its 1440-min cap regardless of `staleErrorSeconds`.
 */

/**
 * Persists a rate_limit stop_failure event to the task row. Called from the
 * worker and review-agent reconcile paths the moment they observe
 * `info.errorDetail === "rate_limit"`; every observed event restarts the
 * window by overwriting the column with `new Date()` (matches the user
 * mental model of "a fresh rate_limit resets the clock"). Capture happens
 * BEFORE the grace check on the same tick so a fresh rate_limit takes
 * effect immediately rather than on the next-tick pass. Returns the
 * timestamp that was written (or null if no write happened), so the caller
 * can use it without re-reading the task row — `task` objects in the
 * reconciler loop are snapshots from the start-of-tick SELECT and don't
 * reflect mid-loop writes.
 */
export async function recordRateLimitEvent(
  app: FastifyInstance,
  taskId: number,
  info: { errorDetail: string | null },
): Promise<Date | null> {
  if (info.errorDetail !== "rate_limit") return null;
  const now = new Date();
  app.db.update(tasks).set({ lastRateLimitAt: now }).where(eq(tasks.id, taskId)).run();
  return now;
}

/**
 * True iff the task is within its rate_limit grace window and the
 * rate_limit is still the most recent error state. See module doc above
 * for the full rationale.
 */
export function isRateLimitGraceActive(
  info: {
    errorState: string | null;
    errorDetail: string | null;
  },
  task: {
    lastRateLimitAt: Date | null;
  },
  opts: {
    graceMinutes: number;
    hasCommitsPastBase: boolean;
  },
): boolean {
  if (info.errorState !== "api_error") return false;
  if (opts.graceMinutes <= 0) return false;
  if (opts.hasCommitsPastBase) return false;
  if (task.lastRateLimitAt === null) return false;
  if (info.errorDetail !== "rate_limit") return false;

  const graceMs = opts.graceMinutes * 60_000;
  return Date.now() - task.lastRateLimitAt.getTime() < graceMs;
}

/**
 * Lightweight pre-check used by the outer reconciler gate: returns true
 * iff the task has a recent enough `lastRateLimitAt` to enter the
 * `(finished || api_error || in_grace)` branch on its own. Does NOT
 * consult the session at all — it only exists so the outer gate can
 * accept a TTL-cleared session that the rate_limit left in
 * "idle"-or-whatever and would otherwise strand in_progress. The full
 * grace check (above) refines this with the api_error pre-check and
 * commits-progress gate; this is just the "is the durable signal
 * recent enough to deserve attention" predicate.
 */
export function isTaskInRateLimitGrace(
  task: { lastRateLimitAt: Date | null },
  graceMinutes: number,
): boolean {
  if (task.lastRateLimitAt === null) return false;
  if (graceMinutes <= 0) return false;
  const graceMs = graceMinutes * 60_000;
  return Date.now() - task.lastRateLimitAt.getTime() < graceMs;
}
