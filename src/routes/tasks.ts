import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, tasks, TASK_STATUSES } from "../db/schema.js";
import { claimTask, retryTask } from "../services/task-claim.js";
import { resolveTaskMasterConfig } from "../services/task-config.js";
import { buildRejectPrompt } from "../services/task-prompt.js";
import { canTransition, recordTaskTransition, type TaskStatus } from "../services/task-state.js";
import { syncTaskTransition } from "../services/task-github-sync.js";
import { dependencyGate, parseBlockedBy } from "../services/task-dependencies.js";
import { promoteTaskToPR, closeDraftPRForTask } from "../services/task-promote.js";
import { reseedTaskIfSessionExited } from "../services/task-reseed.js";
import { resolveBackend } from "../services/session-backend.js";

// Phase 6's 6.8 (#283) — best-effort worktree cleanup once a task leaves
// "reviewing" for a terminal state. Fire-and-forget, same posture as the
// GitHub sync calls below it: cleanup succeeding or failing doesn't change
// whether the transition itself is valid, and removeWorktreeIfClean already
// leaves a dirty/unclear tree in place for a later pass to retry rather
// than losing anything.
function cleanupTaskWorktree(
  app: FastifyInstance,
  task: { worktreePath: string | null },
  project: typeof projects.$inferSelect,
): void {
  if (!task.worktreePath) return;
  void resolveBackend(app, project.hostId)
    .removeWorktreeIfClean(task.worktreePath, project.cwd)
    .catch((err) => {
      app.log.warn(
        { err, worktreePath: task.worktreePath, projectId: project.id },
        "task cleanup: removeWorktreeIfClean threw",
      );
    });
}
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
}

interface UpdateTaskBody {
  title?: string;
  body?: string | null;
  status?: LocalCreatableStatus;
  boardOrder?: number;
}

