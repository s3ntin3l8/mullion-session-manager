import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/react-virtual";
import { useDashboardStore } from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import { CreateProjectModal } from "./CreateProjectModal.js";
import type { Host, Project, Session } from "./api/index.js";
import { projectSpansHosts } from "./lib/hostBadge.js";
import { MullionMark } from "./assets/MullionMark.js";
import { TextInput } from "./ui/primitives.js";
import { EmptyState, EmptyStateActions, EmptyStateBody, EmptyStateTitle } from "./ui/EmptyState.js";
import { ErrorText } from "./ui/ErrorText.js";
import {
  CloseIcon,
  LayersIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SkillIcon,
  WarningTriangleIcon,
} from "./ui/icons.js";
import { STORAGE_KEYS, readJSON, writeJSON } from "./lib/persistedState.js";
import {
  dockColumnProjectIds,
  readDockManualProjectIds,
  subscribeDockManualProjectIds,
} from "./dock/dockHelpers.js";
import { taskLinkedSessionIds } from "./boardLanes.js";
import { HierarchyToggle } from "./HierarchyToggle.js";
import { buildHierarchicalRows } from "./sidebarHierarchy.js";
import { SourceControlSection } from "./SourceControlSection.js";
import { columnForSession } from "./kanban.js";
import type { KanbanColumnId } from "./kanban.js";
import { isListedSession, sessionMatchesSearch } from "./lib/sessionDisplay.js";
import { estimateSidebarRowHeight } from "./lib/sidebarRowSizing.js";
import { DiscoverProjects } from "./sidebar/DiscoverProjects.js";
import { ProjectHeader } from "./sidebar/ProjectHeader.js";
import { expandedSessionRows } from "./session-row/expandedSessionRows.js";
import { SessionRow } from "./session-row/SessionRow.js";

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

export interface SidebarProps {
  // Source Control lives in the right sidebar on desktop and tablet; only the
  // phone navigator (which has no right sidebar) still renders it here.
  showSourceControl: boolean;
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
  // App.tsx already had this callback (for Source Control's own command-palette
  // entry, issue #76) but never threaded it down to Sidebar until now.
  onOpenGit: (projectId: number) => void;
  // Phase 4 (issue #1205's plan, Gap F) — "Scaffold Mullion" used to be
  // reachable only from the Command Palette; App.tsx already had this
  // callback (for the palette's own entry) but never threaded it down to
  // Sidebar until now, so the project's own kebab menu can offer it too.
  onOpenProjectSetup: (projectId: number) => void;
  // Issue #1877 — the Dock's workspaceProjectIds (App.tsx, via
  // workspaceProjectIdsFromPanels): the projects with a session open in
  // the live layout. null means "do not scope" — the phone tier, which has
  // no workspaces, and desktop until that set is actually knowable (the
  // layout restored and GET /api/sessions resolved). An empty array is a
  // real workspace with nothing tiled into it yet. Manual Dock pins are
  // not in this array; the tree unions them itself via dockColumnProjectIds,
  // the same helper Dock.tsx builds its columns with.
  workspaceProjectIds?: number[] | null;
  // Terminal panes already in that same layout. null means "don't mark"
  // (phone, or a caller that isn't workspace-scoped). Activating one of
  // these still goes through onOpenSession, which focuses the existing pane
  // rather than opening a second one — see usePanelOpener.
  openSessionIds?: number[] | null;
  // The empty workspace state has no project rows left, so it has no
  // per-project "+" either. This is App's openGlobalLauncher — the
  // toolbar's launcher / Ctrl-K — not the project-scoped opener above.
  onOpenGlobalLauncher: () => void;
}

