import { QUICK_VIEWS } from "./taskFilters.js";
import type { TaskFilterApi } from "./useTaskFilters.js";
import { EpicChecklist, ProjectPickerPanel } from "./TaskFilterPanels.js";

// The optional left rail of the board's filter bar (#2840, mockup variant 1c): state,
// projects and epics with counts, for installs with many of each. A second view of
// the same filter state the bar edits, not a second state: both write through `api`.
export function TaskFacetsPanel({
  api,
  projects,
}: {
  api: TaskFilterApi;
  projects: Array<{ id: number; name: string }>;
}) {
  const { filters } = api;
  return (
    <aside className="task-facets" aria-label="Task facets">
      <div className="task-pop-h">State</div>
      <div className="task-facets-views" role="group" aria-label="Facet quick views">
        {QUICK_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`task-facets-view${filters.view === v.id ? " active" : ""}`}
            aria-pressed={filters.view === v.id}
            onClick={() => api.setView(v.id)}
          >
            <span>{v.label}</span> <span className="task-pop-n">{api.counts[v.id]}</span>
          </button>
        ))}
      </div>
      {projects.length > 1 && (
        <ProjectPickerPanel
          projects={projects}
          selected={filters.projectIds}
          counts={api.projectCounts}
          recent={api.recentProjectIds}
          onToggle={api.toggleProject}
          onClear={() => api.setProjectIds([])}
        />
      )}
      <EpicChecklist
        epicOpts={api.epicOpts}
        noEpic={api.noEpic}
        selectedEpics={filters.epicKeys}
        onToggleEpic={api.toggleEpic}
      />
    </aside>
  );
}
