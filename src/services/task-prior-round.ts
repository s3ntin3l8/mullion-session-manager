import type { tasks } from "../db/schema.js";

/**
 * What the previous review round found, for a FOLLOW-UP review's delta
 * prompt — the last `## Round N` block of `tasks.reviewFindings`, plus the
 * head SHA that review covered. `undefined` for a first review, and after an
 * inconclusive one (there was nothing to follow up on).
 *
 * Also `undefined` when the head has not moved since that review AND no worker
 * round has run since its verdict — which is what a human's "Re-review" is. A
 * follow-up prompt tells the reviewer that a finding which is not fixed keeps
 * its severity, so on unchanged code it would just re-derive the verdict the
 * human asked to have looked at again. The worker-round condition keeps the
 * auto-return loop's own follow-ups (a round that pushed nothing) as deltas, so
 * its stall detection still sees the previous round's dispositions.
 * `headSha` is the head being reviewed now, when the caller knows it.
 */
export function priorRoundFor(
  task: typeof tasks.$inferSelect,
  headSha?: string | null,
): { reviewedSha: string | null; findings: string; approved?: boolean } | undefined {
  if (!task.reviewFindings) return undefined;
  if (
    task.lastReviewVerdict !== "changes-requested" &&
    task.lastReviewVerdict !== "approved-with-suggestions"
  ) {
    return undefined;
  }
  const workerReturnedSinceVerdict =
    task.claimedAt !== null &&
    task.lastReviewVerdictAt !== null &&
    task.claimedAt.getTime() > task.lastReviewVerdictAt.getTime();
  if (!workerReturnedSinceVerdict && headSha && task.lastReviewedHeadSha === headSha) {
    return undefined;
  }
  const blocks = task.reviewFindings.split(/\n\n(?=## Round )/);
  const last = blocks[blocks.length - 1];
  return last
    ? {
        reviewedSha: task.lastReviewedHeadSha,
        findings: last,
        approved: task.lastReviewVerdict === "approved-with-suggestions",
      }
    : undefined;
}
