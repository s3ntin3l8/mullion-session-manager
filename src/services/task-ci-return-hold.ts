import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import type { projects } from "../db/schema.js";
import type { GitHubRepoRef } from "./git-remote.js";
import { resolveGitHubToken } from "./github-integration.js";
import { rerunFailedJobs } from "./github-write.js";
import { isHostTransientError } from "./remote-host-errors.js";
import { redactSecrets } from "./scaffold-failure.js";
import { resolveBackend } from "./session-backend.js";
import { resolveTaskWorkerHost } from "./session-live-info.js";
import { neutraliseDecisionLine } from "./task-decisions.js";
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

const MAX_UNFIXABLE_REASON_CHARS = 500;

/**
 * A worker's free-text reason, made safe to store and show: one line, secrets
 * redacted, capped. It is shown as plain text by the board (React escapes it),
 * so it is NOT markup-escaped here; the PR comment, which GitHub renders as
 * markdown, escapes it (`neutraliseDecisionLine`) where it is built.
 */
export function sanitiseCiUnfixableReason(raw: string): string {
  const oneLine = redactSecrets(raw.replace(/\s+/g, " ").trim());
  return oneLine.length > MAX_UNFIXABLE_REASON_CHARS
    ? `${oneLine.slice(0, MAX_UNFIXABLE_REASON_CHARS)}…`
    : oneLine;
}

/** What GitHub's merge state says about whether the red checks are required:
 * `unstable` is "only non-required checks are failing", `blocked` is "a
 * required one is". Anything else is not a claim worth making. */
function requiredClause(mergeableState: string | undefined): string {
  if (mergeableState === "unstable") return " None of them is a required check.";
  if (mergeableState === "blocked") return " At least one of them is a required check.";
  return "";
}

/**
 * Did the worker declare, for THIS head, that the red check cannot be fixed
 * from the PR? `"transient"` means the host holding the file is unreachable or
 * busy right now — the caller waits a tick rather than rerunning or parking on
 * an answer it could not get. Any other read error (a peer build without the
 * route, a 5xx) will not heal by waiting and reads as "no declaration".
 */
async function readUnfixableDeclaration(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  headSha: string,
): Promise<string | null | "transient"> {
  try {
    return await resolveBackend(app, resolveTaskWorkerHost(app, task)).readTaskCiUnfixable(
      task.id,
      headSha,
    );
  } catch (err) {
    if (isHostTransientError(err)) {
      app.log.warn(
        { err, taskId: task.id },
        "task reconcile: host unreachable or busy reading the worker's ci-unfixable declaration — retrying next tick",
      );
      return "transient";
    }
    app.log.warn(
      { err, taskId: task.id },
      "task reconcile: failed to read the worker's ci-unfixable declaration — treating it as none",
    );
    return null;
  }
}

/**
 * Neutralises a check name or worker reason for a GitHub markdown PR comment:
 * runs `neutraliseDecisionLine` (mentions, HTML, markdown links/images) and
 * inserts a zero-width space after `#` before digits so bare `#123` and
 * `owner/repo#123` references do not auto-link or emit cross-reference events.
 */
