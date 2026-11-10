// Retrying a round's review post that a transient GitHub failure lost (#2749):
// the durable marker is `tasks.reviewPostPending`, written by the ingest in
// task-reconciler.ts's processReviewingTasks. See docs/tasks-internals.md,
// "A lost post is retried, and holds auto-approve".
import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { isGitHubRateLimited, githubRateLimitRemainingMs } from "./github-fetch.js";
import {
  postReviewFindingsComment,
  recordGithubSyncError,
  parsePendingReviewPost,
  type PendingReviewPost,
} from "./task-github-sync.js";
import { resolveMullionOwnThreadsWithOutcome } from "./task-own-threads.js";
import { isApprovingVerdict } from "./task-prompt.js";
import { createRetryBackoff } from "./task-retry-backoff.js";
import { REVIEW_POST_FAILED_MARKER } from "./task-merge-human.js";

// A review post that keeps failing transiently is given up on after this long:
// a marker must not outlive any plausible outage, or the task would wait on it
// (auto-approve and merge are held) forever.
const REVIEW_POST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REVIEW_POST_RETRY_TTL_MS = 60 * 1000;
const REVIEW_POST_RETRY_MAX_TTL_MS = 15 * 60 * 1000;
const MAX_REVIEW_POST_RETRIES_PER_SWEEP = 20;
const MAX_REVIEW_POST_RETRY_ENTRIES = 500;
// Process-local like the other retry ledgers: the marker itself is durable, the
// rate limiter need not be (a restart just retries at once).
const reviewPostRetryBackoff = createRetryBackoff<number>({
  ttlMs: REVIEW_POST_RETRY_TTL_MS,
  maxTtlMs: REVIEW_POST_RETRY_MAX_TTL_MS,
  maxEntries: MAX_REVIEW_POST_RETRY_ENTRIES,
});

/** Compare-and-set on the marker's exact text, so a newer round's marker (or
 * one a concurrent tick already settled) is never overwritten. */
function writeReviewPostPending(
  app: FastifyInstance,
  taskId: number,
  expectedRaw: string,
  nextRaw: string | null,
): boolean {
  return (
    app.db
      .update(tasks)
      .set({ reviewPostPending: nextRaw })
      .where(and(eq(tasks.id, taskId), eq(tasks.reviewPostPending, expectedRaw)))
      .run().changes > 0
  );
}

// Sets `review-post-failed` without replacing a different reason already parked
// on the task (`cap`, `no-progress`, `finding-persisted`, a merge-tied one).
const SET_REVIEW_POST_FAILED = sql<
  string | null
>`CASE WHEN needs_human_reason IS NULL THEN 'review-post-failed' ELSE needs_human_reason END`;

/** Compare-and-set the marker to the terminal failed state and, in the same
 * statement, flag the task. The marker (not the reason column) is the hold, so
 * it survives another reason (`cap`, `rebase-exhausted`, ...) being present. */
function clearMarkerAndHold(app: FastifyInstance, taskId: number, expectedRaw: string): boolean {
  return (
    app.db
      .update(tasks)
      .set({
        reviewPostPending: REVIEW_POST_FAILED_MARKER,
        needsHumanReason: SET_REVIEW_POST_FAILED,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.reviewPostPending, expectedRaw)))
      .run().changes > 0
  );
}

/**
 * True while an approving verdict has not (or could not be) put on GitHub: the
 * post is still pending, or it failed for good (`reviewPostPending` is the
 * terminal failed marker, or a legacy row's `needsHumanReason` is
 * `review-post-failed`). GitHub may still hold an older CHANGES_REQUESTED, so
 * auto-approve and auto-merge must both stand down until a human acts.
 */
export function holdsForReviewPost(
  task: Pick<
    typeof tasks.$inferSelect,
    "reviewPostPending" | "needsHumanReason" | "lastReviewVerdict"
  >,
): boolean {
  return (
    (task.reviewPostPending !== null || task.needsHumanReason === "review-post-failed") &&
    isApprovingVerdict(task.lastReviewVerdict)
  );
}

/**
 * One attempt at what a round still owes GitHub: its review post, then (an
 * approving verdict) the resolution of Mullion's own earlier threads. Settles
 * the `reviewPostPending` marker: cleared when both are done, or when the post
 * failed permanently (already recorded in `githubSyncError`); kept — with the
 * post marked done once it has landed — when a transient failure means a later
 * tick must try again. A failed thread resolution never marks the round as
 * posted-and-finished.
 */
