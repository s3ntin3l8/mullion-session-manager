import { useDashboardStore } from "./store.js";
import { GridIcon, ListIcon } from "./icons.js";

// Issue #211's list/Kanban view switcher — split out of Toolbar.tsx into its
// own tiny component (rather than inlined JSX there) so it's testable
// without also pulling in Toolbar's other, much heavier children
// (NotificationBell's virtualized event feed needs a much larger store-mock
// surface than this needs — see ViewModeToggle.test.tsx).
export function ViewModeToggle() {
  const { viewMode, setViewMode } = useDashboardStore();

  return (
    <div className="view-mode-toggle" role="group" aria-label="View mode">
      <button
        type="button"
        className={`toolbar-icon-btn${viewMode === "list" ? " active" : ""}`}
        onClick={() => setViewMode("list")}
        title="List view"
        aria-pressed={viewMode === "list"}
      >
        <ListIcon size={15} />
      </button>
      <button
        type="button"
        className={`toolbar-icon-btn${viewMode === "kanban" ? " active" : ""}`}
        onClick={() => setViewMode("kanban")}
        title="Kanban board view"
        aria-pressed={viewMode === "kanban"}
      >
        <GridIcon size={15} />
      </button>
    </div>
  );
}
