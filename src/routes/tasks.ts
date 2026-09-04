import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { projects, sessions, tasks, TASK_STATUSES } from "../db/schema.js";
import { enqueueTask, retryTask } from "../services/task-claim.js";
import { resolveTaskMasterConfig } from "../services/task-config.js";
import { buildRejectPrompt, taskCommitTitlePath } from "../services/task-prompt.js";
import { resolveTaskIssueContextSafe } from "../services/task-issue-context.js";
import { canTransition, recordTaskTransition, type TaskStatus } from "../services/task-state.js";
import { syncTaskTransition, isIssueStillTrackable } from "../services/task-github-sync.js";
import { deriveTaskBranchName } from "../services/git-worktree.js";
import { dependencyGate, parseBlockedBy } from "../services/task-dependencies.js";
import { closeDraftPRForTask } from "../services/task-promote.js";
import { approveTask, cleanupTaskWorktree, cleanupTaskSessions } from "../services/task-approve.js";
import { resetMergeBackoff, resolveMaxAutoReturnRounds } from "../services/task-reconciler.js";
import { reseedTaskIfSessionExited } from "../services/task-reseed.js";
import { resolveBackend, resolveSessionsDirWithFallback } from "../services/session-backend.js";
import { resolveGitHubToken } from "../services/github-integration.js";
import { resolveRepoRef } from "../services/host-git.js";
import { getPullRequestByNumber, removeLabel } from "../services/github-write.js";
import { isGitHubRateLimited } from "../services/github-fetch.js";
import { killSession } from "../services/session-lifecycle.js";

import { KNOWN_AGENTS } from "../services/agent-detect.js";

// Phase 6 (6.9/#233) — the only two statuses PR1 (this file, pre-6.2) knows
// how to validate: a locally-created task starts "backlog" and the only
// transition available before 6.2's state machine lands is the interactive
// drag-to-ready toggle. Claimed/in_progress/reviewing/done/failed all
// require the full transition table (task-state.ts, 6.2/#215) and are
// deliberately out of PATCH's reach here — see this file's own module
// comment on the local-CRUD routes below.
const LOCAL_CREATABLE_STATUSES = ["backlog", "ready"] as const;
type LocalCreatableStatus = (typeof LOCAL_CREATABLE_STATUSES)[number];

interface CreateTaskBody {
  projectId: number;
  title: string;
  body?: string | null;
  status?: LocalCreatableStatus;
  boardOrder?: number;
  agent?: string | null;
  reviewAgent?: string | null;
}

interface UpdateTaskBody {
  title?: string;
  body?: string | null;
  status?: LocalCreatableStatus;
  boardOrder?: number;
  agent?: string | null;
  reviewAgent?: string | null;
}

interface ClaimTaskBody {
  agent?: string | null;
  reviewAgent?: string | null;
}

interface RetryTaskBody {
  agent?: string | null;
  reviewAgent?: string | null;
}

// #746 — no existing route in this codebase returns a per-row ok/failed
// shape (the nearest precedent, git-worktree.ts's cleanupOrphanWorktrees,
// is service-level: `{ removed: string[]; skipped: Array<{ path, reason }> }`
// — this establishes the convention at the route layer, modeled on it).
const clearDoneTasksSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      projectIds: { type: "array", items: { type: "integer", minimum: 1 } },
      deleteBranches: { type: "boolean" },
    },
  },
};

// #1015 (archive), review fix — mirrors clearDoneTasksSchema above, which
// this route was otherwise modeled on directly; a malformed body (e.g.
// projectIds sent as a string) would previously fall through to drizzle's
// inArray and 500 instead of 400.
const archiveMergedTasksSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      projectIds: { type: "array", items: { type: "integer", minimum: 1 } },
    },
  },
};

const createTaskSchema = {
  body: {
    type: "object",
    required: ["projectId", "title"],
    additionalProperties: false,
    properties: {
      projectId: { type: "integer", minimum: 1 },
      title: { type: "string", minLength: 1 },
      body: { type: ["string", "null"] },
      status: { type: "string", enum: [...LOCAL_CREATABLE_STATUSES] },
      boardOrder: { type: "integer", minimum: 0 },
      agent: { type: ["string", "null"], enum: [...KNOWN_AGENTS, null] },
      reviewAgent: { type: ["string", "null"], enum: [...KNOWN_AGENTS, "none", null] },
    },
  },
};

const updateTaskSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      title: { type: "string", minLength: 1 },
      body: { type: ["string", "null"] },
      status: { type: "string", enum: [...LOCAL_CREATABLE_STATUSES] },
      boardOrder: { type: "integer", minimum: 0 },
      agent: { type: ["string", "null"], enum: [...KNOWN_AGENTS, null] },
      reviewAgent: { type: ["string", "null"], enum: [...KNOWN_AGENTS, "none", null] },
    },
  },
};

const claimTaskSchema = {
  body: {
    type: ["object", "null"],
    additionalProperties: false,
    properties: {
      agent: { type: ["string", "null"], enum: [...KNOWN_AGENTS, null] },
      reviewAgent: { type: ["string", "null"], enum: [...KNOWN_AGENTS, "none", null] },
    },
  },
};

const retryTaskSchema = claimTaskSchema;

// Phase 2.5 Task Master, Thin Slice (issue #219/#227) — read endpoint for
// the sidebar's Tasks section. Always registered, regardless of Task Master
// being enabled, so the frontend's flag gate (server-info's
// taskMasterEnabled) is the single source of truth for whether the UI shows
// up. The watcher plugin itself always registers too (see
// plugins/task-watcher.ts's own doc comment) — it just skips GitHub
// ingest/auto-claim work when disabled, rather than this route depending on
// the plugin never having run.
//
// Phase 6 (6.9/#233) changed that framing: the local task board works
// regardless of the flag (see the roadmap's Flag semantics decision — the
// flag gates autonomous behavior only, not the local board), so this route
// and the local-CRUD routes below (POST/PATCH/DELETE) are unconditional.
// Only the claim endpoint further down stays flag-gated, since claiming
// spawns an agent — genuinely autonomous behavior.
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
  reviewFindings: tasks.reviewFindings,
  // #756 — renamed from reviewRounds: this counter is no longer
  // review-verdict-only (a red required CI check and an unresolved PR
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
  // Task 258971's investigation: declared on the frontend Task type
  // (api/types.ts) but never selected here — the same TASK_ROW_COLUMNS
  // silent-drop that bit #816/#818 (see that PR's own doc comment above).
  // Every read of `task.lastReviewVerdict` was `undefined` at runtime while
  // typechecking as `string | null`.
  lastReviewVerdict: tasks.lastReviewVerdict,
  // Not surfaced directly — consumed by withAutoReturnCapped below to derive
  // `autoReturnCapped`, then stripped, same treatment as blockedBy/
  // withBlockedState just below. Raw per-project config has no reason to
  // leak into a task response; the frontend only needs the yes/no answer.
  projectMaxAutoReturnRounds: projects.maxAutoReturnRounds,
  worktreePath: tasks.worktreePath,
  branchName: tasks.branchName,
  baseSha: tasks.baseSha,
  agent: tasks.agent,
  reviewAgent: tasks.reviewAgent,
  agentCommand: tasks.agentCommand,
  // Issue #957/#958 — the resolved opencode model(s) the worker actually ran
  // under, recorded at claim time (task-model-resolve.ts). Was previously
  // missing here, the exact TASK_ROW_COLUMNS silent-drop that bit #816/#818
  // (see this file's own doc comments below) — GET /api/tasks and
  // GET /api/tasks/:id would have returned `undefined` for both.
  model: tasks.model,
  smallModel: tasks.smallModel,
  prUrl: tasks.prUrl,
  prNumber: tasks.prNumber,
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
  releaseRequestedAt: tasks.releaseRequestedAt,
  releaseError: tasks.releaseError,
  assignee: tasks.assignee,
  failureReason: tasks.failureReason,
  githubSyncError: tasks.githubSyncError,
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