const createTaskSchema = {
  body: {
    type: "object",
    required: ["projectId", "title"],
    additionalProperties: false,
    properties: {
      projectId: { type: "integer" },
      title: { type: "string", minLength: 1 },
      body: { type: ["string", "null"] },
      status: { type: "string", enum: [...LOCAL_CREATABLE_STATUSES] },
      boardOrder: { type: "integer", minimum: 0 },
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
    },
  },
};

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
  reviewFindings: tasks.reviewFindings,
  reviewRounds: tasks.reviewRounds,
  worktreePath: tasks.worktreePath,
  branchName: tasks.branchName,
  baseSha: tasks.baseSha,
  agentCommand: tasks.agentCommand,
  prUrl: tasks.prUrl,
  prNumber: tasks.prNumber,
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
  claimedAt: tasks.claimedAt,
  startedAt: tasks.startedAt,
  reviewingAt: tasks.reviewingAt,
  completedAt: tasks.completedAt,
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
      return rows.map(withBlockedState);
    },
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
    const [row] = app.db
      .select(TASK_ROW_COLUMNS)
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(tasks.id, taskId))
      .all();
    if (!row) return reply.notFound();
    return withBlockedState(row);
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
  async function reseedIfSessionExited(
    task: typeof tasks.$inferSelect,
    project: typeof projects.$inferSelect,
    feedback: string | null,
  ): Promise<void> {
    if (!task.sessionId || !task.worktreePath || !task.agentCommand) return;
    // Includes the task spec, not just the feedback: this only actually
    // reaches a fresh agent once reseedTaskIfSessionExited's own "session
    // still active" guard passes, and that agent has no memory of the task
    // — the previous feedback-only prompt told it "this was rejected,
    // here's why" about work it had never seen and a spec it had never read.
    const prompt = buildRejectPrompt({
      task,
      branchName: task.branchName ?? `mullion/task-${task.id}`,
      worktreePath: task.worktreePath,
      budgetMinutes: resolveTaskMasterConfig(app).budgetMinutes,
      // A reject is always a human's action, so someone is watching.
      auto: false,
      feedback,
    });
    await reseedTaskIfSessionExited(app, task, project, prompt, "task reject");
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
      const { projectId, title, body, status, boardOrder } = request.body;
      if (!getProjectOr404(projectId)) return reply.notFound("Project not found");

      const [created] = app.db
        .insert(tasks)
        .values({
          projectId,
          title,
          body: body ?? null,
          status: status ?? "backlog",
          boardOrder: boardOrder ?? 0,
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

      const { title, body, status, boardOrder } = request.body;
      if ((title !== undefined || body !== undefined) && existing.issueNumber !== null) {
        return reply.conflict(
          "Cannot edit title/body of a task linked to a GitHub issue — edit the issue itself; boardOrder and status remain editable here",
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

      const patch: Partial<typeof tasks.$inferInsert> = {};
      if (title !== undefined) patch.title = title;
      if (body !== undefined) patch.body = body;
      if (status !== undefined) patch.status = status;
      if (boardOrder !== undefined) patch.boardOrder = boardOrder;

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
  // update sync) that haven't been claimed yet. Widening this to
  // done/failed once those statuses exist is 6.2's job, not this PR's.
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
    const existing = getLocalTaskOr404(taskId);
    if (!existing) return reply.notFound();
    if (existing.issueNumber !== null) {
      return reply.conflict("Cannot delete a task linked to a GitHub issue");
    }
    if (!LOCAL_CREATABLE_STATUSES.includes(existing.status as LocalCreatableStatus)) {
      return reply.conflict(
        `Cannot delete a task past the backlog/ready stage (status: ${existing.status})`,
      );
    }

    app.db.delete(tasks).where(eq(tasks.id, taskId)).run();
    reply.code(204);
  });

  // Phase 6 (6.2/#215) — thin wrapper over task-claim.ts's shared
  // orchestration (also used by task-watcher.ts's auto-claim sweep), which
  // owns the reservation-first/concurrency-cap/agent-resolution/seed logic.
  // This handler's only job is mapping ClaimTaskOutcome to an HTTP
  // response.
  //
  // Task-Master-enabled-gated (independent review, PR #471; settings
  // override added by the Settings UI follow-up — see task-config.ts):
  // claiming spawns an agent — the roadmap's Flag semantics decision names
  // this endpoint explicitly as autonomous behavior the gate must cover,
  // unlike the local board's create/edit/drag routes above. Before this
  // check, a task created via the (deliberately un-gated) local board with
  // `status: "ready"` could reach claim with Task Master off — the exact
  // bypass the gate exists to prevent.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/claim", async (request, reply) => {
    if (!resolveTaskMasterConfig(app).enabled) {
      return reply.forbidden(
        "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
      );
    }
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");

    const outcome = await claimTask(app, taskId, { auto: false });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case "not-found":
          return reply.notFound();
        case "not-ready":
          return reply.conflict(outcome.detail ?? "Task is not ready");
        case "cap":
          return reply
            .code(429)
            .send({ error: "concurrency-cap", limit: outcome.limit, message: outcome.detail });
        case "worktree-failed":
          return reply.badGateway(outcome.detail ?? "Failed to create a worktree for this task");
        case "spawn-failed":
          return reply.badGateway(outcome.detail ?? "Failed to spawn a session for this task");
        case "no-seed-channel":
          return reply.badRequest(outcome.detail ?? "Resolved agent can't receive a seed prompt");
      }
    }

    reply.code(201);
    return { ...outcome.session, seedDelivered: outcome.seedDelivered };
  });

  // #483 — retries a "failed" task by resuming on its preserved branch
  // (task-claim.ts's retryTask). Same gate as claim: this leads to
  // spawning a session, genuinely new autonomous work the flag must cover.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request, reply) => {
    if (!resolveTaskMasterConfig(app).enabled) {
      return reply.forbidden(
        "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
      );
    }
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");

    const outcome = await retryTask(app, taskId);
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
  });

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

    const promotion = await promoteTaskToPR(app, existing, project);
    if (!promotion.ok) {
      switch (promotion.reason) {
        case "dirty-tree":
          return reply.conflict(promotion.detail ?? "Worktree has uncommitted changes");
        case "no-worktree":
          return reply.badGateway(promotion.detail ?? "Task has no worktree to promote");
        case "no-token":
          return reply.badRequest(promotion.detail ?? "No GitHub token connected");
        case "no-repo":
          return reply.badGateway(
            promotion.detail ?? "Could not resolve the project's GitHub repo",
          );
        case "push-failed":
          return reply.badGateway(promotion.detail ?? "Failed to push the task's branch");
        case "pr-create-failed":
          return reply.badGateway(promotion.detail ?? "Failed to create the pull request");
        case "remote-not-supported":
          return reply.code(501).send({ error: "remote-not-supported", message: promotion.detail });
      }
    }

    const [updated] = app.db
      .update(tasks)
      .set({
        status: "done",
        completedAt: new Date(),
        prUrl: promotion.prUrl,
        prNumber: promotion.prNumber,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "reviewing")))
      .returning()
      .all();
    if (!updated) {
      // Promotion already succeeded (branch pushed, PR opened) but the
      // task moved out of "reviewing" before this write — a concurrent
      // reject, most plausibly. The PR is real and left open; nothing to
      // roll back here (see task-promote.ts's own doc comment on the
      // narrower "PR already exists" retry case this is adjacent to).
      return reply.conflict(
        `Task was no longer in reviewing by the time this ran — a PR was opened at ${promotion.prUrl} but the task's status was not updated`,
      );
    }
    recordTaskTransition(app, {
      taskId,
      projectId: project.id,
      from: "reviewing",
      to: "done",
      via: "approve",
      context: { prUrl: promotion.prUrl },
    });
    // Deliberately NOT awaited (Hermes review, PR #474) — syncTaskTransition
    // never throws (every failure is caught and logged inside it), so
    // awaiting its GitHub round-trips here would only add latency for no
    // benefit. Fire-and-forget.
    void syncTaskTransition(app, updated, project, "done", { prUrl: updated.prUrl ?? undefined });
    cleanupTaskWorktree(app, updated, project);
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
        await reseedIfSessionExited(updated, project, request.body.feedback ?? null);
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
