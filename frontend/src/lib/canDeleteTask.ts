import type { Task } from "../api/types.js";

/**
 * Mirrors routes/tasks.ts's DELETE restriction (and #746/#1014): a local task
 * in backlog/ready/done/failed, or a GitHub-linked one once failed/done. The
 * server stays the authority; this only decides whether to offer the button.
 * Shared by the retired TaskDetail view and the sidebar task detail.
 */
export function canDeleteTask(task: Pick<Task, "issueNumber" | "status">): boolean {
  if (task.issueNumber === null)
    return (
      task.status === "backlog" ||
      task.status === "ready" ||
      task.status === "done" ||
      task.status === "failed"
    );
  return task.status === "failed" || task.status === "done";
}
