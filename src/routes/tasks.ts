import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, tasks, TASK_STATUSES } from "../db/schema.js";
import { claimTask } from "../services/task-claim.js";
import { canTransition } from "../services/task-state.js";
import { syncTaskTransition } from "../services/task-github-sync.js";

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

  // Phase 6 (6.2/#215) — approve/reject act on a task in "reviewing". In
  // this PR they only write the local transition (task-state.ts's own
  // canTransition table is the single source of truth for legality, so a
  // request against a task not in "reviewing" 409s here the same way it
  // would from any other illegal-transition attempt). 6.7 attaches PR
  // creation to approve and an issue comment to reject; this PR's job is
  // just the state machine being correct and enforced.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/approve", async (request, reply) => {
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
    const existing = getLocalTaskOr404(taskId);
    if (!existing) return reply.notFound();
    if (!canTransition(existing.status as (typeof TASK_STATUSES)[number], "done")) {
      return reply.conflict(`Cannot approve a task in status "${existing.status}"`);
    }
    const [updated] = app.db
      .update(tasks)
      .set({ status: "done", completedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "reviewing")))
      .returning()
      .all();
    if (!updated) return reply.conflict("Task was no longer in reviewing by the time this ran");
    app.log.info({ taskId, from: "reviewing", to: "done" }, "task approve: transitioned");
    // 6.7 (not yet landed) attaches push+PR creation before this write, so
    // `prUrl` is null here today — the sync still runs so the label swap
    // and issue close happen now; 6.7 just needs to create the PR before
    // this handler runs so `updated.prUrl` is populated by the time it does.
    const project = getProjectOr404(updated.projectId);
    if (project) {
      await syncTaskTransition(app, updated, project, "done", {
        prUrl: updated.prUrl ?? undefined,
      });
    }
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
        await syncTaskTransition(app, updated, project, "rejected", {
          feedback: request.body.feedback,
        });
      }
      return updated;
    },
  );
}
