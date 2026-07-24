import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";

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
}
