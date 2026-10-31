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
// claim side (an archived task is never auto-claimed nor claimable), and this
// module closes the retry side — `retryTask` (task-claim.ts) resumes a
// `failed` task's preserved branch and CLEARS `archivedAt` (#1015), so
// without the marker a superseded copy that was claimed once and later failed
// is one deliberate Retry away from spawning that duplicate worker.
//
// This module owns the two pieces of shared vocabulary that used to live
// inline in project-merge.ts and are now also mirrored by the backfill
// migration (drizzle/0104_past_famine.sql):
//
//   - the failure-reason wording a merge writes onto a superseded copy, and
//   - the refusal message a Retry returns when it meets one.

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

/**
 * The refusal a Retry returns for a superseded copy — a 409 from
 * `POST /api/tasks/:id/retry` (routes/tasks.ts maps the outcome reason).
 *
 * It has to explain WHY, because the row on the board looks like any other
 * `failed` task: without this, "Retry did nothing" reads like a bug.
 */
export const SUPERSEDED_RETRY_DETAIL =
  "This task's copy was superseded by a project merge — another task now owns the issue, so retrying it would start a duplicate worker.";
