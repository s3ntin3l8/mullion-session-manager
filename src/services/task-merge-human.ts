import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tasks } from "../db/schema.js";
import type { PrReviewThreadsResult } from "./github-write.js";

// Reasons a task needs a human that are tied to a merge that cannot proceed
// (as opposed to the review-loop reasons `cap` / `no-progress` /
// `finding-persisted`). They live and die with `tasks.mergeError`: recorded
// with it, cleared wherever it is cleared, and by a merge.
export type MergeNeedsHumanReason = "rebase-exhausted" | "blocked-threads" | "ci-status-stalled";

/**
 * A `.set()` value for `tasks.needsHumanReason` that clears a merge-tied
 * reason and leaves every other value (a review-loop reason) alone. Use it at
 * each site that clears `mergeError` without recording a merge. For a recorded
 * merge, use `mergeRecordedSet` instead.
 */
export const clearMergeNeedsHumanReason = sql<
  string | null
>`CASE WHEN needs_human_reason IN ('rebase-exhausted', 'blocked-threads', 'ci-status-stalled') THEN NULL ELSE needs_human_reason END`;

/** Like clearMergeNeedsHumanReason, for a recorded merge: the PR is merged, so
 * a `review-post-failed` hold (nothing left to hold) is released too. */
const clearNeedsHumanOnMerge = sql<
  string | null
>`CASE WHEN needs_human_reason IN ('rebase-exhausted', 'blocked-threads', 'ci-status-stalled', 'review-post-failed', 'pr-closed') THEN NULL ELSE needs_human_reason END`;

/**
 * `tasks.reviewPostPending` value once an approving review's post failed for
 * good (permanent failure, stale head, or the 24 h give-up). It is a terminal
 * hold that lives beside whatever `needsHumanReason` the task carries, which a
 * single column cannot (`holdsForReviewPost` honours it like a pending post);
 * the retry sweep never posts it. Human exits (approve, merge request, the next
 * round's ingest) clear it, and the sweep drops it once the task leaves review.
 */
export const REVIEW_POST_FAILED_MARKER = "review-post-failed";

/** The board's two booleans for the raw `tasks.reviewPostPending` column. */
export function reviewPostFlags(raw: string | null) {
  return {
    reviewPostPending: raw !== null && raw !== REVIEW_POST_FAILED_MARKER,
    reviewPostFailed: raw === REVIEW_POST_FAILED_MARKER,
  };
}

/** A `.set()` value for `tasks.reviewPostPending` that clears only the
 * terminal failed marker, leaving a genuinely pending post untouched. */
export const clearReviewPostFailedMarker = sql<
  string | null
>`CASE WHEN review_post_pending = 'review-post-failed' THEN NULL ELSE review_post_pending END`;

/**
 * The one `.set()` value for every site that records a merge (`mergedAt`): it
 * pairs the date with the reason clear (`clearNeedsHumanOnMerge`) and the
 * review-post marker clear, because a merged PR has nothing left to hold.
 * `extra` carries the site's own columns (`archivedAt`, `status`, ...).
 * `test/services/task-merge-set-sites.test.ts` fails a site that assigns
 * `mergedAt` without it.
 */
export function mergeRecordedSet<T extends object>(mergedAt: Date, extra?: T) {
  return {
    ...extra,
    mergedAt,
    needsHumanReason: clearNeedsHumanOnMerge,
    reviewPostPending: clearReviewPostFailedMarker,
  } as T & {
    mergedAt: Date;
    needsHumanReason: typeof clearNeedsHumanOnMerge;
    reviewPostPending: typeof clearReviewPostFailedMarker;
  };
}

/** What `recordMergeIfUnmerged` takes, so a caller cannot record a merge with a
 * hand-built patch (it lacks the marker and reason clears, so it fails to type-check). */
export type MergeRecordedPatch = ReturnType<typeof mergeRecordedSet<{ archivedAt?: Date }>>;

/** The `.set()` fields that clear a merge error and its merge-tied reason. */
export const CLEARED_MERGE_ERROR = {
  mergeError: null,
  mergeBlockedThreads: null,
  needsHumanReason: clearMergeNeedsHumanReason,
};

/** Like CLEARED_MERGE_ERROR, for a human merge request: that also acts on a
 * `review-post-failed` hold (holdsForReviewPost), so it is released too. */
