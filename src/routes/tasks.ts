import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { createSessionRecord, withLiveStatus } from "./sessions.js";
import { resolveBackend } from "../services/session-backend.js";
import { resolveDefaultBaseRef } from "../services/git-refs.js";
import { getStoredSettings } from "../services/settings.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";

// Phase 2.5 Task Master, Thin Slice (issue #219/#227) — read endpoint for
// the sidebar's Tasks section. Always registered, regardless of
// MULLION_TASK_MASTER_ENABLED, so the frontend's flag gate (server-info's
// taskMasterEnabled) is the single source of truth for whether the UI shows
// up — this route just naturally returns [] when the watcher plugin never
// ran (see plugins/task-watcher.ts).
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
        sessionId: tasks.sessionId,
        createdAt: tasks.createdAt,
        claimedAt: tasks.claimedAt,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .all();
    return rows;
  });

  // Phase 2.5, 2.5.2 (issue #216) — the thin slice's agent spawner. Claiming
  // a pending task: resolves origin/<default> as the base ref (no human
  // present to pick one, unlike the interactive worktree toggle's picker —
  // see the roadmap's "branch from origin/<default> for the autonomous
  // case" rule), creates an isolated worktree there, spawns the project's
  // default agent in it, and stashes the issue title+body as that new
  // session's seed prompt (issue #271's SessionStart-hook delivery — the
  // same mechanism the promote flow already uses, not a new one). Reuses
  // sessions.ts's createSessionRecord rather than reimplementing
  // worktree-then-spawn-then-rollback.
  //
  // Local-host projects only for this slice — worktree/spawn on a remote
  // agent is Phase 6's 6.8 worktree lifecycle proxy.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/claim", async (request, reply) => {
    const taskId = Number(request.params.id);
    if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");

    const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (!task) return reply.notFound();
    if (task.status !== "pending") {
      return reply.conflict(`Task is not pending (status: ${task.status})`);
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

    const result = await createSessionRecord(app, {
      projectId: project.id,
      command,
      worktree: { baseRef, branchName: `mullion/task-${task.issueNumber}` },
    });
    if (!result.ok) {
      if (result.reason === "worktree-failed") {
        // The deterministic branch name (`mullion/task-<issueNumber>`) means
        // a concurrent claim for the SAME task collides here first, before
        // ever reaching the optimistic-lock UPDATE below (`git worktree add
        // -b` refuses to reuse a branch name a sibling request's worktree
        // creation already claimed) — surface that as the same 409 a
        // same-task double-claim gets elsewhere, not a misleading 502.
        const [current] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
        if (current && current.status !== "pending") {
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
    // guard. Re-checking status="pending" here makes only the first UPDATE to
    // actually land win; a second, now-losing request's UPDATE affects zero
    // rows and its spawned session is terminated rather than left orphaned
    // and unreferenced by any task. Its worktree is left on disk — removal
    // isn't wired up anywhere yet (worktree lifecycle cleanup is Phase 6's
    // 6.8), so this is the same "leave it for manual cleanup" posture every
    // other worktree operation in this codebase already has.
    const updated = app.db
      .update(tasks)
      .set({ status: "claimed", sessionId: result.row.id, claimedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "pending")))
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
