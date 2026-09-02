import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/react-virtual";
import { useDashboardStore } from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import { CreateProjectModal } from "./CreateProjectModal.js";
import { KebabMenu } from "./ui/KebabMenu.js";
import { api, ApiError, LOCAL_HOST_ID } from "./api/index.js";
import type { DiscoveredProject, Host, Project, Session } from "./api/index.js";
import { describeLatestEvent } from "./eventDescriptions.js";
import {
  formatStatusLabel,
  isStatusReachable,
  rowClassNameForSeverity,
  STATUS_PRESENTATION,
} from "./sessionStatus.js";
import { MullionMark } from "./assets/MullionMark.js";
import { Dropdown } from "./ui/primitives.js";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateIcon,
  EmptyStateTitle,
} from "./ui/EmptyState.js";
import { resolveAgentLogo, commandToBinary } from "./cliLogos.js";
import { PromoteDialog } from "./PromoteDialog.js";
import {
  ChevronDownIcon,
  CloseIcon,
  FileTextIcon,
  FolderIcon,
  HostsIcon,
  LayersIcon,
  PlusIcon,
  RenameIcon,
  SearchAlertIcon,
  SearchIcon,
} from "./ui/icons.js";
import { STORAGE_KEYS, readJSON, writeJSON } from "./lib/persistedState.js";
import { taskLinkedSessionIds } from "./unifiedBoard.js";
import { HierarchyToggle } from "./HierarchyToggle.js";
import { buildHierarchicalRows, liveChildCount } from "./sidebarHierarchy.js";
import { SourceControlSection } from "./SourceControlSection.js";
import { columnForSession } from "./kanban.js";
import type { KanbanColumnId } from "./kanban.js";
import { sessionDisplayTitle, sessionMatchesSearch } from "./lib/sessionDisplay.js";
import { summarizeFileChanges } from "./lib/sidebarStatus.js";
import { estimateSidebarRowHeight } from "./lib/sidebarRowSizing.js";
import { Header } from "./session-row/Header.js";
import { GitLine } from "./session-row/GitLine.js";
import { FileChanges } from "./session-row/FileChanges.js";
import { Chips } from "./session-row/Chips.js";

// U3's three status filter chips. Deliberately only 3 of kanban.ts's 5
// severity-derived columns (not "Finished"/"Idle") — matches the finding's
// own spec verbatim, and reuses `columnForSession`'s existing severity→
// column derivation (the same one the Kanban board already filters by)
// rather than inventing a fourth status vocabulary for this one filter bar,
// per this codebase's "match the vocabulary that already exists" rule (see
// sessionStatus.ts's own header comment on why there's only ever ONE status
// table). "Attention"/"Working"/"Exited" are the three highest-signal
// categories for "which of my N sessions needs a look" — Finished/Idle
// sessions are, definitionally, the ones that don't.
const SIDEBAR_FILTER_CHIPS: { id: KanbanColumnId; label: string }[] = [
  { id: "attention", label: "Attention" },
  { id: "working", label: "Working" },
  { id: "exited", label: "Exited" },
];

// U3 — how many *base-filtered* sessions (the same set Sidebar already
// computes per project below, before the new search/chip filter) trigger
// the switch from plain unvirtualized rendering to the flattened
// `VirtualizedProjectTree` further down. Tied directly to the finding's own
// framing ("nothing degrades gracefully past ~20 sessions") — set at the
// finding's own number rather than picking a different one, so the switch
// engages right where the finding says the current UI starts to hurt.
// Deliberately counted on the *unfiltered* total (not whatever the search
// box currently matches) so typing into the filter box never flips
// rendering strategy out from under the user mid-keystroke.
const VIRTUALIZE_SESSION_THRESHOLD = 20;

interface SidebarProps {
  onOpenSession: (session: Session) => void;
  onOpenSessionAsFloat: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
  // Opens the command palette scoped to this project (design's project-row
  // "+" button) — cwd is bound implicitly, no target-picker step needed.
  onOpenProjectLauncher: (projectId: number) => void;
  // "Configure search roots" in the discovery empty state (design section
  // 03·1C) opens Settings straight to the Projects tab.
  onOpenSettingsProjects: () => void;
  // Phase 6 (6.5/#218) — opens (or focuses) the global task board, replacing
  // 2.5's own ad hoc TasksSection list.
  onOpenTasks: () => void;
  // Issue #433 scope B — SourceControlSection's own "Open Git Panel" action.
  // App.tsx already had this callback (for GitPanel's own command-palette
  // entry, issue #76) but never threaded it down to Sidebar until now.
  onOpenGit: (projectId: number) => void;
}