function neutraliseCiHoldCommentText(text: string): string {
  return neutraliseDecisionLine(text).replace(/#(?=\d)/g, "#\u200B");
}

/**
 * Park a task whose red check no further automatic step will clear, for a human.
 * `ci-unfixable`: the worker said so. `ci-still-red`: it pushed nothing and the
 * reruns did not clear it. Set BEFORE the post, CAS'd on the task still
 * reviewing and not yet parked (same reasoning as the round-cap notice in
 * `attemptReturnRedCiToWorker`); `lastReviewedHeadSha` is the head so only a
 * GENUINE later push re-arms it (`reannounceCappedTasksAfterHumanPush`).
 */
async function parkRedCiForHuman(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  park: {
    reason: "ci-unfixable" | "ci-still-red";
    headSha: string;
    redChecks: { name: string }[];
    mergeableState?: string;
    workerReason?: string;
  },
): Promise<void> {
  const names = park.redChecks.map((c) => c.name).join(", ");
  const parked = app.db
    .update(tasks)
    .set({
      autoReturnCapAnnouncedAt: new Date(),
      needsHumanReason: park.reason,
      ciHoldNote: park.workerReason ? `${names} — ${park.workerReason}` : names,
      lastReviewedHeadSha: park.headSha,
    })
    .where(
      and(
        eq(tasks.id, task.id),
        eq(tasks.status, "reviewing"),
        isNull(tasks.autoReturnCapAnnouncedAt),
      ),
    )
    .run();
  if (parked.changes === 0) return;
  ciRerunRequestedAt.delete(task.id);
  app.log.warn(
    {
      taskId: task.id,
      headSha: park.headSha,
      reason: park.reason,
      checks: park.redChecks.map((c) => c.name),
    },
    "task reconcile: a check is red on a head the worker was already returned for and no automatic step will clear it — parked for a human",
  );
  const required = requiredClause(park.mergeableState);
  // The comment is markdown GitHub renders and the check names and the worker's
  // text are not ours: neutralise mentions, issue/PR auto-links and markup in both.
  const safeNames = neutraliseCiHoldCommentText(names);
  const body =
    park.reason === "ci-unfixable"
      ? `The worker was sent back for a failing CI check on this task's PR (${safeNames}) and reported that no change to this PR can fix it: "${neutraliseCiHoldCommentText(park.workerReason ?? "")}".${required} Mullion has stopped re-running it. A human can approve the task and use "Merge anyway" if the check is not required, or fix the cause on the base branch and update this branch (which re-arms the task).`
      : `A CI check is still failing on this task's PR (${safeNames}). The worker was sent back for this exact commit and pushed nothing, and re-running the failed jobs did not clear it.${required} The automatic loop has stopped; a human needs to re-run the check or push a fix.`;
  await postReviewFindingsComment(app, task, project, { body });
}

/**
 * The same-head arm of the red-CI gate (`attemptReturnRedCiToWorker`): the PR
 * head is the one the worker was last returned for, so the worker pushed
 * nothing and sending it back again would replay an identical prompt every
 * tick (task 1031536 did that 116 times). Instead:
 *
 * 0. if the worker declared the failure unfixable from this PR
 *    (`readUnfixableDeclaration`), park at once as `ci-unfixable`: no reruns;
 * 1. re-run the failed Actions jobs (bounded by `MAX_CI_RERUNS_PER_HEAD`, spaced
 *    by `CI_RERUN_SETTLE_MS`) — GitHub refuses that for some runs (CodeQL,
 *    runs that never created jobs), which falls through to
 * 2. parking: `needsHumanReason: "ci-still-red"` plus the announce stamp, one
 *    PR comment naming the checks. A human push moves the head and
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
  current: {
    headSha: string;
    repoRef: GitHubRepoRef;
    failedRunIds: number[];
    /** GitHub's `mergeable_state`, only to say whether the red checks are required. */
    mergeableState?: string;
  },
  redChecks: { name: string }[],
): Promise<true> {
  // Already parked (by this arm or the cap): nothing more to say or do.
  if (task.autoReturnCapAnnouncedAt !== null) return true;

  // Inside the settle window after a rerun the answer cannot change, and for a
  // remote-hosted task the read is a host round trip: skip it until the window ends.
  const lastRerunAt = ciRerunRequestedAt.get(task.id);
  if (lastRerunAt !== undefined && Date.now() - lastRerunAt < CI_RERUN_SETTLE_MS) return true;

  const declared = await readUnfixableDeclaration(app, task, current.headSha);
  if (declared === "transient") return true;
  if (declared !== null) {
    await parkRedCiForHuman(app, task, project, {
      reason: "ci-unfixable",
      headSha: current.headSha,
      redChecks,
      mergeableState: current.mergeableState,
      workerReason: sanitiseCiUnfixableReason(declared),
    });
    return true;
  }

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

  await parkRedCiForHuman(app, task, project, {
    reason: "ci-still-red",
    headSha: current.headSha,
    redChecks,
    mergeableState: current.mergeableState,
  });
  return true;
}