export function Sidebar({
  showSourceControl,
  onOpenSession,
  onOpenSessionAsFloat,
  onSessionEnded,
  onOpenProjectLauncher,
  onOpenSettingsProjects,
  onOpenTasks,
  onOpenGit,
  onOpenProjectSetup,
  workspaceProjectIds = null,
  openSessionIds = null,
  onOpenGlobalLauncher,
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
    projectsLoaded,
    projectsError,
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
      // The three states an empty project list can be in — still loading,
      // loaded-and-empty, and failed. Without these, "Welcome to Mullion"
      // covered all three, so a failed fetch looked like a fresh install
      // (audit finding 14).
      projectsLoaded: s.projectsLoaded,
      projectsError: s.projectsError,
    })),
  );
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  // Lifted here (rather than owned entirely inside DiscoverProjects) so the
  // "Welcome to Mullion" empty state's "Scan for repos" button can force it
  // open, matching the design's two-button first-run CTA.
  const [discoverCollapsed, setDiscoverCollapsed] = useState(true);

  // Phase 4 (Gap F) — the post-create "want to scaffold this?" offer.
  // `newProjectRef` is a ref, not state: it's written inside the
  // CreateProjectModal's own `onCreate` (fires on a successful create) and
  // read inside `onClose` (fires right after, in the same user gesture,
  // except the confirm-first PROJECT_DIR_MISSING retry path — see that
  // callback's own comment) — nothing in between needs to re-render on it.
  // Carries `{id, name}` straight off `onCreate`'s own resolved result
  // rather than looking the id up in `projects` afterward — `createProject`
  // only *triggers* a `refreshProjects()` (store/slices/projects.ts), it
  // doesn't await it, so the new row isn't guaranteed to be in `projects`
  // yet by the time `onClose` fires.
  // `scaffoldOfferProject` is the actual banner-visibility state,
  // deliberately never store-persisted (#944: an integration affordance is
  // a dismissible nudge, not an onboarding gate) — dismissing it, or
  // navigating away, drops it for good, same as the update banner above.
  const newProjectRef = useRef<{ id: number; name: string } | null>(null);
  const [scaffoldOfferProject, setScaffoldOfferProject] = useState<{
    id: number;
    name: string;
  } | null>(null);
  // code-review round 1 — opening a second "Add project" modal while an
  // unactioned offer from a PREVIOUS create is still showing left the
  // banner visible alongside/underneath the new modal, so its "Scaffold
  // Mullion" button could navigate to the WRONG (stale) project once the
  // new create resolved. Clearing on open, not on the modal's own onClose,
  // ensures whichever create finishes first controls the banner.
  const openAddProject = useCallback(() => {
    setScaffoldOfferProject(null);
    setAddProjectOpen(true);
  }, []);

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
    // The projects fetch is the one whose failure is SURFACED (the sidebar
    // renders the failure state below), so it is caught rather than left
    // to reject unhandled. The slice records the error itself before
    // rethrowing (see slices/projects.ts), so the catch here only has to
    // stop the unhandled rejection.
    void store.refreshProjects().catch(() => {});
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

  // Issue #1877 — null means "do not scope" (the phone tier, and desktop
  // until App knows the workspace). An array is the panel-derived project
  // ids, in that order. Manual Dock pins are not in the array;
  // dockColumnProjectIds unions them the same way Dock.tsx builds its
  // columns, so a project pinned with nothing tiled still appears here,
  // sessions and all. A project the dashboard knows about that is neither
  // tiled nor pinned is not in this list.
  const manualProjectIds = useSyncExternalStore(
    subscribeDockManualProjectIds,
    readDockManualProjectIds,
  );
  const treeProjects = useMemo(() => {
    if (workspaceProjectIds == null) return projects;
    const ids = dockColumnProjectIds(workspaceProjectIds, manualProjectIds, projects);
    const byId = new Map(projects.map((p) => [p.id, p]));
    const scoped: Project[] = [];
    for (const id of ids) {
      const project = byId.get(id);
      if (project) scoped.push(project);
    }
    return scoped;
  }, [projects, workspaceProjectIds, manualProjectIds]);
  const openSessionIdSet = useMemo(
    () => (openSessionIds == null ? null : new Set(openSessionIds)),
    [openSessionIds],
  );

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
    for (const project of treeProjects) {
      map.set(
        project.id,
        sessions.filter(
          (s) =>
            s.projectId === project.id &&
            isListedSession(s, {
              hideEndedSessions,
              showTaskSessions,
              taskSessionIds,
              includeExited: selectedChips.has("exited"),
            }),
        ),
      );
    }
    return map;
  }, [treeProjects, sessions, hideEndedSessions, showTaskSessions, taskSessionIds, selectedChips]);

  // Issue #2238 — once per project: does it span hosts? Computed from the
  // store's FULL session list (not the display-filtered base list), so a
  // Settings toggle or chip never flips a badge and the pane tab agrees.
  const spansHostsByProject = useMemo(() => {
    const map = new Map<number, boolean>();
    for (const project of treeProjects) map.set(project.id, projectSpansHosts(project, sessions));
    return map;
  }, [treeProjects, sessions]);

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
    for (const project of treeProjects) {
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
  }, [treeProjects, baseSessionsByProject, searchQuery, selectedChips]);

  // U3 — a project with zero matches while a filter is active is skipped
  // entirely, not shown collapsed or with an empty body: the same "nothing
  // to render, don't render a husk" posture DiscoverProjects' own
  // `remaining.length === 0` branch takes below, just one level further in
  // (that panel hides itself as a whole when nothing's left to discover;
  // this hides each individually-empty project section while leaving
  // matching ones alone). Scoped to treeProjects (issue #1877) so a filter
  // can't reveal a project that isn't in this workspace.
  const visibleProjects = useMemo(
    () =>
      filterActive
        ? treeProjects.filter((p) => (filteredSessionsByProject.get(p.id)?.length ?? 0) > 0)
        : treeProjects,
    [treeProjects, filterActive, filteredSessionsByProject],
  );

  // Issue #1889 — the Projects section header's caption. It used to be the
  // bare word "sessions", which read as a label with no number (or a number
  // that never got filled in); it is now the count of the sessions the
  // section holds, with its unit, so it reads as the total of the
  // per-project numbers directly beneath it.
  //
  // It sums the SAME quantity the per-project numbers show — a project's own
  // session count, which is its "base" list (the sessions the sidebar would
  // list for it, ignoring the search box and the chips; ProjectHeader reads
  // exactly that list, via ProjectSection's `allSessions` prop and the
  // virtualized path's own `sessions: base`). Summing over `visibleProjects`
  // rather than over every project keeps that promise while a filter is
  // active: a project the filter matched nothing in is not listed at all, so
  // its sessions are not counted either.
  //
  // With no filter active, `visibleProjects` IS `treeProjects` — the scoped
  // set, which is every project when the scope is null — and the sum is
  // `totalBaseSessionCount` by construction (that count is reduced over
  // `baseSessionsByProject`, itself built from `treeProjects`). So that is
  // what it reads, rather than a second reduction of the same numbers (one
  // source of truth for "how many sessions").
  const sectionSessionCount = useMemo(
    () =>
      filterActive
        ? visibleProjects.reduce(
            (sum, project) => sum + (baseSessionsByProject.get(project.id)?.length ?? 0),
            0,
          )
        : totalBaseSessionCount,
    [filterActive, visibleProjects, baseSessionsByProject, totalBaseSessionCount],
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
      // Sidebar declutter (issue #1465) — no "empty" placeholder row: an
      // empty `filtered` list just contributes nothing here, same as
      // ProjectSection's own `rows.map(...)` below the threshold (see that
      // component's matching comment).
      const filtered = filteredSessionsByProject.get(project.id) ?? [];
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
      <>
        <div className="sidebar-section-header">
          <h2 className="sidebar-section-title">Projects</h2>
          {/* Issue #1889 — this caption was the bare word "sessions":
                a label with no number, or a number that never got filled
                in. It is the count now, with its unit, so it reads as the
                total of the per-project numbers below it.

                It renders only once there is something to count, the same
                declutter rule the per-project badge follows ("a project
                with no sessions at all doesn't need a '0' sitting in its
                header"). */}
          {sectionSessionCount > 0 && (
            <span className="sidebar-section-count">
              <span className="sidebar-section-count-value">{sectionSessionCount}</span>{" "}
              <span className="sidebar-section-count-unit">
                {sectionSessionCount === 1 ? "session" : "sessions"}
              </span>
            </span>
          )}
          <HierarchyToggle />
          <button
            className="toolbar-icon-btn"
            style={{ width: 22, height: 22 }}
            title="Add project"
            onClick={openAddProject}
          >
            <PlusIcon size={15} strokeLinecap="round" strokeWidth={1.9} />
          </button>
        </div>
        {/* The list below is the last-known-good one when a refresh
              failed, which is the right thing to keep on screen — but the
              user has to be told it is stale, or a project added on another
              device silently never appears here. */}
        {projectsError && projects.length > 0 && (
          <ErrorText style={{ margin: "0 0 6px" }}>
            Could not refresh projects — showing the last known list. {projectsError}
          </ErrorText>
        )}
        {/* U3 — sticky at the top of the scrollable sidebar (see
        .sidebar-filter-bar's own `position: sticky` rule in styles.css) so
        it stays reachable while scrolled deep into a long session list —
        exactly the scenario ("past ~20 sessions") this filter exists for.
        Only shown once the section is actually listing a project — an empty
        dashboard, and a workspace with nothing tiled into it, have nothing
        to filter. */}
        {treeProjects.length > 0 && (
          <div className="sidebar-filter-bar">
            <div className="sidebar-filter-search ui-input-wrap">
              <SearchIcon size={13} strokeWidth={1.9} />
              <TextInput
                small
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
          projectsError ? (
            // The fetch FAILED — not "you have no projects". This used to
            // render the "Welcome to Mullion" first-run state forever,
            // which told a user with a working dashboard and a flaky
            // connection that they had never added a project (audit
            // finding 14).
            <EmptyState>
              <WarningTriangleIcon size={26} className="ui-empty-state-mark" />
              <EmptyStateTitle>Could not load your projects</EmptyStateTitle>
              <ErrorText style={{ marginBottom: 8 }}>{projectsError}</ErrorText>
              <EmptyStateActions>
                <button
                  className="ui-empty-state-btn-primary"
                  onClick={() => {
                    void useDashboardStore
                      .getState()
                      .refreshProjects()
                      .catch(() => {});
                  }}
                >
                  <RefreshIcon size={12} strokeWidth={2} />
                  Retry
                </button>
              </EmptyStateActions>
            </EmptyState>
          ) : !projectsLoaded ? (
            // Still loading — the first run's "Welcome to Mullion" is the
            // wrong thing to show for a list that is on its way.
            <EmptyState>
              <MullionMark size={32} className="ui-empty-state-mark" />
              <EmptyStateTitle>Loading projects…</EmptyStateTitle>
            </EmptyState>
          ) : (
            <EmptyState>
              <MullionMark size={32} className="ui-empty-state-mark" />
              <EmptyStateTitle>Welcome to Mullion</EmptyStateTitle>
              <EmptyStateBody>
                Add a project folder to start — sessions run there and survive across restarts.
              </EmptyStateBody>
              <EmptyStateActions>
                <button
                  className="ui-empty-state-btn-primary"
                  onClick={() => setAddProjectOpen(true)}
                >
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
          )
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
            {treeProjects.length === 0 ? (
              // Issue #1877 — the dashboard HAS projects; none of them are
              // tiled into this workspace or pinned to the Dock. "Welcome
              // to Mullion" would be a lie here (that state is the
              // projects.length === 0 branch above). Same membership as
              // the Dock's columns: a session open in the live layout, or
              // a "+ Add project" pin.
              <EmptyState>
                <EmptyStateTitle>Nothing tiled in this workspace</EmptyStateTitle>
                <EmptyStateBody>
                  A project shows up here once one of its sessions is open in this layout, or you
                  pin it from the Dock. Launch a session to put one here.
                </EmptyStateBody>
                <EmptyStateActions>
                  <button className="ui-empty-state-btn-primary" onClick={onOpenGlobalLauncher}>
                    <PlusIcon size={12} strokeLinecap="round" strokeWidth={2.2} />
                    Launch a session
                  </button>
                </EmptyStateActions>
              </EmptyState>
            ) : filterActive && visibleProjects.length === 0 ? (
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
                spansHostsByProject={spansHostsByProject}
                openSessionIds={openSessionIdSet}
                onOpenSession={onOpenSession}
                onOpenSessionAsFloat={onOpenSessionAsFloat}
                onSessionEnded={onSessionEnded}
                onOpenProjectLauncher={onOpenProjectLauncher}
                onToggleCollapsed={toggleProjectCollapsedVirtualized}
                onOpenProjectSetup={onOpenProjectSetup}
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
                  spansHosts={spansHostsByProject.get(project.id) ?? false}
                  onOpenSession={onOpenSession}
                  onSessionEnded={onSessionEnded}
                  onOpenLauncher={() => onOpenProjectLauncher(project.id)}
                  onOpenProjectSetup={() => onOpenProjectSetup(project.id)}
                  hierarchicalView={hierarchicalView}
                  forceExpanded={filterActive}
                  openSessionIds={openSessionIdSet}
                />
              ))
            )}
          </>
        )}
        {showSourceControl && <SourceControlSection onOpenGit={onOpenGit} />}
        <DiscoverProjects
          collapsed={discoverCollapsed}
          onToggleCollapsed={() => setDiscoverCollapsed((v) => !v)}
          onOpenSettingsProjects={onOpenSettingsProjects}
          hosts={hosts}
        />
      </>
      {addProjectOpen && (
        <CreateProjectModal
          hosts={hosts}
          initialPath={settingsLoaded ? (settings.projectRoots[0] ?? "") : ""}
          onClose={() => {
            setAddProjectOpen(false);
            // Phase 4 (Gap F) — only surface the offer once the modal
            // actually finishes closing, so it never renders underneath a
            // still-open modal (the confirm-first PROJECT_DIR_MISSING
            // retry path resolves onCreate but keeps the modal open for a
            // second confirm — see CreateProjectModal's own gitInitFailed
            // handling — so onClose, not onCreate, is the right trigger).
            if (newProjectRef.current !== null) {
              setScaffoldOfferProject(newProjectRef.current);
              newProjectRef.current = null;
            }
          }}
          onCreate={async ({
            name,
            cwd,
            hostId,
            createDir,
            gitInit,
            placement,
            allowDuplicate,
          }) => {
            const project = await useDashboardStore
              .getState()
              // Issue #1726 / roadmap 8.12 — the placement mode rides in the
              // same opts bag as createDir/gitInit.
              .createProject(name, cwd, hostId, { createDir, gitInit, placement, allowDuplicate });
            newProjectRef.current = { id: project.id, name: project.name };
            return project;
          }}
        />
      )}
      {scaffoldOfferProject && (
        <div className="scaffold-offer-banner">
          <div className="scaffold-offer-banner-header">
            <SkillIcon size={14} style={{ color: "var(--b)", flexShrink: 0 }} />
            <span className="scaffold-offer-banner-title">
              Set up Mullion&rsquo;s conventions in &ldquo;{scaffoldOfferProject.name}&rdquo;?
            </span>
            <span
              className="scaffold-offer-banner-dismiss"
              role="button"
              tabIndex={0}
              onClick={() => setScaffoldOfferProject(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setScaffoldOfferProject(null);
                }
              }}
              title="Dismiss"
            >
              ×
            </span>
          </div>
          {/* Plan's own "with the project's conventions preview inline" —
              the same install-wide text ProjectSetupPanel.tsx's own
              disclosure reads (see its comment for why this is not a
              second source of truth: computeScaffold resolves and commits
              the SAME text server-side). Empty when unconfigured — the
              scaffold still has SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS to fall
              back to, so this stays worth offering either way. */}
          {settings.sessions.workflowConventionsText && (
            <div className="scaffold-offer-banner-preview">
              {settings.sessions.workflowConventionsText}
            </div>
          )}
          <div className="scaffold-offer-banner-actions">
            <button
              className="scaffold-offer-banner-accept"
              onClick={() => {
                onOpenProjectSetup(scaffoldOfferProject.id);
                setScaffoldOfferProject(null);
              }}
            >
              Scaffold Mullion
            </button>
          </div>
        </div>
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
type SidebarFlatRow = ProjectHeaderFlatRow | SessionFlatRow;

// P9 — the identical onEnd / onPromoted pair used by ProjectSection and
// VirtualizedProjectTree. Returns the promise (not `void`-discarded) so
// SessionRow's own handleEnd can catch a rejection and surface it inline
// instead of it disappearing. Both call sites call this helper.
function sessionEndHandlers(
  session: Session,
  onSessionEnded: (session: Session) => void,
  onOpenSession: (session: Session) => void,
) {
  return {
    onEnd: () =>
      useDashboardStore
        .getState()
        .deleteSession(session.id)
        .then(() => onSessionEnded(session)),
    onPromoted: (newSession: Session) => {
      onSessionEnded(session);
      onOpenSession(newSession);
    },
  };
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
  spansHosts = false,
  hosts,
  onOpenSession,
  onOpenSessionAsFloat,
  onSessionEnded,
  onOpenLauncher,
  onOpenProjectSetup,
  hierarchicalView,
  forceExpanded = false,
  openSessionIds = null,
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
  // Issue #2238 — the project spans hosts, so a local row gets a badge too.
  spansHosts?: boolean;
  hosts: Host[];
  onOpenSession: (session: Session) => void;
  onOpenSessionAsFloat: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
  onOpenLauncher: () => void;
  onOpenProjectSetup: () => void;
  hierarchicalView: boolean;
  // U3 — set by Sidebar while its search/chip filter is active: reveals a
  // matching session inside an otherwise manually-collapsed project rather
  // than leaving it hidden behind a stale collapse state the user set
  // before they had any reason to expect it to hide a search match. Purely
  // a render-time override — it does NOT touch `manualCollapsed` below, so
  // clearing the filter restores exactly whatever collapse state the user
  // had before.
  forceExpanded?: boolean;
  // Issue #1877 — terminal panes already in this workspace. null (the
  // phone tier, and every caller that isn't the sidebar) marks nothing.
  openSessionIds?: ReadonlySet<number> | null;
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
        onOpenProjectSetup={onOpenProjectSetup}
        bodyId={`project-row-body-${project.id}`}
      />

      {/* Sidebar declutter (issue #1465) — a project with no visible sessions
        renders nothing here (an empty, zero-height body) rather than a
        permanent "No sessions yet" line: that line never conveyed anything
        actionable, and could get stuck showing indefinitely once a
        project's sessions all end/get hidden by `hideEndedSessions` while a
        manual expand from when it DID have sessions was still persisted
        (`manualCollapsed ?? sessions.length === 0` above only supplies a
        DEFAULT — an explicit prior expand always wins over it). `rows` is
        derived straight from `sessions`, so an empty list here already
        renders nothing on its own; no separate empty-state branch needed. */}
      {!collapsed && (
        <div className="project-row-body" id={`project-row-body-${project.id}`}>
          {rows.map(({ session, depth }) => (
            <SessionRow
              key={session.id}
              session={session}
              project={project}
              spansHosts={spansHosts}
              depth={depth}
              onOpen={() => onOpenSession(session)}
              onOpenAsFloat={() => onOpenSessionAsFloat(session)}
              openInWorkspace={openSessionIds?.has(session.id) ?? false}
              // P9 — returns the promise (not `void`-discarded) so
              // SessionRow's own handleEnd can catch a rejection and
              // surface it inline instead of it disappearing.
              {...sessionEndHandlers(session, onSessionEnded, onOpenSession)}
            />
          ))}
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
  spansHostsByProject,
  openSessionIds,
  onOpenSession,
  onOpenSessionAsFloat,
  onSessionEnded,
  onOpenProjectLauncher,
  onToggleCollapsed,
  onOpenProjectSetup,
}: {
  rows: SidebarFlatRow[];
  hosts: Host[];
  spansHostsByProject: ReadonlyMap<number, boolean>;
  openSessionIds: ReadonlySet<number> | null;
  onOpenSession: (session: Session) => void;
  onOpenSessionAsFloat: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
  onOpenProjectLauncher: (projectId: number) => void;
  onToggleCollapsed: (projectId: number, derivedDefault: boolean) => void;
  onOpenProjectSetup: (projectId: number) => void;
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
                  onOpenProjectSetup={() => onOpenProjectSetup(row.project.id)}
                />
              </div>
            ) : (
              <div className="sidebar-vrow-session">
                <SessionRow
                  session={row.session}
                  project={row.project}
                  spansHosts={spansHostsByProject.get(row.project.id) ?? false}
                  depth={row.depth}
                  onOpen={() => onOpenSession(row.session)}
                  onOpenAsFloat={() => onOpenSessionAsFloat(row.session)}
                  openInWorkspace={openSessionIds?.has(row.session.id) ?? false}
                  // P9 — see ProjectSection's identical onEnd above.
                  {...sessionEndHandlers(row.session, onSessionEnded, onOpenSession)}
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
// here rather than moving with it, and why `expandedSessionRows`
// (session-row/expandedSessionRows.ts, shared with SessionRow) is passed in
// explicitly at the call site instead of closed over.

export { SessionRow } from "./session-row/SessionRow.js";
