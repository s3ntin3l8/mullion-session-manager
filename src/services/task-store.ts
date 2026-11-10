import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { TASK_MODEL_COLUMNS } from "./task-model-patch.js";
import { getProjectById, listProjects } from "./project-store.js";
import type { MergeRecordedPatch } from "./task-merge-human.js";
import { projects, sessions, tasks, TASK_STATUSES } from "../db/schema.js";

// The DB access of the task, task-push, review-relay and webhook routes lives
// here (issue #2817), so those route modules no longer import the schema or
// drizzle. Every function is a thin, query-for-query move of what the routes
// ran inline: ordering, filtering and CAS guards are unchanged.

export { TASK_STATUSES };
// The projects table is owned by project-store; re-exported so task callers keep one import.
export { getProjectById, listProjects };
export type TaskRow = typeof tasks.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
/** A partial task write, as handed to `updateTask`. */
export type TaskPatch = {
  [K in keyof typeof tasks.$inferInsert]?: (typeof tasks.$inferInsert)[K] | SQL;
};
type NewTask = typeof tasks.$inferInsert;

// Shared row shape for GET /api/tasks and GET /api/tasks/:id — kept as one
// column list rather than duplicated between the two so a newly-added
// column can't silently reach one endpoint's response but not the other's.
const TASK_ROW_COLUMNS = {
  id: tasks.id,
  projectId: tasks.projectId,
  projectName: projects.name,
  issueNumber: tasks.issueNumber,
  title: tasks.title,
  body: tasks.body,
  htmlUrl: tasks.htmlUrl,
  status: tasks.status,
  boardOrder: tasks.boardOrder,
  sessionId: tasks.sessionId,
  seedDelivered: tasks.seedDelivered,
  reviewSessionId: tasks.reviewSessionId,
  reviewSeedDelivered: tasks.reviewSeedDelivered,
  // Task-claim queueing (rate-limit-storm fix) — the frontend's own
  // "review in flight vs. awaiting your approval" predicate compares this
  // against reviewSessionId (see TaskCard.tsx); wasn't previously exposed
  // to any API response.
  reviewFindingsIngestedSessionId: tasks.reviewFindingsIngestedSessionId,
  // #2369 — an external reviewer's run, paired like the session columns above:
  // the run, when it was dispatched, and the run whose verdict is ingested.
  // deriveApprovalState reads these off this same row, so they must be named
  // here or they arrive as `undefined`.
  reviewRunId: tasks.reviewRunId,
  reviewRunIngestedId: tasks.reviewRunIngestedId,
  reviewRunDispatchedAt: tasks.reviewRunDispatchedAt,
  reviewFindings: tasks.reviewFindings,
  // How many auto-rebases the task has been through (the drawer says so).
  // `rebaseStartedAt`, which `reviewPhase`/`reReviewAt` are derived from, is
  // selected further down with the merge-sweep columns.
  rebaseAttempts: tasks.rebaseAttempts,
  // #756 — renamed from reviewRounds: this counter is no longer
  // review-verdict-only (a red CI check and an unresolved PR
  // review comment are later auto-return triggers on the same model — see
  // task-reconciler.ts's AutoReturnReason). lastAutoReturnReason names
  // which trigger most recently spent a round.
  autoReturnRounds: tasks.autoReturnRounds,
  lastAutoReturnReason: tasks.lastAutoReturnReason,
  // Issue #1038 — see schema.ts's doc comment on this column for why it's
  // distinct from autoReturnRounds reaching the cap: this is when the
  // machine actually announced it stopped, not when the counter merely hit
  // the ceiling. Surfaced as-is (no derived-field treatment like
  // autoReturnCapped below) — the frontend combines this with
  // autoReturnCapped/reviewFindingsIngestedSessionId itself to render the
  // three-state distinction (see TaskCard.tsx/TaskDetail.tsx).
  autoReturnCapAnnouncedAt: tasks.autoReturnCapAnnouncedAt,
  needsHumanReason: tasks.needsHumanReason,
  // Task 258971's investigation: declared on the frontend Task type
  // (api/types.ts) but never selected here — the same TASK_ROW_COLUMNS
  // silent-drop that bit #816/#818 (see that PR's own doc comment above).
  // Every read of `task.lastReviewVerdict` was `undefined` at runtime while
  // typechecking as `string | null`.
  lastReviewVerdict: tasks.lastReviewVerdict,
  // Raw retry payload — not surfaced; withAutoReturnCapped turns it into the
  // `reviewPostPending` boolean the board shows ("review waiting to be posted").
  reviewPostPending: tasks.reviewPostPending,
  // Not surfaced directly — consumed by withAutoReturnCapped below to derive
  // `autoReturnCapped`, then stripped, same treatment as blockedBy/
  // withBlockedState just below. Raw per-project config has no reason to
  // leak into a task response; the frontend only needs the yes/no answer.
  projectMaxAutoReturnRounds: projects.maxAutoReturnRounds,
  // Read only to derive `approvalState` / `reviewPhase` (withApprovalState strips them).
  projectAutoApprove: projects.autoApprove,
  projectDefaultReviewAgent: projects.defaultReviewAgent,
  worktreePath: tasks.worktreePath,
  branchName: tasks.branchName,
  baseSha: tasks.baseSha,
  agent: tasks.agent,
  reviewAgent: tasks.reviewAgent,
  agentCommand: tasks.agentCommand,
  // Issue #1954 — where the task REQUIRES its worker to run (`Platform:` /
  // `Host:`), resolved at dispatch and stored as JSON. Without this entry it
  // would be written but never reach GET /api/tasks or GET /api/tasks/:id —
  // the TASK_ROW_COLUMNS silent-drop this constant's other comments record.
  placementRequirement: tasks.placementRequirement,
  // Issue #957/#958 — the resolved opencode model(s) the worker actually ran
  // under, recorded at claim time (task-model-resolve.ts). Was previously
  // missing here, the exact TASK_ROW_COLUMNS silent-drop that bit #816/#818
  // (see this file's own doc comments below) — GET /api/tasks and
  // GET /api/tasks/:id would have returned `undefined` for both.
  model: tasks.model,
  smallModel: tasks.smallModel,
  ...TASK_MODEL_COLUMNS, // #2491
  prUrl: tasks.prUrl,
  prNumber: tasks.prNumber,
  // #761's Conventional Commits title, and the exact TASK_ROW_COLUMNS
  // silent-drop this constant's own comments record biting #816/#818 and
  // #957/#958 — was written by task-reconciler.ts and read by
  // task-promote.ts, but never exposed to GET /api/tasks or
  // GET /api/tasks/:id. Raw `prTitle === null` is NOT itself "the worker
  // fell back" — resolvePrTitle (task-prompt.ts) keeps an already-conventional
  // issue title over a worker-supplied one, so a task can legitimately have
  // `prTitle === null` and a perfectly fine live PR title. See
  // `withPrTitleFallback` below for the actual "did this fall back to a
  // non-conventional title" computation.
  prTitle: tasks.prTitle,
  // Not surfaced directly — consumed by withPrTitleFallback below to derive
  // `prTitleFallback`, then stripped, same treatment as
  // projectMaxAutoReturnRounds above.
  projectConventionalCommitTitles: projects.conventionalCommitTitles,
  // Hermes review, PR #818 — merge-on-approve (#816) and autorelease (#744)
  // both write these four columns (task-reconciler.ts's attemptMerge/
  // attemptRelease, POST /api/tasks/:id/merge, resolveReleaseMerge) and both
  // frontend TaskDetail.tsx components read them straight off the task
  // object — but neither was ever added here, so GET /api/tasks and
  // GET /api/tasks/:id never actually returned them. Every consumer of
  // `undefined !== null` (both hint/error guards) read that as "true," so
  // TaskMergeStatus's release-pending hint rendered unconditionally and a
  // real releaseError/mergeError could never surface — this was the root
  // cause, not the frontend guards themselves.
  mergeRequestedAt: tasks.mergeRequestedAt,
  mergeError: tasks.mergeError,
  // Auto-rebase attempt marker (task-reconciler.ts's attemptAutoRebase): the
  // PR sidebar reads it to say a done task's conflicts are already owned.
  rebaseStartedAt: tasks.rebaseStartedAt,
  releaseRequestedAt: tasks.releaseRequestedAt,
  releaseError: tasks.releaseError,
  assignee: tasks.assignee,
  failureReason: tasks.failureReason,
  failureDiagnostics: tasks.failureDiagnostics,
  // Issue #1997 — since when a queued task has been failing to dispatch.
  dispatchFailingSince: tasks.dispatchFailingSince,
  githubSyncError: tasks.githubSyncError,
  // Workflow-change approval gate — raw `{ sha, files }` JSON while a push is
  // held for the operator (parsed client-side; the approved sha is
  // deliberately NOT exposed). Listed here because this projection silently
  // drops any column it doesn't name.
  workflowChange: tasks.workflowChange,
  dependencyCount: tasks.dependencyCount,
  blockedBy: tasks.blockedBy,
  // #701 — already in their final display shape (unlike blockedBy), no
  // withBlockedState-style transform needed.
  parentIssueNumber: tasks.parentIssueNumber,
  parentIssueRepo: tasks.parentIssueRepo,
  parentIssueTitle: tasks.parentIssueTitle,
  subIssueTotal: tasks.subIssueTotal,
  subIssueCompleted: tasks.subIssueCompleted,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  // Task-claim queueing (rate-limit-storm fix) — when the task JOINED the
  // queue, distinct from claimedAt below (when its current worker spell
  // actually started). See task-claim.ts's enqueueTask/dispatchClaimedTask.
  queuedAt: tasks.queuedAt,
  claimedAt: tasks.claimedAt,
  startedAt: tasks.startedAt,
  reviewingAt: tasks.reviewingAt,
  completedAt: tasks.completedAt,
  // #1015 (archive) — see schema.ts's own doc comments on why these are two
  // separate columns. Both added here alongside the schema/migration and the
  // frontend Task type in the same commit — this list has twice silently
  // dropped a new column before (#816/#818, task 258971's lastReviewVerdict
  // above), typechecking clean while the API response quietly omitted it.
  mergedAt: tasks.mergedAt,
  archivedAt: tasks.archivedAt,
};

