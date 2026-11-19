import { useState } from "react";
import { ApiError } from "./api/index.js";
import type { Task } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { parseWorkflowChange } from "./workflowChange.js";

// A branch that edits `.github/workflows/` is held, not pushed, until the
// operator approves this exact head commit (backend task-workflow-gate.ts).
// Shows the files so the approval is informed; the sha rides along so the
// server can refuse if the branch moved after this was rendered.
export function WorkflowChangeApproval({ task }: { task: Task }) {
  const { taskMasterEnabled, approveWorkflowChange, refreshTasks } = useDashboardStore();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = parseWorkflowChange(task.workflowChange);
  if (!change) return null;

  return (
    <div className="task-detail-workflow-change" role="group" aria-label="Workflow change">
      <div className="task-detail-workflow-change-title">
        This branch edits CI workflows — approval needed before it is pushed
      </div>
      <ul className="task-detail-workflow-change-files">
        {change.files.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
      </ul>
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled || change.sha === ""}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await approveWorkflowChange(task.id, change.sha);
            } catch (err) {
              // A stale approval can clear a hold that no longer applies or
              // replace it with a new head. Refresh before showing an error so
              // an obsolete panel doesn't leave the next action hidden.
              if (err instanceof ApiError && err.statusCode === 409) await refreshTasks();
              setError(
                err instanceof ApiError ? err.message : "Failed to approve the workflow change",
              );
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Approve workflow change
        </button>
        {change.sha === "" && (
          <span className="task-detail-hint">
            The head commit could not be read, so this cannot be approved yet.
          </span>
        )}
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    </div>
  );
}
