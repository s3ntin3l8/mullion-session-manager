import type { Task } from "../../api/types.js";
import type { Tone } from "../../lib/statusTone.js";
import { StatusChip } from "./StatusChip.js";

function taskTone(status: string): Tone {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "reviewing":
      return "warn";
    case "claimed":
    case "in_progress":
      return "info";
    default:
      return "neutral";
  }
}

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
