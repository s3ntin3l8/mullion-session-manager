// #2904 — a non-Actions status that never settles after green CI.
//
// Codecov's `codecov/patch` is a CHECK RUN posted by the Codecov app, not an
// Actions check run: it has no workflow run behind it, so the red-check path
// (`attemptReturnRedCiToWorker` / `holdRedCiWithoutProgress` in
// task-reconciler.ts) cannot re-run anything for it — and it is `pending`,
// not red, so that path does not even look at it. Task Master merges only
// when every check is green (required or not), so a `codecov/patch` that
// Codecov never resolves holds the PR — and with it the task — forever.
//
// The lever a human reaches for is the one GitHub exposes: re-run the job
// that uploaded the coverage. Codecov reprocesses the commit and posts the
// status within seconds (that is what unblocked PRs #2894 and #2897 on
// 2026-11-10, and what the issue's author did by hand).
//
// This module owns that whole mechanism: detecting the stuck status,
// re-running the upload job, the per-head budget, and the message the human
// reads. The reconciler calls it and records the outcome as the merge error
// (and the needs-human reason, once the budget is spent); it does not record
// anything itself.

import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import type { GitHubRepoRef } from "./git-remote.js";
import {
  actionsRunIdFromCheckUrl,
  fetchRunsForHeadChecked,
  getWorkflowRunJobs,
  isRedCheckConclusion,
  type CheckRunResult,
} from "./github.js";
import { rerunJob } from "./github-write.js";
import { resolveGitHubToken } from "./github-integration.js";
import { createThrottledWarn } from "./throttled-warn.js";
import type { MergeNeedsHumanReason } from "./task-merge-human.js";

/**
 * The "no dispatch token" warning, throttled once per task per hour: the
 * merge sweep asks again on every tick, and a misconfigured install would
 * otherwise write the same line every 30 seconds for as long as the stall
 * lasts.
 */
const warnNoDispatchToken = createThrottledWarn(60 * 60_000);

/**
 * How long a non-Actions status must stay pending before it counts as stuck.
 *
 * Codecov posts its status a moment after the upload job finishes and
 * normally resolves it within a couple of minutes, so a status that is still
 * pending half an hour later is not going to settle on its own. The head's
 * CI must have finished by then — the guard below waits for that — so this
 * window measures the provider, not the upload.
 */
export const COVERAGE_STATUS_STALL_MS = 30 * 60_000;

/**
 * How many coverage re-uploads one head may get.
 *
 * Two is enough for the case this exists for: the first re-upload usually
 * settles the status, and the second covers a first attempt that raced a
 * still-running workflow. A third would only repeat what the first two
 * already showed.
 */
export const MAX_COVERAGE_REUPLOADS_PER_HEAD = 2;

/**
 * The minimum gap between two re-uploads of the same head.
 *
 * A re-upload is not instant: the job re-runs, Codecov reprocesses the
 * commit, and the status lands a minute or two later. Asking again while the
 * first attempt is still working would spend the budget on the same stall.
 */
export const COVERAGE_REUPLOAD_SPACING_MS = 20 * 60_000;

/** A non-Actions status on the head that is pending and not settling. */
export interface CoverageStall {
  /** The status' own name (`codecov/patch`). */
  statusName: string;
  /** When it went pending (ISO 8601). */
  pendingSince: string;
  /** How long it has been pending, in whole minutes. */
  pendingMinutes: number;
  /** True when Codecov posted it — the provider this mechanism can re-ask. */
  isCodecov: boolean;
}

