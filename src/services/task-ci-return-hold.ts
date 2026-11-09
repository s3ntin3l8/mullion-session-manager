import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import type { projects } from "../db/schema.js";
import type { GitHubRepoRef } from "./git-remote.js";
import { resolveGitHubToken } from "./github-integration.js";
import { rerunFailedJobs } from "./github-write.js";
import { postReviewFindingsComment } from "./task-github-sync.js";

// A red check on a head the worker was ALREADY sent back for means it came back
// without pushing: what is red is usually not the code (a lost runner, an
// abandoned shard, a run GitHub never created jobs for). Mullion re-runs the
// failed jobs itself, this many times per head, before parking the task.
const MAX_CI_RERUNS_PER_HEAD = 2;
// A rerun takes a moment to replace the red check on the head; sweeping again
// inside this window would read the stale red and burn the next attempt.
const CI_RERUN_SETTLE_MS = 3 * 60_000;
const MAX_CI_RERUN_ENTRIES = 500;
const ciRerunRequestedAt = new Map<number, number>();

/** Exported for tests only — the settle window is module-scope state. */
export function resetCiRerunSettleForTests(): void {
  ciRerunRequestedAt.clear();
}

/**
 * The same-head arm of the red-CI gate (`attemptReturnRedCiToWorker`): the PR
 * head is the one the worker was last returned for, so the worker pushed
 * nothing and sending it back again would replay an identical prompt every
 * tick (task 1031536 did that 116 times). Instead:
 *
 * 1. re-run the failed Actions jobs (bounded by `MAX_CI_RERUNS_PER_HEAD`, spaced
 *    by `CI_RERUN_SETTLE_MS`) — GitHub refuses that for some runs (CodeQL,
 *    runs that never created jobs), which falls through to
 * 2. parking: `needsHumanReason: "no-progress"` plus the announce stamp, one PR
 *    comment, exactly the shape the review loop uses when its worker returns
 *    without a change. A human push moves the head and
 *    `reannounceCappedTasksAfterHumanPush` re-arms the task.
 *
 * Always returns true: the caller must not return the worker or fall through to
 * the approve gates for this tick. An unanswered rerun (rate limit, network)
 * holds without parking, so a blip never strands a task.
 */
export async function holdRedCiWithoutProgress(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  current: { headSha: string; repoRef: GitHubRepoRef; failedRunIds: number[] },
  redChecks: { name: string }[],
): Promise<true> {
  // Already parked (by this arm or the cap): nothing more to say or do.
  if (task.autoReturnCapAnnouncedAt !== null) return true;

  const lastRerunAt = ciRerunRequestedAt.get(task.id);
  if (lastRerunAt !== undefined && Date.now() - lastRerunAt < CI_RERUN_SETTLE_MS) return true;

  if (task.ciRerunCount < MAX_CI_RERUNS_PER_HEAD && current.failedRunIds.length > 0) {
    // `dispatch`, not `write`: re-running jobs needs `actions: write`, which only
    // the dispatch permission set grants (github-app.ts's DISPATCH_PERMISSIONS).
    // With the write token an App install 403s every rerun, which reads as a
    // refusal and would park the task on the first tick.
    const token = await resolveGitHubToken(app, current.repoRef, "dispatch");
    if (token) {
      let accepted = 0;
      let failure: unknown;
      // Per run: a throw on a later run must not discard a rerun GitHub already
      // accepted for an earlier one, or the next tick would re-request it.
      for (const runId of current.failedRunIds) {
        try {
          if (await rerunFailedJobs(token, current.repoRef.owner, current.repoRef.repo, runId)) {
            accepted++;
          }
        } catch (err) {
          failure = err;
          app.log.warn(
            { err, taskId: task.id, headSha: current.headSha, runId },
            "task reconcile: could not ask GitHub to re-run a failed Actions run",
          );
        }
      }
      // Nothing was accepted and at least one request could not be made: hold,
      // do not park (a blip must not strand the task).
      if (accepted === 0 && failure !== undefined) return true;
      if (accepted > 0) {
        const counted = app.db
          .update(tasks)
          .set({ ciRerunCount: task.ciRerunCount + 1 })
          .where(
            and(
              eq(tasks.id, task.id),
              eq(tasks.status, "reviewing"),
              eq(tasks.ciRerunCount, task.ciRerunCount),
            ),
          )
          .run();
        if (counted.changes > 0) {
          if (!ciRerunRequestedAt.has(task.id) && ciRerunRequestedAt.size >= MAX_CI_RERUN_ENTRIES) {
            const oldest = ciRerunRequestedAt.keys().next().value;
            if (oldest !== undefined) ciRerunRequestedAt.delete(oldest);
          }
          ciRerunRequestedAt.set(task.id, Date.now());
          app.log.info(
            {
              taskId: task.id,
              headSha: current.headSha,
              runs: accepted,
              attempt: task.ciRerunCount + 1,
            },
            "task reconcile: the worker returned without a fix for a red check — re-ran the failed Actions jobs instead of returning it again",
          );
        }
        return true;
      }
    }
  }

  // Set BEFORE the post, CAS'd on the task still reviewing and not yet parked
  // (same reasoning as the round-cap notice in attemptReturnRedCiToWorker).
  const parked = app.db
    .update(tasks)
    .set({
      autoReturnCapAnnouncedAt: new Date(),
      needsHumanReason: "no-progress",
      // The human-push re-arm (`reannounceCappedTasksAfterHumanPush`) fires on a
      // head that differs from this baseline. A carried-approval CI fix never
      // re-reviews, so the baseline can be a head or two behind and the very next
      // sweep would re-arm the park it just made (and comment again). Only a
      // GENUINE later push should.
      lastReviewedHeadSha: current.headSha,
    })
    .where(
      and(
        eq(tasks.id, task.id),
        eq(tasks.status, "reviewing"),
        isNull(tasks.autoReturnCapAnnouncedAt),
      ),
    )
    .run();
  if (parked.changes === 0) return true;
  ciRerunRequestedAt.delete(task.id);
  app.log.warn(
    { taskId: task.id, headSha: current.headSha, checks: redChecks.map((c) => c.name) },
    "task reconcile: a check is still red on a head the worker was already returned for and the jobs could not be re-run or a rerun did not clear it — parked for a human",
  );
  await postReviewFindingsComment(app, task, project, {
    body: `A CI check is failing on this task's PR (${redChecks.map((c) => c.name).join(", ")}), but the worker was already sent back for this exact commit and pushed nothing, so the failure does not look like something a code change fixes (a lost runner or an abandoned job). Mullion could not re-run the failed jobs, or re-running them did not clear it. The automatic loop has stopped; this task needs a human to re-run the check or push a fix.`,
  });
  return true;
}
