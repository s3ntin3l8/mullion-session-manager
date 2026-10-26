import type { Task } from "../../api/types.js";
import { StatusChip } from "./StatusChip.js";
import { taskTone } from "./linkDecisions.js";

export interface TaskChipProps {
  task: Pick<Task, "id" | "status">;
  /** Branch is owned by this task: shows the lock variant. */
  locked?: boolean;
  onOpen?: (taskId: number) => void;
}

/** Task status chip; the lock variant says "owned by task #N" up front. */
export function TaskChip({ task, locked, onOpen }: TaskChipProps) {
  const label = locked
    ? `🔒 task #${task.id} · ${task.status}`
    : `task #${task.id} · ${task.status}`;
  return (
    <StatusChip
      tone={taskTone(task.status)}
      title={locked ? `Owned by task #${task.id} — can't be deleted here` : `Task #${task.id}`}
      onClick={onOpen ? () => onOpen(task.id) : undefined}
    >
      {label}
    </StatusChip>
  );
}
