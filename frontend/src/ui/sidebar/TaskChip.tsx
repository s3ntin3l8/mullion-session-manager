import type { Task } from "../../api/types.js";
import type { SessionLink } from "../../hooks/useMullionLinks.js";
import { STATUS_PRESENTATION } from "../../sessionStatus.js";
import { useDashboardStore } from "../../store/index.js";
import { BotIcon } from "../icons.js";
import { StatusChip } from "./StatusChip.js";
import { severityTone, splitTaskSessions, taskActiveSession, taskTone } from "./linkDecisions.js";

export interface TaskChipProps {
  task: Pick<Task, "id" | "status"> & Partial<Pick<Task, "sessionId" | "reviewSessionId">>;
  /** Branch is owned by this task: shows the lock variant. */
  locked?: boolean;
  /** The row's sessions; the task's own worker/reviewer among them drives the live dot. */
  sessions?: readonly SessionLink[];
  /** A review run is in flight: while `reviewing`, the dot tracks the reviewer. */
  reviewInFlight?: boolean;
  /** Override for tests / hosts that own task opening. */
  onOpen?: (taskId: number) => void;
}

/**
 * Task chip: a bot badge marks it as a Task Master task (not a hand-started
 * session), the status keeps its tone, and a dot shows the task's active
 * session. The lock variant says "owned by task #N" up front. A click opens the
 * task's detail panel through the store's requestOpenTask (the sidebar has no
 * dockview API of its own; see useOpenTaskRequest.ts).
 */
export function TaskChip({ task, locked, sessions, reviewInFlight, onOpen }: TaskChipProps) {
  const requestOpenTask = useDashboardStore((s) => s.requestOpenTask);
  const open = onOpen ?? requestOpenTask;
  const active = sessions
    ? taskActiveSession(task, splitTaskSessions(sessions, task).owned, reviewInFlight)
    : null;
  const label = `${locked ? "🔒 " : ""}#${task.id} · ${task.status}`;
  const base = locked
    ? `Owned by task #${task.id} — can't be deleted here; open task`
    : `Task #${task.id} — open task`;
  return (
    <StatusChip
      tone={taskTone(task.status)}
      className="sb-chip--task"
      title={
        active
          ? `${base} (${STATUS_PRESENTATION[active.session.sessionStatus].label} session)`
          : base
      }
      onClick={() => open(task.id)}
    >
      <BotIcon size={11} aria-hidden="true" />
      {label}
      {active && (
        <span
          className={`sb-task-dot sb-task-dot--${severityTone(active.severity)}`}
          data-testid="task-session-dot"
          aria-hidden="true"
        />
      )}
    </StatusChip>
  );
}
