import { useState } from "react";
import type { ReactNode } from "react";
import type { ClearDoneResult } from "../api/index.js";
import { BottomSheet } from "../ui/BottomSheet.js";
import { CloseIcon, FilterIcon, PlusIcon, SidebarToggleIcon } from "../ui/icons.js";
import { ClearDoneControl } from "./ClearDoneControl.js";
import { FilterPopover } from "./FilterPopover.js";
import { NewTaskForm } from "./NewTaskForm.js";
import { DisplayMenuPanel, FilterMenuPanel, ProjectPickerPanel } from "./TaskFilterPanels.js";
import { NO_EPIC, QUICK_VIEWS, activeFilterCount, followOption } from "./taskFilters.js";
import type { TaskFilterApi } from "./useTaskFilters.js";

// The Task Master board's single filter row (epic #2847, #2840; mockup view
// "1 · Filter bar"): facets toggle, project picker, quick-view tabs, Filter menu,
// Display menu and New task. Active epic/agent/text filters show as removable tokens
// under it. On phone the row collapses to [New task] [Filter] and everything moves
// into a filter sheet, rendering the same panels inline.
export function TaskFilterBar({
  api,
  projects,
  phone,
  facetsShown,
  creating,
  onToggleCreate,
  createTask,
  onCreated,
  clearDoneTasks,
  displayExtra,
}: {
  api: TaskFilterApi;
  projects: Array<{ id: number; name: string }>;
  phone: boolean;
  /** Whether the facets panel is currently open (resolved from the Off/On/Auto setting). */
  facetsShown: boolean;
  creating: boolean;
  onToggleCreate: () => void;
  createTask: (projectId: number, title: string) => Promise<unknown>;
  onCreated: () => void;
  clearDoneTasks: (opts?: {
    projectIds?: number[];
    deleteBranches?: boolean;
  }) => Promise<ClearDoneResult>;
  /** More Display entries (group by, card density: #2841). */
  displayExtra?: ReactNode;
}) {
  const { filters } = api;
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const newBtn = (
    <button type="button" className="tasks-panel-new-btn" onClick={onToggleCreate}>
      <PlusIcon size={12} strokeLinecap="round" strokeWidth={2.2} />
      New task
    </button>
  );
  const newForm = creating && (
    <NewTaskForm projects={projects} createTask={createTask} onCreated={onCreated} />
  );

  const showProjects = projects.length > 1;
  const projectsPanel = (
    <ProjectPickerPanel
      projects={projects}
      selected={filters.projectIds}
      counts={api.projectCounts}
      recent={api.recentProjectIds}
      onToggle={api.toggleProject}
      onClear={() => api.setProjectIds([])}
      follow={followOption(api, projects)}
    />
  );
  const filterPanel = (
    <FilterMenuPanel
      epicOpts={api.epicOpts}
      noEpic={api.noEpic}
      selectedEpics={filters.epicKeys}
      onToggleEpic={api.toggleEpic}
      agentOpts={api.agentOpts}
      selectedAgents={filters.agents}
      onToggleAgent={api.toggleAgent}
      text={filters.text}
      onText={api.setText}
    />
  );
  const displayPanel = (
    <DisplayMenuPanel
      hideDone={api.hideDone}
      hideDoneSuppressed={api.hideDone && !api.effectiveHideDone}
      onToggleHideDone={api.toggleHideDone}
      showArchived={filters.showArchived}
      onToggleShowArchived={api.toggleShowArchived}
      facets={api.facets}
      onFacets={api.setFacets}
      showFacets={!phone}
      extra={displayExtra}
      clearDone={
        <ClearDoneControl
          activeProjectIds={filters.projectIds}
          awaitingMergeCount={api.awaitingMergeCount}
          clearDoneTasks={clearDoneTasks}
        />
      }
    />
  );
  const quickViews = (
    <div className="task-views" role="group" aria-label="Quick views">
      {QUICK_VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          className={`task-view${filters.view === v.id ? " active" : ""}${
            v.id === "needs-me" && api.counts[v.id] > 0 ? " attention" : ""
          }`}
          aria-pressed={filters.view === v.id}
          onClick={() => api.setView(v.id)}
        >
          {v.label} <span className="task-view-n">{api.counts[v.id]}</span>
        </button>
      ))}
    </div>
  );

  if (phone) {
    const count = activeFilterCount(filters, api.hideDone);
    return (
      <div className="tasks-panel-toolbar tasks-panel-toolbar--phone">
        {newBtn}
        <button
          type="button"
          className="tasks-phone-filter-btn"
          aria-haspopup="dialog"
          onClick={() => setFilterSheetOpen(true)}
        >
          Filter{count > 0 ? ` (${count})` : ""}
        </button>
        {newForm}
        <BottomSheet
          open={filterSheetOpen}
          onClose={() => setFilterSheetOpen(false)}
          label="Task filters"
          closeLabel="Close filters"
          title="Filters"
          sheetClassName="tasks-phone-filter-sheet"
          backStack
          portal={false}
        >
          <div className="tasks-phone-filter-body">
            {quickViews}
            {showProjects && projectsPanel}
            {filterPanel}
            {displayPanel}
          </div>
        </BottomSheet>
      </div>
    );
  }

  const projectNames = projects
    .filter((p) => filters.projectIds.includes(p.id))
    .map((p) => p.name)
    .join(", ");
  const projectSummary = api.followSidebar
    ? `◎ ${projectNames || "All projects"}`
    : filters.projectIds.length === 0
      ? "All projects"
      : filters.projectIds.length <= 2
        ? projectNames
        : `${filters.projectIds.length} projects`;
  const filterDims =
    (filters.epicKeys.length > 0 ? 1 : 0) +
    (filters.agents.length > 0 ? 1 : 0) +
    (filters.text.trim() !== "" ? 1 : 0);
  const epicLabel = (key: string) =>
    key === NO_EPIC ? "No epic" : (api.epicOpts.find((o) => o.key === key)?.label ?? key);

  return (
    <div className="task-filter-bar">
      <div className="tasks-panel-toolbar task-filter-row">
        <button
          type="button"
          className={`task-pop-btn task-facets-toggle${facetsShown ? " active" : ""}`}
          aria-label="Facets panel"
          aria-pressed={facetsShown}
          title="Show or hide the facets panel (state, projects, epics)"
          onClick={() => api.setFacets(facetsShown ? "off" : "on")}
        >
          <SidebarToggleIcon size={14} aria-hidden="true" />
        </button>
        {showProjects && (
          <FilterPopover
            ariaLabel="Projects"
            buttonLabel={`Projects: ${projectSummary}${api.followSidebar ? " (following the sidebar)" : ""}`}
            label={projectSummary}
            active={filters.projectIds.length > 0}
          >
            {projectsPanel}
          </FilterPopover>
        )}
        {quickViews}
        <FilterPopover
          ariaLabel="Filter"
          buttonLabel={filterDims > 0 ? `Filter ${filterDims} active` : "Filter"}
          label={
            <>
              <FilterIcon size={12} aria-hidden="true" />
              Filter
              {filterDims > 0 && (
                <>
                  {" "}
                  <span className="task-view-n">{filterDims}</span>
                </>
              )}
            </>
          }
          active={filterDims > 0}
        >
          {filterPanel}
        </FilterPopover>
        <FilterPopover ariaLabel="Display" label="Display">
          {displayPanel}
        </FilterPopover>
        <span className="task-filter-spacer" />
        {newBtn}
      </div>
      {filterDims > 0 && (
        <div className="task-filter-tokens" role="group" aria-label="Active filters">
          {filters.epicKeys.map((key) => (
            <span key={key} className="task-token">
              Epic: {epicLabel(key)}
              <button
                type="button"
                aria-label={`Remove epic filter ${epicLabel(key)}`}
                onClick={() => api.toggleEpic(key)}
              >
                <CloseIcon size={10} aria-hidden="true" />
              </button>
            </span>
          ))}
          {filters.agents.map((agent) => (
            <span key={agent} className="task-token">
              Agent: {agent}
              <button
                type="button"
                aria-label={`Remove agent filter ${agent}`}
                onClick={() => api.toggleAgent(agent)}
              >
                <CloseIcon size={10} aria-hidden="true" />
              </button>
            </span>
          ))}
          {filters.text.trim() !== "" && (
            <span className="task-token">
              Text: “{filters.text.trim()}”
              <button type="button" aria-label="Remove text filter" onClick={() => api.setText("")}>
                <CloseIcon size={10} aria-hidden="true" />
              </button>
            </span>
          )}
          <button type="button" className="tasks-panel-filter-clear" onClick={api.clearFilters}>
            Clear all
          </button>
        </div>
      )}
      {newForm}
    </div>
  );
}