const taskRowQuery = (app: FastifyInstance) =>
  app.db.select(TASK_ROW_COLUMNS).from(tasks).innerJoin(projects, eq(tasks.projectId, projects.id));

/** GET /api/tasks rows: board order within each status, optionally filtered. */
export function listTaskRows(
  app: FastifyInstance,
  filter: { status?: string; projectId?: number },
) {
  const filters: SQL[] = [];
  if (filter.status !== undefined)
    filters.push(eq(tasks.status, filter.status as TaskRow["status"]));
  if (filter.projectId !== undefined) filters.push(eq(tasks.projectId, filter.projectId));
  return (
    taskRowQuery(app)
      // `.where(undefined)` omits the clause entirely: no filters means every task.
      .where(filters.length > 0 ? and(...filters) : undefined)
      // boardOrder is the render/ordering tier: a deterministic order within each status.
      .orderBy(tasks.status, tasks.boardOrder, tasks.createdAt)
      .all()
  );
}

/** One task in the GET /api/tasks/:id row shape (joined with its project's name). */
export function getTaskRowById(app: FastifyInstance, taskId: number) {
  const [row] = taskRowQuery(app).where(eq(tasks.id, taskId)).all();
  return row;
}

export function getTaskById(app: FastifyInstance, taskId: number): TaskRow | undefined {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  return task;
}