export function clearedFor(reason: string | null | undefined) {
  return {
    ...(reason === "review-post-failed"
      ? { mergeError: null, mergeBlockedThreads: null, needsHumanReason: null }
      : CLEARED_MERGE_ERROR),
    reviewPostPending: clearReviewPostFailedMarker,
  };
}

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
  blockedThreads?: MergeBlockedThreads | null,
): void {
  app.db
    .update(tasks)
    .set({
      mergeError: message,
      mergeBlockedThreads:
        needsHumanReason === "blocked-threads" && blockedThreads
          ? JSON.stringify(blockedThreads)
          : null,
      needsHumanReason: needsHumanReason
        ? sql`CASE WHEN needs_human_reason IS NULL OR needs_human_reason IN ('rebase-exhausted', 'blocked-threads', 'ci-status-stalled') THEN ${needsHumanReason} ELSE needs_human_reason END`
        : clearMergeNeedsHumanReason,
    })
    .where(and(eq(tasks.id, taskId), isNull(tasks.mergedAt)))
    .run();
}

/** One foreign open review thread, as shown on the task. */
export interface BlockedThread {
  author: string;
  /** `path:line` of the first comment, when it has a path. */
  location: string | null;
  /** First line of the first comment, markdown noise stripped, capped. */
  excerpt: string;
  /** The thread's first comment on GitHub. */
  url: string | null;
  /** Set when the thread is a code-scanning alert annotation. */
  alert: { number: number | null; url: string | null } | null;
}

export interface MergeBlockedThreads {
  /** How many foreign threads are open (may exceed `threads.length`). */
  total: number;
  threads: BlockedThread[];
}

const MAX_BLOCKED_THREADS = 3;
const CODE_SCANNING_AUTHOR = "github-advanced-security";
const ALERT_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/security\/code-scanning\/(\d+)/;

function firstLine(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw
      .replace(/^[\s#>*_-]+/, "")
      .replace(/[*_`]+/g, "")
      .trim();
    if (line) return line.length > 140 ? `${line.slice(0, 139)}…` : line;
  }
  return "";
}

/**
 * The unresolved threads Mullion did not open (a code-scanning bot, a
 * reviewer), classified by author rather than `isResolved` alone because the
 * thread snapshot predates Mullion's own resolve pass.
 */
export async function foreignOpenThreads(
  result: PrReviewThreadsResult,
  resolveMullionLogins: (viewerLogin: string | null) => Promise<ReadonlySet<string>>,
): Promise<PrReviewThreadsResult["threads"]> {
  const mullionLogins = await resolveMullionLogins(result.viewerLogin);
  return result.threads.filter(
    (t) =>
      !t.isResolved &&
      !(t.comments.length > 0 && t.comments.every((c) => mullionLogins.has(c.author ?? ""))),
  );
}

/** The merge-error message for a blocked PR's thread list, plus the capped
 * summary of the foreign open threads (null when there are none). Null result:
 * nothing unresolved, so the caller's generic message stands. */
export async function describeBlockingThreads(
  result: PrReviewThreadsResult,
  resolveMullionLogins: (viewerLogin: string | null) => Promise<ReadonlySet<string>>,
): Promise<{ message: string; detail: MergeBlockedThreads | null } | null> {
  if (result.truncated) {
    return {
      message: "Blocked on the PR, but its review threads couldn't be fully enumerated",
      detail: null,
    };
  }
  const unresolved = result.threads.filter((t) => !t.isResolved).length;
  if (unresolved === 0) return null;
  const foreign = await foreignOpenThreads(result, resolveMullionLogins);
  return {
    message: `Blocked on ${unresolved} unresolved review conversation${unresolved === 1 ? "" : "s"}`,
    detail: foreign.length > 0 ? summarizeBlockedThreads(foreign) : null,
  };
}

/** Summarise foreign open threads for the task card (capped). */
export function summarizeBlockedThreads(
  threads: PrReviewThreadsResult["threads"],
): MergeBlockedThreads {
  return {
    total: threads.length,
    threads: threads.slice(0, MAX_BLOCKED_THREADS).map((t) => {
      const c = t.comments[0];
      const author = c?.author ?? "unknown";
      const body = c?.body ?? "";
      const m = ALERT_URL_RE.exec(body);
      const isAlert = author.replace(/\[bot\]$/, "") === CODE_SCANNING_AUTHOR || m !== null;
      return {
        author,
        location: c?.path ? (c.line != null ? `${c.path}:${c.line}` : c.path) : null,
        excerpt: firstLine(body),
        url: c?.url ?? null,
        alert: isAlert ? { number: m ? Number(m[1]) : null, url: m ? m[0] : null } : null,
      };
    }),
  };
}
