import type { Task } from "../api/types.js";
import { useOpenTask } from "../hooks/useOpenTask.js";
import { useDashboardStore } from "../store/index.js";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import {
  CheckIcon,
  PlayTriangleIcon,
  RefreshIcon,
  RotateIcon,
  TerminalPromptIcon,
} from "../ui/icons.js";
import { IconButton } from "../ui/sidebar/IconButton.js";
import { useTaskActions } from "../useTaskActions.js";
import { parseWorkflowChange } from "../workflowChange.js";
import { taskReReviewEligible } from "./prNextStep.js";

const OFF_HINT = " — Task Master is off";

/**
 * A task's quick actions on a GitHub sidebar row (#2461), revealed on hover or
 * focus with the row's other `sb-row-actions`: Claim when ready, Retry when
 * failed, Approve / Re-review while reviewing, Open session while it runs.
 * The same handlers as the task panel's `TaskActions` (`useTaskActions`), and
 * the same gating: Claim, Retry and Approve need Task Master on; Approve is
 * left out while a workflow change holds the task.
 *
 * Takes the task's id, not a row's `{ id, status }` summary: the decisions
 * need the whole task (its session, its review state), so a task the store
 * has not loaded shows nothing rather than a guess.
 *
 * Approve is one tap from a list, so it arms first (#3011's precedent). The
 * one case a row can't host — a tracking epic's "close it anyway?" — opens
 * the task, whose detail asks.
 */
export function TaskRowActions({
  taskId,
  onError,
}: {
  taskId: number;
  /** Where an action's failure is shown: the row has no line of its own. */
  onError: (message: string | null) => void;
}) {
  const task = useDashboardStore((s) => s.tasks.find((t) => t.id === taskId));
  if (!task) return null;
  return <TaskRowButtons task={task} onError={onError} />;
}

function TaskRowButtons({
  task,
  onError,
}: {
  task: Task;
  onError: (message: string | null) => void;
}) {
  const tmOn = useDashboardStore((s) => s.taskMasterEnabled);
  const openTask = useOpenTask();
  const actions = useTaskActions(task, { onError });
  const busy = actions.submitting;
  const gated = busy || !tmOn;
  const hint = tmOn ? "" : OFF_HINT;

  switch (task.status) {
    case "ready":
      return (
        <IconButton label={`Claim task${hint}`} disabled={gated} onClick={() => void actions.claim()}>
          <PlayTriangleIcon size={14} />
        </IconButton>
      );
    case "failed":
      return (
        <IconButton label={`Retry task${hint}`} disabled={gated} onClick={() => void actions.retry()}>
          <RotateIcon size={14} />
        </IconButton>
      );
    case "reviewing":
      return (
        <>
          {taskReReviewEligible(task) && (
            <IconButton
              label="Re-review task"
              disabled={busy}
              onClick={() => void actions.reReview()}
            >
              <RefreshIcon size={14} />
            </IconButton>
          )}
          {!parseWorkflowChange(task.workflowChange) && (
            <ConfirmButton
              compact
              variant="neutral"
              title={`Approve task${hint}`}
              disabled={gated}
              onConfirm={() =>
                void actions.approve().then((outcome) => {
                  if (outcome !== "tracking-epic") return;
                  onError(
                    "This task tracks an epic with open sub-issues — confirm the approval in the task.",
                  );
                  openTask(task.id);
                })
              }
            >
              <CheckIcon size={13} />
            </ConfirmButton>
          )}
        </>
      );
    case "claimed":
    case "in_progress":
      // A retry waiting for its host has no session yet ("Start fresh" is the
      // task panel's call to make).
      return task.sessionId != null && !task.retryHostId ? (
        <IconButton
          label="Open session"
          onClick={() => useDashboardStore.getState().requestOpenSession(task.sessionId!)}
        >
          <TerminalPromptIcon size={14} />
        </IconButton>
      ) : null;
    default:
      return null;
  }
}