/** What the attempt did. */
export type CoverageReuploadOutcome =
  /** Nothing to do: no stuck non-Actions status, or the head's CI is not settled. */
  | { kind: "no-stall" }
  /** A stuck status was found, but the budget or the spacing is not due yet. */
  | { kind: "awaiting-retry"; stall: CoverageStall }
  /** The upload job was re-run; Codecov should reprocess the commit. */
  | { kind: "reuploaded"; stall: CoverageStall; attempt: number }
  /** Every candidate job was refused by GitHub (it will not re-run them). */
  | { kind: "refused"; stall: CoverageStall; attempt: number }
  /** The head's CI has no job that uploads coverage — nothing to re-run. */
  | { kind: "no-candidate"; stall: CoverageStall; attempt: number }
  /** GitHub could not be asked (a rate limit, a network error). */
  | { kind: "unavailable"; stall: CoverageStall; attempt: number }
  /** The attempt could not be RECORDED (a database error) — no budget was spent. */
  | { kind: "reserve-failed"; stall: CoverageStall }
  /** The budget is spent and the status still has not settled: a human must act. */
  | { kind: "capped"; stall: CoverageStall };

/**
 * Is this check run one GitHub Actions produced?
 *
 * Only an Actions check run belongs to a workflow run of this repository,
 * and only its workflow run can be re-run. A check run from another app
 * (Codecov's `codecov/patch`, CodeQL's) has no Actions run behind it: its
 * `details_url` names the app's own page, not `/actions/runs/<id>`.
 *
 * `details_url` alone cannot say this — CodeQL's check run names
 * `/runs/<id>`, not `/actions/runs/<id>` — so the app slug is what decides.
 */
export function isActionsCheckRun(check: CheckRunResult): boolean {
  return check.app === "github-actions";
}

/**
 * The head's stuck non-Actions status, or null when there is none.
 *
 * "Stuck" = posted by an app other than GitHub Actions, not completed, and
 * pending for longer than {@link COVERAGE_STATUS_STALL_MS}. The pending age
 * comes from the check run's own `started_at` — for a check run that never
 * settles that is when it went pending. A check run with no start time
 * (still queued, never picked up) has no age to measure, so it is not
 * counted: it is not yet known to be stuck.
 *
 * The oldest stuck status is the one worth naming: it has been waiting
 * longest, and it is the one whose re-upload is most overdue.
 */
export function findStuckNonActionsStatus(
  checkRuns: readonly CheckRunResult[],
  now: number,
): CoverageStall | null {
  let stuck: CoverageStall | null = null;
  for (const c of checkRuns) {
    // A check run with no app at all cannot be classified, so it is left out
    // of both the Actions set and the non-Actions set rather than guessed at.
    if (!c.app || isActionsCheckRun(c)) continue;
    if (c.status === "completed") continue;
    if (!c.startedAt) continue;
    const since = Date.parse(c.startedAt);
    if (!Number.isFinite(since)) continue;
    const age = now - since;
    if (age < COVERAGE_STATUS_STALL_MS) continue;
    const candidate: CoverageStall = {
      statusName: c.name,
      pendingSince: c.startedAt,
      pendingMinutes: Math.max(1, Math.round(age / 60_000)),
      isCodecov: c.app === "codecov" || /codecov/i.test(c.name),
    };
    if (!stuck || candidate.pendingMinutes > stuck.pendingMinutes) stuck = candidate;
  }
  return stuck;
}

/**
 * Has every Actions check on the head finished, and none of them red?
 *
 * This is the precondition for calling the status "stuck": while an Actions
 * job is still running, a pending status is the normal state of a CI that
 * has not reported yet, and the red-check path owns that case. A non-Actions
 * status is only evidence of a stalled provider once the head's own CI is
 * done and green.
 */
export function actionsChecksFinishedGreen(checkRuns: readonly CheckRunResult[]): boolean {
  return checkRuns.every(
    (c) =>
      !isActionsCheckRun(c) || (c.status === "completed" && !isRedCheckConclusion(c.conclusion)),
  );
}

/**
 * The workflow runs of this head that could own a coverage upload, most
 * checks first.
 *
 * The run that uploads the coverage is the one behind the head's CI, and the
 * CI run owns most of the head's check runs — so ordering by that count puts
 * the right run first and keeps the number of job listings down. Ids come
 * from the check runs' own `details_url` (`…/actions/runs/<id>/job/<id>`),
 * the same way the red-check path finds the run that owns a red check.
 */
