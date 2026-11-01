// #2292 — the "superseded copy" concept, in one place.
//
// When a duplicate project is merged into its same-repo survivor
// (project-merge.ts's `mergeProjects`), the two projects can each hold a task
// for the SAME GitHub issue. Exactly one of them survives; the other is
// archived with its `issueNumber` cleared (NULLs do not collide under the
// `(project_id, issue_number)` unique index) and recorded as superseded —
// `tasks.supersededAt`, a durable marker (see db/schema.ts's own doc
// comment on it).
//
// Why the marker matters: that copy's worker, if it ever ran again, would be
// a SECOND worker for an issue another task already owns. #2291 closed the
// claim side (an archived task is never auto-claimed nor claimable), and
// task-claim.ts's `retryTask` closes the retry side — it resumes a `failed`
// task's preserved branch and CLEARS `archivedAt` (#1015), so without the
// marker a superseded copy that was claimed once and later failed is one
// deliberate Retry away from spawning that duplicate worker.
//
// This module owns the wording a merge writes onto a superseded copy, which
// the backfill migration (drizzle/0104_past_famine.sql) also matches as a
// signal for rows old enough to predate `html_url`. The refusal a Retry
// returns for such a copy is task-claim.ts's own (SUPERSEDED_RETRY_DETAIL
// there) — it belongs to the refusal that produces it, and keeping it here
// would add a module edge to an already heavily-coupled `retryTask`.

/**
 * The `failureReason` a merge writes on the DUPLICATE's copy when the
 * survivor already tracks that issue: the duplicate's copy is the one that
 * gets archived and superseded.
 *
 * The migration's backfill matches this wording as a second signal, for rows
 * old enough to predate `html_url` — see drizzle/0104_past_famine.sql's own
 * comment for why the wording alone is not enough.
 */
export function supersededMergeReason(fromProjectId: number): string {
  return `Merged from project #${fromProjectId}: superseded.`;
}

/**
 * The `failureReason` a merge writes on the SURVIVOR's copy when a live
 * duplicate replaces it: this copy is the one that gets archived and
 * superseded, and the duplicate's task is the one that carries the work on.
 */
export function replacedByMergeReason(taskId: number, fromProjectId: number): string {
  return `Replaced by task #${taskId} when project #${fromProjectId} was merged.`;
}