export function getSessionById(app: FastifyInstance, sessionId: number): SessionRow | undefined {
  const [session] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  return session;
}

/** Every project's id/cwd/host, oldest first: the first project on a repo owns its issue import. */
export function listProjectRefsOldestFirst(app: FastifyInstance) {
  return app.db
    .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
    .from(projects)
    .orderBy(projects.createdAt, projects.id)
    .all();
}

export function insertTask(app: FastifyInstance, values: NewTask): TaskRow | undefined {
  const [created] = app.db.insert(tasks).values(values).returning().all();
  return created;
}

/**
 * Update a task and return the new row (undefined when no row matched). With
 * `whenStatus` the write is a compare-and-set on the task's current status.
 */
export function updateTask(
  app: FastifyInstance,
  taskId: number,
  patch: TaskPatch,
  opts: { whenStatus?: TaskRow["status"] } = {},
): TaskRow | undefined {
  const where =
    opts.whenStatus === undefined
      ? eq(tasks.id, taskId)
      : and(eq(tasks.id, taskId), eq(tasks.status, opts.whenStatus));
  const [updated] = app.db.update(tasks).set(patch).where(where).returning().all();
  return updated;
}

/** Update a task with no row returned; the count of rows changed. */
export function updateTaskCount(app: FastifyInstance, taskId: number, patch: TaskPatch): number {
  return app.db.update(tasks).set(patch).where(eq(tasks.id, taskId)).run().changes;
}

/** Delete a task only while it still has `status` (a CAS); the count of rows deleted. */
export function deleteTaskWhenStatus(
  app: FastifyInstance,
  taskId: number,
  status: TaskRow["status"],
): number {
  return app.db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.status, status)))
    .run().changes;
}

/** Every done task, optionally narrowed to some projects. */
export function listDoneTasks(app: FastifyInstance, projectIds?: number[]): TaskRow[] {
  return projectIds && projectIds.length > 0
    ? app.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.status, "done"), inArray(tasks.projectId, projectIds)))
        .all()
    : app.db.select().from(tasks).where(eq(tasks.status, "done")).all();
}

