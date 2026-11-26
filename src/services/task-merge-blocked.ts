// The merge sweep's `blocked` arm — the PR state where GitHub reports
// `mergeable_state: "blocked"`.
//
// Split out of task-reconciler.ts, which is at its file-size ceiling (the
// file-size guardrail, `scripts/check-max-file-lines.mjs`, forbids it growing);
// the arm's own logic lives here so it can grow without the reconciler
// growing with it.
//
// WHAT "BLOCKED" MEANS. GitHub collapses several distinct reasons it will
// not merge into one state:
//
//   - a required CHECK is red or still pending,
//   - a required APPROVING REVIEW is missing or was dismissed,
//   - an unresolved review CONVERSATION (a per-thread branch-protection rule
//     that `reviewDecision` has no opinion on).
//
// The arm's job is to say WHICH one is holding the PR, because "Required
// checks are red or still pending" sent a human hunting for a red check when
// the real cause was a missing review.
//
// #2971 — the coverage re-upload. A non-Actions status (Codecov's
// `codecov/patch`, posted by the Codecov app as its own check run, with no
// workflow run of this repository behind it) that never settles holds the PR
// forever — and in a repository whose branch protection REQUIRES the
// provider's status, that PR reads as `blocked`, not `unstable`, so the
// `unstable` arm's own recovery (#2904) never sees it. This arm therefore
// runs the same mechanism, with the same budget, spacing, cap and
// `ci-status-stalled` reason: see `task-coverage-reupload.ts`.

import type { FastifyInstance } from "fastify";
import type { projects, tasks } from "../db/schema.js";
import { isRedCheckConclusion } from "./github.js";
import { resolveMullionReviewLogins, resolveReviewerToken } from "./github-integration.js";
import {
  createPullRequestReview,
  fetchPullRequestReviewThreads,
  getPullRequestReviewDecision,
} from "./github-write.js";
import type { GitHubRepoRef } from "./git-remote.js";
import { readPrCheckRuns } from "./pr-check-runs.js";
import { holdForStuckCoverageStatus } from "./task-coverage-reupload.js";
import {
  describeBlockingThreads,
  recordMergeError,
  type MergeBlockedThreads,
  type MergeNeedsHumanReason,
} from "./task-merge-human.js";
import { mergeRetryBackoff } from "./task-merge-backoff.js";
import { resolveMullionOwnThreadsIfClean } from "./task-own-threads.js";
import { isApprovingVerdict } from "./task-prompt.js";

/** The generic message — the one a blocked PR falls back to. */
const GENERIC_BLOCKED_MESSAGE = "Required checks are red or still pending";

/**
 * Hold a PR GitHub reports as `blocked`, and say what is holding it.
 *
 * Records the merge error (and, once the coverage budget is spent, the
 * `ci-status-stalled` needs-human reason) — it never merges and never
 * re-reads the PR: the caller has already classified this tick.
 */
