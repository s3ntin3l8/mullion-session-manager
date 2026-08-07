import { useEffect, useState } from "react";
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
// links, Claim/Approve/Reject/Retry/Give up (GateActions idiom,
// NotificationBell.tsx's own precedent — no optimistic local state, the
// next tasks poll reconciles), and the worker session's embedded timeline.
// Reads straight off the store (same posture as SessionTimeline itself)
// rather than fetching its own copy, so it stays live as
// refreshTasks/refreshSessions tick.
export function TaskDetail({
  params,
  onOpenSession,
}: {
  params: TaskDetailParams;
  onOpenSession: (session: Session) => void;
}) {
  const task = useDashboardStore((s) => s.tasks.find((t) => t.id === params.taskId));
  const sessions = useDashboardStore((s) => s.sessions);
  const refreshTasks = useDashboardStore((s) => s.refreshTasks);

  // A workspace layout can restore this panel (by taskId) before the
  // store's own task list has loaded — same "poll the full list, don't
  // fetch a single row" convention TasksPanel.tsx's own mount effect
  // follows, rather than a separate single-task fetch that'd duplicate
  // Task's shape in local component state.
  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

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

      {/* Independent review, PR #477 — mirrors routes/tasks.ts's own DELETE
          restriction exactly (no linked GitHub issue, status still
          backlog/ready): a locally-created task that turns out to be a
          mistake previously had no way to be removed anywhere in the UI at
          all. Local-board CRUD, so unlike Claim/Approve/Reject this isn't
          gated on taskMasterEnabled. */}
      {task.issueNumber === null && (task.status === "backlog" || task.status === "ready") && (
        <DeleteTaskAction taskId={task.id} />
      )}

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

      {/* #485 — independent of status: a task can be happily in_progress
          while its GitHub sync is silently broken (e.g. an under-scoped
          token). Previously invisible outside a server-log grep; this is
          durable across remounts, unlike TaskActions' own transient
          setError. */}
      {task.githubSyncError && (
        <div className="task-detail-sync-error">
          <GitHubIcon size={12} />
          GitHub sync: {task.githubSyncError}
        </div>
      )}

      <TaskActions task={task} onOpenSession={onOpenSession} />

      <div className="task-detail-section">
        <div className="task-detail-section-title">Timeline</div>
        {task.seedDelivered === false && (
          <div className="task-detail-noseed">
            <WarningTriangleIcon size={12} />
            This agent can&apos;t receive an initial prompt — it started with no instructions.
          </div>
        )}
        <SessionTimeline params={{ sessionIds: task.sessionId !== null ? [task.sessionId] : [] }} />
      </div>

      {task.reviewSessionId !== null && (
        <div className="task-detail-section task-detail-review-section">
          <div className="task-detail-section-title">Review (advisory)</div>
          <div className="task-detail-review-hint">
            An advisory review agent's own findings — it cannot approve, reject, or otherwise
            transition this task; that's still your call above.
          </div>
          {task.reviewSeedDelivered === false && (
            <div className="task-detail-review-noseed">
              <WarningTriangleIcon size={12} />
              This agent can&apos;t receive an initial prompt — it started with no instructions.
            </div>
          )}
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

// Independent review, PR #477 — a "click again to confirm" step, same
// GateActions/notif-gate-* idiom as TaskActions below (not ConfirmButton.tsx,
// which is styled for its own specific parent contexts, e.g.
// .ws-group-actions .danger — dropping it in bare here would render
// unstyled). No explicit "close this panel" on success: once the store's
// task list no longer contains this id, TaskDetail's own `if (!task)` guard
// above already renders "Task not found." — the same no-optimistic-state,
// let-the-poll-reconcile posture the rest of this file follows.
function DeleteTaskAction({ taskId }: { taskId: number }) {
  const deleteTask = useDashboardStore((s) => s.deleteTask);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <div className="task-detail-actions">
        <button className="notif-gate-btn notif-gate-deny" onClick={() => setConfirming(true)}>
          Delete task
        </button>
      </div>
    );
  }

  return (
    <div className="task-detail-actions">
      <span className="task-detail-hint">Delete this task? This can't be undone.</span>
      <button
        className="notif-gate-btn notif-gate-deny-confirm"
        disabled={submitting}
        onClick={async () => {
          setSubmitting(true);
          setError(null);
          try {
            await deleteTask(taskId);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Failed to delete task");
            setSubmitting(false);
          }
        }}
      >
        Confirm delete
      </button>
      <button className="notif-gate-btn" disabled={submitting} onClick={() => setConfirming(false)}>
        Cancel
      </button>
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
}

// GateActions' own pattern (NotificationBell.tsx) — no optimistic state; the
// button just fires the request and the next tasks poll reflects whatever
// actually happened. Claim/Approve/Retry are disabled with a hint when
// taskMasterEnabled is off (the roadmap's Flag semantics decision: these
// spawn/promote autonomous agents, unlike the local board's own CRUD).
// Reject and Give up are deliberately NOT gated here (Hermes review, PR
// #480, fourth pass; extended to give-up by #483), mirroring the server
// routes: they're the only ways to resolve a task that's already in
// "reviewing" when the toggle flips off — disabling them client-side would
// hide the escape hatches the server still allows.
function TaskActions({
  task,
  onOpenSession,
}: {
  task: Task;
  onOpenSession: (session: Session) => void;
}) {
  const { taskMasterEnabled, claimTask, approveTask, rejectTask, retryTask, giveUpTask } =
    useDashboardStore();
  const [submitting, setSubmitting] = useState(false);
  // Which free-text-reason-then-confirm flow is open, if any — reject and
  // give-up share the same input/confirm/cancel shape, so one bit of state
  // (not two independent booleans) tracks which action a confirm click
  // resolves to.
  const [pendingAction, setPendingAction] = useState<"reject" | "give-up" | null>(null);
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

  // #483 — resumes on the preserved mullion/task-<id> branch rather than
  // starting over. Gated like Claim, since it also spawns a session.
  if (task.status === "failed") {
    return (
      <div className="task-detail-actions">
        <button
          className="notif-gate-btn notif-gate-approve"
          disabled={submitting || !taskMasterEnabled}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              const session = await retryTask(task.id);
              onOpenSession(session);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Failed to retry task");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Retry
        </button>
        {disabledHint && <span className="task-detail-hint">{disabledHint}</span>}
        {error && <span className="task-detail-error">{error}</span>}
      </div>
    );
  }

  if (task.status !== "reviewing") return null;

  if (pendingAction !== null) {
    const isGiveUp = pendingAction === "give-up";
    return (
      <div className="task-detail-actions">
        <input
          className="notif-gate-deny-reason"
          placeholder={isGiveUp ? "Reason (optional)" : "Feedback (optional)"}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
        <button
          className="notif-gate-btn notif-gate-deny-confirm"
          disabled={submitting}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            try {
              if (isGiveUp) {
                await giveUpTask(task.id, reason.trim() || undefined);
              } else {
                await rejectTask(task.id, reason.trim() || undefined);
              }
              setPendingAction(null);
            } catch (err) {
              setError(
                err instanceof ApiError
                  ? err.message
                  : `Failed to ${isGiveUp ? "give up on" : "reject"} task`,
              );
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {isGiveUp ? "Give up" : "Reject"}
        </button>
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={() => setPendingAction(null)}
        >
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
        disabled={submitting}
        onClick={() => setPendingAction("reject")}
      >
        Reject
      </button>
      <button
        className="notif-gate-btn notif-gate-deny"
        disabled={submitting}
        onClick={() => setPendingAction("give-up")}
      >
        Give up
      </button>
      {disabledHint && (
        <span className="task-detail-hint">
          {disabledHint} Reject/Give up still work — they're the escape hatches out of review while
          disabled.
        </span>
      )}
      {error && <span className="task-detail-error">{error}</span>}
    </div>
  );
}