/** Done tasks with a PR that no merge has been recorded for, optionally narrowed to some projects. */
export function listDoneUnmergedWithPr(app: FastifyInstance, projectIds?: number[]): TaskRow[] {
  const doneUnmergedWithPr = and(
    eq(tasks.status, "done"),
    isNotNull(tasks.prNumber),
    isNull(tasks.mergedAt),
  );
  return projectIds && projectIds.length > 0
    ? app.db
        .select()
        .from(tasks)
        .where(and(doneUnmergedWithPr, inArray(tasks.projectId, projectIds)))
        .all()
    : app.db.select().from(tasks).where(doneUnmergedWithPr).all();
}

/** The worker task of a session that may still push: pushable status and not yet merged. */
export function findPushableTaskBySession(
  app: FastifyInstance,
  sessionId: number,
  pushableStatuses: readonly TaskRow["status"][],
): TaskRow | undefined {
  return (
    app.db
      .select()
      .from(tasks)
      // `mergedAt IS NULL`: a merged task's lingering worker session must
      // not be able to force-push (and so recreate) a branch that is gone.
      .where(
        and(
          eq(tasks.sessionId, sessionId),
          inArray(tasks.status, [...pushableStatuses]),
          isNull(tasks.mergedAt),
        ),
      )
      .get()
  );
}

/** Does a session work or review a task in one of `activeStatuses` (for `prNumber`, when given)? */
export function sessionHasActiveTask(
  app: FastifyInstance,
  sessionId: number,
  activeStatuses: readonly TaskRow["status"][],
  prNumber: number | undefined,
): boolean {
  const rows = app.db
    .select({ prNumber: tasks.prNumber })
    .from(tasks)
    .where(
      and(
        or(eq(tasks.sessionId, sessionId), eq(tasks.reviewSessionId, sessionId)),
        inArray(tasks.status, [...activeStatuses]),
      ),
    )
    .all();
  return rows.some((row) => prNumber === undefined || row.prNumber === prNumber);
}

/** An unmerged task for a project's PR (the merge webhook's match). */
export function findUnmergedTaskByPr(
  app: FastifyInstance,
  projectId: number,
  prNumber: number,
): TaskRow | undefined {
  return app.db
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.projectId, projectId), eq(tasks.prNumber, prNumber), isNull(tasks.mergedAt)),
    )
    .get();
}

/** A reviewing task for a project's PR. */
export function findReviewingTaskByPr(
  app: FastifyInstance,
  projectId: number,
  prNumber: number,
): TaskRow | undefined {
  return app.db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.prNumber, prNumber),
        eq(tasks.status, "reviewing"),
      ),
    )
    .get();
}

/**
 * Record a PR merge on a task, only while no merge is recorded yet. Returns the
 * rows changed (0 when a concurrent path recorded the merge first).
 */
export function recordMergeIfUnmerged(
  app: FastifyInstance,
  taskId: number,
  patch: MergeRecordedPatch,
): number {
  return app.db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, taskId), isNull(tasks.mergedAt)))
    .run().changes;
}

/** A project's task for an issue number. */
export function findTaskByIssue(app: FastifyInstance, projectId: number, issueNumber: number) {
  const [task] = app.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, issueNumber)))
    .all();
  return task;
}

/** The id and stored blocker count of a project's task for an issue number. */
export function findTaskBlockerStateByIssue(
  app: FastifyInstance,
  projectId: number,
  issueNumber: number,
) {
  const [task] = app.db
    .select({ id: tasks.id, dependencyCount: tasks.dependencyCount })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, issueNumber)))
    .all();
  return task;
}

/**
 * The re-review re-arm write: clear the stale review handle, but only while the
 * task is still reviewing with exactly the handle, verdict and ingest state the
 * caller read (a compare-and-set, so a concurrent approve/reject/ingest wins).
 */
export function rearmStaleReview(
  app: FastifyInstance,
  taskId: number,
  patch: TaskPatch,
  stale: {
    lastReviewVerdict: string;
    reviewSessionId: number | null;
    reviewRunId: string | null;
    reviewIsRun: boolean;
  },
): TaskRow | undefined {
  const [updated] = app.db
    .update(tasks)
    .set(patch)
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.status, "reviewing"),
        eq(tasks.lastReviewVerdict, stale.lastReviewVerdict),
        stale.reviewSessionId === null
          ? isNull(tasks.reviewSessionId)
          : eq(tasks.reviewSessionId, stale.reviewSessionId),
        stale.reviewRunId === null
          ? isNull(tasks.reviewRunId)
          : eq(tasks.reviewRunId, stale.reviewRunId),
        // Same reasoning as the read-time check in the route, re-applied at the
        // write: a concurrent write between the read and this write could
        // otherwise let a stale handle match while an ingest raced in behind it.
        stale.reviewIsRun
          ? isNotNull(tasks.reviewRunIngestedId)
          : isNotNull(tasks.reviewFindingsIngestedSessionId),
      ),
    )
    .returning()
    .all();
  return updated;
}
