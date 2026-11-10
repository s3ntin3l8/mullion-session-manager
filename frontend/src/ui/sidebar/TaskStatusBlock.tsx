import type { ReactNode } from "react";
import type { Task, TaskBlocker } from "../../api/types.js";
import { needsYouReason } from "../../github/taskMasterSummary.js";
import { formatRelativeAge } from "../../relativeTime.js";
import {
  TASK_STEPS,
  statusSince,
  taskNextStep,
  taskStatusBadge,
  taskStepIndex,
} from "../../taskStatusModel.js";
import { StatusChip } from "./StatusChip.js";

export interface TaskStatusBlockProps {
  task: Task;
  /** How a blocker reads inside the "Next:" sentence: a link that selects the
   * blocking task, say. Defaults to the plain "#N". */
  renderBlocker?: (blocker: TaskBlocker) => ReactNode;
  /** The task's actions (the primary one and its `⋯` menu): the GitHub
   * sidebar's PR and issue views put them in the strip; the Tasks sidebar's
   * detail keeps them in their own section below. */
  actions?: ReactNode;
  /** Shows "Open task →" (selects the task in the Tasks view). Omitted where
   * the task is already the thing on screen. */
  onOpenTask?: () => void;
}

/**
 * The status-first block of a task (epic #2847): the status badge, how long it
 * has been there, what waits on the user, a step tracker and one "Next:"
 * sentence. Takes a Task and renders it; it fetches nothing and holds no
 * state, so the Tasks sidebar's detail and the GitHub sidebar's PR view can
 * both render it.
 */
export function TaskStatusBlock({
  task,
  renderBlocker,
  actions,
  onOpenTask,
}: TaskStatusBlockProps) {
  const badge = taskStatusBadge(task);
  const since = statusSince(task);
  const sinceMs = since ? Date.parse(since) : NaN;
  const attention = needsYouReason(task);
  const step = taskStepIndex(task);
  const next = taskNextStep(task);
  return (
    <div className="sb-taskstatus" data-testid="task-status-block">
      <div className="sb-taskstatus-head">
        <StatusChip tone={badge.tone} className="sb-taskstatus-badge">
          {badge.label}
        </StatusChip>
        {Number.isFinite(sinceMs) && (
          <span className="sb-taskstatus-since">{formatRelativeAge(sinceMs)}</span>
        )}
        {attention && (
          <StatusChip tone="warn" className="sb-taskstatus-attn" title={attention}>
            {attention}
          </StatusChip>
        )}
      </div>
      {step !== null && (
        <ol className="sb-steps" aria-label="Progress">
          {TASK_STEPS.map((name, i) => (
            <li
              key={name}
              className={`sb-step${i < step ? " sb-step--done" : i === step ? " sb-step--current" : ""}`}
              aria-current={i === step ? "step" : undefined}
            >
              <span className="sb-step-mark" aria-hidden="true">
                {i < step ? "✓" : i === step ? "●" : "○"}
              </span>
              <span className="sb-step-name">{name}</span>
            </li>
          ))}
        </ol>
      )}
      {next.lead && (
        <p className="sb-taskstatus-next">
          <b>Next:</b> {next.lead}
          {next.blocker && (
            <>
              {" "}
              {renderBlocker ? renderBlocker(next.blocker) : `#${next.blocker.number}`}
              {next.tail && ` ${next.tail}`}
            </>
          )}
        </p>
      )}
      {(actions || onOpenTask) && (
        <div className="sb-taskstatus-actions">
          {actions}
          {onOpenTask && (
            <button type="button" className="sb-link sb-taskstatus-open" onClick={onOpenTask}>
              Open task →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
