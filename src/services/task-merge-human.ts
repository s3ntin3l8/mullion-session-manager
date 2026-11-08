import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tasks } from "../db/schema.js";
import type { PrReviewThreadsResult } from "./github-write.js";

// Reasons a task needs a human that are tied to a merge that cannot proceed
// (as opposed to the review-loop reasons `cap` / `no-progress` /
// `finding-persisted`). They live and die with `tasks.mergeError`: recorded
// with it, cleared wherever it is cleared, and by a merge.
export type MergeNeedsHumanReason = "rebase-exhausted" | "blocked-threads";

/**
 * A `.set()` value for `tasks.needsHumanReason` that clears a merge-tied
 * reason and leaves every other value (a review-loop reason) alone. Use it at
 * each site that clears `mergeError` or records a merge.
 */
export const clearMergeNeedsHumanReason = sql<
  string | null
>`CASE WHEN needs_human_reason IN ('rebase-exhausted', 'blocked-threads') THEN NULL ELSE needs_human_reason END`;

/** The `.set()` fields that clear a merge error and its merge-tied reason. */
export const CLEARED_MERGE_ERROR = {
  mergeError: null,
  needsHumanReason: clearMergeNeedsHumanReason,
};

// A confirmed-merged task never carries a merge error: `mergedAt` wins over a
// late failure from an in-flight request or a slow sweep (a webhook or a
// concurrent reconcile may have recorded the merge while this one was still
// waiting on a timeout), so the write is a no-op once `mergedAt` is set.
//
// `needsHumanReason` names a merge failure only a human can fix. It is set
// whatever the task's status, but never over a review-loop reason (`cap`, ...)
// already parked on the task. Recording any other error clears a stale
// merge-tied reason: the cause changed.
export function recordMergeError(
  app: FastifyInstance,
  taskId: number,
  message: string,
  needsHumanReason?: MergeNeedsHumanReason,
): void {
  app.db
    .update(tasks)
    .set({
      mergeError: message,
      needsHumanReason: needsHumanReason
        ? sql`CASE WHEN needs_human_reason IS NULL OR needs_human_reason IN ('rebase-exhausted', 'blocked-threads') THEN ${needsHumanReason} ELSE needs_human_reason END`
        : clearMergeNeedsHumanReason,
    })
    .where(and(eq(tasks.id, taskId), isNull(tasks.mergedAt)))
    .run();
}

/**
 * Is any unresolved thread one Mullion did not open (a code-scanning bot, a
 * reviewer)? Classified by author, not by `isResolved` alone, because the
 * thread snapshot predates Mullion's own resolve pass.
 */
export async function hasForeignOpenThread(
  result: PrReviewThreadsResult,
  resolveMullionLogins: (viewerLogin: string | null) => Promise<ReadonlySet<string>>,
): Promise<boolean> {
  const mullionLogins = await resolveMullionLogins(result.viewerLogin);
  return result.threads.some(
    (t) =>
      !t.isResolved &&
      !(t.comments.length > 0 && t.comments.every((c) => mullionLogins.has(c.author ?? ""))),
  );
}
