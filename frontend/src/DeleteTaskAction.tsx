import { useState } from "react";
import { ApiError } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";

// Independent review, PR #477 — a "click again to confirm" step, same
// GateActions/notif-gate-* idiom as TaskActions below (not ConfirmButton.tsx,
// which is styled for its own specific parent contexts, e.g.
// .ws-group-actions .danger — dropping it in bare here would render
// unstyled). On success it calls `onDeleted` so the host closes the panel;
// a host that passes none (or a task that vanishes for any other reason)
// falls through to TaskDetail's own `if (!task)` guard, which renders
// "Task not found." — the no-optimistic-state posture the rest of this file
// follows.
export function DeleteTaskAction({
  taskId,
  isDone,
  isGithubLinked,
  branchName,
  worktreePath,
  onDeleted,
}: {
  taskId: number;
  isDone: boolean;
  isGithubLinked: boolean;
  branchName: string | null;
  worktreePath: string | null;
  onDeleted?: () => void;
}) {
  const deleteTask = useDashboardStore((s) => s.deleteTask);
  // #1014 (Abandon), review fix — the label name is configurable
  // (MULLION_TASK_LABEL, env.ts), not always literally "mullion-task". This
  // is the same value TaskMasterSection.tsx's own Settings display reads.
  const taskMasterEnv = useDashboardStore((s) => s.taskMasterEnv);
  const taskLabel = taskMasterEnv?.issueLabel ?? "mullion-task";
  const [confirming, setConfirming] = useState(false);
  // #1014 (Abandon) — set once a plain delete 409s, per api/client.ts's own
  // guidance to branch on statusCode rather than the message text. Once
  // true, the confirm step below switches to naming exactly what a
  // force-delete destroys and re-issues with force: true. Mirrors the
  // Hosts cascade-delete flow (HostsSection.tsx's cascadePrompt state).
  const [needsForce, setNeedsForce] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Review fix — Cancel must also drop needsForce, or reopening this panel
  // skips straight to the Abandon/force prompt even if whatever triggered
  // the earlier 409 (a still-tracked issue, a since-resolved race) no
  // longer holds. A fresh open should always try the plain delete again
  // first.
  function cancel() {
    setConfirming(false);
    setNeedsForce(false);
    setError(null);
  }

  if (!confirming) {
    return (
      <div className="task-detail-actions task-detail-actions-delete">
        <button className="notif-gate-btn notif-gate-deny" onClick={() => setConfirming(true)}>
          Delete task
        </button>
      </div>
    );
  }

  // #746 — a done task's local row is the only thing this removes: the
  // closed issue and its PR stay on GitHub (whatever state that PR is in —
  // approveTask sets prNumber/prUrl unconditionally, but only requests a
  // merge when the project has mergeOnApprove on, default off, and even
  // then the merge sweep is async/best-effort, so "done" does not imply
  // "merged"), and cleanupTaskWorktree already removed the worktree
  // directory at approve time — the branch itself is untouched (see the
  // DELETE route's own doc comment on why that's true for the
  // GitHub-linked case).
  //
  // #1014 — once a plain delete has 409'd, the hint switches to naming
  // exactly what a force-delete (Abandon) destroys: the GitHub label (only
  // for a linked task), the worktree, the branch, and any live sessions.
  const hint = needsForce
    ? [
        "This task can't be deleted normally.",
        isGithubLinked
          ? `Abandoning it removes the ${taskLabel} label from the linked issue,`
          : "Abandoning it",
        worktreePath ? `deletes its worktree (${worktreePath}),` : null,
        branchName ? `deletes its branch (${branchName}),` : null,
        "and kills any of its sessions still running. This can't be undone.",
      ]
        .filter(Boolean)
        .join(" ")
    : isDone && isGithubLinked
      ? "Delete this task? The closed issue and its PR stay on GitHub, and the branch is untouched. This can't be undone."
      : isDone
        ? "Delete this task? The branch is untouched. This can't be undone."
        : "Delete this task? This can't be undone.";

  // The buttons keep the right-aligned slot "Delete task" occupied (same
  // wrapper class), and the hint/error go in a following full-width sibling so
  // a long hint wraps on its own line instead of pushing the buttons around
  // the action row.
  return (
    <>
      <div className="task-detail-actions task-detail-actions-delete">
        <button className="notif-gate-btn" disabled={submitting} onClick={cancel}>
          Cancel
        </button>
        <button
          className="notif-gate-btn notif-gate-deny-confirm"
          disabled={submitting}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              if (needsForce) await deleteTask(taskId, { force: true });
              else await deleteTask(taskId);
              onDeleted?.();
            } catch (err) {
              if (!needsForce && err instanceof ApiError && err.statusCode === 409) {
                setNeedsForce(true);
                setSubmitting(false);
                return;
              }
              setError(err instanceof ApiError ? err.message : "Failed to delete task");
              setSubmitting(false);
            }
          }}
        >
          {needsForce ? "Abandon task" : "Confirm delete"}
        </button>
      </div>
      <div className="task-detail-actions-note">
        <span className="task-detail-hint">{hint}</span>
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    </>
  );
}
