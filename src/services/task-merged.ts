import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { tasks, type projects } from "../db/schema.js";
import { broadcastTaskEvent } from "./task-events.js";
import { cleanupMergedTaskBranch } from "./task-approve.js";

// #1015 (archive) — called only where the caller has already confirmed
// `pr.merged` is true (never on a PR closed WITHOUT merging — see this
// function's two call sites' own comments on why that distinction matters).
// Every task reaching attemptMerge came from processMergeRequests' own
// `status = "done"` sweep candidate query, so archivedAt is set
// unconditionally here — unlike the `pull_request` webhook handler
// (routes/webhooks.ts), which can observe a merge before the task has left
// "reviewing" and must check status itself. `isNull(tasks.mergedAt)` makes
// this idempotent against attemptMerge's own retry/backoff behavior. Returns
// whether this call won the write — and so now owns the task's worktree and
// branch cleanup (callers must not start a second worktree removal).
export function markTaskMerged(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  mergedAt: Date = new Date(),
): boolean {
  const { changes } = app.db
    .update(tasks)
    .set({ mergedAt, archivedAt: new Date() })
    .where(and(eq(tasks.id, task.id), isNull(tasks.mergedAt)))
    .run();
  if (changes === 0) return false;
  // The board's "PR open — needs merge" badge clears off this write, so tell
  // it to refetch ("ingested" is the generic refetch kind).
  notifyTaskMerged(app, task.id);
  // Only the pass that won the write cleans up, so a webhook and a sweep
  // observing the same merge don't both run it.
  cleanupMergedTaskBranch(app, task, project);
  return true;
}

export function notifyTaskMerged(app: FastifyInstance, taskId: number): void {
  const row = app.db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (row)
    broadcastTaskEvent({ taskId, projectId: row.projectId, kind: "ingested", ts: Date.now() });
}
