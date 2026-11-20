import type { TaskStatus } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

// Tasks mode's middle region of the left rail (#3026, design frame 2a): one
// entry per status of the board, each a count over a short label, with a dot
// for a status holding a task that needs the owner. The entries are the
// board's own (UnifiedBoard publishes them with its filtered counts, the same
// ones its stacked sections and strip show), and a tap raises the store's
// jump request, which the board consumes whichever layout it shows.
// The rail is 40px wide at 9px text: the long titles get a shorter word.
const SHORT_LABEL: Partial<Record<TaskStatus, string>> = {
  reviewing: "Review",
  in_progress: "Active",
};

// The name starts with what the entry shows, the count over the short label
// ("2 Review"), so it contains the visible text (WCAG 2.5.3, axe's
// label-content-name-mismatch, #2886); the full title follows when the label
// is a shortened one.
function statusName(s: {
  id: TaskStatus;
  title: string;
  count: number;
  needsYouCount: number;
}): string {
  const short = SHORT_LABEL[s.id] ?? s.title;
  const full = short === s.title ? "" : ` (${s.title})`;
  const needs =
    s.needsYouCount > 0
      ? `, ${s.needsYouCount} ${s.needsYouCount === 1 ? "needs" : "need"} you`
      : "";
  return `${s.count} ${short}${full}${needs}`;
}

export function RailStatusList() {
  const statuses = useDashboardStore((s) => s.boardStatuses);
  if (statuses.length === 0) return null;
  return (
    <div className="rail-status-list" role="group" aria-label="Task statuses">
      {statuses.map((s) => (
        <button
          key={s.id}
          type="button"
          className="left-rail-btn rail-status-entry"
          data-status={s.id}
          aria-label={statusName(s)}
          title={s.title}
          onClick={() => useDashboardStore.getState().requestStatusJump(s.id)}
        >
          <span className="rail-status-count" aria-hidden="true">
            {s.count}
          </span>{" "}
          <span className="rail-status-label" aria-hidden="true">
            {SHORT_LABEL[s.id] ?? s.title}
          </span>
          {s.needsYou && <span className="rail-status-dot" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
