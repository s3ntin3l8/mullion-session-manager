/** The two task columns that say which review is current and whether its
 * verdict was ingested. Narrow on purpose: callers pass a full task row, a
 * board row or a test fixture alike. */
export interface ReviewHandleRow {
  reviewSessionId: number | null;
  reviewFindingsIngestedSessionId: number | null;
}

// Every "is the current review's verdict in?" check goes through here rather
// than comparing the two columns itself: the latch has no reset of its own
// (it stops matching because each spawn gets a fresh session id), so the
// comparison is the one definition of "ingested for the CURRENT review". A
// review that is not a local session needs the same answer from the same
// call sites.

/** Does the task have a review at all — spawned and not cleared since? */
export function hasReviewHandle(row: Pick<ReviewHandleRow, "reviewSessionId">): boolean {
  return row.reviewSessionId !== null;
}

/** Was the CURRENT review's verdict ingested? False for a task with no review,
 * a review still running, and one whose latch points at an older review. */
export function hasIngestedCurrentReview(row: ReviewHandleRow): boolean {
  return (
    row.reviewSessionId !== null && row.reviewFindingsIngestedSessionId === row.reviewSessionId
  );
}
