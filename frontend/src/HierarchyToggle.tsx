import { useDashboardStore } from "./store.js";
import { ListIcon, LayersIcon } from "./icons.js";

// Phase 5 (Track B, issue #195 5.5b) — flat vs hierarchical sidebar toggle.
// Split out of Sidebar.tsx into its own tiny component, same
// testability-over-inlining rationale as ViewModeToggle.tsx (its own header
// comment explains why: a heavier host component's mock surface shouldn't
// be a prerequisite for testing a two-button toggle).
export function HierarchyToggle() {
  const { hierarchicalView, setHierarchicalView } = useDashboardStore();

  return (
    <div className="hierarchy-toggle" role="group" aria-label="Session grouping">
      <button
        type="button"
        className={`toolbar-icon-btn${!hierarchicalView ? " active" : ""}`}
        onClick={() => setHierarchicalView(false)}
        title="Flat view"
        aria-pressed={!hierarchicalView}
      >
        <ListIcon size={13} />
      </button>
      <button
        type="button"
        className={`toolbar-icon-btn${hierarchicalView ? " active" : ""}`}
        onClick={() => setHierarchicalView(true)}
        title="Hierarchical view"
        aria-pressed={hierarchicalView}
      >
        <LayersIcon size={13} />
      </button>
    </div>
  );
}
