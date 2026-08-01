import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, sessions, tasks, TASK_STATUSES } from "../db/schema.js";
import { claimTask } from "../services/task-claim.js";
import { canTransition } from "../services/task-state.js";
import { syncTaskTransition } from "../services/task-github-sync.js";
import { promoteTaskToPR } from "../services/task-promote.js";
import { commandSupportsSeed } from "../services/task-agent-resolve.js";
import { resolveBackend } from "../services/session-backend.js";
// Route-to-route import, not the services-don't-import-routes exception
// documented elsewhere (task-claim.ts, task-reconciler.ts) — createSessionRecord
// already lives in this same routes/ layer.
import { createSessionRecord } from "./sessions.js";

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
// the sidebar's Tasks section. Always registered, regardless of
// MULLION_TASK_MASTER_ENABLED, so the frontend's flag gate (server-info's
// taskMasterEnabled) is the single source of truth for whether the UI shows
// up — this route just naturally returns [] when the watcher plugin never
// ran (see plugins/task-watcher.ts).
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
  reviewSessionId: tasks.reviewSessionId,
  worktreePath: tasks.worktreePath,
  branchName: tasks.branchName,
  agentCommand: tasks.agentCommand,
  prUrl: tasks.prUrl,
  assignee: tasks.assignee,
  failureReason: tasks.failureReason,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  claimedAt: tasks.claimedAt,
  startedAt: tasks.startedAt,
  reviewingAt: tasks.reviewingAt,
  completedAt: tasks.completedAt,
};

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
      return rows;
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
  // isn't, a fresh session is spawned in the SAME worktree (never a new
  // one — the branch and its commits are exactly what should be built on)
  // and seeded with the feedback, so a reject doesn't strand the task with
  // no agent attached to it. Only fires when the DB already knows the
  // session isn't "active" — a session that died moments ago and hasn't
  // been reconciled yet is left for a later reject/reconcile pass rather
  // than racing the reconciler here.
  async function reseedIfSessionExited(
    task: typeof tasks.$inferSelect,
    project: typeof projects.$inferSelect,
    feedback: string | null,
  ): Promise<void> {
    if (!task.sessionId || !task.worktreePath || !task.agentCommand) return;
    const [session] = app.db.select().from(sessions).where(eq(sessions.id, task.sessionId)).all();
    if (session && session.status === "active") return;

    const result = await createSessionRecord(app, {
      projectId: project.id,
      command: task.agentCommand,
      cwd: task.worktreePath,
    });
    if (!result.ok) {
      app.log.warn(
        { taskId: task.id, reason: result.reason },
        "task reject: re-seed spawn failed, worktree left as-is for a manual claim/retry",
      );
      return;
    }
    if (commandSupportsSeed(task.agentCommand)) {
      const prompt = feedback
        ? `This task was rejected with the following feedback — please address it:\n\n${feedback}`
        : "This task was rejected. Continue working on it.";
      await resolveBackend(app, project.hostId).stashSeed(String(result.row.id), prompt);
    }
    app.db.update(tasks).set({ sessionId: result.row.id }).where(eq(tasks.id, task.id)).run();
    app.log.info(
      { taskId: task.id, previousSessionId: task.sessionId, newSessionId: result.row.id },
      "task reject: re-seeded a fresh session in the same worktree (previous session had exited)",
    );
  }

  // Phase 6 (6.9/#233) — local-board creation, works with
  // MULLION_TASK_MASTER_ENABLED off. A task created here has no GitHub
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
  // MULLION_TASK_MASTER_ENABLED-gated (independent review, PR #471):
  // claiming spawns an agent — the roadmap's Flag semantics decision names
  // this endpoint explicitly as autonomous behavior the flag must gate,
  // unlike the local board's create/edit/drag routes above. Before this
  // check, a task created via the (deliberately un-gated) local board with
  // `status: "ready"` could reach claim with the flag off — the exact
  // bypass the flag exists to prevent.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/claim", async (request, reply) => {
    if (!app.config.MULLION_TASK_MASTER_ENABLED) {
      return reply.forbidden("Task Master is disabled (MULLION_TASK_MASTER_ENABLED=false)");
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
        case "remote-unsupported":
          return reply.badRequest(outcome.detail ?? "Remote-hosted claim isn't supported yet");
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
      }
    }

    const [updated] = app.db
      .update(tasks)
      .set({ status: "done", completedAt: new Date(), prUrl: promotion.prUrl })
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
    app.log.info(
      { taskId, from: "reviewing", to: "done", prUrl: promotion.prUrl },
      "task approve: transitioned",
    );
    // Deliberately NOT awaited (Hermes review, PR #474) — syncTaskTransition
    // never throws (every failure is caught and logged inside it), so
    // awaiting its GitHub round-trips here would only add latency for no
    // benefit. Fire-and-forget.
    void syncTaskTransition(app, updated, project, "done", { prUrl: updated.prUrl ?? undefined });
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
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "reviewing")))
        .returning()
        .all();
      if (!updated) return reply.conflict("Task was no longer in reviewing by the time this ran");
      app.log.info({ taskId, from: "reviewing", to: "in_progress" }, "task reject: transitioned");
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
}
