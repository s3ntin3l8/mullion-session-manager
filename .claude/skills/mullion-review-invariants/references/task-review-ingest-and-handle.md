# Review ingestion, the review handle and the wire contract

Read this when a diff touches how a finished review is ingested, which task
columns identify "the current review", or the task row sent to the UI. Verified
against `origin/main` 6af59eac; code is cited by symbol, not line.

## 1. Ingestion is a durable latch, and "nothing will come" is decided late

**Invariant.** `reviewFindingsIngestedSessionId` (session reviews) and
`reviewRunIngestedId` (external-run reviews) are written once, in
`ingestReviewOutcome`, and then are never re-read as pending. A missing findings
file counts as "inconclusive" only when the session is `exited`, or is not `busy`
and `REVIEW_FINDINGS_GRACE_MS` (30 min from the session's creation) has elapsed
(`isUsableSignal` in `processReviewingTasks`). A parsed file is usable on
`finished` or `exited`. The reviewer writes its file atomically (tmp, then
rename) so a torn file is never parsed as a garbled `changes-requested`.

**Breaks.** A tick that sees `finished` before the file lands latches
"inconclusive"; the real verdict arriving seconds later is never read and the
task sits in `reviewing` for good. A torn read burns an auto-return round.

**Check.** Any change to the usable-signal predicate, the grace window, or where
the latch is written needs an argument for the file-arrives-late case; confirm
the review prompt still tells the reviewer to write tmp-then-move.

## 2. The ingest write is a compare-and-swap and must lose cleanly

**Invariant.** The ingest `UPDATE` is guarded by `status = 'reviewing'`. For a
run review it is also guarded by `reviewRunId = <run>` and by
`(reviewRunIngestedId IS NULL OR reviewRunIngestedId != <run>)`. The `IS NULL`
arm is required: in SQLite a bare `!=` against NULL is never true. A loser
(`changes === 0`) cleans up and returns without commenting, auto-returning or
appending a second `## Round N` block.

**Breaks.** Two concurrent passes over one finished run (for example the poll
pass's `catch` after a GitHub post throws) overwrite `lastReviewVerdict`, append
a duplicate round and post two reviews.

**Check.** Read the `.where(...)` of the ingest update and its `changes === 0`
branch. A `try/catch` around the post-write GitHub calls must not re-enter ingest.

## 3. Whatever resets a review clears the whole handle

**Invariant.** A review is identified by a session handle (`reviewSessionId` plus
`reviewFindingsIngestedSessionId`) or a run handle (`reviewRunId`,
`reviewRunDispatchedAt`, `reviewRunHeadSha`, `reviewRunIngestedId`). A run has no
fresh id per round, so a reset that clears `reviewSessionId` but leaves the run
columns makes the next round read as already reviewed. Resets spread
`CLEARED_REVIEW_RUN` (`src/services/task-review-handle.ts`); callers use `hasReviewHandle` and
`hasIngestedCurrentReview`, not their own column comparisons. The one legitimate
exception is the carried-approval path, which keeps the pair on purpose. A new
run-scoped column belongs in `CLEARED_REVIEW_RUN`.

**Breaks.** A re-review that never dispatches or never ingests, or a stale
approval applied to a new head.

**Check.** `git grep -n "reviewSessionId: null" -- src`: each site must also
spread `CLEARED_REVIEW_RUN` or be the carry path.

## 4. A column the route does not select is silently `undefined`

**Invariant.** `GET /api/tasks` and `GET /api/tasks/:id` use
`.select(TASK_ROW_COLUMNS)` (`src/routes/tasks.ts`). A field added to the frontend
`Task` type, or a column added by migration "for display", that is not added to
`TASK_ROW_COLUMNS` typechecks but is `undefined` at runtime. Paired columns
(`prUrl`/`prNumber`) are cleared together and neither is asserted non-null alone.

**Breaks.** A UI that never shows the verdict, the PR link or the cap banner. This
class has recurred repeatedly.

**Check.** For every new tasks column or `Task` field, grep both
`TASK_ROW_COLUMNS` and `frontend/src/api/types.ts`; for pair columns, check the
clearing `.set()` includes both.