export function candidateCoverageRuns(
  checkRuns: readonly CheckRunResult[],
  repoRef: GitHubRepoRef,
): number[] {
  const counts = new Map<number, number>();
  for (const c of checkRuns) {
    const runId = actionsRunIdFromCheckUrl(c.url, repoRef);
    if (runId === undefined) continue;
    counts.set(runId, (counts.get(runId) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([runId]) => runId);
}

/** A job of a workflow run that uploads coverage, and can be re-run. */
function isCoverageUploadJob(job: { status: string; steps: readonly { name: string }[] }): boolean {
  // A job that is still running cannot be re-run (GitHub refuses with 422),
  // so it is not a candidate.
  if (job.status !== "completed") return false;
  return job.steps.some((s) => /codecov/i.test(s.name));
}

/** How one re-upload round ended. */
type ReuploadResult = "accepted" | "refused" | "no-candidate" | "unavailable";

/**
 * Re-run one job that uploads the coverage.
 *
 * A job GitHub refuses to re-run (403/404/422 "cannot be rerun" — the run
 * has already been re-run, or the job is not in a re-runnable state) is
 * SKIPPED, not an error: the caller tries the next candidate. One accepted
 * re-run is enough — Codecov reprocesses the commit from that one upload.
 */
async function reuploadCoverage(
  app: FastifyInstance,
  taskId: number,
  token: string,
  repoRef: GitHubRepoRef,
  checkRuns: readonly CheckRunResult[],
): Promise<ReuploadResult> {
  let refused = false;
  let failed = false;
  for (const runId of candidateCoverageRuns(checkRuns, repoRef)) {
    const jobs = await getWorkflowRunJobs(token, repoRef.owner, repoRef.repo, runId);
    for (const job of jobs) {
      if (!isCoverageUploadJob(job)) continue;
      try {
        if (await rerunJob(token, repoRef.owner, repoRef.repo, job.id)) return "accepted";
        refused = true;
      } catch (err) {
        // "Could not ask" (a rate limit, a network error) is NOT a refusal:
        // the job may well be re-runnable, and the next candidate may answer
        // fine. Say so instead of pretending GitHub said no.
        failed = true;
        app.log.warn(
          { err, taskId, runId, jobId: job.id },
          "task reconcile: could not ask GitHub to re-run the coverage upload job",
        );
      }
    }
  }
  if (failed) return "unavailable";
  if (refused) return "refused";
  // Nothing to re-run: this head's CI has no completed job with a coverage
  // upload step (a repository whose CI does not upload coverage at all, or a
  // run whose jobs could not be listed). Saying "GitHub refused" would be a
  // lie; saying nothing would hide it.
  return "no-candidate";
}

/**
 * Reserve one re-upload attempt on the task row.
 *
 * The count belongs to the HEAD it was spent on: a new head starts a fresh
 * budget, because a new head is a new CI run with a new status to settle.
 * The write is a compare-and-set on the row it read, so two sweeps racing
 * over the same task cannot both spend the same attempt — the loser of the
 * CAS sees no change and does not re-upload.
 *
 * Returns false when the row moved under us (another sweep spent the
 * attempt first).
 */
async function reserveAttempt(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  headSha: string,
  attempt: number,
  now: number,
): Promise<boolean> {
  const changed = app.db
    .update(tasks)
    .set({
      coverageReuploadHeadSha: headSha,
      coverageReuploadCount: attempt,
      coverageReuploadAt: new Date(now),
    })
    .where(
      and(
        eq(tasks.id, task.id),
        eq(tasks.coverageReuploadCount, task.coverageReuploadCount),
        task.coverageReuploadHeadSha === null
          ? isNull(tasks.coverageReuploadHeadSha)
          : eq(tasks.coverageReuploadHeadSha, task.coverageReuploadHeadSha),
      ),
    )
    .run();
  return changed.changes > 0;
}

/**
 * Notice a stuck non-Actions status on the head, and re-upload the coverage
 * that would make the provider report it.
 *
 * `checkRuns` are the head's check runs, already read by the caller (the
 * merge sweep reads them to name a red non-required check), so this costs no
 * extra check-run call of its own.
 */
export async function attemptCoverageReupload(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  args: {
    repoRef: GitHubRepoRef;
    headSha: string;
    checkRuns: readonly CheckRunResult[];
  },
): Promise<CoverageReuploadOutcome> {
  const now = Date.now();

  // The head's own CI must be finished and green first: while an Actions
  // job is still running a pending status is the normal state of a CI that
  // has not reported yet, and the red-check path owns that case.
  if (!actionsChecksFinishedGreen(args.checkRuns)) return { kind: "no-stall" };

  const stall = findStuckNonActionsStatus(args.checkRuns, now);
  if (!stall) return { kind: "no-stall" };

  // The budget belongs to the head it was spent on: a new head is a new CI
  // run with a new status to settle, so it starts over.
  const sameHead = task.coverageReuploadHeadSha === args.headSha;
  const attempts = sameHead ? task.coverageReuploadCount : 0;
  const lastAttemptAt = sameHead ? (task.coverageReuploadAt?.getTime() ?? null) : null;

  // `dispatch`, not `write`: re-running a job and listing a run's jobs need
  // `actions: write`, which only the dispatch permission set grants (the
  // same scope the red-check rerun uses).
  const token = await resolveGitHubToken(app, args.repoRef, "dispatch");
  if (!token) {
    warnNoDispatchToken(
      app,
      task.id,
      { taskId: task.id, prNumber: task.prNumber },
      "task reconcile: no dispatch token — cannot re-run the coverage upload for a stuck CI status",
    );
    return { kind: "no-stall" };
  }

  // The head's own workflow runs must all be finished before a pending
  // status counts: a status can be pending simply because the job that
  // produces it is still running, and the head's CI has to have reported
  // before the provider's silence is the provider's fault.
  //
  // This gates EVERY outcome below, not just the re-upload: a verdict that
  // spends the budget or names a Codecov-side stall must not be reached while
  // the head's CI is still running, or the human is told to fix a stall that
  // is really just a CI still in flight.
  const runs = await fetchRunsForHeadChecked(
    token,
    args.repoRef.owner,
    args.repoRef.repo,
    args.headSha,
  );
  if (!runs.ok) return { kind: "no-stall" };
  if (runs.runs.some((r) => r.status !== "completed")) return { kind: "no-stall" };

  if (attempts >= MAX_COVERAGE_REUPLOADS_PER_HEAD) return { kind: "capped", stall };

  if (lastAttemptAt !== null && now - lastAttemptAt < COVERAGE_REUPLOAD_SPACING_MS) {
    return { kind: "awaiting-retry", stall };
  }

  const attempt = sameHead ? attempts + 1 : 1;
  // A failure to RESERVE the attempt (a database error) or to ask GitHub must
  // not escape as a merge failure: it is "could not act", and the next tick
  // tries again. The two differ in one way that matters to the human: a
  // reserved-but-unused attempt IS spent from the budget, while a reserve that
  // never landed is not — hence the two distinct outcomes below.
  try {
    if (!(await reserveAttempt(app, task, args.headSha, attempt, now))) {
      // Another sweep spent this attempt first — do not spend another one.
      return { kind: "awaiting-retry", stall };
    }
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id, headSha: args.headSha },
      "task reconcile: could not record the coverage re-upload attempt — the next tick will try again",
    );
    return { kind: "reserve-failed", stall };
  }

  const result = await reuploadCoverage(app, task.id, token, args.repoRef, args.checkRuns);
  if (result === "unavailable") return { kind: "unavailable", stall, attempt };
  if (result === "refused") return { kind: "refused", stall, attempt };
  if (result === "no-candidate") return { kind: "no-candidate", stall, attempt };

  app.log.info(
    {
      taskId: task.id,
      prNumber: task.prNumber,
      headSha: args.headSha,
      attempt,
      status: stall.statusName,
    },
    "task reconcile: a non-Actions status stayed pending on a green head — re-ran the coverage upload so the provider can reprocess the commit",
  );
  return { kind: "reuploaded", stall, attempt };
}

