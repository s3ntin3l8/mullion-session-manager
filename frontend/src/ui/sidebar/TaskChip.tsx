import type { Task } from "../../api/types.js";
import { useDashboardStore } from "../../store/index.js";
import { StatusChip } from "./StatusChip.js";
import { taskTone } from "./linkDecisions.js";

export interface TaskChipProps {
  task: Pick<Task, "id" | "status">;
  /** Branch is owned by this task: shows the lock variant. */
  locked?: boolean;
  /** Override for tests / hosts that own task opening. */
  onOpen?: (taskId: number) => void;
}

/**
 * Task status chip; the lock variant says "owned by task #N" up front. A click
 * opens the task's detail panel through the store's requestOpenTask (the
 * sidebar has no dockview API of its own; see useOpenTaskRequest.ts).
 */
export function TaskChip({ task, locked, onOpen }: TaskChipProps) {
  const requestOpenTask = useDashboardStore((s) => s.requestOpenTask);
  const open = onOpen ?? requestOpenTask;
  const label = locked
    ? `🔒 task #${task.id} · ${task.status}`
    : `task #${task.id} · ${task.status}`;
  return (
    <StatusChip
      tone={taskTone(task.status)}
      title={
        locked
          ? `Owned by task #${task.id} — can't be deleted here; open task`
          : `Task #${task.id} — open task`
      }
      onClick={() => open(task.id)}
    >
      {label}
    </StatusChip>
  );
}