export async function holdBlockedPullRequest(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  args: {
    repoRef: GitHubRepoRef;
    token: string;
    prNumber: number;
    headSha: string;
  },
): Promise<void> {
  const { repoRef, token, prNumber, headSha } = args;

  // #737 — `mergeable_state: "blocked"` collapses several distinct
  // reasons GitHub won't merge into one state: a required CHECK red
  // or pending, or a required APPROVING REVIEW missing/dismissed.
  // Before this, every "blocked" PR got the same "Required checks
  // are red or still pending" message even when the real cause was a
  // missing review — actively misleading once a repo's branch
  // protection also requires an approval. `reviewDecision` is
  // GitHub's own aggregate verdict across all reviews on the PR
  // (`null` when the repo has no review requirement configured at
  // all, in which case a required CHECK is the only thing "blocked"
  // could mean here).
  const reviewDecision = await getPullRequestReviewDecision(
    token,
    repoRef.owner,
    repoRef.repo,
    prNumber,
  ).catch((err) => {
    app.log.warn(
      { err, taskId: task.id, prNumber },
      "task reconcile: failed to read the PR's review decision — falling back to the generic 'blocked' message",
    );
    // `undefined` — "couldn't ask" — and NOT `null` ("asked, and the repo has
    // no review requirement"): the two are different answers, and the
    // coverage hold below may only run on the second one. A read that failed
    // leaves open the possibility that the PR is blocked on a required
    // APPROVAL, and a message naming a stuck status would hide that.
    return undefined;
  });

  // #737 — re-assert an approval a later Mullion-initiated push may
  // have dismissed. Deliberately `"REVIEW_REQUIRED"` ONLY, not
  // `"CHANGES_REQUESTED"` too (Hermes review, PR #827): a `done` task
  // only ever got there via the bot's own clean-gate or a human
  // clicking Approve, so a `CHANGES_REQUESTED` decision at THIS point
  // can only be a review posted AFTER that — either a human on
  // GitHub, or a later review-agent round the reviewer identity
  // itself posted. Re-asserting APPROVE over that would silently
  // override an explicit rejection, exactly the "manufacture an
  // approval nobody made" failure mode this mechanism must never
  // become, just with the rejection arriving after approval instead
  // of before it. `REVIEW_REQUIRED` has no such ambiguity — it means
  // "no active review objects, but the required-approval count isn't
  // met," which is what a push-dismissed approval (and nothing else
  // reachable from this arm) produces.
  //
  // `attemptMerge` only ever runs for `status: "done"` tasks
  // (processMergeRequests' own candidate query) — reaching "done"
  // already means a human clicked Approve or auto-approve's own
  // `lastReviewVerdict === "clean"` gate fired, so `task.status
  // === "done"` is trivially true on every call here today. Kept as
  // an explicit condition anyway (not just a comment) as a guard
  // against a future refactor calling this function from a context
  // where that's no longer guaranteed.
  //
  // Why this usually can't spin: a successful re-assert flips
  // `reviewDecision` to `"APPROVED"` and the condition below closes
  // immediately. It only reopens when something DISMISSES that
  // approval, which is always a push (`"behind"`'s
  // `updatePullRequestBranch`, or an auto-rebase worker's
  // commits) — so the number of re-asserts this can ever produce is
  // bounded by the number of pushes to the head branch, not by how
  // many sweep ticks pass while blocked, PROVIDED the re-assert
  // actually counts. Hermes review, PR #827 (round 2): that proviso
  // can fail — the reviewer App's `APPROVE` can succeed at the GitHub
  // API level without satisfying the branch protection rule at all
  // (the App isn't an eligible approver — the CODEOWNERS limitation
  // this feature already documents), in which case `reviewDecision`
  // NEVER flips to `"APPROVED"` and the argument above breaks: every
  // backoff tick would re-post an identical `APPROVE` on the same
  // commit forever, spam bounded by ticks, not pushes. Guarded here
  // by memoizing the head SHA a re-assert was last attempted for
  // (`mergeRetryBackoff`, shared with the rest of this task's merge
  // backoff — same lifecycle, cleared by `clearMergeState`/
  // `resetMergeBackoff`) and only trying again once the head SHA
  // actually changes — restoring "bounded by pushes" as a guarantee
  // rather than an assumption, regardless of whether any given
  // re-assert counts. (A persistent failure to re-assert — e.g. a
  // reviewer App that always 422s — still only retries at
  // `processMergeRequests`' own per-task backoff cadence, same as
  // every other merge attempt, not on every tick — that part
  // of the throttling was never the issue.)
  const retryState = mergeRetryBackoff.get(task.id);
  if (
    reviewDecision === "REVIEW_REQUIRED" &&
    task.status === "done" &&
    retryState?.lastReassertedSha !== headSha
  ) {
    const reviewerToken = await resolveReviewerToken(app, repoRef);
    if (reviewerToken) {
      try {
        await createPullRequestReview(reviewerToken, repoRef.owner, repoRef.repo, prNumber, {
          body: "Re-affirming approval: this task's clean review was already approved in Mullion; re-asserting it after a required branch update.",
          commitId: headSha,
          event: "APPROVE",
        });
        // Record the SHA regardless of whether this ends up
        // satisfying branch protection — that's precisely the case
        // this memoization exists to stop from retrying forever.
        // The attempt count and the timestamp are carried over
        // unchanged: this memoizes a re-assert, it does not start a
        // new attempt.
        mergeRetryBackoff.record(task.id, retryState?.lastAttemptedAt ?? Date.now(), {
          attempts: retryState?.attempts ?? 1,
          extra: { lastReassertedSha: headSha },
        });
        // Don't record an error — the next sweep tick re-reads
        // GitHub's fresh mergeable_state instead of retrying a merge
        // this tick already knows is still blocked on stale data.
        return;
      } catch (err) {
        app.log.warn(
          { err, taskId: task.id, prNumber },
          "task reconcile: failed to re-assert the reviewer App's approval",
        );
      }
    }
  }

  // D3 — `reviewDecision` (a repo-wide required-approval verdict) has
  // no opinion on conversation resolution, a SEPARATE, per-thread
  // branch-protection rule (this repo's own `main` has both enabled).
  // Before this, a `blocked` PR with no required-approval rule but an
  // unresolved thread got the same generic "Required checks" message
  // even with CI green — actively wrong, and exactly what made D1's
  // deadlock invisible in the logs. Checked whenever `reviewDecision`
  // ISN'T already a more specific, correct explanation on its own —
  // that's `CHANGES_REQUESTED`/`REVIEW_REQUIRED`, but NOT `APPROVED`:
  // independent review, round 3 — a repo requiring both an approval
  // AND conversation resolution can be `blocked` with the approval
  // requirement already satisfied (`reviewDecision: "APPROVED"`)
  // while a stale conversation is the sole remaining cause; treating
  // `APPROVED` as "already explained" would leave exactly that
  // combination on the old generic message forever.
  //
  // Reading branch protection's own `required_conversation_resolution`
  // flag directly isn't an option here — that endpoint needs the
  // `administration` scope, which neither WRITE_PERMISSIONS nor
  // READ_PERMISSIONS grants — so this
  // derives the cause from OBSERVED unresolved threads instead, which
  // is more precise anyway: it answers "is THIS PR actually blocked on
  // a conversation," not "does the branch require one."
  let message = GENERIC_BLOCKED_MESSAGE;
  let blockedDetail: MergeBlockedThreads | null = null;
  // Whether something OTHER than a check already explains the hold. Only
  // then can the generic message be replaced by the coverage stall (#2971)
  // without overwriting a more specific — and more actionable — cause.
  let explainedByReview = false;
  if (reviewDecision === "CHANGES_REQUESTED") {
    message = "Changes were requested on the PR";
    explainedByReview = true;
  } else if (reviewDecision === "REVIEW_REQUIRED") {
    message = "Waiting on a required approving review";
    explainedByReview = true;
  } else {
    // Self-heals the D1 deadlock — but ONLY when this row's own last
    // ingested verdict is "clean". Independent review, round 2: an
    // earlier version of this call fired unconditionally on the
    // (false) assumption that a `done` task's verdict can never be
    // "changes-requested." It can: `POST .../approve`
    // (task-approve.ts) and the closed-issue sync path
    // (syncClosedIssueToLocal, task-github-sync.ts) both flip
    // "reviewing" straight to "done" on `canTransition` alone, never
    // consulting `lastReviewVerdict` — a human (or a closed issue)
    // can promote a task whose last review genuinely requested
    // changes. Resolving Mullion's own threads in THAT case would
    // satisfy `required_conversation_resolution` with zero
    // corroboration a finding was ever addressed, defeating the
    // entire point of the gate. Checking the column here is what
    // keeps this call as safe as its sibling in
    // processReviewingTasks, which reads the SAME column at the
    // point of ingestion rather than re-deriving a "must be clean by
    // now" assumption.
    //
    // Reuses the self-heal's own fetch for the diagnostic below
    // (independent review, round 3) rather than fetching twice in
    // the same tick — `null` means either self-heal didn't run
    // (verdict isn't "clean") or it hit its own early-return
    // (fetch failure/truncation), either way falling through to a
    // fresh fetch just for the count.
    const selfHealResult = isApprovingVerdict(task.lastReviewVerdict)
      ? await resolveMullionOwnThreadsIfClean(app, task, project)
      : null;
    try {
      const threadsResult =
        selfHealResult ??
        (await fetchPullRequestReviewThreads(token, repoRef.owner, repoRef.repo, prNumber));
      // Only threads Mullion did not open need a human: its own are
      // resolved above when the verdict allows, or belong to the
      // review loop.
      const blocking = await describeBlockingThreads(threadsResult, (viewer) =>
        resolveMullionReviewLogins(app, repoRef, viewer),
      );
      if (blocking) {
        message = blocking.message;
        blockedDetail = blocking.detail;
        explainedByReview = true;
      }
    } catch (err) {
      app.log.warn(
        { err, taskId: task.id, prNumber },
        "task reconcile: failed to check for unresolved review conversations — falling back to the generic 'blocked' message",
      );
    }
  }

  // #2971 — the coverage stall, the `unstable` arm's own recovery (#2904).
  //
  // A non-Actions status that never settles holds the PR forever, and in a
  // repository whose branch protection REQUIRES the provider's status the PR
  // reads as `blocked` — so the `unstable` arm's wiring never sees it. The
  // same mechanism runs here: the Actions job that uploaded the coverage is
  // re-run, the provider reprocesses the commit, the status settles.
  //
  // It replaces the generic message ONLY when a stuck status is what is
  // actually holding the PR: a PR blocked on a missing approval, on
  // unresolved conversations, or on a red check keeps the explanation it
  // already had. A red check is skipped for the same reason the `unstable`
  // arm skips it — it needs a fix, not a re-run.
  //
  // The review decision must also have been READ: a read that failed leaves
  // open the possibility that the PR is blocked on a required approval, which
  // a message naming a stuck status would hide. That is a transient answer —
  // the next tick reads the decision again.
  //
  // The message text itself is #2904's, reused apart from how it names the
  // check: it says how long the status has been pending and what a human can
  // do about it. #2904's arm calls the status a "non-required check", which
  // is what it is there — but HERE it may be a REQUIRED one (that is why the
  // PR reads `blocked` at all), and Mullion cannot tell: branch protection is
  // not readable with the scopes this App holds. So this arm asks for the
  // neutral "the check" instead of asserting the opposite of what the state
  // proves.
  let needsHumanReason: MergeNeedsHumanReason | undefined = blockedDetail
    ? "blocked-threads"
    : undefined;
  if (!explainedByReview && reviewDecision !== undefined) {
    // The PR's check runs — the shared lookup, which also says whether
    // GitHub answered: "no checks" and "couldn't ask" are different
    // answers, and only a list that was actually read can name a stuck
    // status. An unreadable list leaves the generic message in place.
    const checkRuns = await readPrCheckRuns(app, task, token, repoRef, headSha, "blocked-merge");
    const runs = checkRuns.ok ? checkRuns.runs : [];
    const coverage = await holdForStuckCoverageStatus(app, task, {
      repoRef,
      headSha,
      checkRuns: runs,
      // A red check needs a fix, not a coverage re-upload — the same skip
      // the `unstable` arm makes.
      skip: runs.some((c) => isRedCheckConclusion(c.conclusion)),
      fallbackMessage: message,
      // Neutral on purpose: this status may be the REQUIRED one holding the
      // PR, and Mullion cannot read branch protection to tell.
      statusNoun: "the check",
    });
    message = coverage.message;
    needsHumanReason = coverage.reason ?? needsHumanReason;
  }

  recordMergeError(app, task.id, message, needsHumanReason, blockedDetail);
}