/**
 * #667 — the single place `dependencyGate` (task-dependencies.ts) gets
 * evaluated for API responses, so the board card and detail drawer both
 * read the same server-computed truth rather than each re-deriving it —
 * `frontend/` is a separate workspace with its own tsconfig and doesn't
 * import backend source, so mirroring the gate table client-side would risk
 * the two drifting. The raw `blockedBy` JSON column is replaced with a
 * parsed `blockers` array; `unresolved`'s blockers are irrelevant (the UI
 * shows "checking…" instead) so `?? []` is a safe fallback either way.
 */
function withBlockedState<
  T extends {
    issueNumber: number | null;
    dependencyCount: number | null;
    blockedBy: string | null;
  },
>(
  row: T,
): Omit<T, "blockedBy"> & {
  blockedState: "clear" | "blocked" | "unresolved";
  blockers: ReturnType<typeof parseBlockedBy>;
} {
  const { blockedBy, ...rest } = row;
  return {
    ...rest,
    blockedState: dependencyGate(row),
    blockers: parseBlockedBy(blockedBy) ?? [],
  };
}

// Task 258971's investigation: TaskCard's "Round {n} · returned to worker"
// and TaskDetail's "Round {n} sent back to the worker automatically" both
// render identically whether the task is genuinely mid-round or has spent
// its every automatic round and is parked in "reviewing" for a human — the
// exact state PR #136 sat in for hours. Deriving the cap here (rather than
// recomputing `resolveMaxAutoReturnRounds` client-side) keeps the one
// existing implementation as the only place that decides "is this task
// capped," same reasoning as blockedState/dependencyGate above it.
function withAutoReturnCapped<
  T extends {
    autoReturnRounds: number;
    projectMaxAutoReturnRounds: number | null;
  },
>(row: T): Omit<T, "projectMaxAutoReturnRounds"> & { autoReturnCapped: boolean } {
  const { projectMaxAutoReturnRounds, ...rest } = row;
  return {
    ...rest,
    autoReturnCapped:
      row.autoReturnRounds >=
      resolveMaxAutoReturnRounds({ maxAutoReturnRounds: projectMaxAutoReturnRounds }),
  };
}

interface ListTasksQuery {
  status?: string;
  projectId?: string;
}

const listTasksSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: [...TASK_STATUSES] },
      projectId: { type: "string", pattern: "^[0-9]+$" },
    },
  },
};

