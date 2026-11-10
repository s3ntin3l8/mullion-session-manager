import type { CSSProperties } from "react";
import type { EpicProgress } from "./taskLanes.js";

// The header over one swimlane when the board is grouped (epic #2847, #2841): the epic's
// `#number title` with its progress and a link to the issue, or a project's name. The
// colour is the same slot the epic's cards and tags use.
export function TaskLaneHeader({
  title,
  count,
  colour,
  progress,
  href,
}: {
  title: string;
  count: number;
  colour: string | null;
  progress: EpicProgress | null;
  /** The epic issue on GitHub. */
  href: string | null;
}) {
  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div
      className="task-lane-header"
      style={colour ? ({ "--task-epic-colour": colour } as CSSProperties) : undefined}
    >
      {colour && <span className="task-lane-dot" aria-hidden="true" />}
      <span className="task-lane-title">{title}</span>
      {progress && (
        <>
          <span
            className="task-lane-bar"
            role="progressbar"
            aria-label="Epic progress"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
          >
            <i style={{ width: `${pct}%` }} />
          </span>
          <span className="task-lane-progress">
            {progress.done}/{progress.total} {progress.basis}
          </span>
        </>
      )}
      {href && (
        <a
          className="task-lane-link"
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label="Open epic on GitHub"
        >
          ↗
        </a>
      )}
      <span className="kanban-column-count">{count}</span>
    </div>
  );
}
