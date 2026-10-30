/** The task columns that say which review is current and whether its verdict
 * was ingested. A review is either a local session (`reviewSessionId`, with
 * `reviewFindingsIngestedSessionId` as its ingest marker) or a run on an
 * external reviewer (`reviewRunId`, with `reviewRunIngestedId`). Narrow on
 * purpose: callers pass a full task row, a board row or a test fixture alike. */
export interface ReviewHandleRow {
  reviewSessionId: number | null;
  reviewFindingsIngestedSessionId: number | null;
  reviewRunId: string | null;
  reviewRunIngestedId: string | null;
}

// Every "is the current review's verdict in?" check goes through here rather
// than comparing the columns itself: the markers have no reset of their own
// (a session marker stops matching because each spawn gets a fresh session id;
// a run marker is nulled with its run), so the comparison is the one
// definition of "ingested for the CURRENT review".
//
// The run checks test `typeof … === "string"` rather than `!== null`: a column
// a query forgot to select arrives as `undefined`, which must read as "no run"
// — `undefined !== null` would claim a run that is not there.

/**
 * The run columns of the review handle, all nulled. Spread it next to the
 * session columns at every site that resets a review (a new round, a rebase, a
 * re-arm, a re-review) so the next round dispatches a fresh run — and so a
 * site cannot null the run id yet leave a stale ingest marker or dispatch time
 * behind. Each site keeps its own subset of the SESSION columns: they differ on
 * purpose (some leave `reviewFindingsIngestedSessionId` to stop matching on its
 * own once the next spawn gets a fresh session id); the run columns have no
 * such luck and are always cleared together.
 */
export const CLEARED_REVIEW_RUN = {
  reviewRunId: null,
  reviewRunDispatchedAt: null,
  reviewRunHeadSha: null,
  reviewRunIngestedId: null,
} as const;

/** Does the task have a review at all — spawned or dispatched and not cleared
 * since? */
export function hasReviewHandle(
  row: Pick<ReviewHandleRow, "reviewSessionId" | "reviewRunId">,
): boolean {
  return row.reviewSessionId !== null || typeof row.reviewRunId === "string";
}

/** Was the CURRENT review's verdict ingested? False for a task with no review,
 * a review still running, and one whose marker points at an older review. The
 * session pair and the run pair are checked separately, never mixed: a session
 * marker says nothing about a run. */
export function hasIngestedCurrentReview(row: ReviewHandleRow): boolean {
  const sessionIngested =
    row.reviewSessionId !== null && row.reviewFindingsIngestedSessionId === row.reviewSessionId;
  const runIngested =
    typeof row.reviewRunId === "string" && row.reviewRunIngestedId === row.reviewRunId;
  return sessionIngested || runIngested;
}