export async function tasksRoute(app: FastifyInstance) {
  app.get<{ Querystring: ListTasksQuery }>(
    "/api/tasks",
    { schema: listTasksSchema },
    async (request) => {
      const filters = [];
      if (request.query.status !== undefined) {
        filters.push(eq(tasks.status, request.query.status));
      }
      if (request.query.projectId !== undefined) {
        filters.push(eq(tasks.projectId, Number(request.query.projectId)));
      }
      const rows = app.db
        .select(TASK_ROW_COLUMNS)
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        // `.where(undefined)` omits the clause entirely — no filters means
        // "every task," same as before this endpoint took query params.
        .where(filters.length > 0 ? and(...filters) : undefined)
        // boardOrder is the render/ordering tier (roadmap's Task Model &
        // Task Board section) — order by it within each status so the
        // board has a deterministic render order instead of arbitrary
        // insertion order (Hermes review, PR #471).
        .orderBy(tasks.status, tasks.boardOrder, tasks.createdAt)
        .all();
      return rows.map((row) => withBlockedState(withAutoReturnCapped(row)));
    },
  );

  // Shared by GET /api/tasks/:id below and claim's own 202 response
  // (task-claim queueing, rate-limit-storm fix) — a queued/dispatched task
  // now returns its row, not a session, so it needs the exact same
  // shape/withBlockedState treatment the detail view already gets, not a
  // second, drifting definition of "what a task looks like over the wire."
  function selectTaskRow(taskId: number) {
    const [row] = app.db
      .select(TASK_ROW_COLUMNS)
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(tasks.id, taskId))
      .all();
    return row ? withBlockedState(withAutoReturnCapped(row)) : null;
  }

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
    const row = selectTaskRow(taskId);
    if (!row) return reply.notFound();
    return row;
  });

  function getProjectOr404(projectId: number) {
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    return project ?? null;
  }

  function getLocalTaskOr404(taskId: number) {
    const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return task ?? null;
  }

  // Reject flow's re-seed (6.7/#220) — a reject keeps the worktree and
  // session untouched by default so the agent can pick the feedback up on
  // its own, but that only works if the session is still alive. When it
  // isn't, a fresh session is spawned in the SAME worktree, seeded with the
  // feedback, so a reject doesn't strand the task with no agent attached to
  // it. Builds the prompt here (this route owns the human-feedback framing);
  // the actual spawn-or-not decision is shared with task-reconciler.ts's
  // review-feedback auto-return via reseedTaskIfSessionExited
  // (task-reseed.ts), so the two paths can't drift into different re-seed
  // behaviors.
  //
  // Returns whether the task is left with a live agent attached: `true`
  // covers both "re-seeded a fresh session" and "the old session is still
  // active, left alone by design so a human watching that terminal can pick
  // the feedback up" (task-reseed.ts's own default, non-`force` behavior).
  // `false` means the previous session had already exited AND the re-seed
  // attempt itself failed (spawn failure, or lost a race) — issue #987: that
  // used to leave the task sitting at "in_progress" with a dead session and
  // a stale `sessionId` forever, since nothing ever revisits it. The caller
  // below fails the task explicitly instead.
  async function reseedIfSessionExited(
    task: typeof tasks.$inferSelect,
    project: typeof projects.$inferSelect,
    feedback: string | null,
  ): Promise<boolean> {
    if (!task.sessionId || !task.worktreePath || !task.agentCommand) return true;
    const [session] = app.db.select().from(sessions).where(eq(sessions.id, task.sessionId)).all();
    if (session?.status === "active") {
      // Session still alive — task-reseed.ts's own default behavior is to
      // leave it untouched, not a failure.
      return true;
    }
    // Includes the task spec, not just the feedback: this only actually
    // reaches a fresh agent once reseedTaskIfSessionExited's own "session
    // still active" guard passes, and that agent has no memory of the task
    // — the previous feedback-only prompt told it "this was rejected,
    // here's why" about work it had never seen and a spec it had never read.
    // #939/#1016 — resolved once per spawn, fail-open — see
    // task-issue-context.ts's own doc comment.
    const issueContext = await resolveTaskIssueContextSafe(app, task, project);
    const prompt = buildRejectPrompt({
      task: {
        ...task,
        comments: issueContext?.comments,
        parent: issueContext?.parent,
        siblings: issueContext?.siblings,
      },
      branchName: task.branchName ?? deriveTaskBranchName(task),
      worktreePath: task.worktreePath,
      budgetMinutes: resolveTaskMasterConfig(app).budgetMinutes,
      // A reject is always a human's action, so someone is watching.
      auto: false,
      feedback,
      // #778 — resolved against the OWNING host's own sessionsDir; see
      // task-reconciler.ts's spawnReviewAgentNow for the full rationale.
      commitTitlePath: project.conventionalCommitTitles
        ? taskCommitTitlePath(
            await resolveSessionsDirWithFallback(app, resolveBackend(app, project.hostId), {
              taskId: task.id,
              hostId: project.hostId,
            }),
            task.id,
          )
        : undefined,
    });
    return reseedTaskIfSessionExited(app, task, project, prompt, "task reject");
  }

  // Phase 6 (6.9/#233) — local-board creation, works with Task Master off.
  // A task created here has no GitHub
  // issue (issueNumber/htmlUrl stay null) — the roadmap's Task backend
  // decision: the Mullion-local row is the hub, GitHub is an optional
  // synced projection, never a requirement for a task to exist.
  app.post<{ Body: CreateTaskBody }>(
    "/api/tasks",
    { schema: createTaskSchema },
    async (request, reply) => {
      const { projectId, title, body, status, boardOrder, agent, reviewAgent } = request.body;
      if (!getProjectOr404(projectId)) return reply.notFound("Project not found");

      const [created] = app.db
        .insert(tasks)
        .values({
          projectId,
          title,
          body: body ?? null,
          status: status ?? "backlog",
          boardOrder: boardOrder ?? 0,
          agent: agent ?? null,
          reviewAgent: reviewAgent ?? null,
        })
        .returning()
        .all();
      reply.code(201);
      return created;
    },
  );

  // Phase 6 (6.9/#233) — local-board edit: boardOrder for any task (it's a
  // purely local ordering column with no GitHub representation — safe to
  // edit regardless of link), plus the one status transition PR1 can
  // validate on its own (backlog<->ready, the interactive drag-to-ready
  // toggle from the roadmap's Task Model & Task Board section). Any other
  // status value — including a GitHub-linked task's own claimed/
  // in_progress/reviewing/done/failed — requires 6.2's full transition
  // table and is rejected here with a 409 rather than silently accepted;
  // see task-state.ts once 6.2 lands.
  //
  // title/body are local-CREATE-only for a GitHub-linked task (Hermes
  // review, PR #471): the watcher's onConflictDoUpdate resyncs title/body/
  // htmlUrl from the issue on every poll (see task-watcher.ts), so an edit
  // here would be silently reverted within one poll cycle with no error —
  // the issue itself is where a linked task's title/body get edited.
  app.patch<{ Params: { id: string }; Body: UpdateTaskBody }>(
    "/api/tasks/:id",
    { schema: updateTaskSchema },
    async (request, reply) => {
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
      const existing = getLocalTaskOr404(taskId);
      if (!existing) return reply.notFound();

      const { title, body, status, boardOrder, agent, reviewAgent } = request.body;
      if ((title !== undefined || body !== undefined) && existing.issueNumber !== null) {
        return reply.conflict(
          "Cannot edit title/body of a task linked to a GitHub issue — edit the issue itself; boardOrder, status, and agents remain editable here",
        );
      }
      // The request schema's own `enum` already restricts `status` to
      // LOCAL_CREATABLE_STATUSES — anything else (e.g. "claimed") 400s
      // before reaching this handler. What's left to guard here is the
      // *existing* row's status: a task already past backlog/ready needs
      // 6.2's full transition table, not this route.
      if (
        status !== undefined &&
        !LOCAL_CREATABLE_STATUSES.includes(existing.status as LocalCreatableStatus)
      ) {
        return reply.conflict(
          `Task is past the backlog/ready stage (status: ${existing.status}) — its status can no longer be edited directly`,
        );
      }

      if (
        (agent !== undefined || reviewAgent !== undefined) &&
        !LOCAL_CREATABLE_STATUSES.includes(existing.status as LocalCreatableStatus) &&
        existing.status !== "failed"
      ) {
        return reply.conflict(`Cannot edit agents for a task in status "${existing.status}"`);
      }

      const patch: Partial<typeof tasks.$inferInsert> = {};
      if (title !== undefined) patch.title = title;
      if (body !== undefined) patch.body = body;
      if (status !== undefined) patch.status = status;
      if (boardOrder !== undefined) patch.boardOrder = boardOrder;
      if (agent !== undefined) patch.agent = agent;
      if (reviewAgent !== undefined) patch.reviewAgent = reviewAgent;

      const [updated] = app.db
        .update(tasks)
        .set(patch)
        .where(eq(tasks.id, taskId))
        .returning()
        .all();
      // #488 — the most user-visible transition (drag-to-ready) had no
      // signal of any kind before. Guarded on the status actually changing:
      // this route also carries boardOrder-only PATCHes (drag-to-reorder
      // *within* a column), which must not broadcast a transition event on
      // every reorder.
      if (updated && status !== undefined && status !== existing.status) {
        recordTaskTransition(app, {
          taskId,
          projectId: updated.projectId,
          from: existing.status as TaskStatus,
          to: status,
          via: "patch",
        });
      }
      return updated;
    },
  );

  // Phase 6 (6.9/#233) — deletion is restricted to locally-created tasks
  // (no linked GitHub issue — deleting a GitHub-ingested row would just
  // have the watcher re-create it on the next poll, per its insert-or-
  // update sync) that haven't been claimed yet, plus two later-added
  // exceptions for terminal statuses that are individually safe to delete.
  //
  // #729 — a `failed` GitHub-linked task that was NEVER claimed is the
  // first exception: auto-failed by `syncUnlabeledIssueToLocal` (issue lost
  // the `mullion-task` label, or closed, while still backlog/ready), it has
  // no `branchName`, so Retry can't recover it (`no-worktree`,
  // task-claim.ts's retryTask) and it was otherwise permanently orphaned —
  // neither refusal above has an escape hatch for it. Gated on
  // `branchName === null`, not just `status === "failed"`: a task that WAS
  // claimed carries a real worktree/branch Retry CAN resume from, and its
  // issue can independently end up closed/unlabeled later (at promote time,
  // a maintainer tidying labels, ...) — deleting that row would silently
  // discard recoverable work with no cascade to clean up the worktree it
  // points at. That branch check alone also closes off any race with a
  // concurrent Retry: retryTask requires a non-null `branchName` too, so
  // nothing can move a `branchName === null`, `failed` row forward while
  // this handler's own GitHub round-trip is in flight.
  //
  // #746 — `done` is the second exception, for both local and GitHub-linked
  // tasks. Deliberately does NOT extend the `branchName === null` guard to
  // it: that guard exists so Retry can still resume a `failed` task, but
  // `done` is terminal (no Retry) and every done task from the normal
  // pipeline has a branch — requiring `branchName === null` here would make
  // this exception dead on arrival. `failed` deliberately stays out of this
  // widening beyond the #729 case above (a separate cleanup effort).
  //
  // Deleting either GitHub-linked exception is only durable if the watcher
  // genuinely won't re-create the row on its next sweep, so this re-checks
  // the linked issue's CURRENT state via `isIssueStillTrackable` rather than
  // trusting the local status alone — the issue could have been reopened
  // (and, for `done`, relabeled back to `mullion-task`) since the task
  // finished. That function already handles both shapes correctly: a
  // `done`-and-closed issue reads `state === "closed"` regardless of its
  // current label, same condition the `failed`-and-unlabeled case checks.
  // Tri-state on purpose — `undefined` means the check couldn't run (no
  // repo/token, GitHub threw), never treated as "confirmed untrackable," so
  // a transient outage can't be mistaken for permission to delete a task
  // the watcher would otherwise still re-ingest. The final delete is
  // additionally status-guarded (same "the row may have moved since this
  // handler's own read" reasoning task-github-sync.ts's own writes use) —
  // belt-and-braces given the GitHub round-trip above already makes this
  // route's read-then-write window unusually wide.
  const deletableTerminalGithubStatus = (status: string): status is "failed" | "done" =>
    status === "failed" || status === "done";

  // #746 — extracted so the bulk clear-done route (below) shares this
  // EXACT logic rather than a second copy that could quietly drift from
  // it, including the tri-state isIssueStillTrackable handling: `undefined`
  // means the check couldn't run (no repo/token, GitHub threw) and must
  // never be treated as "confirmed untrackable," or a transient outage
  // could delete a task the watcher would otherwise still re-ingest. Folds
  // the (practically unreachable — a task's projectId is FK'd to a real
  // row) "project not found" case into the same conflict-shaped result as
  // everything else, since the bulk route has no per-row 404 concept to
  // distinguish it into.
  //
  // #1014 (Abandon) — `force` is the single-task DELETE route's escape
  // hatch, never passed by the bulk clear-done caller below. It skips both
  // the preserved-branch refusal and the isIssueStillTrackable round-trip,
  // because the caller (the DELETE handler) is about to unlabel the issue
  // itself before this row is deleted — re-asking GitHub "is it still
  // tracked" here would just race that write. `deletableTerminalGithubStatus`
  // still applies even under force: Abandon is only ever offered for
  // failed/done tasks, never a task with a live in-flight worker.
  async function checkTaskDeletable(
    existing: typeof tasks.$inferSelect,
    opts: { force?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (existing.issueNumber !== null) {
      if (!deletableTerminalGithubStatus(existing.status)) {
        return { ok: false, reason: "Cannot delete a task linked to a GitHub issue" };
      }
      if (opts.force) return { ok: true };
      if (existing.status === "failed" && existing.branchName !== null) {
        return {
          ok: false,
          reason: "Cannot delete: this task has a preserved branch — use Retry to resume it",
        };
      }
      const project = getProjectOr404(existing.projectId);
      if (!project) return { ok: false, reason: "Project not found" };
      const trackable = await isIssueStillTrackable(app, existing, {
        cwd: project.cwd,
        hostId: project.hostId,
      });
      if (trackable !== false) {
        const label = app.config.MULLION_TASK_LABEL;
        return {
          ok: false,
          reason:
            trackable === undefined
              ? "Could not confirm the linked GitHub issue is no longer tracked — try again"
              : `Cannot delete: the linked GitHub issue is still open and labeled "${label}" — remove the label or close the issue first`,
        };
      }
    } else {
      // #1014 — force additionally allows a LOCAL failed task (previously
      // not deletable at all: TaskDetail.tsx never even rendered a Delete
      // button for one). Every other locally-creatable state is unaffected.
      const locallyDeletable =
        LOCAL_CREATABLE_STATUSES.includes(existing.status as LocalCreatableStatus) ||
        existing.status === "done" ||
        (opts.force === true && existing.status === "failed");
      if (!locallyDeletable) {
        return {
          ok: false,
          reason: `Cannot delete a task past the backlog/ready stage (status: ${existing.status})`,
        };
      }
    }
    return { ok: true };
  }

  // #1014 (Abandon) — best-effort session/worktree/branch teardown for a
  // force-deleted task, run in this exact order:
  //   1. sessions are AWAITED (not the fire-and-forget cleanupTaskSessions),
  //      so a live worker can't still be writing to the worktree while step
  //      3 force-removes it out from under it.
  //   2. worktree removal uses the FORCED `removeWorktree`, not
  //      `removeWorktreeIfClean` — the whole point of Abandon is to discard
  //      whatever's there, and `removeWorktreeIfClean` would just report
  //      "dirty" and leave it.
  //   3. branch delete, forced, last — once nothing has it checked out.
  // Routed through the project's SessionBackend (not the local git-worktree/
  // git-branch-delete functions directly) so a remote-hosted project's
  // worktree and branch — which live on that host's own filesystem — are
  // actually cleaned up too, matching attemptBranchDeleteForClearDone's own
  // reasoning above. Every step here is best-effort and reported, never
  // fatal — by the time this runs the task's row (and, for a GitHub-linked
  // task, its label) are already gone, so a leftover worktree/branch/session
  // is a cleanup gap, not a correctness problem.
  async function teardownAbandonedTask(
    task: typeof tasks.$inferSelect,
    project: typeof projects.$inferSelect,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean }> {
    for (const sessionId of new Set([task.sessionId, task.reviewSessionId])) {
      if (sessionId === null) continue;
      try {
        await killSession(app, sessionId, "detach");
      } catch (err) {
        app.log.warn({ err, sessionId, taskId: task.id }, "abandon: killSession threw");
      }
    }

    let worktreeRemoved = false;
    if (task.worktreePath) {
      try {
        worktreeRemoved = await resolveBackend(app, project.hostId).removeWorktree(
          task.worktreePath,
          project.cwd,
        );
      } catch (err) {
        app.log.warn(
          { err, worktreePath: task.worktreePath, taskId: task.id },
          "abandon: removeWorktree threw",
        );
      }
    }

    let branchDeleted = false;
    if (task.branchName) {
      try {
        const result = await resolveBackend(app, project.hostId).deleteBranch(
          project.cwd,
          task.branchName,
          { force: true },
        );
        branchDeleted = result.deleted;
        if (!result.deleted) {
          app.log.warn(
            { taskId: task.id, branch: task.branchName, reason: result.reason },
            "abandon: deleteBranch did not delete",
          );
        }
      } catch (err) {
        app.log.warn(
          { err, branch: task.branchName, taskId: task.id },
          "abandon: deleteBranch threw",
        );
      }
    }

    return { worktreeRemoved, branchDeleted };
  }

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
      const existing = getLocalTaskOr404(taskId);
      if (!existing) return reply.notFound();
      const force = request.query.force === "true";

      const check = await checkTaskDeletable(existing, { force });
      if (!check.ok) return reply.conflict(check.reason);

      // #1014 (Abandon) — the unlabel MUST succeed before the row is
      // touched. If it fails, the row stays exactly as it was: deleting
      // first and unlabeling after (the ordering attemptBranchDeleteForClearDone
      // uses for a branch, above) would mean a failed unlabel lets the
      // watcher re-ingest this issue into "ready" on its next sweep —
      // auto-claim would then dispatch a fresh worker to the very task the
      // user just asked to get rid of.
      let project: typeof projects.$inferSelect | null = null;
      // Review fix (#1014) — tracked so the CAS-delete-failed branch below
      // can tell the caller the label is ALREADY gone, rather than implying
      // (as the generic "refresh and try again" message would) that nothing
      // happened yet. The unlabel itself is not undone on that path: retrying
      // the request is enough (issueNumber's already unlabeled, so the
      // second attempt's checkTaskDeletable + this whole `if` block is a
      // no-op) and re-adding a label a human or the watcher may have since
      // touched again would be its own race.
      let labelRemoved = false;
      if (force && existing.issueNumber !== null) {
        project = getProjectOr404(existing.projectId);
        if (!project) return reply.notFound();
        const repoRef = await resolveRepoRef(app, project);
        if (!repoRef) {
          return reply.badGateway("Could not resolve the project's GitHub repo");
        }
        const token = await resolveGitHubToken(app, repoRef);
        if (!token) {
          return reply.badGateway("No GitHub token available to remove the task label");
        }
        try {
          await removeLabel(
            token,
            repoRef.owner,
            repoRef.repo,
            existing.issueNumber,
            app.config.MULLION_TASK_LABEL,
          );
          labelRemoved = true;
        } catch (err) {
          app.log.warn(
            { err, taskId, issueNumber: existing.issueNumber },
            "abandon: removeLabel failed — task not deleted",
          );
          return reply.badGateway("Failed to remove the task label on GitHub — task not deleted");
        }
      }

      const deleted = app.db
        .delete(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.status, existing.status)))
        .run();
      if (deleted.changes === 0) {
        // Review fix (#1014) — a concurrent status change (a Retry, the
        // reconciler, a second concurrent force-delete) between this
        // handler's own read and this CAS write can land here AFTER the
        // label above was already removed. The row survives, but it's no
        // longer labeled — say so, rather than the generic message that
        // reads as "nothing happened."
        if (labelRemoved) {
          app.log.warn(
            { taskId, issueNumber: existing.issueNumber },
            "abandon: label removed but the row changed before it could be deleted — retry will finish the delete",
          );
          return reply.conflict(
            "Task changed since this check — the GitHub label was already removed; refresh and try again",
          );
        }
        return reply.conflict("Task changed since this check — refresh and try again");
      }

      if (force) {
        project ??= getProjectOr404(existing.projectId);
        if (project) await teardownAbandonedTask(existing, project);
      }

      reply.code(204);
    },
  );

  // #746 — best-effort branch cleanup for the bulk clear-done flow below,
  // opt-in and off by default (records preserved unless the caller asks for
  // branch deletion too). This repo squash-merges, so a merged task
  // branch's commits are NOT literally in main's history — a non-force
  // `git branch -d` would return "unmerged" for practically every done
  // task — but blind `force: true` is not acceptable either. Resolves it
  // explicitly: only force-deletes once a fresh GitHub read confirms the
  // task's PR actually merged; otherwise reports the branch as skipped
  // with its reason and never touches it. A branch failure — including
  // "couldn't confirm merge state" — never blocks the row deletion the
  // caller already committed to; this is called strictly AFTER that DB
  // delete succeeds, so a branch-check failure only means the branch
  // survives, not that the task reappears.
  async function attemptBranchDeleteForClearDone(
    task: typeof tasks.$inferSelect,
    project: typeof projects.$inferSelect,
    rateLimited: boolean,
  ): Promise<{ id: number; branch: string; deleted: boolean; reason?: string }> {
    const branch = task.branchName!;
    if (task.prNumber === null) {
      return { id: task.id, branch, deleted: false, reason: "no-pr" };
    }
    if (rateLimited) {
      return { id: task.id, branch, deleted: false, reason: "rate-limited" };
    }
    const repoRef = await resolveRepoRef(app, project);
    if (!repoRef) {
      return { id: task.id, branch, deleted: false, reason: "no-repo" };
    }
    // "read", not "write" — this only ever reads the PR's merge state.
    const token = await resolveGitHubToken(app, repoRef, "read");
    if (!token) {
      return { id: task.id, branch, deleted: false, reason: "no-token" };
    }
    let merged: boolean;
    try {
      const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
      merged = pr.merged;
    } catch (err) {
      app.log.warn(
        { err, taskId: task.id, prNumber: task.prNumber },
        "clear-done: failed to confirm PR merge state — leaving the branch alone",
      );
      return { id: task.id, branch, deleted: false, reason: "merge-check-failed" };
    }
    if (!merged) {
      return { id: task.id, branch, deleted: false, reason: "not-merged" };
    }
    try {
      // resolveBackend, not the local deleteBranch function directly — a
      // remote-hosted project's branch lives on that host's own
      // filesystem (/internal/git-branch-delete).
      const result = await resolveBackend(app, project.hostId).deleteBranch(project.cwd, branch, {
        force: true,
      });
      return {
        id: task.id,
        branch,
        deleted: result.deleted,
        reason: result.deleted ? undefined : (result.reason ?? "delete-failed"),
      };
    } catch (err) {
      app.log.warn({ err, taskId: task.id, branch }, "clear-done: deleteBranch threw");
      return { id: task.id, branch, deleted: false, reason: "delete-failed" };
    }
  }

  // #746 — bulk companion to DELETE /api/tasks/:id above, scoped to `done`
  // tasks only (the single-row route's other terminal exception, `failed`,
  // stays out of scope here too — see that route's own comment). Shares
  // `checkTaskDeletable` so a row's deletability is decided in exactly one
  // place regardless of which route reaches it.
  //
  // Capped at MAX_CLEAR_DONE_BATCH per call, mirroring task-watcher.ts's own
  // MAX_READBACK_CHECKS_PER_SWEEP precedent — a GitHub-linked done task
  // costs one isIssueStillTrackable round-trip, and 50+ of those in one
  // request is exactly the call-volume pattern #759/#777 exist to prevent.
  // The remainder is reported, not silently dropped; the frontend calls
  // again for the next batch. The install-wide rate-limit budget
  // (isGitHubRateLimited, github-fetch.ts) is checked ONCE per request, not
  // once per task — a GitHub-linked candidate caught by it is reported
  // failed with a rate-limit reason rather than opening a call the
  // transport layer already knows will fail; a local (no issueNumber)
  // candidate is entirely unaffected, since it needs no GitHub call at all.
  const MAX_CLEAR_DONE_BATCH = 20;

  app.post<{ Body: { projectIds?: number[]; deleteBranches?: boolean } }>(
    "/api/tasks/clear-done",
    { schema: clearDoneTasksSchema },
    async (request) => {
      const { projectIds, deleteBranches } = request.body ?? {};

      const candidates =
        projectIds && projectIds.length > 0
          ? app.db
              .select()
              .from(tasks)
              .where(and(eq(tasks.status, "done"), inArray(tasks.projectId, projectIds)))
              .all()
          : app.db.select().from(tasks).where(eq(tasks.status, "done")).all();

      const attempted = candidates.slice(0, MAX_CLEAR_DONE_BATCH);
      const remaining = candidates.length - attempted.length;
      if (remaining > 0) {
        app.log.debug(
          { total: candidates.length, attempting: attempted.length },
          "clear-done: batch cap reached — remainder left for a follow-up call",
        );
      }

      const rateLimited = isGitHubRateLimited();
      const deleted: number[] = [];
      const failed: { id: number; error: string }[] = [];
      const branches: { id: number; branch: string; deleted: boolean; reason?: string }[] = [];

      for (const task of attempted) {
        if (task.issueNumber !== null && rateLimited) {
          failed.push({
            id: task.id,
            error: "GitHub rate limit is in effect — try again shortly",
          });
          continue;
        }
        const check = await checkTaskDeletable(task);
        if (!check.ok) {
          failed.push({ id: task.id, error: check.reason });
          continue;
        }

        const result = app.db
          .delete(tasks)
          .where(and(eq(tasks.id, task.id), eq(tasks.status, "done")))
          .run();
        if (result.changes === 0) {
          failed.push({
            id: task.id,
            error: "Task changed since this check — refresh and try again",
          });
          continue;
        }
        deleted.push(task.id);

        if (deleteBranches && task.branchName !== null) {
          const project = getProjectOr404(task.projectId);
          if (project) {
            // Serial, not Promise.all — concurrent git operations across
            // this repo's own worktrees have twice corrupted shared
            // objects; a bulk branch-delete is that exact class of risk.
            branches.push(await attemptBranchDeleteForClearDone(task, project, rateLimited));
          }
        }
      }

      return { deleted, failed, branches, remaining };
    },
  );

  // #1015 (archive) — orthogonal to `status`, not a status transition: hides
  // a `done`/`failed` task from the board's default view without touching
  // its status, its prNumber -> task linkage, or any of the services that
  // branch on `status === "done"`. Restricted to done/failed for the same
  // reason Abandon's force-delete is: archiving an in_progress/reviewing
  // task would hide it from the board while its worker keeps running (and
  // holding a maxConcurrent slot), or from the person whose approval it's
  // waiting on.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/archive", async (request, reply) => {
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
    const existing = getLocalTaskOr404(taskId);
    if (!existing) return reply.notFound();
    if (existing.status !== "done" && existing.status !== "failed") {
      return reply.conflict(
        `Cannot archive a task that hasn't finished (status: ${existing.status})`,
      );
    }
    const [updated] = app.db
      .update(tasks)
      .set({ archivedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning()
      .all();
    return updated;
  });

  // Clears ONLY archivedAt, never mergedAt — mergedAt is a fact about the
  // PR (see schema.ts's own doc comment), unarchiving doesn't make it
  // un-merged.
  app.delete<{ Params: { id: string } }>("/api/tasks/:id/archive", async (request, reply) => {
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
    const existing = getLocalTaskOr404(taskId);
    if (!existing) return reply.notFound();
    const [updated] = app.db
      .update(tasks)
      .set({ archivedAt: null })
      .where(eq(tasks.id, taskId))
      .returning()
      .all();
    return updated;
  });

  // #1015 (archive) — both the backfill for tasks that merged before this
  // feature existed (or while the app was down — webhooks have no replay)
  // and the ongoing reconciliation path for a merge task-reconciler.ts never
  // observed (mergeOnApprove off, so nothing ever set mergeRequestedAt to
  // arm that sweep). Modeled directly on /api/tasks/clear-done above: same
  // MAX_CLEAR_DONE_BATCH-shaped cap, same "check the install-wide rate
  // limit once per request, not once per task" reasoning.
  //
  // Review fix — candidates gate on `isNull(tasks.mergedAt)`, not just
  // `isNull(tasks.archivedAt)`. Unarchive (DELETE .../archive) deliberately
  // clears only archivedAt, leaving mergedAt set — the same
  // isNull(mergedAt) guard the other two merge-observation paths
  // (webhooks.ts, task-reconciler.ts's markTaskMerged) already use so a
  // manual unarchive sticks. Without it, this route (meant to be re-run
  // periodically) would re-confirm the same already-known merge and
  // silently re-archive a task the user just asked to bring back.
  app.post<{ Body: { projectIds?: number[] } }>(
    "/api/tasks/archive-merged",
    { schema: archiveMergedTasksSchema },
    async (request) => {
      const { projectIds } = request.body ?? {};

      const doneUnmergedWithPr = and(
        eq(tasks.status, "done"),
        isNotNull(tasks.prNumber),
        isNull(tasks.mergedAt),
      );
      const candidates =
        projectIds && projectIds.length > 0
          ? app.db
              .select()
              .from(tasks)
              .where(and(doneUnmergedWithPr, inArray(tasks.projectId, projectIds)))
              .all()
          : app.db.select().from(tasks).where(doneUnmergedWithPr).all();

      const attempted = candidates.slice(0, MAX_CLEAR_DONE_BATCH);
      const remaining = candidates.length - attempted.length;

      const rateLimited = isGitHubRateLimited();
      const archived: number[] = [];
      const failed: { id: number; error: string }[] = [];

      for (const task of attempted) {
        if (rateLimited) {
          failed.push({ id: task.id, error: "GitHub rate limit is in effect — try again shortly" });
          continue;
        }
        const project = getProjectOr404(task.projectId);
        if (!project) {
          failed.push({ id: task.id, error: "Project not found" });
          continue;
        }
        const repoRef = await resolveRepoRef(app, project);
        if (!repoRef) {
          failed.push({ id: task.id, error: "Could not resolve the project's GitHub repo" });
          continue;
        }
        const token = await resolveGitHubToken(app, repoRef, "read");
        if (!token) {
          failed.push({ id: task.id, error: "No GitHub token available" });
          continue;
        }
        let mergedAt: string | null;
        try {
          const pr = await getPullRequestByNumber(
            token,
            repoRef.owner,
            repoRef.repo,
            task.prNumber!,
          );
          if (!pr.merged) {
            failed.push({ id: task.id, error: "PR is not merged" });
            continue;
          }
          mergedAt = pr.mergedAt;
        } catch (err) {
          app.log.warn(
            { err, taskId: task.id, prNumber: task.prNumber },
            "archive-merged: failed to confirm PR merge state",
          );
          failed.push({ id: task.id, error: "Could not confirm PR merge state" });
          continue;
        }
        const now = new Date();
        app.db
          .update(tasks)
          // Review fix — prefers GitHub's own merged_at (the PR's actual
          // merge time) over "whenever this endpoint happened to run," which
          // matters for the backfill case: a task merged days before this
          // route is ever called would otherwise get a misleading mergedAt.
          // Falls back to `now` only when GitHub genuinely doesn't have one
          // (shouldn't happen once pr.merged is confirmed true, but the type
          // is nullable) or a prior run already set one.
          .set({
            mergedAt: task.mergedAt ?? (mergedAt ? new Date(mergedAt) : now),
            archivedAt: now,
          })
          .where(eq(tasks.id, task.id))
          .run();
        archived.push(task.id);
      }

      return { archived, failed, remaining };
    },
  );

  // Phase 6 (6.2/#215) — thin wrapper over task-claim.ts's shared
  // orchestration (also used by task-watcher.ts's auto-claim sweep), which
  // owns the agent-resolution/seed logic. This handler's only job is
  // mapping EnqueueTaskOutcome to an HTTP response.
  //
  // Task-claim queueing (rate-limit-storm fix) — claiming now unconditionally
  // ENQUEUES the task (status -> "claimed") and returns 202, rather than
  // reserving-and-spawning synchronously and returning 201 with the new
  // session. A manual claim can therefore no longer 429 on the concurrency
  // cap at all — see task-claim.ts's enqueueTask/dispatchClaimedTask split.
  // Dispatch (the actual worktree/session spawn) happens asynchronously,
  // off task-dispatch.ts's opportunistic hook or its periodic sweep; the
  // caller observes it via GET /api/tasks (or /ws/tasks) once it happens,
  // not synchronously on this response.
  //
  // Task-Master-enabled-gated (independent review, PR #471; settings
  // override added by the Settings UI follow-up — see task-config.ts):
  // claiming queues real autonomous work — the roadmap's Flag semantics
  // decision names this endpoint explicitly as autonomous behavior the gate
  // must cover, unlike the local board's create/edit/drag routes above.
  // Before this check, a task created via the (deliberately un-gated) local
  // board with `status: "ready"` could reach claim with Task Master off —
  // the exact bypass the gate exists to prevent.
  app.post<{ Params: { id: string }; Body: ClaimTaskBody }>(
    "/api/tasks/:id/claim",
    { schema: claimTaskSchema },
    async (request, reply) => {
      if (!resolveTaskMasterConfig(app).enabled) {
        return reply.forbidden(
          "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
        );
      }
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");

      const body = request.body ?? {};
      const outcome = await enqueueTask(app, taskId, {
        auto: false,
        agent: body.agent,
        reviewAgent: body.reviewAgent,
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case "not-found":
            return reply.notFound();
          case "not-ready":
            return reply.conflict(outcome.detail ?? "Task is not ready");
          case "no-seed-channel":
            return reply.badRequest(outcome.detail ?? "Resolved agent can't receive a seed prompt");
        }
      }

      reply.code(202);
      return selectTaskRow(taskId);
    },
  );

  // #483 — retries a "failed" task by resuming on its preserved branch
  // (task-claim.ts's retryTask). Same gate as claim: this leads to
  // spawning a session, genuinely new autonomous work the flag must cover.
  app.post<{ Params: { id: string }; Body: RetryTaskBody }>(
    "/api/tasks/:id/retry",
    { schema: retryTaskSchema },
    async (request, reply) => {
      if (!resolveTaskMasterConfig(app).enabled) {
        return reply.forbidden(
          "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
        );
      }
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");

      const outcome = await retryTask(app, taskId, request.body || undefined);
      if (!outcome.ok) {
        switch (outcome.reason) {
          case "not-found":
            return reply.notFound();
          case "not-failed":
            return reply.conflict(outcome.detail ?? "Task is not failed");
          case "cap":
            return reply
              .code(429)
              .send({ error: "concurrency-cap", limit: outcome.limit, message: outcome.detail });
          case "no-worktree":
            return reply.badRequest(outcome.detail ?? "Task has no recorded branch to resume");
          case "remote-not-supported":
            return reply.code(501).send({ error: "remote-not-supported", message: outcome.detail });
          case "worktree-failed":
            return reply.badGateway(outcome.detail ?? "Failed to resume this task's worktree");
          case "spawn-failed":
            return reply.badGateway(outcome.detail ?? "Failed to spawn a session for this task");
        }
      }

      reply.code(201);
      return { ...outcome.session, seedDelivered: outcome.seedDelivered };
    },
  );

  // Phase 6 (6.2/#215, promotion added in 6.7/#220) — approve acts on a
  // task in "reviewing" (task-state.ts's canTransition table is the single
  // source of truth for legality, so a request against a task not in
  // "reviewing" 409s here the same way it would from any other
  // illegal-transition attempt). Push + PR creation (task-promote.ts) runs
  // BEFORE the local status write below and IS awaited — unlike the
  // best-effort label/comment sync further down, whether the task is
  // actually allowed to reach "done" depends on promotion having
  // succeeded, so there's nothing to fire-and-forget here. A failure
  // leaves the task in "reviewing", untouched and safely retryable —
  // never half-promoted.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/approve", async (request, reply) => {
    // Same resolved-enabled gate as claim (independent review, PR #480) —
    // approve triggers promoteTaskToPR (a branch push, a PR, closing the
    // GitHub issue) and previously had NO server-side gate at all, relying
    // entirely on the Tasks panel disabling the button client-side. A
    // client that believes Task Master is enabled (e.g. a settings PATCH
    // still in flight, or one that silently failed) could otherwise push
    // real GitHub writes while the server's own resolved config says
    // otherwise.
    if (!resolveTaskMasterConfig(app).enabled) {
      return reply.forbidden(
        "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
      );
    }
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
    const existing = getLocalTaskOr404(taskId);
    if (!existing) return reply.notFound();
    if (!canTransition(existing.status as (typeof TASK_STATUSES)[number], "done")) {
      return reply.conflict(`Cannot approve a task in status "${existing.status}"`);
    }
    const project = getProjectOr404(existing.projectId);
    if (!project) return reply.notFound("Project not found");

    const outcome = await approveTask(app, existing, project, "approve");
    if (!outcome.ok) {
      switch (outcome.reason) {
        case "dirty-tree":
          return reply.conflict(outcome.detail ?? "Worktree has uncommitted changes");
        case "no-worktree":
          return reply.badGateway(outcome.detail ?? "Task has no worktree to promote");
        case "no-token":
          return reply.badRequest(outcome.detail ?? "No GitHub token connected");
        case "no-repo":
          return reply.badGateway(outcome.detail ?? "Could not resolve the project's GitHub repo");
        case "push-failed":
          return reply.badGateway(outcome.detail ?? "Failed to push the task's branch");
        case "pr-create-failed":
          return reply.badGateway(outcome.detail ?? "Failed to create the pull request");
        case "remote-not-supported":
          return reply.code(501).send({ error: "remote-not-supported", message: outcome.detail });
        case "cas-lost":
          // Promotion already succeeded (branch pushed, PR opened) but the
          // task moved out of "reviewing" before the CAS write could land —
          // a concurrent reject, most plausibly. The PR is real and left
          // open; nothing to roll back here (see task-promote.ts's own doc
          // comment on the narrower "PR already exists" retry case this is
          // adjacent to).
          return reply.conflict(
            `Task was no longer in reviewing by the time this ran — a PR was opened at ${outcome.prUrl} but the task's status was not updated`,
          );
      }
    }
    return outcome.task;
  });

  // Merge-on-approve — "Merge now" / "Retry merge". Re-arms the merge sweep
  // (task-reconciler.ts's processMergeRequests) rather than merging inline:
  // the same branch-protection reasoning as approve above applies here too
  // (an up-to-date branch + green required checks a fresh click can't
  // guarantee synchronously), so this only sets intent and resets the
  // sweep's own backoff so the next tick attempts it immediately instead of
  // waiting out whatever interval it was already on.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/merge", async (request, reply) => {
    if (!resolveTaskMasterConfig(app).enabled) {
      return reply.forbidden(
        "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
      );
    }
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
    const existing = getLocalTaskOr404(taskId);
    if (!existing) return reply.notFound();
    if (existing.status !== "done") {
      return reply.conflict(`Cannot request a merge for a task in status "${existing.status}"`);
    }
    if (existing.prNumber === null) {
      return reply.conflict("Task has no linked pull request to merge");
    }

    const [updated] = app.db
      .update(tasks)
      .set({ mergeRequestedAt: new Date(), mergeError: null })
      .where(eq(tasks.id, taskId))
      .returning()
      .all();
    resetMergeBackoff(taskId);
    return updated;
  });

  interface RejectBody {
    feedback?: string;
  }
  const rejectSchema = {
    body: {
      type: "object",
      additionalProperties: false,
      properties: { feedback: { type: "string" } },
    },
  };
  app.post<{ Params: { id: string }; Body: RejectBody }>(
    "/api/tasks/:id/reject",
    { schema: rejectSchema },
    async (request, reply) => {
      // Deliberately NOT gated on "enabled" (Hermes review, PR #480, fourth
      // pass), unlike claim/approve. The reconciler never advances a
      // finished task into "reviewing" while disabled (see the gate in
      // task-reconciler.ts), but a task already sitting in "reviewing" when
      // the toggle flips off is still possible — approve is the only other
      // resolver, and it's gated (it creates a real PR and closes the
      // GitHub issue, exactly the kind of consequential write the flag
      // should keep contained). Leaving reject open is the escape hatch:
      // it's a human decision to send an in-flight task back for another
      // attempt, not new autonomous work, and it's the one action that
      // keeps a disabled install from permanently stranding a reviewing
      // task. It can re-seed the worker session if that session already
      // exited (see reseedIfSessionExited below) — a bounded continuation
      // of already-approved scope, not a new claim.
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
      const existing = getLocalTaskOr404(taskId);
      if (!existing) return reply.notFound();
      // Checked directly against "reviewing", not via canTransition(...,
      // "in_progress") — that table entry is also satisfied by "claimed"
      // (claimed -> in_progress is a legal edge on its own), which would
      // let this pass for a task that was never in review and then fall
      // through to a misleading "no longer in reviewing" 409 below.
      if (existing.status !== "reviewing") {
        return reply.conflict(`Cannot reject a task in status "${existing.status}"`);
      }
      const [updated] = app.db
        .update(tasks)
        .set({
          status: "in_progress",
          failureReason: request.body.feedback ?? null,
          // Same reasoning as retryTask's own reservation (task-claim.ts):
          // this is a bounded continuation of already-approved scope, not a
          // new claim, but it re-enters the reconciler's budget-enforced
          // "claimed"/"in_progress" pool (task-reconciler.ts) all the same.
          // Leaving the original claimedAt would let the reconciler measure
          // the budget deadline from a timestamp that predates however long
          // the task already sat in review — and the re-seeded agent below
          // is told a budget window that assumes a fresh clock. Resetting
          // it keeps both true.
          //
          // Unconditional, so it also fires below when reseedIfSessionExited
          // finds the previous session still `active` and skips re-seeding
          // (Hermes review, PR #569): that surviving agent keeps its
          // ORIGINAL prompt, whose budget line still cites the original
          // claim time, while enforcement now measures from this reject.
          // Safe direction only — the agent may believe its budget is
          // nearly spent when it isn't — not the reverse. Fixing the
          // prompt/enforcement match on that path would mean re-prompting a
          // still-running session, which is a bigger change than this
          // fix's scope.
          claimedAt: new Date(),
          // Issue #1038 — Reject is exactly the escape hatch a capped,
          // announced task relies on (it doesn't spend a round, see
          // task-reconciler.ts's autoReturnRounds doc comment), so this is
          // the one clear site most likely to fire on an announced task.
          // Clearing it here, same write, means the board stops claiming
          // "needs a human" the instant a human has, in fact, acted.
          autoReturnCapAnnouncedAt: null,
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "reviewing")))
        .returning()
        .all();
      if (!updated) return reply.conflict("Task was no longer in reviewing by the time this ran");
      recordTaskTransition(app, {
        taskId,
        projectId: updated.projectId,
        from: "reviewing",
        to: "in_progress",
        via: "reject",
      });
      const project = getProjectOr404(updated.projectId);
      if (project) {
        // Deliberately NOT awaited — same request-path latency reasoning
        // as approve's own sync call above.
        void syncTaskTransition(app, updated, project, "rejected", {
          feedback: request.body.feedback,
        });
        // Awaited, unlike the sync above: this can change `sessionId` on
        // the task row, and the response below should reflect that rather
        // than the pre-reseed snapshot.
        const reseeded = await reseedIfSessionExited(
          updated,
          project,
          request.body.feedback ?? null,
        );
        if (!reseeded) {
          // Issue #987 — the previous session had already exited AND the
          // re-seed attempt itself failed (spawn failure, or lost a race).
          // Leaving the task at "in_progress" here strands it with a dead
          // session and a stale `sessionId` permanently: nothing else ever
          // revisits it. Fail it explicitly instead, same CAS-guarded shape
          // task-reconciler.ts's failReviewingGate/budget-exceeded paths
          // use. Deliberately NOT calling removeWorktreeIfClean, unlike
          // those two — a human just wrote real reject feedback onto a
          // branch that may carry committed work worth a retryTask picking
          // back up, so the worktree is left in place for that.
          const failedAt = new Date();
          const failed = app.db
            .update(tasks)
            .set({
              status: "failed",
              failureReason: "re-seed spawn failed after reject",
              completedAt: failedAt,
            })
            .where(and(eq(tasks.id, taskId), eq(tasks.status, "in_progress")))
            .returning()
            .all();
          if (failed.length > 0) {
            recordTaskTransition(app, {
              taskId,
              projectId: project.id,
              from: "in_progress",
              to: "failed",
              via: "reject",
            });
            void syncTaskTransition(
              app,
              {
                ...updated,
                status: "failed",
                failureReason: "re-seed spawn failed after reject",
                completedAt: failedAt,
              },
              project,
              "failed",
            );
          }
        }
      }
      const [final] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
      return final ?? updated;
    },
  );

  interface GiveUpBody {
    reason?: string;
  }
  const giveUpSchema = {
    body: {
      type: "object",
      additionalProperties: false,
      properties: { reason: { type: "string" } },
    },
  };
  app.post<{ Params: { id: string }; Body: GiveUpBody }>(
    "/api/tasks/:id/give-up",
    { schema: giveUpSchema },
    async (request, reply) => {
      // #483 — the other resolver of a "reviewing" task, alongside
      // approve/reject. NOT gated on "enabled", same reasoning as reject:
      // a human decision to abandon an in-flight task, not new autonomous
      // work — and it's the escape hatch reject already is, just landing
      // on "failed" instead of "in_progress" when the answer is "give up
      // entirely" rather than "try again."
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
      const existing = getLocalTaskOr404(taskId);
      if (!existing) return reply.notFound();
      // Same direct-status check as reject, not canTransition(...,
      // "failed") — that table entry is also satisfied by several other
      // source statuses, which would let this pass for a task never in
      // review.
      if (existing.status !== "reviewing") {
        return reply.conflict(`Cannot give up on a task in status "${existing.status}"`);
      }
      const [updated] = app.db
        .update(tasks)
        .set({
          status: "failed",
          failureReason: request.body.reason ?? "given up during review",
          completedAt: new Date(),
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "reviewing")))
        .returning()
        .all();
      if (!updated) return reply.conflict("Task was no longer in reviewing by the time this ran");
      recordTaskTransition(app, {
        taskId,
        projectId: updated.projectId,
        from: "reviewing",
        to: "failed",
        via: "give-up",
      });
      const project = getProjectOr404(updated.projectId);
      if (project) {
        // Deliberately NOT awaited — same request-path latency reasoning
        // as approve/reject's own sync calls above.
        void syncTaskTransition(app, updated, project, "failed");
        // Leaves "reviewing" for a terminal state — cleanupTaskWorktree's
        // own doc comment already describes exactly this case (its other,
        // and previously only, call site is approve).
        cleanupTaskWorktree(app, updated, project);
        // Same reasoning as approveTask's own call — a task leaving
        // "reviewing" for good must not leave its worker/review sessions
        // running with nothing left to do.
        cleanupTaskSessions(app, updated);
        // A draft PR may already be open (task-promote.ts's
        // openDraftPRForTask, best-effort at "-> reviewing") — give-up is
        // the only route that resolves "reviewing" -> "failed" (a
        // budget/session-death failure never reaches "reviewing" in the
        // first place, so it never has one to close). Also not awaited,
        // same fire-and-forget posture as the sync call above.
        void closeDraftPRForTask(app, updated, project);
      }
      return updated;
    },
  );
}
