import type { TaskStatus } from "../api/index.js";
import type { StatusEntry } from "./stackLayout.js";

// The statuses of the stacked board with their counts, each one a jump to
// that status (#3011). Its own component, fed by props, so the left rail can
// list the same entries in Tasks mode (design frame 2a) without reaching into
// the board: the rail slice renders it with the statuses and an onJump.
export function TaskStatusStrip({
  statuses,
  onJump,
  label = "Jump to status",
}: {
  statuses: readonly StatusEntry[];
  onJump: (id: TaskStatus) => void;
  label?: string;
}) {
  return (
    <nav className="task-status-strip" aria-label={label}>
      {statuses.map((s) => (
        <button
          key={s.id}
          type="button"
          className="task-status-strip-entry"
          data-status={s.id}
          aria-label={`${s.title}, ${s.count}${s.needsYou ? ", needs you" : ""}`}
          onClick={() => onJump(s.id)}
        >
          <span className="task-status-strip-title">{s.title}</span>
          <span className="task-status-strip-count">{s.count}</span>
          {s.needsYou && <span className="task-status-strip-dot" aria-hidden="true" />}
        </button>
      ))}
    </nav>
  );
}