/**
 * The merge sweep's hold for a stuck non-Actions status: what to record as
 * the merge error, and whether the task now needs a human.
 *
 * The reason is set only once the budget is spent — until then the task is
 * still working on it (it re-runs the upload itself), and a card that says
 * "needs a human" while Mullion is still retrying is a lie. After the cap,
 * the reason names the stall so the card does not read as "merely
 * reviewing".
 */
export async function holdForStuckCoverageStatus(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  args: {
    repoRef: GitHubRepoRef;
    headSha: string;
    checkRuns: readonly CheckRunResult[];
    /** What the merge sweep records when nothing is stuck. */
    fallbackMessage: string;
  },
): Promise<{ message: string; reason?: MergeNeedsHumanReason }> {
  const outcome = await attemptCoverageReupload(app, task, args);
  if (outcome.kind === "no-stall") return { message: args.fallbackMessage };

  const pending =
    `the non-required check "${outcome.stall.statusName}" has been pending for ` +
    `${outcome.stall.pendingMinutes} minute(s) on a head whose Actions checks are all green`;
  // Codecov is the provider this exists for; another app's status is the same
  // kind of stall, but calling it a Codecov stall would be a lie.
  const provider = outcome.stall.isCodecov ? "Codecov" : "the status provider";
  // The same distinction, phrased to sit after "a" — "a Codecov-side stall"
  // but "a provider-side stall" (not "a the status provider-side stall").
  const providerSide = outcome.stall.isCodecov ? "Codecov-side" : "provider-side";

  switch (outcome.kind) {
    case "capped":
      return {
        message:
          `Held: ${pending}, and Mullion already spent ` +
          `${MAX_COVERAGE_REUPLOADS_PER_HEAD} coverage re-upload attempt(s) without the status settling. ` +
          `This is a ${providerSide} stall, not something a code change fixes: re-run the coverage upload by hand, or use "Merge now" to override.`,
        reason: "ci-status-stalled",
      };
    case "reuploaded":
      return {
        message:
          `Held: ${pending}. Mullion re-ran the coverage upload (attempt ` +
          `${outcome.attempt} of ${MAX_COVERAGE_REUPLOADS_PER_HEAD}) so ${provider} can reprocess the commit.`,
      };
    case "awaiting-retry": {
      const last = task.coverageReuploadAt?.getTime() ?? null;
      const wait =
        last === null
          ? COVERAGE_REUPLOAD_SPACING_MS
          : COVERAGE_REUPLOAD_SPACING_MS - (Date.now() - last);
      return {
        message:
          `Held: ${pending}. Mullion re-ran the coverage upload recently; the next attempt is due in ` +
          `${Math.max(1, Math.ceil(wait / 60_000))} minute(s).`,
      };
    }
    case "refused":
      return {
        message:
          `Held: ${pending}, but GitHub refused to re-run the coverage upload job ` +
          `(attempt ${outcome.attempt} of ${MAX_COVERAGE_REUPLOADS_PER_HEAD}). ` +
          `Re-run the coverage upload by hand, or use "Merge now" to override.`,
      };
    case "no-candidate":
      return {
        message:
          `Held: ${pending}, and this head's CI has no completed job that uploads coverage, ` +
          `so there is nothing for Mullion to re-run. Re-run the coverage upload by hand, ` +
          `or use "Merge now" to override.`,
      };
    case "unavailable":
      return {
        message:
          `Held: ${pending}, and Mullion could not re-run the coverage upload ` +
          `(a rate limit or a network error), so attempt ` +
          `${outcome.attempt} of ${MAX_COVERAGE_REUPLOADS_PER_HEAD} was spent without a re-run.`,
      };
    case "reserve-failed":
      return {
        message:
          `Held: ${pending}, and Mullion could not record its coverage re-upload ` +
          `attempt (a database error), so no attempt was spent — the next tick will try again.`,
      };
    default:
      return { message: args.fallbackMessage };
  }
}
