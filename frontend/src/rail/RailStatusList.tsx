import { useDashboardStore } from "../store/index.js";

// Tasks mode's middle region of the left rail (#3026, design frame 2a): one
// entry per status of the board, each a count over a short label, with a dot
// for a status holding a task that needs the owner. The entries are the
// board's own (UnifiedBoard publishes them with its filtered counts, the same
// ones its stacked sections and strip show), and a tap raises the store's
// jump request, which the board consumes whichever layout it shows.
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
          aria-label={`${s.title}, ${s.count} ${s.count === 1 ? "task" : "tasks"}${
            s.needsYouCount > 0
              ? `, ${s.needsYouCount} ${s.needsYouCount === 1 ? "needs" : "need"} you`
              : ""
          }`}
          title={s.title}
          onClick={() => useDashboardStore.getState().requestStatusJump(s.id)}
        >
          <span className="rail-status-count" aria-hidden="true">
            {s.count}
          </span>
          <span className="rail-status-label" aria-hidden="true">
            {s.title}
          </span>
          {s.needsYou && <span className="rail-status-dot" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
