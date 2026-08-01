import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { createSessionRecord, withLiveStatus } from "./sessions.js";
import { resolveBackend } from "../services/session-backend.js";
import { resolveDefaultBaseRef } from "../services/git-refs.js";
import { getStoredSettings } from "../services/settings.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";

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
export async function tasksRoute(app: FastifyInstance) {
  app.get("/api/tasks", async () => {
    const rows = app.db
      .select({
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
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      // boardOrder is the render/ordering tier (roadmap's Task Model &
      // Task Board section) — order by it within each status so the board
      // has a deterministic render order instead of arbitrary insertion
      // order (Hermes review, PR #471).
      .orderBy(tasks.status, tasks.boardOrder, tasks.createdAt)
      .all();
    return rows;
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

  // Phase 2.5, 2.5.2 (issue #216) — the thin slice's agent spawner. Claiming
  // a ready task: resolves origin/<default> as the base ref (no human
  // present to pick one, unlike the interactive worktree toggle's picker —
  // see the roadmap's "branch from origin/<default> for the autonomous
  // case" rule), creates an isolated worktree there, spawns the project's
  // default agent in it, and stashes the issue title+body as that new
  // session's seed prompt (issue #271's SessionStart-hook delivery — the
  // same mechanism the promote flow already uses, not a new one). Reuses
  // sessions.ts's createSessionRecord rather than reimplementing
  // worktree-then-spawn-then-rollback.
  //
  // Gate is "ready" (6.9/#233, Hermes review PR #471) — not "pending".
  // Once this PR remaps existing rows to backlog/ready and the watcher
  // stops producing "pending" at all, "pending" is a status nothing can
  // ever reach; gating on it would make claim permanently unreachable.
  //
  // Local-host projects only for this slice — worktree/spawn on a remote
  // agent is Phase 6's 6.8 worktree lifecycle proxy.
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

    const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (!task) return reply.notFound();
    if (task.status !== "ready") {
      return reply.conflict(`Task is not ready (status: ${task.status})`);
    }

    const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
    if (!project) return reply.notFound();
    if (project.hostId !== LOCAL_HOST_ID) {
      return reply.badRequest(
        "Claiming a task on a remote-hosted project isn't supported yet (Phase 6's 6.8)",
      );
    }

    const baseRef = await resolveDefaultBaseRef(project.cwd);
    const command = getStoredSettings(app.db).launchers.defaultAgent;
    // Derived from task.id, not task.issueNumber (Hermes review, PR #471):
    // issueNumber is nullable now (6.9), and every local task shares the
    // same NULL — branching on it would collide every local task onto
    // `mullion/task-null`, refusing every claim after the first. task.id
    // is always present and unique, and still stable/readable.
    const branchName = `mullion/task-${task.id}`;

    const result = await createSessionRecord(app, {
      projectId: project.id,
      command,
      worktree: { baseRef, branchName },
    });
    if (!result.ok) {
      if (result.reason === "worktree-failed") {
        // The deterministic branch name means a concurrent claim for the
        // SAME task collides here first, before ever reaching the
        // optimistic-lock UPDATE below (`git worktree add -b` refuses to
        // reuse a branch name a sibling request's worktree creation
        // already claimed) — surface that as the same 409 a same-task
        // double-claim gets elsewhere, not a misleading 502.
        const [current] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
        if (current && current.status !== "ready") {
          return reply.conflict("Task was already claimed by a concurrent request");
        }
        return reply.badGateway("Failed to create a worktree for this task");
      }
      if (result.reason === "unknown-project") return reply.notFound();
      return reply.badGateway("Failed to spawn a session for this task");
    }

    // Best-effort: only Claude Code sessions (the default agent) actually
    // consume a stashed seed via their SessionStart hook — see pty-manager.ts's
    // stashSeed()/consumeSeed(). A session spawned with a different command
    // just never picks it up; nothing here depends on that succeeding.
    const prompt = task.body ? `${task.title}\n\n${task.body}` : task.title;
    await resolveBackend(app, project.hostId).stashSeed(String(result.row.id), prompt);

    // Optimistic lock (Hermes review, PR #280): the SELECT/status check above
    // and this UPDATE straddle an async gap (worktree creation + spawn), so
    // two concurrent claims for the same task can both pass the earlier
    // guard. Re-checking status="ready" here makes only the first UPDATE to
    // actually land win; a second, now-losing request's UPDATE affects zero
    // rows and its spawned session is terminated rather than left orphaned
    // and unreferenced by any task. Its worktree is left on disk — removal
    // isn't wired up anywhere yet (worktree lifecycle cleanup is Phase 6's
    // 6.8), so this is the same "leave it for manual cleanup" posture every
    // other worktree operation in this codebase already has.
    const updated = app.db
      .update(tasks)
      .set({
        status: "claimed",
        sessionId: result.row.id,
        claimedAt: new Date(),
        worktreePath: result.row.cwd,
        branchName,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "ready")))
      .run();
    if (updated.changes === 0) {
      await resolveBackend(app, project.hostId).terminate(String(result.row.id));
      return reply.conflict("Task was already claimed by a concurrent request");
    }

    reply.code(201);
    const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
    return withLiveStatus(app, result.row, idleThresholdMs, project.hostId);
  });
}