export async function attemptPendingReviewPost(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  pending: PendingReviewPost,
  raw: string,
  isRetry: boolean,
  onLanded: (taskId: number) => void,
): Promise<void> {
  let current = pending;
  let currentRaw = raw;
  let again = false;
  let permanentFailure = false;
  if (!current.posted) {
    const base = {
      body: current.body,
      verdict: current.verdict,
      dedupeKey: current.key,
      isRetry,
      ...(current.reviewedHeadSha !== undefined
        ? {
            commitId: current.reviewedHeadSha,
            // A retry after the task left review (an auto-return, a worker push)
            // must not put the old verdict on a head nobody reviewed.
            dropIfHeadMoved: isRetry && task.status !== "reviewing",
          }
        : {}),
    };
    const outcome = await postReviewFindingsComment(
      app,
      task,
      project,
      current.findings !== undefined && current.reviewSummary !== undefined
        ? { ...base, reviewSummary: current.reviewSummary, findings: current.findings }
        : base,
    );
    if (outcome === "retry") again = true;
    else if (outcome === "stale") {
      // An approving verdict that never posted leaves GitHub's older
      // CHANGES_REQUESTED standing: hold for a human instead of releasing.
      const approving = isApprovingVerdict(current.verdict);
      if (
        approving
          ? clearMarkerAndHold(app, task.id, currentRaw)
          : writeReviewPostPending(app, task.id, currentRaw, null)
      ) {
        recordGithubSyncError(
          app,
          task.id,
          "Dropped this round's unposted review: the PR head moved past the commit it reviewed and the task is no longer in review",
        );
      }
      reviewPostRetryBackoff.clear(task.id);
      return;
    } else if (outcome === "posted") {
      current = { ...current, posted: true };
      const nextRaw = JSON.stringify(current);
      // Lost the marker to a newer round or a concurrent tick: that owner settles it.
      if (!writeReviewPostPending(app, task.id, currentRaw, nextRaw)) return;
      currentRaw = nextRaw;
    } else permanentFailure = true;
    // "permanent": already recorded in githubSyncError — nothing to retry, but
    // the thread resolution below does not depend on the post.
  }

  // D1 — a "clean" verdict is corroborating evidence any of Mullion's own
  // earlier anchored findings on this PR were actually addressed; resolve them
  // now so a repo requiring conversation resolution doesn't deadlock on a
  // self-inflicted stale thread. Never fires on "changes-requested" or
  // "inconclusive" (a crashed/silent reviewer confirms nothing). Independent
  // of whether the post landed; a transient failure here keeps the marker so a
  // later tick retries it, and never marks the round as finished.
  if (isApprovingVerdict(current.verdict)) {
    const { retry } = await resolveMullionOwnThreadsWithOutcome(app, task, project);
    if (retry) again = true;
  }
  if (again) {
    reviewPostRetryBackoff.record(task.id, Date.now());
    return;
  }
  if (permanentFailure && isApprovingVerdict(current.verdict)) {
    // The approving review will never reach GitHub, which may still hold a
    // CHANGES_REQUESTED: clearing the marker alone would release auto-approve
    // against it. Flag the task for a human instead (githubSyncError, already
    // recorded, is the text the card shows).
    clearMarkerAndHold(app, task.id, currentRaw);
    reviewPostRetryBackoff.clear(task.id);
    return;
  }
  writeReviewPostPending(app, task.id, currentRaw, null);
  reviewPostRetryBackoff.clear(task.id);
  // The post this verdict was waiting on has landed: let auto-approve act at once.
  onLanded(task.id);
}

/**
 * Retries every round whose review post (or own-thread resolution) was lost to
 * a transient GitHub failure — the incident this exists for: a rate limit hit
 * between the ingest and the post, the approving review never landed, and the
 * task was auto-approved against GitHub's still-standing CHANGES_REQUESTED.
 * Runs right after `processReviewingTasks` and before `processAutoApprovals`,
 * so a post that lands here releases auto-approve in the same tick.
 *
 * The marker is dropped, never retried forever, when: the task is no longer one
 * a review post is owed for (merged, failed, back in the queue); the post fails
 * permanently; or it is older than REVIEW_POST_MAX_AGE_MS (recorded in
 * `githubSyncError`).
 */
export async function retryPendingReviewPosts(
  app: FastifyInstance,
  onLanded: (taskId: number) => void,
): Promise<void> {
  const rows = app.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(isNotNull(tasks.reviewPostPending))
    .all();
  if (rows.length === 0) return;

  const now = Date.now();
  let attempted = 0;
  for (const { task, project } of rows) {
    const raw = task.reviewPostPending!;
    if (raw === REVIEW_POST_FAILED_MARKER) {
      // A terminal hold, never retried: kept while a human can still act on it
      // (in review, or approved and awaiting the merge), dropped otherwise.
      const held =
        task.mergedAt === null && (task.status === "reviewing" || task.status === "done");
      if (!held) writeReviewPostPending(app, task.id, raw, null);
      continue;
    }
    const pending = parsePendingReviewPost(raw);
    // A merged task owes nothing, whatever its status: a recorded merge can
    // land on a claimed or in_progress row, and a late give-up there would
    // re-set a hold that nothing clears afterwards.
    const owed =
      task.mergedAt === null &&
      (task.status === "reviewing" ||
        task.status === "claimed" ||
        task.status === "in_progress" ||
        task.status === "done");
    if (pending === null || !owed) {
      writeReviewPostPending(app, task.id, raw, null);
      reviewPostRetryBackoff.clear(task.id);
      continue;
    }
    if (now - pending.createdAt > REVIEW_POST_MAX_AGE_MS) {
      // An approving verdict that never posted leaves GitHub's older
      // CHANGES_REQUESTED standing: hold instead of releasing. A review that
      // did post (only its own-thread resolution kept failing) holds nothing.
      const gaveUp =
        isApprovingVerdict(pending.verdict) && !pending.posted
          ? clearMarkerAndHold(app, task.id, raw)
          : writeReviewPostPending(app, task.id, raw, null);
      if (gaveUp) {
        recordGithubSyncError(
          app,
          task.id,
          pending.posted
            ? "Gave up resolving this round's own review threads on GitHub after 24h of transient failures (the review itself posted)"
            : "Gave up posting this round's review to GitHub after 24h of transient failures",
        );
      }
      reviewPostRetryBackoff.clear(task.id);
      continue;
    }
    if (isGitHubRateLimited()) {
      app.log.debug(
        { sweep: "retryPendingReviewPosts", resumeInMs: githubRateLimitRemainingMs() },
        "task reconcile: skipping sweep — GitHub rate limit is in effect",
      );
      return;
    }
    if (attempted >= MAX_REVIEW_POST_RETRIES_PER_SWEEP) return;
    if (!reviewPostRetryBackoff.shouldAttempt(task.id, now)) continue;
    attempted++;
    await attemptPendingReviewPost(app, task, project, pending, raw, true, onLanded);
  }
}
