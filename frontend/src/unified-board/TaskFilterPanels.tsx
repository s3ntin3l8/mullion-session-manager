import { useState } from "react";
import type { ReactNode } from "react";
import { SearchInput, Segmented } from "../ui/primitives.js";
import type { EpicOption, FacetsSetting } from "./taskFilters.js";
import { NO_EPIC } from "./taskFilters.js";

// The contents of the board's three menus (#2840): the project picker, the Filter menu
// and the Display menu. Each is rendered inside a FilterPopover on desktop and inline
// inside the filter sheet on phone, so one component serves both.

function CheckItem({
  checked,
  onChange,
  children,
  count,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  count?: ReactNode;
}) {
  return (
    <label className="task-pop-item">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="task-pop-item-label">{children}</span>
      {count !== undefined && (
        <>
          {" "}
          <span className="task-pop-n">{count}</span>
        </>
      )}
    </label>
  );
}

export function ProjectPickerPanel({
  projects,
  selected,
  counts,
  recent,
  onToggle,
  onClear,
  follow,
}: {
  projects: Array<{ id: number; name: string }>;
  selected: number[];
  counts: Map<number, number>;
  /** Most recently picked first. */
  recent: number[];
  onToggle: (id: number) => void;
  onClear: () => void;
  /** The "follow" option (#2858, #2864 for phone); omitted when there is no followed
   * project to offer. */
  follow?: {
    label: string;
    checked: boolean;
    projectName: string | null;
    onChange: (next: boolean) => void;
  };
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = projects.filter((p) => p.name.toLowerCase().includes(needle));
  // A Recent group only earns its place once the list is long enough to scroll.
  const recentProjects =
    needle === "" && projects.length > 8
      ? recent.flatMap((id) => projects.filter((p) => p.id === id))
      : [];
  const row = (p: { id: number; name: string }) => (
    <CheckItem
      key={p.id}
      checked={selected.includes(p.id)}
      onChange={() => onToggle(p.id)}
      count={counts.get(p.id) ?? 0}
    >
      {p.name}
    </CheckItem>
  );
  return (
    <>
      <SearchInput
        small
        className="task-pop-search"
        placeholder={`Search ${projects.length} projects`}
        aria-label="Search projects"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {recentProjects.length > 0 && (
        <>
          <div className="task-pop-h">Recent</div>
          {recentProjects.map(row)}
        </>
      )}
      <div className="task-pop-h">{recentProjects.length > 0 ? "All projects" : "Projects"}</div>
      {shown.length === 0 ? (
        <div className="task-pop-empty">No project matches.</div>
      ) : (
        shown.map(row)
      )}
      {selected.length > 0 && (
        <button type="button" className="tasks-panel-filter-clear" onClick={onClear}>
          Show every project
        </button>
      )}
      {follow && (
        <CheckItem checked={follow.checked} onChange={() => follow.onChange(!follow.checked)}>
          {follow.projectName ? `${follow.label} (${follow.projectName})` : follow.label}
        </CheckItem>
      )}
    </>
  );
}

/** The epics on the board, `#N title` with sub-issue progress (or a task count while the
 * parent reports none), plus "No epic". Shared by the Filter menu and the facets panel. */
export function EpicChecklist({
  epicOpts,
  noEpic,
  selectedEpics,
  onToggleEpic,
}: {
  epicOpts: EpicOption[];
  noEpic: number;
  selectedEpics: string[];
  onToggleEpic: (key: string) => void;
}) {
  if (epicOpts.length === 0 && noEpic === 0) return null;
  return (
    <>
      <div className="task-pop-h">Epic</div>
      {epicOpts.map((o) => (
        <CheckItem
          key={o.key}
          checked={selectedEpics.includes(o.key)}
          onChange={() => onToggleEpic(o.key)}
          count={o.total !== null ? `${o.done ?? 0}/${o.total}` : o.count}
        >
          {o.label}
        </CheckItem>
      ))}
      {noEpic > 0 && (
        <CheckItem
          checked={selectedEpics.includes(NO_EPIC)}
          onChange={() => onToggleEpic(NO_EPIC)}
          count={noEpic}
        >
          No epic
        </CheckItem>
      )}
    </>
  );
}

export function FilterMenuPanel({
  epicOpts,
  noEpic,
  selectedEpics,
  onToggleEpic,
  agentOpts,
  selectedAgents,
  onToggleAgent,
  text,
  onText,
}: {
  epicOpts: EpicOption[];
  noEpic: number;
  selectedEpics: string[];
  onToggleEpic: (key: string) => void;
  agentOpts: Array<{ value: string; count: number }>;
  selectedAgents: string[];
  onToggleAgent: (value: string) => void;
  text: string;
  onText: (value: string) => void;
}) {
  return (
    <>
      <SearchInput
        small
        className="task-pop-search"
        placeholder="Search title, issue # or PR #"
        aria-label="Search tasks"
        value={text}
        onChange={(e) => onText(e.target.value)}
      />
      <EpicChecklist
        epicOpts={epicOpts}
        noEpic={noEpic}
        selectedEpics={selectedEpics}
        onToggleEpic={onToggleEpic}
      />
      {agentOpts.length > 0 && (
        <>
          <div className="task-pop-h">Agent</div>
          {agentOpts.map((o) => (
            <CheckItem
              key={o.value}
              checked={selectedAgents.includes(o.value)}
              onChange={() => onToggleAgent(o.value)}
              count={o.count}
            >
              {o.value}
            </CheckItem>
          ))}
        </>
      )}
    </>
  );
}

export function DisplayMenuPanel({
  hideDone,
  hideDoneSuppressed = false,
  onToggleHideDone,
  showArchived,
  onToggleShowArchived,
  facets,
  onFacets,
  showFacets = true,
  extra,
  clearDone,
}: {
  hideDone: boolean;
  /** The setting is on but not applied: the Awaiting merge view needs Done visible. */
  hideDoneSuppressed?: boolean;
  onToggleHideDone: () => void;
  showArchived: boolean;
  onToggleShowArchived: () => void;
  facets: FacetsSetting;
  onFacets: (next: FacetsSetting) => void;
  /** The facets panel setting is meaningless on phone, which never shows the panel. */
  showFacets?: boolean;
  /** More Display entries (group by, card density: #2841) slot in here. */
  extra?: ReactNode;
  clearDone: ReactNode;
}) {
  return (
    <>
      <div className="task-pop-h">Columns</div>
      <CheckItem checked={hideDone} onChange={onToggleHideDone}>
        Hide Done &amp; Failed
        {hideDone && hideDoneSuppressed && (
          <span className="task-pop-note"> (not applied in the Awaiting merge view)</span>
        )}
      </CheckItem>
      <CheckItem checked={showArchived} onChange={onToggleShowArchived}>
        Show archived
      </CheckItem>
      {extra}
      {showFacets && (
        <>
          <div className="task-pop-h">Facets panel</div>
          <Segmented<FacetsSetting>
            ariaLabel="Facets panel"
            value={facets}
            onChange={onFacets}
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
              { value: "auto", label: "Auto" },
            ]}
          />
        </>
      )}
      <div className="task-pop-h">Maintenance</div>
      <div className="task-pop-clear">{clearDone}</div>
    </>
  );
}
