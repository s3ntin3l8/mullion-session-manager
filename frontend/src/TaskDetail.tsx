import { useState } from "react";
import { useDashboardStore } from "./store.js";
import { statusLabel } from "./tasksBoard.js";
import { SessionTimeline } from "./SessionTimeline.js";
import { ApiError } from "./api.js";
import type { Session, Task } from "./api.js";
import { commandToBinary } from "./cliLogos.js";
import { BotIcon, GitHubIcon, TerminalPromptIcon, WarningTriangleIcon } from "./icons.js";
import { formatRelativeAge } from "./relativeTime.js";

export interface TaskDetailParams {
  taskId: number;
}

// Phase 6 (6.5/#218) — the task board's detail panel: metadata, issue/PR
// links, Claim/Approve/Reject (GateActions idiom, NotificationBell.tsx's own
// precedent — no optimistic local state, the next tasks poll reconciles),
// and the worker session's embedded timeline. Reads straight off the store
// (same posture as SessionTimeline itself) rather than fetching its own
// copy, so it stays live as refreshTasks/refreshSessions tick.
export function TaskDetail({
  params,
  onOpenSession,
}: {
  params: TaskDetailParams;
  onOpenSession: (session: Session) => void;
}) {
  const task = useDashboardStore((s) => s.tasks.find((t) => t.id === params.taskId));
  const sessions = useDashboardStore((s) => s.sessions);

  if (!task) {
    return <div className="github-panel-empty">Task not found.</div>;
  }

  const workerSession =
    task.sessionId !== null ? sessions.find((s) => s.id === task.sessionId) : undefined;
  const agentName = task.agentCommand ? commandToBinary(task.agentCommand) : null;

  return (
    <div className="task-detail cmux-scroll">
      <div className="task-detail-header">
        <span className="task-detail-title">{task.title}</span>
        <span className={`task-status-badge task-status-${task.status}`}>
          {statusLabel(task.status)}
        </span>
      </div>

      <div className="task-detail-meta">
        <span className="task-detail-meta-row">{task.projectName}</span>
        {task.issueNumber !== null && task.htmlUrl && (
          <a
            className="task-detail-meta-row task-detail-link"
            href={task.htmlUrl}
            target="_blank"
            rel="noreferrer"
          >
            <GitHubIcon size={12} /> Issue #{task.issueNumber}
          </a>
        )}
        {task.prUrl && (
          <a
            className="task-detail-meta-row task-detail-link"
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            <GitHubIcon size={12} /> Pull request
          </a>
        )}
        {agentName && (
          <span className="task-detail-meta-row">
            <BotIcon size={12} /> Agent: {agentName}
          </span>
        )}
        {task.assignee && <span className="task-detail-meta-row">Assignee: {task.assignee}</span>}
        {workerSession && (
          <button
            className="task-detail-meta-row task-detail-link task-detail-open-session"
            onClick={() => onOpenSession(workerSession)}
          >
            <TerminalPromptIcon size={12} /> Open session
          </button>
        )}
      </div>

      {task.body && <div className="task-detail-body">{task.body}</div>}

      {task.status === "failed" && task.failureReason && (
        <div className="task-detail-failure">
          <WarningTriangleIcon size={12} />
          {task.failureReason}
        </div>
      )}

      <TaskActions task={task} onOpenSession={onOpenSession} />

      <div className="task-detail-section">
        <div className="task-detail-section-title">Timeline</div>
        <SessionTimeline params={{ sessionIds: task.sessionId !== null ? [task.sessionId] : [] }} />
      </div>

      {task.reviewSessionId !== null && (
        <div className="task-detail-section task-detail-review-section">
          <div className="task-detail-section-title">Review (advisory)</div>
          <div className="task-detail-review-hint">
            An advisory review agent's own findings — it cannot approve, reject, or otherwise
            transition this task; that's still your call above.
          </div>
          <SessionTimeline params={{ sessionIds: [task.reviewSessionId] }} />
        </div>
      )}

      <div className="task-detail-footer">
        Created {formatRelativeAge(new Date(task.createdAt).getTime())}
        {task.claimedAt && <> · Claimed {formatRelativeAge(new Date(task.claimedAt).getTime())}</>}
        {task.completedAt && (
          <> · Completed {formatRelativeAge(new Date(task.completedAt).getTime())}</>
        )}
      </div>
    </div>
  );
}

// GateActions' own pattern (NotificationBell.tsx) — no optimistic state; the
// button just fires the request and the next tasks poll reflects whatever
// actually happened. Claim/Approve/Reject are disabled with a hint when
// taskMasterEnabled is off (the roadmap's Flag semantics decision: these
// spawn/promote autonomous agents, unlike the local board's own CRUD).
function TaskActions({
  task,
  onOpenSession,
}: {
  task: Task;
  onOpenSession: (session: Session) => void;
}) {
  const { taskMasterEnabled, claimTask, approveTask, rejectTask } = useDashboardStore();
  const [submitting, setSubmitting] = useState(false);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const disabledHint = !taskMasterEnabled
    ? "Task Master is disabled — enable it to use this action."
    : null;

  if (task.status === "ready") {
    return (
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              const session = await claimTask(task.id);
              onOpenSession(session);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Failed to claim task");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Claim
        </button>
        {disabledHint && <span className="task-detail-hint">{disabledHint}</span>}
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  if (task.status !== "reviewing") return null;

  if (denying) {
    return (
      <div className="task-detail-actions">
        <input
          className="notif-gate-deny-reason"
          placeholder="Feedback (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
        <button
          className="notif-gate-btn notif-gate-deny-confirm"
          disabled={submitting || !taskMasterEnabled}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              await rejectTask(task.id, reason.trim() || undefined);
              setDenying(false);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Failed to reject task");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Reject
        </button>
        <button className="notif-gate-btn" disabled={submitting} onClick={() => setDenying(false)}>
          Cancel
        </button>
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="task-detail-actions">
      <button
        className="notif-gate-btn notif-gate-approve"
        disabled={submitting || !taskMasterEnabled}
        onClick={async () => {
          setSubmitting(true);
          setError(null);
          try {
            await approveTask(task.id);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Failed to approve task");
          } finally {
            setSubmitting(false);
          }
        }}
      >
        Approve
      </button>
      <button
        className="notif-gate-btn notif-gate-deny"
        disabled={submitting || !taskMasterEnabled}
        onClick={() => setDenying(true)}
      >
        Reject
      </button>
      {disabledHint && <span className="task-detail-hint">{disabledHint}</span>}
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
}
