import { useState } from "react";
import { ApiError } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";

// #1015 (archive) — no confirm step, unlike a delete: archiving is reversible
// (Unarchive clears only archivedAt, see api/tasks.ts's own doc comment).
// Rendered by TaskActions for done/failed tasks only, the same restriction as
// the server (routes/tasks.ts's POST/DELETE /api/tasks/:id/archive): archiving
// an in_progress/reviewing task would hide it while its worker still runs.
export function ArchiveTaskAction({
  taskId,
  archivedAt,
}: {
  taskId: number;
  archivedAt: string | null;
}) {
  const archiveTask = useDashboardStore((s) => s.archiveTask);
  const unarchiveTask = useDashboardStore((s) => s.unarchiveTask);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (archivedAt !== null) await unarchiveTask(taskId);
      else await archiveTask(taskId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update archive state");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button className="notif-gate-btn" disabled={submitting} onClick={run}>
        {archivedAt !== null ? "Unarchive" : "Archive"}
      </button>
      {error && <span className="task-detail-error">{error}</span>}
    </>
  );
}