export function Sidebar({
  onOpenSession,
  onOpenSessionAsFloat,
  onSessionEnded,
  onOpenProjectLauncher,
  onOpenSettingsProjects,
  onOpenTasks,
  onOpenGit,
}: SidebarProps) {
  // P1 perf fix — was a single bare `useDashboardStore()` (whole-store
  // subscription); split into one selector per rendered field (via
  // useShallow, same shape as App.tsx's own top-level selector block) plus
  // getState() at each of the four mount-effect actions and `createProject`
  // below, none of which this component needs to react to as a value.
  const {
    projects,
    sessions,
    hosts,
    tasks,
    hideEndedSessions,
    showTaskSessions,
    settings,
    settingsLoaded,
    hierarchicalView,
    viewMode,
  } = useDashboardStore(
    useShallow((s) => ({
      projects: s.projects,
      sessions: s.sessions,
      hosts: s.hosts,
      tasks: s.tasks,
      hideEndedSessions: s.hideEndedSessions,
      showTaskSessions: s.showTaskSessions,
      settings: s.settings,
      settingsLoaded: s.settingsLoaded,
      hierarchicalView: s.hierarchicalView,
      viewMode: s.viewMode,
    })),
  );
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  // Lifted here (rather than owned entirely inside DiscoverProjects) so the
  // "Welcome to Mullion" empty state's "Scan for repos" button can force it
  // open, matching the design's two-button first-run CTA.
  const [discoverCollapsed, setDiscoverCollapsed] = useState(true);

  // U3 — the search box + status chips. Plain component state, deliberately
  // NOT persisted (unlike the collapse state below): a filter silently
  // surviving a reload would leave a dashboard showing an unexplained
  // subset of sessions with no visible reason why, which is a footgun, not
  // a convenience the way remembering collapse state is.
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChips, setSelectedChips] = useState<Set<KanbanColumnId>>(() => new Set());
  const toggleChip = useCallback((id: KanbanColumnId) => {
    setSelectedChips((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const filterActive = searchQuery.trim() !== "" || selectedChips.size > 0;

  useEffect(() => {
    const store = useDashboardStore.getState();
    void store.refreshProjects();
    void store.refreshSessions();
    void store.refreshHosts();
    // Loaded on mount alongside everything else above rather than waiting
    // for startLiveRefresh's ~60s-throttled tick to reach it first — this is
    // what lets the Tasks nav entry's count badge below be accurate right
    // away.
    void store.refreshTasks();
  }, []);

  // Phase 6 (6.5/#218) — count of tasks needing human attention right now:
  // "ready" (claimable) and "reviewing" (awaiting Approve/Reject). Neither
  // "claimed"/"in_progress" (the agent is already working, nothing for a
  // human to do yet) nor "done"/"failed"/"backlog" belong in this count.
  const actionableTaskCount = tasks.filter(
    (t) => t.status === "ready" || t.status === "reviewing",
  ).length;

  // #9 — a "killed" task session is already excluded by the `s.status !==
  // "killed"` check above/below regardless of this toggle (see PR 8's own
  // cleanup, which flips a superseded task session to "killed" rather than
  // leaving it "active"/"exited") — this predicate only ever hides a
  // currently LIVE task-linked session, which is the actual point: a human
  // may still want to glance at or attach to it directly without
  // navigating into the task view first, so it's a toggle, not a hard
  // exclusion.
  const taskSessionIds = useMemo(() => taskLinkedSessionIds(tasks), [tasks]);

  // U3 — per-project base session list: the exact filter Sidebar has always
  // applied (kind === "terminal", not killed, hideEndedSessions), with TWO
  // additions — an explicitly-selected "Exited" chip bypasses
  // hideEndedSessions for its own selection, and showTaskSessions governs
  // whether a task-linked session is visible at all. Without the exited
  // carve-out, hideEndedSessions=on would make the Exited chip permanently
  // return zero rows, which is the "conflict" the task explicitly asks this
  // PR to avoid; this makes the two *compose* instead — the Settings toggle
  // still governs the default view, but an explicit chip click always wins
  // for its own session set.
  const baseSessionsByProject = useMemo(() => {
    const map = new Map<number, Session[]>();
    for (const project of projects) {
      map.set(
        project.id,
        sessions.filter(
          (s) =>
            s.projectId === project.id &&
            s.kind === "terminal" &&
            s.status !== "killed" &&
            (!hideEndedSessions || s.status === "active" || selectedChips.has("exited")) &&
            (showTaskSessions || !taskSessionIds.has(s.id)),
        ),
      );
    }
    return map;
  }, [projects, sessions, hideEndedSessions, showTaskSessions, taskSessionIds, selectedChips]);

  // Counted on the unfiltered base set (not whatever the search box
  // currently narrows to) — see VIRTUALIZE_SESSION_THRESHOLD's own comment
  // for why: typing into the filter box must never flip rendering strategy
  // out from under the user mid-keystroke.
  const totalBaseSessionCount = useMemo(
    () => Array.from(baseSessionsByProject.values()).reduce((sum, list) => sum + list.length, 0),
    [baseSessionsByProject],
  );
  const shouldVirtualize = totalBaseSessionCount > VIRTUALIZE_SESSION_THRESHOLD;

  const filteredSessionsByProject = useMemo(() => {
    const map = new Map<number, Session[]>();
    const query = searchQuery.trim();
    for (const project of projects) {
      const base = baseSessionsByProject.get(project.id) ?? [];
      if (query === "" && selectedChips.size === 0) {
        map.set(project.id, base);
        continue;
      }
      map.set(
        project.id,
        base.filter(
          (s) =>
            (query === "" || sessionMatchesSearch(s, project, query)) &&
            (selectedChips.size === 0 || selectedChips.has(columnForSession(s))),
        ),
      );
    }
    return map;
  }, [projects, baseSessionsByProject, searchQuery, selectedChips]);

  // U3 — a project with zero matches while a filter is active is skipped
  // entirely, not shown collapsed or with an empty body: the same "nothing
  // to render, don't render a husk" posture DiscoverProjects' own
  // `remaining.length === 0` branch takes below, just one level further in
  // (that panel hides itself as a whole when nothing's left to discover;
  // this hides each individually-empty project section while leaving
  // matching ones alone).
  const visibleProjects = useMemo(
    () =>
      filterActive
        ? projects.filter((p) => (filteredSessionsByProject.get(p.id)?.length ?? 0) > 0)
        : projects,
    [projects, filterActive, filteredSessionsByProject],
  );

  // U3 — the virtualized path's own re-flatten trigger for collapse
  // toggles. Both rendering paths read/write the SAME persisted
  // `projectCollapsedState` object (declared next to ProjectSection) as
  // their one source of truth — there is deliberately no separate Map
  // cached here. An earlier version of this file DID cache a
  // `collapsedOverrides` Map, seeded once from `projectCollapsedState` at
  // Sidebar's own mount: that went stale the moment a below-threshold
  // `ProjectSection` toggle wrote straight to `projectCollapsedState`
  // without this component ever hearing about it, so a project collapsed
  // under VIRTUALIZE_SESSION_THRESHOLD would silently re-expand the moment
  // the session count crossed it and `VirtualizedProjectTree` took over —
  // reading a stale snapshot instead of the same live truth ProjectSection
  // itself was already using (Hermes review, PR #583). `flatRows` below
  // now reads `projectCollapsedState` directly on every recompute instead;
  // this counter carries no data of its own, it exists purely so that
  // memo has something in its deps array that changes on every toggle,
  // forcing an immediate re-flatten (rather than waiting on the next
  // unrelated `sessions` poll tick, which would also eventually pick up
  // the live value but with a visible lag after the click).
  const [collapseVersion, setCollapseVersion] = useState(0);
  const toggleProjectCollapsedVirtualized = useCallback(
    (projectId: number, derivedDefault: boolean) => {
      const current =
        projectId in projectCollapsedState ? projectCollapsedState[projectId] : derivedDefault;
      setProjectCollapsedPersisted(projectId, !current);
      setCollapseVersion((v) => v + 1);
    },
    [],
  );

  // U3's flattened tree: projects → sessions, respecting collapse state and
  // the filter above, as a single array `VirtualizedProjectTree` windows
  // over. Only actually built once `shouldVirtualize` is true — below the
  // threshold this is a cheap `[]` and the plain `visibleProjects.map(...)`
  // branch below renders instead, so small dashboards (the common case)
  // never pay for this at all.
  const flatRows = useMemo<SidebarFlatRow[]>(() => {
    // `collapseVersion` carries no data of its own (see its own comment
    // above) — this reference exists only so `react-hooks/exhaustive-deps`
    // sees it used and doesn't flag the dep-array entry below as
    // unnecessary; the actual live read is `projectCollapsedState` inside
    // the loop.
    void collapseVersion;
    if (!shouldVirtualize) return [];
    const rows: SidebarFlatRow[] = [];
    for (const project of visibleProjects) {
      const base = baseSessionsByProject.get(project.id) ?? [];
      const derivedDefault = base.length === 0;
      // Read the SAME persisted `projectCollapsedState` object
      // ProjectSection itself reads/writes below — live, not a cached
      // snapshot (see `collapseVersion`'s own comment above for why that
      // distinction matters). Filter active -> force-expanded (same
      // "reveal matches rather than hide them behind a stale collapse"
      // reasoning as forceExpanded on ProjectSection below).
      const persistedCollapsed =
        project.id in projectCollapsedState ? projectCollapsedState[project.id] : null;
      const collapsed = filterActive ? false : (persistedCollapsed ?? derivedDefault);
      rows.push({
        key: `p-${project.id}`,
        type: "header",
        project,
        sessions: base,
        collapsed,
        derivedDefault,
      });
      if (collapsed) continue;
      const filtered = filteredSessionsByProject.get(project.id) ?? [];
      if (filtered.length === 0) {
        rows.push({ key: `e-${project.id}`, type: "empty" });
        continue;
      }
      const hRows = hierarchicalView
        ? buildHierarchicalRows(filtered)
        : filtered.map((session) => ({ session, depth: 0 }));
      for (const { session, depth } of hRows) {
        rows.push({ key: `s-${session.id}`, type: "session", session, project, depth });
      }
    }
    return rows;
  }, [
    shouldVirtualize,
    visibleProjects,
    baseSessionsByProject,
    filteredSessionsByProject,
    filterActive,
    collapseVersion,
    hierarchicalView,
  ]);

  return (
    <div className="sidebar">
      <button
        className={`sidebar-tasks-entry${viewMode === "kanban" ? " active" : ""}`}
        aria-pressed={viewMode === "kanban"}
        // Issue: this already claimed to be a toggle via aria-pressed, but
        // onOpenTasks only ever set viewMode to "kanban" — clicking it a
        // second time while already in Tasks did nothing, leaving the
        // Toolbar's "Back" chevron as the only way out. Honoring what the
        // a11y attribute already advertised.
        onClick={() =>
          viewMode === "kanban" ? useDashboardStore.getState().setViewMode("list") : onOpenTasks()
        }
      >
        <LayersIcon size={14} />
        <span className="sidebar-tasks-entry-label">Tasks</span>
        {actionableTaskCount > 0 && (
          <span className="project-attn-pill">{actionableTaskCount}</span>
        )}
      </button>
      <div className="sidebar-section-header">
        <span className="sidebar-section-title">Projects</span>
        <span className="project-session-count">sessions</span>
        <HierarchyToggle />
        <button
          className="toolbar-icon-btn"
          style={{ width: 22, height: 22 }}
          title="Add project"
          onClick={() => setAddProjectOpen(true)}
        >
          <PlusIcon size={15} strokeLinecap="round" strokeWidth={1.9} />
        </button>
      </div>
      {/* U3 — sticky at the top of the scrollable sidebar (see
        .sidebar-filter-bar's own `position: sticky` rule in styles.css) so
        it stays reachable while scrolled deep into a long session list —
        exactly the scenario ("past ~20 sessions") this filter exists for.
        Only shown once there's at least one project — an empty dashboard
        has nothing to filter, and the box would just add clutter to the
        "Welcome to Mullion" empty state below. */}
      {projects.length > 0 && (
        <div className="sidebar-filter-bar">
          <div className="sidebar-filter-search">
            <SearchIcon size={13} strokeWidth={1.9} />
            <input
              type="text"
              placeholder="Filter sessions…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Filter sessions"
            />
            {searchQuery !== "" && (
              <button
                type="button"
                className="sidebar-filter-clear"
                title="Clear filter"
                onClick={() => setSearchQuery("")}
              >
                <CloseIcon size={10} />
              </button>
            )}
          </div>
          <div className="sidebar-filter-chips" role="group" aria-label="Filter by status">
            {SIDEBAR_FILTER_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className={`sidebar-filter-chip${selectedChips.has(chip.id) ? " active" : ""}`}
                aria-pressed={selectedChips.has(chip.id)}
                onClick={() => toggleChip(chip.id)}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {projects.length === 0 ? (
        <EmptyState>
          <MullionMark size={32} className="ui-empty-state-mark" />
          <EmptyStateTitle>Welcome to Mullion</EmptyStateTitle>
          <EmptyStateBody>
            Add a project folder to start — sessions run there and survive across restarts.
          </EmptyStateBody>
          <EmptyStateActions>
            <button className="ui-empty-state-btn-primary" onClick={() => setAddProjectOpen(true)}>
              <PlusIcon size={12} strokeLinecap="round" strokeWidth={2.2} />
              Add a project
            </button>
            <button
              className="ui-empty-state-btn-secondary"
              onClick={() => setDiscoverCollapsed(false)}
            >
              <SearchIcon size={12} strokeWidth={2} />
              Scan for repos
            </button>
          </EmptyStateActions>
        </EmptyState>
      ) : (
        <>
          {/* U3 — the live GitHub CI subscription used to live inside
            ProjectSection's own effect, one per mounted instance. Split out
            so it has exactly one owner regardless of which rendering path
            below is active (ProjectSection isn't mounted at all once
            `shouldVirtualize` flips) — rendered for every project
            unconditionally (not just `visibleProjects`) since a filtered-out
            project's CI status should keep updating in the background, the
            same as it always has. */}
          {projects.map((project) => (
            <ProjectGitHubSubscription key={project.id} projectId={project.id} />
          ))}
          {filterActive && visibleProjects.length === 0 ? (
            <EmptyState>
              <EmptyStateTitle>No sessions match</EmptyStateTitle>
              <EmptyStateBody>
                Try a different search, or clear the status filters above.
              </EmptyStateBody>
            </EmptyState>
          ) : shouldVirtualize ? (
            <VirtualizedProjectTree
              rows={flatRows}
              hosts={hosts}
              onOpenSession={onOpenSession}
              onOpenSessionAsFloat={onOpenSessionAsFloat}
              onSessionEnded={onSessionEnded}
              onOpenProjectLauncher={onOpenProjectLauncher}
              onToggleCollapsed={toggleProjectCollapsedVirtualized}
            />
          ) : (
            visibleProjects.map((project) => (
              <ProjectSection
                key={project.id}
                project={project}
                hosts={hosts}
                onOpenSessionAsFloat={onOpenSessionAsFloat}
                sessions={filteredSessionsByProject.get(project.id) ?? []}
                allSessions={baseSessionsByProject.get(project.id) ?? []}
                onOpenSession={onOpenSession}
                onSessionEnded={onSessionEnded}
                onOpenLauncher={() => onOpenProjectLauncher(project.id)}
                hierarchicalView={hierarchicalView}
                forceExpanded={filterActive}
              />
            ))
          )}
        </>
      )}
      <SourceControlSection onOpenGit={onOpenGit} />
      <DiscoverProjects
        collapsed={discoverCollapsed}
        onToggleCollapsed={() => setDiscoverCollapsed((v) => !v)}
        onOpenSettingsProjects={onOpenSettingsProjects}
        hosts={hosts}
      />
      {addProjectOpen && (
        <CreateProjectModal
          hosts={hosts}
          initialPath={settingsLoaded ? (settings.projectRoots[0] ?? "") : ""}
          onClose={() => setAddProjectOpen(false)}
          onCreate={({ name, cwd, hostId, createDir, gitInit }) =>
            useDashboardStore.getState().createProject(name, cwd, hostId, { createDir, gitInit })
          }
        />
      )}
    </div>
  );
}

// U3 — the live GitHub CI subscription that used to live inline inside
// ProjectSection's own effect (see the "one owner" comment at its call site
// in Sidebar above). A standalone no-DOM component rather than a bare
// `useEffect` call in a loop — hooks can't be called conditionally/in a
// loop, so each project needs its own component instance to host its own
// effect.
function ProjectGitHubSubscription({ projectId }: { projectId: number }) {
  useEffect(() => {
    const store = useDashboardStore.getState();
    store.subscribeToGitHubProject(projectId);
    return () => useDashboardStore.getState().unsubscribeFromGitHubProject(projectId);
  }, [projectId]);
  return null;
}

// Above this many commits behind origin, the badge switches to a louder
// color (issue #433 scope A's "color the badge to draw attention" ask) — an
// arbitrary but reasonable line between "you'll want to pull soon" and
// "you're working from a very stale checkout".
const BEHIND_STALE_THRESHOLD = 10;

// U3 — persisted per-project collapse state. Same serialization/
// hydrate-once-at-module-load shape as readExpandedSessionRows below (read
// that block first) — the one difference is the data structure: expand
// state there only ever needs "is this id in the set of expanded rows"
// (absence == collapsed, the default), but collapse here has a THIRD state
// this component's own derivation already relies on — "never touched, follow
// the derived default" (see `manualCollapsed`'s own doc comment: an empty
// project starts collapsed, a non-empty one starts expanded, until the user
// overrides it). A bare `Set<id>` can't distinguish "explicitly expanded"
// from "never touched" the way a `Record<id, boolean>` can, so this uses the
// latter instead of mirroring the Set shape verbatim.
function readProjectCollapsedState(): Record<number, boolean> {
  const parsed = readJSON<unknown>(STORAGE_KEYS.projectCollapsed, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const result: Record<number, boolean> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = Number(key);
    if (Number.isFinite(id) && typeof value === "boolean") result[id] = value;
  }
  return result;
}

// Read once at module load (mirrors expandedSessionRows's own shape below)
// — every ProjectSection/VirtualizedProjectTree instance shares this one
// object rather than each re-reading localStorage on mount.
const projectCollapsedState = readProjectCollapsedState();

function setProjectCollapsedPersisted(projectId: number, collapsed: boolean): void {
  projectCollapsedState[projectId] = collapsed;
  writeJSON(STORAGE_KEYS.projectCollapsed, projectCollapsedState);
}

// U3 — the flattened row shape `VirtualizedProjectTree` windows over.
// String keys (not the array index) are passed to useVirtualizer's own
// `getItemKey` at the call site below — a dragged session row's DOM node
// must survive across the 4s `sessions` poll tick reshuffling earlier
// entries, which an index-keyed row wouldn't (React would treat "row at
// index 3 changed identity" as a full remount mid-drag).
interface ProjectHeaderFlatRow {
  key: string;
  type: "header";
  project: Project;
  // The project's own base (search/chip-unfiltered) session list — header
  // badges (count, attention pill) and the delete-project cascade all read
  // off this, deliberately NOT the filtered list `session` rows below draw
  // from, so an active search never shrinks the count badge or leaves a
  // real session's panel open after "Delete project" (see ProjectHeader's
  // own comment on `sessions` vs. the filtered list).
  sessions: Session[];
  collapsed: boolean;
  // Passed through to the toggle callback so it can compute "current -> not
  // current" without also needing its own copy of the derivation rule.
  derivedDefault: boolean;
}
interface SessionFlatRow {
  key: string;
  type: "session";
  session: Session;
  project: Project;
  depth: number;
}
interface EmptyProjectFlatRow {
  key: string;
  type: "empty";
}
type SidebarFlatRow = ProjectHeaderFlatRow | SessionFlatRow | EmptyProjectFlatRow;

// Extracted out of ProjectSection so both the plain (below-threshold) and
// virtualized (above-threshold) rendering paths share the exact same header
// markup/behavior instead of two copies drifting apart. Collapse is now
// owned by the CALLER (ProjectSection below, or Sidebar's own flatten step
// reading `projectCollapsedState` directly in the virtualized path) — this
// component is a pure function of `collapsed`/`onToggleCollapsed`, with no
// state of its own for it, so it doesn't matter which path is driving.
//
// P1 perf fix (carried over from ProjectSection's original header comment)
// — every field this component reads is either a prop (never a rendered
// whole-store subscription) or a single fine-grained selector
// (`gitStatuses[project.id]` below), and every write goes through
// `useDashboardStore.getState()` at its own call site rather than a
// destructured store hook — the same "selector or getState(), never a bare
// `useDashboardStore()`" rule this file's other components follow.
function ProjectHeader({
  project,
  sessions,
  hosts,
  collapsed,
  onToggleCollapsed,
  onOpenLauncher,
  onSessionEnded,
  bodyId,
}: {
  project: Project;
  sessions: Session[];
  hosts: Host[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenLauncher: () => void;
  onSessionEnded: (session: Session) => void;
  // P10/P11 polish — id of the collapsible region this header's
  // `aria-expanded` governs, for `aria-controls` (the disclosure-button
  // pattern; see UnifiedBoard.tsx's `kanban-lane-body` precedent). Only
  // ProjectSection's plain (below-threshold) rendering path has a single
  // contiguous body element to point at — the virtualized path (Sidebar's
  // own flatten step, above) renders each project's session rows as
  // independent absolutely-positioned siblings within one shared
  // virtualizer container, with no per-project wrapper element to give an
  // id, so that call site leaves this undefined rather than pointing
  // `aria-controls` at a div that doesn't exist.
  bodyId?: string;
}) {
  const [editOpen, setEditOpen] = useState(false);
  // P9 — deleteProject used to be `void deleteProject(...).then(...)` with
  // no `.catch` at all: a failure (a 503 host-unreachable, a locked file on
  // the project's own cwd, ...) left the project sitting in the sidebar
  // with no explanation, indistinguishable from the click never having
  // registered. Local, inline error state — same shape as
  // UnifiedBoard.tsx's TasksToolbar — rendered as a second line under this
  // header, same slot SessionRow's own eventLine/endError use.
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const attentionCount = sessions.filter((s) => s.attention).length;
  // Only a remote project needs a badge at all — the common single-host
  // deployment never shows one, matching CreateProjectModal's own selector
  // only appearing once a remote host exists.
  const host = project.hostId !== LOCAL_HOST_ID ? hosts.find((h) => h.id === project.hostId) : null;

  // Per-project git dirty badge (issue #76) — sourced from the store's
  // gitStatuses map (polled alongside sessions, see store.ts's
  // startLiveRefresh). A missing entry (not fetched yet, right after mount,
  // or a project that's genuinely never been a repo) renders the same as
  // `null` — both read as "nothing to report" rather than a distinct loading
  // state, which would just flicker on every mount. A project that HAS had a
  // successful fetch keeps showing that last-known-good entry through any
  // later transient failure (refreshGitStatuses preserves it rather than
  // overwriting with null) — this is what stops the dot from flickering
  // green→grey on a single flaky poll tick.
  const gitStatus = useDashboardStore((s) => s.gitStatuses[project.id]);
  // Issue #730 — the New-session button is inert in the Task view (no
  // workspace to open a terminal in), so it reads viewMode to disable itself.
  const viewMode = useDashboardStore((s) => s.viewMode);
  const gitDotClass = !gitStatus
    ? "none"
    : gitStatus.hasConflicts
      ? "conflict"
      : gitStatus.isClean
        ? "clean"
        : "dirty";
  const gitDotTitle = !gitStatus
    ? "Not a git repository"
    : gitStatus.hasConflicts
      ? `${gitStatus.branch}: unresolved merge conflicts`
      : gitStatus.isClean
        ? `${gitStatus.branch}: clean`
        : `${gitStatus.branch}: ${gitStatus.files.length} changed file${gitStatus.files.length === 1 ? "" : "s"}`;

  // Ahead/behind sync badge (issue #433 scope A) — `behind` only advances on
  // a `git fetch`, so it's only ever as fresh as the last one (auto-fetch,
  // or a manual Fetch from the GitPanel/Source Control section). The title's
  // "as of last fetch" caveat is what keeps a stale `↓0` (auto-fetch off, or
  // a branch with no upstream, both of which report 0/0 the same way
  // GitPanel's own ahead/behind row does) from silently reading as "you are
  // up to date" — see GitPanel.tsx's own `> 0` guards for the same posture.
  const gitSyncTitle = gitStatus
    ? `${gitStatus.branch}: ` +
      [
        gitStatus.ahead > 0 ? `${gitStatus.ahead} ahead` : null,
        gitStatus.behind > 0 ? `${gitStatus.behind} behind origin` : null,
      ]
        .filter(Boolean)
        .join(", ") +
      " (as of last fetch)"
    : "";

  return (
    <>
      <div
        className="project-row-header"
        onClick={onToggleCollapsed}
        // P10 — same role="button"/tabIndex/Enter-Space pattern as
        // SessionRow above (see that row's own comment for the full
        // rationale), including the `e.target !== e.currentTarget` guard:
        // this header nests its own "+ session" button and a KebabMenu
        // (both already wrapped in `onClick={(e) => e.stopPropagation()}`
        // for the mouse case), and without the guard tabbing to either and
        // pressing Enter/Space would ALSO toggle this row's collapse state.
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleCollapsed();
          }
        }}
      >
        <ChevronDownIcon
          size={12}
          className={collapsed ? "ws-group-chevron collapsed" : "ws-group-chevron"}
        />
        <FolderIcon size={15} />
        <span className="project-row-name" title={project.cwd}>
          {project.name}
        </span>
        <span className={`project-git-dot ${gitDotClass}`} title={gitDotTitle} />
        {/* Issue #433 scope A — ahead/behind vs. origin, already computed
          server-side into gitStatus.ahead/behind and already polled via
          the same gitStatuses map as the dot above; just not surfaced
          here until now. Renders nothing at 0/0 (a synced branch, or one
          with no upstream) — see GitPanel.tsx's own ahead/behind row for
          the identical guard. */}
        {gitStatus && (gitStatus.ahead > 0 || gitStatus.behind > 0) && (
          <span
            className={`project-git-sync${gitStatus.behind > BEHIND_STALE_THRESHOLD ? " stale" : ""}`}
            title={gitSyncTitle}
          >
            {gitStatus.ahead > 0 && <span className="project-git-ahead">↑{gitStatus.ahead}</span>}
            {gitStatus.behind > 0 && (
              <span className="project-git-behind">↓{gitStatus.behind}</span>
            )}
          </span>
        )}
        {/* Issue #431 — a lightweight presence indicator for this project's
          agent-rules files, riding along on the same GET /api/projects
          response as currentBranch above (see ruleFiles's own doc
          comment on api.ts's Project). Non-interactive — the command
          palette's "Agent Rules: <project>" entry is the click target;
          this is purely a signal, so it doesn't compete with the row's
          own collapse-on-click handler. */}
        {project.ruleFiles.length > 0 && (
          <span
            className="project-rules-indicator"
            title={`Agent rules: ${project.ruleFiles.join(", ")}`}
          >
            <FileTextIcon size={11} />
          </span>
        )}
        {host && (
          <span className="project-host-badge" title={`Runs on host: ${host.name}`}>
            <HostsIcon size={10} />
            {host.name}
          </span>
        )}
        {attentionCount > 0 && <span className="project-attn-pill">{attentionCount}</span>}
        <span className="project-session-count">{sessions.length}</span>
        <button
          className="project-add-session"
          title={
            viewMode === "kanban"
              ? "New session (unavailable in Task view)"
              : "New session in project"
          }
          disabled={viewMode === "kanban"}
          onClick={(e) => {
            e.stopPropagation();
            onOpenLauncher();
          }}
        >
          <PlusIcon size={13} strokeLinecap="round" strokeWidth={2.2} />
        </button>
        <span onClick={(e) => e.stopPropagation()}>
          <KebabMenu
            title="More…"
            items={[
              {
                key: "edit",
                label: "Edit",
                icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: () => setEditOpen(true),
              },
              {
                key: "delete",
                label: "Delete project",
                armLabel: "Click again to delete",
                icon: <CloseIcon size={14} />,
                danger: true,
                confirm: true,
                onClick: () => {
                  const endedSessions = sessions;
                  setDeleteError(null);
                  useDashboardStore
                    .getState()
                    .deleteProject(project.id)
                    .then(() => {
                      endedSessions.forEach(onSessionEnded);
                    })
                    .catch((err: unknown) => {
                      console.debug("[Sidebar] deleteProject failed", err);
                      setDeleteError(
                        err instanceof Error
                          ? err.message
                          : "Failed to delete project — try again.",
                      );
                    });
                },
              },
            ]}
          />
        </span>
        {editOpen && (
          <span onClick={(e) => e.stopPropagation()}>
            <CreateProjectModal
              mode="edit"
              initialName={project.name}
              initialPath={project.cwd}
              initialDevServerUrl={project.devServerUrl}
              detectedDevServerPort={project.detectedDevServerPort}
              projectId={project.id}
              initialDefaultAgent={project.defaultAgent}
              initialDefaultReviewAgent={project.defaultReviewAgent}
              initialMergeOnApprove={project.mergeOnApprove}
              initialAutoApprove={project.autoApprove}
              initialMaxAutoReturnRounds={project.maxAutoReturnRounds}
              initialConventionalCommitTitles={project.conventionalCommitTitles}
              initialAutoTagRelease={project.autoTagRelease}
              onClose={() => setEditOpen(false)}
              onCreate={({
                name,
                cwd,
                devServerUrl,
                defaultAgent,
                defaultReviewAgent,
                mergeOnApprove,
                autoApprove,
                maxAutoReturnRounds,
                conventionalCommitTitles,
                autoTagRelease,
                createDir,
                gitInit,
              }) =>
                useDashboardStore.getState().updateProject(project.id, {
                  name,
                  cwd,
                  devServerUrl,
                  defaultAgent,
                  defaultReviewAgent,
                  mergeOnApprove,
                  autoApprove,
                  maxAutoReturnRounds,
                  conventionalCommitTitles,
                  autoTagRelease,
                  createDir,
                  gitInit,
                })
              }
            />
          </span>
        )}
      </div>
      {deleteError && (
        <div className="project-row-error" title={deleteError}>
          {deleteError}
        </div>
      )}
    </>
  );
}

// Exported (mirrors SessionRow below) so ProjectSection.test.tsx can render
// it directly with a selector-based store mock, rather than mounting the
// whole Sidebar. Used for the plain (below VIRTUALIZE_SESSION_THRESHOLD)
// rendering path; VirtualizedProjectTree below is the above-threshold
// counterpart and shares ProjectHeader/SessionRow with this component
// rather than re-implementing them.
export function ProjectSection({
  project,
  sessions,
  allSessions,
  hosts,
  onOpenSession,
  onOpenSessionAsFloat,
  onSessionEnded,
  onOpenLauncher,
  hierarchicalView,
  forceExpanded = false,
}: {
  project: Project;
  sessions: Session[];
  // U3 — the project's base (search/chip-unfiltered) session list, for
  // ProjectHeader's count/attention badges and its delete-project cascade.
  // Optional and defaulting to `sessions` itself: every existing call site
  // before this PR passed one unfiltered list for both purposes (there was
  // no filter yet), and ProjectSection.test.tsx still does — this keeps
  // that call shape valid without every test needing to learn a second prop
  // it doesn't care about.
  allSessions?: Session[];
  hosts: Host[];
  onOpenSession: (session: Session) => void;
  onOpenSessionAsFloat: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
  onOpenLauncher: () => void;
  hierarchicalView: boolean;
  // U3 — set by Sidebar while its search/chip filter is active: reveals a
  // matching session inside an otherwise manually-collapsed project rather
  // than leaving it hidden behind a stale collapse state the user set
  // before they had any reason to expect it to hide a search match. Purely
  // a render-time override — it does NOT touch `manualCollapsed` below, so
  // clearing the filter restores exactly whatever collapse state the user
  // had before.
  forceExpanded?: boolean;
}) {
  // `manualCollapsed` is null until the user explicitly toggles — until then,
  // collapsed state is *derived* from whether the project has sessions
  // (empty projects start collapsed). A plain `useState(sessions.length ===
  // 0)` would be wrong here: projects and sessions load via independent
  // effects (see Sidebar's own refreshProjects/refreshSessions above), so a
  // project can mount with `sessions === []` before its sessions have
  // arrived, permanently collapsing an otherwise-active project. Deriving
  // instead means it stays reactive to that data landing, and "sticks" once
  // the user has an opinion. Initialized from PROJECT_COLLAPSED_KEY-backed
  // persisted state (U3) so an explicit toggle survives a reload — the same
  // "hydrate from localStorage once, on mount" shape EXPANDED_SESSION_ROWS_KEY
  // below already uses for the per-session git-details toggle, adapted to a
  // tri-state Record instead of a Set (see PROJECT_COLLAPSED_KEY's own doc
  // comment for why).
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(() =>
    project.id in projectCollapsedState ? projectCollapsedState[project.id] : null,
  );
  const derivedCollapsed = manualCollapsed ?? sessions.length === 0;
  const collapsed = forceExpanded ? false : derivedCollapsed;
  const toggleCollapsed = () => {
    const next = !collapsed;
    setManualCollapsed(next);
    setProjectCollapsedPersisted(project.id, next);
  };

  // Phase 5 (Track B, issue #195 5.5b) — flat mode keeps today's exact
  // depth-0 order; hierarchical mode nests children under their parent (see
  // buildHierarchicalRows's own doc comment for the orphan rule).
  const rows = useMemo(
    () =>
      hierarchicalView
        ? buildHierarchicalRows(sessions)
        : sessions.map((session) => ({ session, depth: 0 })),
    [sessions, hierarchicalView],
  );

  return (
    <div className="project-row">
      <ProjectHeader
        project={project}
        sessions={allSessions ?? sessions}
        hosts={hosts}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        onOpenLauncher={onOpenLauncher}
        onSessionEnded={onSessionEnded}
        bodyId={`project-row-body-${project.id}`}
      />

      {!collapsed && (
        <div className="project-row-body" id={`project-row-body-${project.id}`}>
          {sessions.length === 0 ? (
            <div className="project-empty-note">No sessions yet</div>
          ) : (
            rows.map(({ session, depth }) => (
              <SessionRow
                key={session.id}
                session={session}
                project={project}
                depth={depth}
                onOpen={() => onOpenSession(session)}
                onOpenAsFloat={() => onOpenSessionAsFloat(session)}
                // P9 — returns the promise (not `void`-discarded) so
                // SessionRow's own handleEnd can catch a rejection and
                // surface it inline instead of it disappearing.
                onEnd={() =>
                  useDashboardStore
                    .getState()
                    .deleteSession(session.id)
                    .then(() => onSessionEnded(session))
                }
                onPromoted={(newSession) => {
                  onSessionEnded(session);
                  onOpenSession(newSession);
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// U3's above-threshold rendering path — see VIRTUALIZE_SESSION_THRESHOLD's
// own comment. Windows a single flattened project+session row list with
// `@tanstack/react-virtual`, the same library (and estimate/measureElement
// pattern) NotificationBell.tsx already uses for its own variable-height
// virtualized feed — read that component's own `estimateSize`/
// `measureElement` usage first if touching this.
//
// Drag-and-drop: session rows stay `draggable` with the exact same
// onDragStart handler SessionRow always had (see that component). A drag
// can only ever be started from a row the user can see and click, so the
// source node is always mounted at drag-start time regardless of
// virtualization — the one real risk is the poll-driven `sessions` refresh
// (every 4s) reordering/inserting rows *during* an in-flight drag, which
// could otherwise cause React to tear down and recreate the dragged row's
// DOM node out from under the browser's native drag operation. `getItemKey`
// below (stable `p-<id>`/`s-<id>`/`e-<id>` strings, not array indices) is
// what prevents that — a row keeps its DOM identity across a mid-drag
// re-flatten as long as its own key doesn't change, which it doesn't for a
// session that's still there.
function VirtualizedProjectTree({
  rows,
  hosts,
  onOpenSession,
  onOpenSessionAsFloat,
  onSessionEnded,
  onOpenProjectLauncher,
  onToggleCollapsed,
}: {
  rows: SidebarFlatRow[];
  hosts: Host[];
  onOpenSession: (session: Session) => void;
  onOpenSessionAsFloat: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
  onOpenProjectLauncher: (projectId: number) => void;
  onToggleCollapsed: (projectId: number, derivedDefault: boolean) => void;
}) {
  // The scroll container is `.sidebar-wrapper` (App.tsx), an ANCESTOR of
  // this component, not an element it renders itself — `closest()` off a
  // ref inside this subtree is simpler than threading a ref down through
  // Sidebar/App.tsx's own prop surface just for this. A `useLayoutEffect`
  // (not a plain effect) so the virtualizer's first real measurement pass
  // already has the right element, avoiding an extra empty-then-populated
  // render flash.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setScrollElement(listRef.current?.closest<HTMLElement>(".sidebar-wrapper") ?? null);
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    getItemKey: (index) => rows[index]?.key ?? index,
    // Content above this list within the same `.sidebar-wrapper` scroll
    // region (the Tasks entry, the Projects section header, the filter bar)
    // isn't part of this virtualizer's own item list, so its item offsets
    // need to be shifted by that content's height — tanstack's own
    // documented `scrollMargin` pattern for "virtualize part of a taller
    // scroll container", using this list's own `offsetTop` as the measured
    // margin (see the transform below for the matching subtraction).
    scrollMargin: listRef.current?.offsetTop ?? 0,
    estimateSize: (index) => estimateSidebarRowHeight(rows[index], expandedSessionRows),
    overscan: 8,
  });

  return (
    // `getTotalSize()` does NOT include `scrollMargin` in its return value
    // — verified by reading @tanstack/virtual-core's own source
    // (`getTotalSize`: `end - this.options.scrollMargin + this.options.paddingEnd`,
    // where `end` is the last item's own end position, itself computed
    // starting from `paddingStart + scrollMargin` — so the subtraction
    // inside the library already cancels the margin back out) and by
    // constructing a headless `Virtualizer` directly and calling
    // `getTotalSize()` against a known count/estimateSize/scrollMargin
    // (see the sizeMath test in Sidebar.test.tsx, which fails if this
    // ever changes upstream). So `getTotalSize()` is already just the sum
    // of row sizes — exactly this div's own correct in-flow height, since
    // its `offsetTop` (normal document flow, after the preceding
    // tasks-entry/header/filter-bar content) already accounts for
    // `scrollMargin` separately. A fix landed in an earlier round of this
    // PR's review subtracted `scrollMargin` a SECOND time here, believing
    // `getTotalSize()` still included it — that was wrong and undersized
    // this div by exactly `scrollMargin`, which a second, independent
    // review round caught (the pre-fix code, with no subtraction, was
    // actually already correct).
    <div
      ref={listRef}
      style={{
        position: "relative",
        height: rowVirtualizer.getTotalSize(),
      }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow: VirtualItem) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start - rowVirtualizer.options.scrollMargin}px)`,
            }}
          >
            {row.type === "header" ? (
              <div className="project-row">
                <ProjectHeader
                  project={row.project}
                  sessions={row.sessions}
                  hosts={hosts}
                  collapsed={row.collapsed}
                  onToggleCollapsed={() => onToggleCollapsed(row.project.id, row.derivedDefault)}
                  onOpenLauncher={() => onOpenProjectLauncher(row.project.id)}
                  onSessionEnded={onSessionEnded}
                />
              </div>
            ) : row.type === "empty" ? (
              <div className="sidebar-vrow-session">
                <div className="project-empty-note">No sessions yet</div>
              </div>
            ) : (
              <div className="sidebar-vrow-session">
                <SessionRow
                  session={row.session}
                  project={row.project}
                  depth={row.depth}
                  onOpen={() => onOpenSession(row.session)}
                  onOpenAsFloat={() => onOpenSessionAsFloat(row.session)}
                  // P9 — see ProjectSection's identical onEnd above.
                  onEnd={() =>
                    useDashboardStore
                      .getState()
                      .deleteSession(row.session.id)
                      .then(() => onSessionEnded(row.session))
                  }
                  onPromoted={(newSession) => {
                    onSessionEnded(row.session);
                    onOpenSession(newSession);
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// estimateSidebarRowHeight (VirtualizedProjectTree's useVirtualizer
// estimateSize above) moved to lib/sidebarRowSizing.ts (PR 27 phase 1) —
// see that module's own doc comment for why `SidebarFlatRow` itself stayed
// here rather than moving with it, and why `expandedSessionRows` (below) is
// now passed in explicitly at the call site instead of closed over.

// The 4 status treatments the redesign's States doc specifies (confirmed
// against the design source — its tab-chrome badge grid has exactly these
// four, no "Killed" badge): attention (prominent, animated, "needs input"),
// working (green pulse), idle (hollow dot), exited (dimmed, program ended
// on its own). A killed session never reaches this component — Sidebar.tsx
// filters `status === "killed"` out of the list before it gets here, since
// the design's kill flow removes the row entirely rather than leaving a
// dimmed tombstone (see Sidebar's own filter comment). Attention takes
// priority over working/idle since it's the highest-value signal for an
// unwatched dashboard.

// describeEvent/describeLatestEvent (the kind/payload interpretation this
// row's status line uses) moved to eventDescriptions.ts for #169, which
// needed the exact same rules for its event-feed panel — see that module's
// own doc comment.

// Row 3's expand/collapse toggle (issue #202) persists per session, same
// single-localStorage-key convention as the sidebar's own collapse/width
// state (store.ts's STORAGE_KEYS.sidebarCollapsed/sidebarWidth) rather than
// one key per session — there's no existing per-*session* persisted-UI-state
// precedent to follow instead (ProjectSection's own collapse above is
// in-memory `useState`, derived fresh each mount). Module-level (not store
// state) since this is pure, session-scoped UI state no other component
// needs to read.
function readExpandedSessionRows(): Set<number> {
  const parsed = readJSON<unknown>(STORAGE_KEYS.expandedSessionRows, []);
  return new Set(Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : []);
}

// Read once at module load (mirrors readStoredSidebarWidth's own shape in
// store.ts) — every SessionRow instance shares this one Set rather than
// each re-reading localStorage on mount.
const expandedSessionRows = readExpandedSessionRows();

function setSessionRowExpanded(sessionId: number, expanded: boolean): void {
  if (expanded) expandedSessionRows.add(sessionId);
  else expandedSessionRows.delete(sessionId);
  writeJSON(STORAGE_KEYS.expandedSessionRows, [...expandedSessionRows]);
}

// Row 5 (subagents)/row 6 (background tasks) chips, and row 4's file-change
// chips + expanded diff (SessionFileDiff), all extracted to
// ./session-row/Chips.tsx and ./session-row/FileChanges.tsx respectively
// (PR 27 phase 2, Wave 5 of .claude/plans/can-we-do-a-warm-cocke.md) — see
// each file's own header comment. That includes the subagent-row
// expand/collapse localStorage persistence helpers (mirrors
// readExpandedSessionRows/setSessionRowExpanded above, but keyed by
// `${sessionId}:${agentId}` — see Chips.tsx) and isSubagentLive/
// subagentDotClass/backgroundTaskLetter/fileChangeDotClass/fileChangeLetter
// (all pure, moved to lib/sidebarStatus.ts in PR 27 phase 1).
//
// sessionGitDotClass/sessionPrDotClass/summarizeFileChanges (also
// lib/sidebarStatus.ts) power row 3 (git details, ./session-row/GitLine.tsx)
// — summarizeFileChanges itself stays called from SessionRow below (its
// input, sessionEvents, is also row 2's eventLine source, so it isn't a
// FileChanges-only concern). ProjectHeader's own gitStatus handling above
// stays inlined rather than routed through sessionGitDotClass (matches
// git-refs.ts's own "small guards get duplicated, not shared" precedent
// elsewhere in this codebase).

const FILE_CHANGE_MAX_SHOWN = 5;

export function SessionRow({
  session,
  project,
  onOpen,
  onOpenAsFloat,
  onEnd,
  onPromoted,
  alwaysExpandGit = false,
  showSubagents = true,
  depth = 0,
}: {
  session: Session;
  project: Project;
  onOpen: () => void;
  onOpenAsFloat?: () => void;
  // Passed straight through to PromoteDialog (see that prop's own doc
  // comment) — optional so UnifiedBoard.tsx's ad-hoc session lane and
  // existing tests that don't exercise promote need no change.
  onPromoted?: (newSession: Session) => void;
  // P9 — every caller (ProjectSection's plain rendering path and
  // VirtualizedProjectTree's above-threshold path, both in this file, plus
  // UnifiedBoard.tsx's ad-hoc session lane) builds this from
  // `deleteSession(...).then(...)`; a failure used to vanish into an
  // unhandled rejection with the session still sitting right there in the
  // list. `void | Promise<void>` (not a bare `Promise<void>`) so the ~80
  // existing `onEnd={vi.fn()}` test doubles across this file's own test
  // suite keep type-checking unchanged — this component wraps the call in
  // `Promise.resolve(...)` below specifically so a caller that still
  // returns nothing (a test mock, or any future caller) degrades to
  // exactly today's silent-success behavior instead of throwing on
  // `.catch` of a non-Promise.
  onEnd: () => void | Promise<void>;
  // A caller with room to always show git details can skip the
  // collapse-by-default toggle this row uses everywhere else (the sidebar's
  // own narrow, scrollable tree) — originally added for issue #211's
  // KanbanBoard.tsx; UnifiedBoard.tsx's ad-hoc session lane leaves this
  // unset (the per-row toggle stays available) rather than always expanding,
  // since a horizontal lane of cards has less room than that board did.
  alwaysExpandGit?: boolean;
  // UnifiedBoard.tsx's ad-hoc session lane passes `false` — its cards are
  // meant to stay flat (issue #195/5.5a), same opt-out shape as
  // alwaysExpandGit above, not a new mechanism.
  showSubagents?: boolean;
  // Phase 5 (Track B, issue #195 5.5b) — how many levels deep this row
  // renders (project → session → child session, so only 0 or 1 is possible
  // today: nesting is capped at one level server-side, see
  // createSessionRecord's "parent-is-child" rejection). An explicit prop
  // rather than recursion: SessionRow (now this orchestrator plus its
  // Header/GitLine/FileChanges/Chips sub-components under ./session-row/,
  // split in PR 27 phase 2) is shared verbatim by UnifiedBoard.tsx's ad-hoc
  // lane (which never passes this, so its cards stay flat for free) —
  // recursing here would force that lane to opt out of a second thing
  // instead of just not knowing this prop exists at all.
  depth?: number;
}) {
  const isTerminal = session.status === "killed";
  const confirmBeforeKill = useDashboardStore((s) => s.settings.sessions.confirmBeforeKill);
  // #719 — per-session mute, read from the store so the sidebar kebab's label
  // stays in sync with the tab overflow menu / toolbar bell.
  const isMuted = useDashboardStore((s) => s.mutedSessionIds.includes(session.id));
  // Phase 5 (Track B, issue #196 5.6) — killSession's default is "detach"
  // (a live child becomes an independent top-level session, never
  // silently killed), but that consequence still needs to be visible in
  // the UI before the DELETE fires rather than happening invisibly. Full
  // session list (not whatever's already filtered into this project
  // section) so the count is correct regardless of "hide ended sessions".
  const allSessions = useDashboardStore((s) => s.sessions);
  const childCount = useMemo(
    () => liveChildCount(allSessions, session.id),
    [allSessions, session.id],
  );
  const theme = useDashboardStore((s) => s.theme);
  // Issue #167 — the 1.1 events store slice (store.ts's `events`, fed by
  // eventsClient.ts), scoped to just this session's list. Selector-based so
  // a live event for a DIFFERENT session's list doesn't re-render this row.
  const sessionEvents = useDashboardStore((s) => s.events[session.id]);
  const eventLine = describeLatestEvent(sessionEvents);
  const agentLogo = resolveAgentLogo(session.command, theme);
  const agentBinary = commandToBinary(session.command);
  const renameSession = useDashboardStore((s) => s.renameSession);

  // Row 4 (issue #177) — recent file changes, derived from the same
  // sessionEvents slice as row 2's eventLine above (no separate fetch).
  // Passed down to ./session-row/FileChanges.tsx as a prop rather than
  // computed there — it stays here because sessionEvents (its input) is
  // ALSO row 2's eventLine source above, so this can't become a
  // FileChanges-only concern without either re-subscribing to the same
  // store slice twice or splitting sessionEvents itself across two
  // components. FileChanges owns `expandedFilePath` itself, though —
  // nothing outside its own chip row + detail pairing ever reads that.
  const fileChanges = useMemo(
    () => summarizeFileChanges(sessionEvents).slice(0, FILE_CHANGE_MAX_SHOWN),
    [sessionEvents],
  );

  // Row 3's data (issue #202) — worktree/branch/PR/diff-stats. Selector-based
  // per field (not one selector returning an object) so a live update to a
  // DIFFERENT session's — or a different project's — slice doesn't re-render
  // this row, same reasoning as sessionEvents above.
  const gitStatus = useDashboardStore((s) => s.sessionGitStatuses[session.id]);
  // Issue: sidebar worktree detection — for sessions in a worktree, prefer
  // the poll-derived git status over hook-reported liveBranch: opencode's
  // vcs.branch.updated always reports the main checkout's branch, while the
  // per-session git status correctly resolves against the worktree cwd via
  // resolveSessionCwdTargets + OSC 7 liveCwd tracking. Outside a worktree,
  // liveBranch still takes priority. Falls back to project.currentBranch.
  const effectiveCwd = session.liveCwd ?? session.cwd ?? project.cwd;
  const inWorktree = effectiveCwd !== project.cwd;
  const displayBranch = inWorktree
    ? (gitStatus?.branch ?? session.liveBranch ?? project.currentBranch)
    : (session.liveBranch ?? gitStatus?.branch ?? project.currentBranch);
  const diffStats = useDashboardStore((s) => s.gitDiffStats[session.id]);
  const branchesResult = useDashboardStore((s) => s.gitBranchesByProject[project.id]);
  const prsStatus = useDashboardStore((s) => s.prsByProject[project.id]);

  // Issue #271 — auto-opens for an agent-triggered `promote_request` (the
  // model's tool call is blocked until this dialog resolves it, one way or
  // another — see PromoteDialog's own header comment) and stays available
  // via the kebab menu below for a human-initiated promote otherwise.
  // Adjusts state during render (React's own recommended pattern for
  // "reopen when a prop transitions", not an Effect — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // rather than a `useEffect` + setState, which the project's lint config
  // (react-hooks/set-state-in-effect) rejects as a cascading-render risk.
  // Initializer covers a row that mounts already "pending" (e.g. a page
  // refresh while a request is mid-flight); the render-time check below
  // covers a later transition into "pending" on an already-mounted row.
  //
  // Stays here (not pushed into Header, where the "promote" kebab item
  // lives) because PromoteDialog itself renders as a SIBLING of the
  // `.session-item` div below, not inside Header's own region — Header only
  // gets a bound `onPromote` callback to open it.
  const [promoteOpen, setPromoteOpen] = useState(() => session.promoteState === "pending");
  const [prevPromoteState, setPrevPromoteState] = useState(session.promoteState);
  if (session.promoteState !== prevPromoteState) {
    setPrevPromoteState(session.promoteState);
    if (session.promoteState === "pending") setPromoteOpen(true);
  }

  // Stays here (not pushed into Header) because it gates whether GitLine
  // renders at all, below — Header only owns the toggle *button*, not the
  // line it controls.
  const [gitLineExpanded, setGitLineExpanded] = useState(() => expandedSessionRows.has(session.id));
  const toggleGitLineExpanded = useCallback(() => {
    setGitLineExpanded((prev) => {
      const next = !prev;
      setSessionRowExpanded(session.id, next);
      return next;
    });
  }, [session.id]);
  const gitExpanded = alwaysExpandGit || gitLineExpanded;

  // P9 — surfaces a failed `onEnd()` inline (see that prop's own doc
  // comment for why the type stays `void | Promise<void>`) instead of the
  // rejection just vanishing, same "an inline error near the control that
  // triggered the request" shape as ProjectHeader's deleteError above.
  // Stays here (not pushed into Header) because the error line itself
  // renders as a sibling of Header below, not inside it.
  const [endError, setEndError] = useState<string | null>(null);
  const handleEnd = () => {
    setEndError(null);
    Promise.resolve(onEnd()).catch((err: unknown) => {
      console.debug("[Sidebar] end session failed", err);
      setEndError(err instanceof Error ? err.message : "Failed to end session — try again.");
    });
  };

  // Matched against this project's own worktree list — `undefined`/no match
  // (the common case: most sessions just run at the project's own cwd, which
  // is always the *main* worktree) means no worktree label, not an error.
  const worktree = branchesResult?.worktrees.find((w) => w.path === effectiveCwd && !w.isMain);
  const worktreeLabel = worktree ? (worktree.path.split("/").filter(Boolean).pop() ?? null) : null;

  // The open PR (if any) for this session's own branch — matched
  // client-side against the project's unfiltered PR list rather than
  // firing a `?branch=` request per session (api.ts's getProjectGitHubPRs
  // doc comment). Uses displayBranch (which inverts precedence for worktree
  // sessions — preferring poll-derived git status over hook-reported
  // liveBranch) so branches from worktree sessions still match their PRs.
  const matchedPr =
    displayBranch && prsStatus?.prs
      ? prsStatus.prs.find((pr) => pr.headBranch === displayBranch)
      : undefined;

  // U3 — factored into sessionDisplayTitle (module scope, top of file) so
  // the sidebar's new search filter matches against exactly this same
  // precedence rather than drifting from it.
  const title = sessionDisplayTitle(session);

  const showCommand = title === session.command;
  // Suppress the agent binary label when the title already starts with it
  // (e.g. command fallback "npm run build" already includes "npm") to avoid
  // redundant "npm npm run build" rendering.
  const showAgentFallback =
    !agentLogo && !(title === agentBinary || title.startsWith(agentBinary + " "));

  // Issue #351 — the matched hook adapter's emits are surfaced directly on
  // each session (computed once at launch from adapter.matches()), so a
  // wrapped/aliased command correctly gets its real adapter's capability list
  // rather than silently falling back to empty (the old binary->agent lookup
  // could only match on the unparsed binary, not the full command string).
  const agentEmits: readonly string[] = session.hookEmits;
  const statusReachable = isStatusReachable(session.sessionStatus, agentEmits);
  const statusEstimated = !statusReachable;

  // Row 5 (Phase 5 Track A, #195/5.5a) — same hookEmits-gating precedent as
  // statusReachable above: a codex/agy session can never emit "subagent" (see
  // sessionStatus.ts's EMITS_REQUIREMENTS), so this must not render an empty
  // "Subagents" affordance for them. Also suppressed once there's nothing to
  // show, and by KanbanBoard's showSubagents={false} opt-out.
  const subagentsReachable = isStatusReachable("subagent", agentEmits);
  const showSubagentsRow = showSubagents && subagentsReachable && session.subagents.length > 0;

  // Row 6 (issue #428) — same hookEmits-gating precedent as Row 5 above,
  // against the "background" status's own EMITS_REQUIREMENTS entry. Data is
  // already filtered to outstanding-only server-side (SessionInfo.
  // outstandingBackgroundTasks — see pty-manager.ts's toInfo()), so no
  // further filtering is needed here, same "presentation only" posture as
  // everything else this component reads off `session`.
  const backgroundTasksReachable = isStatusReachable("background", agentEmits);
  const showBackgroundTasksRow =
    backgroundTasksReachable && session.outstandingBackgroundTasks.length > 0;

  const presentation = STATUS_PRESENTATION[session.sessionStatus];
  const statusClass = rowClassNameForSeverity(session.sessionStatusSeverity);
  const dot = (
    <span
      className="session-dot-wrap"
      title={
        statusEstimated
          ? "Estimated status — this agent doesn't report this state directly"
          : undefined
      }
    >
      {session.sessionStatus === "exited" ? (
        <CloseIcon size={10} style={{ color: "var(--dim)" }} />
      ) : (
        <span
          className={`session-dot-${presentation.tone}${statusEstimated ? " estimated" : ""}`}
        />
      )}
    </span>
  );
  // Issue #323: state-restored and stale-hooks indicators.
  const showUnknownIndicator = !session.stateRestored && session.alive;
  const showStaleIndicator = session.staleHooks;
  const statusLabelText = formatStatusLabel(presentation, session.sessionStatusDetail);
  const statusLabel = (
    <span className={`session-status-label ${presentation.tone}`} title={statusLabelText}>
      {showUnknownIndicator && (
        <span title="Awaiting data… — session state not yet restored after restart">?</span>
      )}
      {statusLabelText}
      {showStaleIndicator && (
        <span
          className="session-stale-icon"
          title={`Session launched with Mullion ${session.restoredVersion ?? "unknown"}, restart to pick up new capabilities`}
        >
          &#9201;
        </span>
      )}
    </span>
  );

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData("application/x-mullion-session", String(session.id));
      e.dataTransfer.setData("text/plain", title);
      e.dataTransfer.effectAllowed = "move";
    },
    [session.id, title],
  );

  return (
    <>
      <div
        className={`session-item ${statusClass}${statusEstimated ? " status-estimated" : ""}`}
        // CSS custom property, not a computed inline margin — styles.css
        // owns the actual indent math (base + depth * step), same "component
        // supplies data, CSS supplies presentation" split as every other
        // status-driven class on this row.
        style={depth > 0 ? ({ "--session-depth": depth } as React.CSSProperties) : undefined}
        onClick={onOpen}
        draggable={true}
        onDragStart={onDragStart}
        // P10 — this is the single most-used control in the app ("opening a
        // session is mouse-only" before this fix), so it gets the same
        // role="button"/tabIndex/Enter-Space pattern as UnifiedBoard.tsx's
        // TaskCard and NotificationBell.tsx's EventRow. Unlike either of
        // those two, this row nests a REAL focusable rename `<input>` plus
        // several of its own buttons (git-details toggle, kebab menu, end
        // session) — every one of those already stops click propagation
        // (the `onClick={(e) => e.stopPropagation()}` wrapper spans below),
        // which keeps a mouse click on any of them from also opening the
        // session. That alone doesn't cover keyboard: a nested `<button>`'s
        // native Enter/Space activation dispatches its own click AND a raw
        // keydown that bubbles here independently of that click's
        // stopPropagation (a different event entirely) — so tabbing to,
        // say, the kebab menu and pressing Enter would fire this row's
        // onOpen too without a guard. `e.target !== e.currentTarget` is that
        // guard: it only treats Enter/Space as "open" when the KEYDOWN's own
        // target is the row itself (i.e. the row, not some focused
        // descendant, has focus), which also covers typing Enter into the
        // rename input for free — no per-descendant stopPropagation needed,
        // unlike NotificationBell's GateActions, which has to do that by
        // hand for its nested reason field.
        role="button"
        tabIndex={0}
        aria-label={`Open session ${title}`}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <Header
          title={title}
          showCommand={showCommand}
          agentLogo={agentLogo}
          showAgentFallback={showAgentFallback}
          agentBinary={agentBinary}
          model={session.model}
          dot={dot}
          statusLabel={statusLabel}
          gitStatus={gitStatus}
          alwaysExpandGit={alwaysExpandGit}
          gitLineExpanded={gitLineExpanded}
          onToggleGitLineExpanded={toggleGitLineExpanded}
          isTerminal={isTerminal}
          isMuted={isMuted}
          onToggleMute={() => useDashboardStore.getState().toggleSessionMute(session.id)}
          onOpenAsFloat={onOpenAsFloat}
          onPromote={() => setPromoteOpen(true)}
          onRename={(value) => {
            void renameSession(session.id, value);
          }}
          childCount={childCount}
          confirmBeforeKill={confirmBeforeKill}
          onConfirmEnd={handleEnd}
        />
        {eventLine && (
          <span
            className={`session-event-line${eventLine.attention ? " attention" : ""}`}
            title={eventLine.text}
          >
            {eventLine.text}
          </span>
        )}
        {endError && (
          <span className="session-end-error" title={endError}>
            {endError}
          </span>
        )}
        {/* Single-line summary, not a second-tier "full" layout with its own
          narrow variant: the sidebar's resizable width defaults to (and can
          go no lower than) SIDEBAR_MIN_WIDTH (store.ts), so any JS width
          threshold for hiding content here would either be unreachable or
          hide content at the *default* width — neither is "shrinks when
          space is tight." `.session-git-line`'s own `overflow: hidden` +
          ellipsis (styles.css) is what actually delivers that: the line
          truncates as the sidebar narrows, same as row 2's
          `.session-event-line` already does. */}
        {/* Show git info when the row is expanded AND there's either
          per-session git status or a hook-reported liveBranch to show. */}
        {gitExpanded && (gitStatus != null || displayBranch) ? (
          <GitLine
            gitStatus={gitStatus}
            displayBranch={displayBranch}
            worktreeLabel={worktreeLabel}
            effectiveCwd={effectiveCwd}
            matchedPr={matchedPr}
            diffStats={diffStats}
          />
        ) : null}
        {/* Row 4 (issue #177) — recent file changes from the structured hook
          channel (Phase 2), not the git working-tree diff row 3 shows above.
          Always visible once there's at least one file_change event, same
          ungated posture as row 2 — not nested inside the git-details
          toggle, since an agent can emit these without the session's cwd
          even being a git repo. Owns its own expand/collapse state and the
          expanded-diff fetch internally — see FileChanges.tsx. */}
        <FileChanges sessionId={session.id} fileChanges={fileChanges} />
        {/* Row 5 (Phase 5 Track A, #195/5.5a, subagents) and row 6 (issue
          #428, background tasks) — both "always visible once there's
          something to show" chip strips, gated on session.hookEmits via
          isStatusReachable above (a sessionStatus.ts concern, so it stays
          here rather than moving into Chips.tsx). See Chips.tsx. */}
        <Chips
          sessionId={session.id}
          showSubagentsRow={showSubagentsRow}
          subagents={session.subagents}
          showBackgroundTasksRow={showBackgroundTasksRow}
          outstandingBackgroundTasks={session.outstandingBackgroundTasks}
        />
      </div>
      {promoteOpen && (
        <PromoteDialog
          session={session}
          project={project}
          onClose={() => setPromoteOpen(false)}
          onPromoted={onPromoted}
        />
      )}
    </>
  );
}

// Vision item #1 — suggests candidates from PROJECTS_ROOTS, never
// auto-inserts. Read-only until the user clicks Add, which is just the
// existing POST /api/projects the manual form above already uses.
//
// `candidates` distinguishes "not yet fetched" (null) from "fetched, zero
// results" ([]) — the design's empty state 1C ("discovery ran · nothing
// found / roots unconfigured") only applies to the latter; rendering
// nothing while the very first fetch is still in flight avoids a state
// flash on load.
function DiscoverProjects({
  collapsed,
  onToggleCollapsed,
  onOpenSettingsProjects,
  hosts,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenSettingsProjects: () => void;
  hosts: Host[];
}) {
  // P1 perf fix — both fields here are pure actions (never read reactively),
  // same reasoning as ProjectSection's own header comment above.
  const [candidates, setCandidates] = useState<DiscoveredProject[] | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  // Keyed by cwd — a discovered candidate's own create can fail (e.g. it
  // vanished from disk between scan and click) and previously failed
  // silently (an unhandled rejection, no UI feedback at all).
  const [addErrors, setAddErrors] = useState<Map<string, string>>(new Map());
  const [hostId, setHostId] = useState(LOCAL_HOST_ID);
  // Distinguishes "discovery ran, found nothing" from "discovery failed" —
  // both otherwise render as an identical "0 found" empty state, which
  // reads a genuinely unreachable host the same as an empty search root
  // (Hermes review, PR #35).
  const [discoverError, setDiscoverError] = useState(false);
  const remoteHosts = hosts.filter((h) => h.id !== LOCAL_HOST_ID);
  // The selected host can be deleted (Settings -> Hosts) while this panel
  // is open — `hostId` itself only ever changes via the picker's onChange,
  // so falling back here (derived at render time, not an effect writing
  // state back) is what actually keeps discovery from targeting an id that
  // no longer exists, without an extra render/effect round-trip (Hermes
  // review, PR #35). "This machine" is always present, so this is a no-op
  // for the common single-host case.
  const selectedHostId =
    hostId === LOCAL_HOST_ID || remoteHosts.some((h) => h.id === hostId) ? hostId : LOCAL_HOST_ID;

  // Deliberately doesn't reset `candidates` to null up front — switching
  // hosts would otherwise flash the "0 found" empty state on every change
  // instead of just replacing the list once the new host's results land.
  // `added` resets alongside it (inside the same async callback, not
  // synchronously in the effect body — react-hooks/set-state-in-effect):
  // a cwd match is per-(hostId, cwd), same as the backend's own
  // registeredCwds query in routes/projects.ts, so the previous host's
  // "just added" set is meaningless once `forHostId` changes.
  const load = (forHostId: string) => {
    api
      .discoverProjects(forHostId)
      .then((found) => {
        setCandidates(found);
        setAdded(new Set());
        setDiscoverError(false);
      })
      .catch(() => {
        setCandidates([]);
        setAdded(new Set());
        setDiscoverError(true);
      });
  };

  useEffect(() => {
    load(selectedHostId);
  }, [selectedHostId]);

  if (candidates === null) return null;

  const remaining = candidates.filter((c) => !c.isRegistered && !added.has(c.cwd));

  // Only rendered once a remote host actually exists — same "no extra UI
  // for a single-host deployment" rule CreateProjectModal's own selector
  // follows.
  const hostPicker = remoteHosts.length > 0 && (
    <span onClick={(e) => e.stopPropagation()}>
      <Dropdown
        small
        value={selectedHostId}
        onChange={setHostId}
        options={[
          { value: LOCAL_HOST_ID, label: "This machine" },
          ...remoteHosts.map((h) => ({ value: h.id, label: h.name })),
        ]}
      />
    </span>
  );

  if (remaining.length === 0) {
    return (
      <div className="discover-block">
        <EmptyState>
          <EmptyStateIcon variant="warn">
            <SearchAlertIcon size={18} />
          </EmptyStateIcon>
          <EmptyStateTitle>
            {discoverError ? "Discovery failed" : "No repositories found"}
          </EmptyStateTitle>
          <EmptyStateBody>
            {discoverError
              ? "Couldn't reach the selected host to scan for repositories. Check that it's online and try again."
              : "Mullion scanned your search roots but found no git projects. Point it at a folder that contains your repos."}
          </EmptyStateBody>
          {hostPicker && <div style={{ marginTop: 8 }}>{hostPicker}</div>}
          <EmptyStateActions>
            {!discoverError && (
              <button className="ui-empty-state-btn-primary" onClick={onOpenSettingsProjects}>
                Configure search roots
              </button>
            )}
            <button className="ui-empty-state-btn-secondary" onClick={() => load(selectedHostId)}>
              {discoverError ? "Retry" : "Rescan"}
            </button>
          </EmptyStateActions>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="discover-block">
      <div className="discover-header" onClick={onToggleCollapsed}>
        <ChevronDownIcon
          size={14}
          className={collapsed ? "ws-group-chevron collapsed" : "ws-group-chevron"}
        />
        <span className="discover-title">Discover projects</span>
        <span className="discover-count">{remaining.length} found</span>
        {hostPicker}
      </div>
      {!collapsed && (
        <div className="discover-body">
          {remaining.map((c) => (
            <div key={c.cwd} className="discover-item">
              <FolderIcon size={14} style={{ color: "var(--muted)" }} />
              <span className="discover-item-name">{c.name}</span>
              {c.isGitRepo && <span className="discover-git-badge">git</span>}
              <button
                className="discover-add"
                onClick={() => {
                  const store = useDashboardStore.getState();
                  setAddErrors((prev) => {
                    if (!prev.has(c.cwd)) return prev;
                    const next = new Map(prev);
                    next.delete(c.cwd);
                    return next;
                  });
                  store
                    .createProject(c.name, c.cwd, selectedHostId)
                    .then(() => {
                      setAdded((prev) => new Set(prev).add(c.cwd));
                      void store.refreshProjects();
                    })
                    .catch((err: unknown) => {
                      // Discover only lists directories a scan already
                      // found on disk, so a missing-directory 400 here is
                      // near-impossible — but this used to be a silent
                      // unhandled rejection either way (issue: same bug as
                      // CreateProjectModal's own pre-fix confirm()).
                      setAddErrors((prev) =>
                        new Map(prev).set(
                          c.cwd,
                          err instanceof ApiError ? err.message : "Could not add project",
                        ),
                      );
                    });
                }}
              >
                Add
              </button>
              {addErrors.has(c.cwd) && (
                <div className="project-row-error" title={addErrors.get(c.cwd)}>
                  {addErrors.get(c.cwd)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
