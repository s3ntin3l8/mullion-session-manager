import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDashboardStore } from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import {
  TASK_COLUMNS,
  canDragToColumn,
  orderTasksForColumn,
  computeTaskReorder,
  absoluteDropIndex,
} from "./tasksBoard.js";
import {
  taskLinkedSessionIds,
  adhocSessionsByColumn,
  LANE_COLUMN_ORDER,
  laneColumnTitle,
} from "./unifiedBoard.js";
import { orderSessionsForColumn, computeKanbanReorder } from "./kanban.js";
import { TaskDetail } from "./TaskDetail.js";
import type { Session, TaskStatus } from "./api/index.js";
import { ApiError } from "./api/index.js";
import {
  BlockedIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  LayersIcon,
} from "./ui/icons.js";
import { useDragResize } from "./hooks/useDragResize.js";
import {
  STORAGE_KEYS,
  readNumber,
  writeNumber,
  readJSON,
  writeJSON,
  readBool,
  writeBool,
  readString,
  writeString,
} from "./lib/persistedState.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import { TasksToolbar } from "./unified-board/TasksToolbar.js";
import { TaskColumn } from "./unified-board/TaskColumn.js";
import { LaneCard } from "./unified-board/LaneCard.js";

// Detail drawer resize (see the drag-handle logic in UnifiedBoard below) —
// same localStorage-key naming convention as store.ts's sidebarWidth.
const DEFAULT_DRAWER_WIDTH = 380; // .kanban-detail-drawer's own prior fixed width
const MIN_DRAWER_WIDTH = 300;
// Reserves at least this much width for the columns behind the drawer —
// .kanban-unified-columns .kanban-column's own min-width (200px) plus a
// sliver of the next column, so dragging the drawer wide never collapses
// the board down to zero visible columns.
const MIN_COLUMNS_WIDTH = 240;

// #701 — sentinel for the parent/phase filter's "(no parent)" option. Never
// a valid "repo#number" key (those always contain "#" preceded by a repo
// slug, never this exact string), so it safely shares the same string
// state as a real selection without a separate boolean.
const PARENT_FILTER_NONE = "__none__";

function clampDrawerWidth(n: number, maxW: number): number {
  return Math.min(Math.max(n, MIN_DRAWER_WIDTH), Math.max(MIN_DRAWER_WIDTH, maxW));
}

// Merges Mullion's two Kanban surfaces (issue #211's session-only
// KanbanBoard.tsx + 6.5/#218's TasksPanel.tsx, both deleted) into one: task
// status columns are the board, every session not owned by a task collects
// in an "ad-hoc sessions" lane beneath it, and a task-owned session instead
// renders nested on its own card (unified-board/TaskCard.tsx's
// TaskSessionSlot). The sole `viewMode === "kanban"` overlay surface in
// App.tsx.
//
// Split into unified-board/*.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md) — this file now owns the board's
// own orchestration (task drag-and-drop, the detail drawer and its resize,
// the ad-hoc lane's collapse/grouping) while TasksToolbar/TaskColumn/
// TaskCard/TaskSessionSlot/LaneCard live in unified-board/ as focused,
// mostly-presentational components.
export function UnifiedBoard({
  onOpenSession,
  onSessionEnded,
}: {
  onOpenSession: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
}) {
  // P1 perf fix — was a single bare `useDashboardStore()` (whole-store
  // subscription). `refreshTasks`/`updateTask`/`createTask`/`deleteSession`/
  // `setViewMode`/`setKanbanColumnOrder` are all pure action-callers (used
  // inside effects/handlers below, never read as a value) — see the
  // useDashboardStore.getState() calls at their own call sites instead of
  // subscribing to them here.
  const {
    tasks,
    tasksLoaded,
    sessions,
    projects,
    taskMasterEnabled,
    hideEndedSessions,
    kanbanOrder,
    theme,
  } = useDashboardStore(
    useShallow((s) => ({
      tasks: s.tasks,
      tasksLoaded: s.tasksLoaded,
      sessions: s.sessions,
      projects: s.projects,
      taskMasterEnabled: s.taskMasterEnabled,
      hideEndedSessions: s.hideEndedSessions,
      kanbanOrder: s.kanbanOrder,
      theme: s.theme,
    })),
  );

  useEffect(() => {
    void useDashboardStore.getState().refreshTasks();
  }, []);

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  // Board-wide project filter (empty = every project, the default) — a
  // client-only render-time filter, not a fetch param: `tasks` in the store
  // always holds every task install-wide (see store.ts's refreshTasks), and
  // must keep doing so here too, because computeTaskReorder below reindexes
  // a target column's FULL contents on every drop, including whatever a
  // filter is currently hiding. #610 considered and cut a project filter
  // for exactly this hazard ("the drag/reorder math indexes against the
  // rendered list, not the full store list, and filtering would silently
  // corrupt boardOrder on drop") — applyDrop's use of absoluteDropIndex
  // below is what closes that gap: it translates a filtered TaskColumn's
  // own rendered index back into the equivalent index against the full,
  // unfiltered column before computeTaskReorder ever sees it.
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>(() => {
    const raw = readJSON<unknown>(STORAGE_KEYS.taskProjectFilter, []);
    return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number") : [];
  });
  // Drops ids for projects deleted since they were selected — same posture
  // as Dock.tsx's own manualIds/columnIds filtering.
  const activeProjectIds = useMemo(
    () => selectedProjectIds.filter((id) => projectsById.has(id)),
    [selectedProjectIds, projectsById],
  );
  const toggleProjectFilter = (id: number) => {
    const next = activeProjectIds.includes(id)
      ? activeProjectIds.filter((p) => p !== id)
      : [...activeProjectIds, id];
    setSelectedProjectIds(next);
    writeJSON(STORAGE_KEYS.taskProjectFilter, next);
  };
  const clearProjectFilter = () => {
    setSelectedProjectIds([]);
    writeJSON(STORAGE_KEYS.taskProjectFilter, []);
  };
  // Issue: a blocked task's badge is easy to miss scrolling past a large
  // board — same "client-only render filter" posture as the project filter
  // above, and it composes with it via the same absoluteDropIndex path
  // (UnifiedBoard's own drop handler below), which is what makes stacking a
  // second filter on top of the first safe for boardOrder.
  const [blockedOnly, setBlockedOnly] = useState(() =>
    readBool(STORAGE_KEYS.taskBlockedOnlyFilter, false),
  );
  // Keeps localStorage in sync with `blockedOnly` on every change, including
  // the render-time reset below — a plain "sync state to an external
  // system" effect, not a setState-in-effect (nothing here calls
  // setBlockedOnly), so toggleBlockedOnly and the reset below don't need
  // their own separate writeBool calls.
  useEffect(() => {
    writeBool(STORAGE_KEYS.taskBlockedOnlyFilter, blockedOnly);
  }, [blockedOnly]);
  const toggleBlockedOnly = () => setBlockedOnly((prev) => !prev);
  const hasBlockedTask = useMemo(() => tasks.some((t) => t.blockedState === "blocked"), [tasks]);
  // Gated on hasBlockedTask, not just the persisted `blockedOnly` flag —
  // otherwise a user who toggled this on, then had every blocked task
  // resolve/close, would be stuck looking at an empty board with no visible
  // way back: the toggle button itself is only rendered while hasBlockedTask
  // is true (see below), so a filter that stayed active regardless would
  // have no on-screen affordance left to turn it off. Same "no way back"
  // trap category as the view-mode navigation issue this same change fixes
  // elsewhere — worth avoiding here too.
  //
  // Hermes review, PR #699 — the gate above silently overrode the *live*
  // filter but left the *persisted* flag (and the in-memory `blockedOnly`
  // state) at true, so it would silently re-engage the next time any task
  // became blocked (even weeks later, after a reload). Reset `blockedOnly`
  // itself — not just an effect's local read of it — whenever the gate is
  // the thing actually suppressing the filter, so re-engaging it is always
  // an explicit click again. Adjusted during render rather than in a
  // useEffect (React's documented pattern for resetting state when a
  // derived value changes — see "Adjusting some state when a prop
  // changes" in react.dev's "You Might Not Need an Effect"): a
  // useEffect-driven reset would paint one extra frame with the stale
  // "still active" toggle before correcting itself, and would need to
  // duplicate the persistence effect above's job instead of composing
  // with it.
  const [prevHasBlockedTask, setPrevHasBlockedTask] = useState(hasBlockedTask);
  if (hasBlockedTask !== prevHasBlockedTask) {
    setPrevHasBlockedTask(hasBlockedTask);
    if (blockedOnly && !hasBlockedTask) setBlockedOnly(false);
  }
  // #746 — hides the Done (and Failed) columns' contents by default, so a
  // board that accumulates finished tasks forever doesn't crowd out the
  // columns still being worked. Collapses rather than removes the columns
  // (TaskColumn's own `collapsed` prop) — the count stays visible either
  // way, and going through the same `visibleTasks` filter every other
  // board filter here uses would ALSO hide the count itself, which isn't
  // what "collapse" is meant to mean. Rendered unconditionally (unlike
  // blockedOnly's toggle above, which only appears while at least one task
  // qualifies) precisely so it never needs the same render-time-reset
  // dance — there's no "no tasks qualify" state for a toggle whose own
  // condition doesn't depend on what's currently on the board.
  const [hideDone, setHideDone] = useState(() => readBool(STORAGE_KEYS.taskHideDone, false));
  useEffect(() => {
    writeBool(STORAGE_KEYS.taskHideDone, hideDone);
  }, [hideDone]);
  const toggleHideDone = () => setHideDone((prev) => !prev);
  // #701 — parent/phase filter. Empty string = "All" (the default); a
  // reserved sentinel (not a real "repo#number" key, which always contains
  // "#") stands in for "(no parent)" so it can share the same string state
  // as a real selection. A <select>, not chips like the project filter:
  // the reference install alone has 10 distinct parents, each a full issue
  // title — chips at that count would wrap the filter bar across several
  // lines the way the project filter's own chips are documented not to.
  // Composes with the project/blocked-only filters via the same
  // absoluteDropIndex path — see selectedProjectIds' own comment above for
  // why that's what makes stacking filters safe for boardOrder.
  const parentOptions = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; count: number }>();
    for (const t of tasks) {
      if (t.parentIssueNumber === null || t.parentIssueRepo === null) continue;
      const key = `${t.parentIssueRepo}#${t.parentIssueNumber}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        // A late-arriving title (task-watcher.ts's fillParentIssueTitles
        // lands after the row itself is ingested) upgrades an
        // already-seen `#N` placeholder option rather than needing a
        // fresh option to appear once it does.
        if (existing.label === `#${t.parentIssueNumber}` && t.parentIssueTitle) {
          existing.label = t.parentIssueTitle;
        }
      } else {
        byKey.set(key, { key, label: t.parentIssueTitle ?? `#${t.parentIssueNumber}`, count: 1 });
      }
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [tasks]);
  const noParentCount = useMemo(
    () => tasks.filter((t) => t.parentIssueNumber === null).length,
    [tasks],
  );
  const [selectedParentKey, setSelectedParentKey] = useState<string>(() =>
    readString(STORAGE_KEYS.taskParentFilter, ""),
  );
  useEffect(() => {
    writeString(STORAGE_KEYS.taskParentFilter, selectedParentKey);
  }, [selectedParentKey]);
  // Same render-time-adjustment pattern as blockedOnly's own reset above
  // (see its comment for the full "why not a useEffect" reasoning) — a
  // persisted selection for a parent that's since vanished from `tasks`
  // (its last child was re-parented, deleted, or closed) must not leave the
  // filter silently stuck showing zero results with no visible way back.
  const selectedParentValid =
    selectedParentKey === "" ||
    selectedParentKey === PARENT_FILTER_NONE ||
    parentOptions.some((o) => o.key === selectedParentKey);
  const [prevSelectedParentValid, setPrevSelectedParentValid] = useState(selectedParentValid);
  if (selectedParentValid !== prevSelectedParentValid) {
    setPrevSelectedParentValid(selectedParentValid);
    if (!selectedParentValid) setSelectedParentKey("");
  }
  const visibleTasks = useMemo(() => {
    let result =
      activeProjectIds.length === 0
        ? tasks
        : tasks.filter((t) => activeProjectIds.includes(t.projectId));
    if (blockedOnly && hasBlockedTask) result = result.filter((t) => t.blockedState === "blocked");
    if (selectedParentKey === PARENT_FILTER_NONE) {
      result = result.filter((t) => t.parentIssueNumber === null);
    } else if (selectedParentKey !== "") {
      result = result.filter(
        (t) =>
          t.parentIssueNumber !== null &&
          `${t.parentIssueRepo}#${t.parentIssueNumber}` === selectedParentKey,
      );
    }
    return result;
  }, [tasks, activeProjectIds, blockedOnly, hasBlockedTask, selectedParentKey]);

  const linkedSessionIds = useMemo(() => taskLinkedSessionIds(tasks), [tasks]);
  const laneColumns = useMemo(
    () => adhocSessionsByColumn(sessions, linkedSessionIds, hideEndedSessions),
    [sessions, linkedSessionIds, hideEndedSessions],
  );
  // Counts only sessions that actually render a card below (Hermes review —
  // a session whose project has since been deleted is still counted by
  // adhocSessionsByColumn, since that partition has no project data to
  // check, but its own render loop skips it via `if (!project) return
  // null`; without this filter the header count could exceed what's
  // visible).
  const laneTotal = useMemo(
    () =>
      Object.values(laneColumns).reduce(
        (sum, list) => sum + list.filter((session) => projectsById.has(session.projectId)).length,
        0,
      ),
    [laneColumns, projectsById],
  );

  // Issue: this wrapper used to be the ONLY path in the whole frontend that
  // reset viewMode before opening a session's panel — every other entry
  // point (sidebar rows, the command palette, deep links) left it at
  // "kanban", so the panel opened invisibly behind this board's own z-index
  // 100 overlay (.kanban-board-overlay, styles.css). That invariant now
  // lives in usePanelOpener.ts's own leaveTaskView, called first inside
  // EVERY opener it returns (onOpenSession included), which is what makes
  // this wrapper redundant — `onOpenSession` itself does what this used to
  // do, for every call site, not just the ones that went through here.
  const [creating, setCreating] = useState(false);
  // Same fire-and-forget-with-resync posture PR #477 established in
  // TasksPanel.tsx — surfaced here verbatim rather than reimplemented.
  const [dragError, setDragError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const draggingTask =
    draggingId !== null ? (tasks.find((t) => t.id === draggingId) ?? null) : null;

  // `visibleIndex` is whatever TaskColumn rendered a drop against — an
  // index into `orderTasksForColumn(visibleTasks, targetStatus)`, since
  // that's the (possibly filtered) list it was handed. computeTaskReorder
  // itself must still run against the FULL `tasks`, so absoluteDropIndex
  // translates the index first; see its own doc comment in tasksBoard.ts
  // for why, and why that's provably a no-op when no filter is active.
  const applyDrop = (draggedId: number, targetStatus: TaskStatus, visibleIndex: number) => {
    const dragged = tasks.find((t) => t.id === draggedId);
    if (!dragged) return;
    if (
      dragged.status !== targetStatus &&
      !(canDragToColumn(dragged.status) && canDragToColumn(targetStatus))
    ) {
      return;
    }
    setDragError(null);
    const targetIndex = absoluteDropIndex(tasks, visibleTasks, targetStatus, visibleIndex);
    const updates = computeTaskReorder(tasks, draggedId, targetStatus, targetIndex);
    for (const update of updates) {
      const patch: { status?: "backlog" | "ready"; boardOrder: number } = {
        boardOrder: update.boardOrder,
      };
      if (update.id === draggedId && update.status !== dragged.status) {
        patch.status = update.status as "backlog" | "ready";
      }
      useDashboardStore
        .getState()
        .updateTask(update.id, patch)
        .catch((err) => {
          setDragError(err instanceof ApiError ? err.message : "Failed to save the reordered task");
          void useDashboardStore.getState().refreshTasks();
        });
    }
  };

  const [laneCollapsed, setLaneCollapsed] = useState(false);
  // Hermes review — dragover can only see dataTransfer.types, not the
  // dragged id itself (getData is drop-only), so a card can't tell on its
  // own whether an incoming x-mullion-session drag belongs to its own
  // severity group. Every group now sits contiguous in one lane (unlike
  // KanbanBoard's separate columns), so without this a card in a different
  // group still highlights as a valid target and the drop then silently
  // no-ops (computeKanbanReorder can't find the id in that group's list).
  // Same lifted-state pattern as unified-board/TaskColumn.tsx's own
  // acceptsDrop.
  const [draggingSessionId, setDraggingSessionId] = useState<number | null>(null);

  // The detail drawer, inline in the board rather than a dockview panel —
  // TaskDetail.tsx already takes { params: { taskId }, onOpenSession } with
  // every read a store selector, so it renders standalone with zero changes.
  // No auto-close when the task disappears: TaskDetail's own
  // `if (!task) return "Task not found."` already covers that, matching its
  // documented no-optimistic-state posture.
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerCloseButtonRef = useRef<HTMLButtonElement>(null);
  // Whatever had focus (the clicked task card) before the drawer opened —
  // Hermes review: a bare <aside> with no dialog semantics never moved
  // focus in, so a keyboard user opening it via Enter had to tab through
  // every remaining card/column to reach the close button, and closing it
  // never returned focus to where they were. Moving focus in/out here is
  // what makes role="dialog" below actually true rather than just labeled.
  // Captured at the click site (openDetail), not inside the effect: with
  // React running the outgoing effect's cleanup before the incoming effect's
  // body, capturing document.activeElement inside the effect would read the
  // element focus was JUST moved to by that same cleanup when switching
  // straight from one card's drawer to another's, losing the real target.
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const openDetail = useCallback(
    (taskId: number) => {
      lastFocusedRef.current = document.activeElement as HTMLElement | null;
      setDetailTaskId(taskId);
    },
    [setDetailTaskId],
  );

  useEffect(() => {
    if (detailTaskId === null) return;
    drawerCloseButtonRef.current?.focus();
    return () => {
      // This cleanup also runs on UnifiedBoard's own unmount, not just a
      // normal drawer close — onOpenSession (usePanelOpener.ts's own
      // leaveTaskView, called first inside every one of its openers,
      // including this one) resets viewMode to "list" before actually
      // opening the panel, and that view switch unmounts the whole board
      // (App.tsx only renders it while viewMode === "kanban"). By the time
      // this cleanup runs in that case, lastFocusedRef's card has already
      // been detached along with the rest of the tree, so .focus() on it is
      // a no-op — isConnected skips that no-op restore rather than fighting
      // a view switch that's already in flight.
      if (lastFocusedRef.current?.isConnected) {
        lastFocusedRef.current.focus();
      }
    };
  }, [detailTaskId]);

  // Escape and the Tab focus-trap both live on the drawer's own onKeyDown
  // (native bubbling from whatever's focused inside it), not a window-level
  // listener — Hermes review: a window listener closes the drawer on ANY
  // Escape anywhere, including one meant for the command palette (a
  // separate modal, reachable globally, with its own Escape handling
  // scoped to its search input) sitting above this board. Scoping to the
  // drawer means Escape only closes it when focus is actually inside it.
  const onDrawerKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setDetailTaskId(null);
      return;
    }
    if (e.key !== "Tab" || !drawerRef.current) return;
    const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ---- Detail drawer width (drag handle on the drawer's left border) ----
  // Same self-contained localStorage + mousedown/mousemove/mouseup pattern
  // as Dock.tsx's own height handle — deliberately NOT threaded through the
  // store, since nothing outside this component reads it. Unlike Dock's
  // resize (which clamps against a fixed floor and the grid's own min
  // height), the drawer's neighbor here is seven columns with no natural
  // ceiling of their own (.kanban-unified-tasks is `overflow-x: auto`), so
  // dragging without an upper clamp could push the drawer wide enough to
  // scroll every column out of view. mainRef measures the actual rendered
  // width of .kanban-unified-main at drag start so the clamp adapts to
  // whatever window size the drag happens to start at.
  const mainRef = useRef<HTMLDivElement>(null);
  const [drawerWidth, setDrawerWidth] = useState(() => {
    const n = readNumber(STORAGE_KEYS.taskDrawerWidth, NaN);
    return Number.isFinite(n) && n > 0 ? clampDrawerWidth(n, Infinity) : DEFAULT_DRAWER_WIDTH;
  });
  // Handle sits on the drawer's LEFT border: dragging left (clientX
  // decreases) grows the drawer, matching the direction the border itself
  // moves — hence `invert: true`. Persists on drag end only via
  // `onCommit` (see the mount-time-clamp comment below for why that's
  // deliberately NOT also persisted).
  const { onMouseDown: onResizeMouseDown } = useDragResize({
    axis: "x",
    invert: true,
    min: MIN_DRAWER_WIDTH,
    getMax: () => {
      const containerWidth = mainRef.current?.clientWidth ?? Infinity;
      return Math.max(MIN_DRAWER_WIDTH, containerWidth - MIN_COLUMNS_WIDTH);
    },
    value: drawerWidth,
    onChange: setDrawerWidth,
    onCommit: (w) => writeNumber(STORAGE_KEYS.taskDrawerWidth, w),
    cursor: "col-resize",
  });

  // Independent review — the initial useState above only applies
  // clampDrawerWidth's floor (maxW: Infinity), since the ceiling depends on
  // a container width that isn't measurable yet at that point in render.
  // The actual ceiling was previously enforced ONLY at the start of a drag
  // (onResizeMouseDown), so a width persisted from a wide monitor stayed
  // completely unclamped on a later, narrower mount or window resize —
  // exactly the "columns squeezed to zero" failure mode this feature's own
  // clamp exists to prevent, just not caught until the user next dragged
  // the handle. Re-clamping here (mount + every window resize) closes that
  // gap. Uses the functional setState form so this doesn't need
  // `drawerWidth` in its own deps — recomputing the clamp on every
  // unrelated resize is cheap and idempotent, so no debounce.
  useEffect(() => {
    const clampToContainer = () => {
      // Falsy (0 or undefined), not just undefined — a genuinely unmeasured
      // container (no ref yet, or read before the browser's first layout
      // pass) reports 0 too, and clamping against that would floor the
      // drawer to MIN_DRAWER_WIDTH on every mount rather than skip until a
      // real measurement is available.
      const containerWidth = mainRef.current?.clientWidth;
      if (!containerWidth) return;
      const maxW = Math.max(MIN_DRAWER_WIDTH, containerWidth - MIN_COLUMNS_WIDTH);
      setDrawerWidth((w) => clampDrawerWidth(w, maxW));
    };
    clampToContainer();
    window.addEventListener("resize", clampToContainer);
    return () => window.removeEventListener("resize", clampToContainer);
  }, []);

  return (
    <div className="kanban-unified">
      <div
        className="kanban-unified-main"
        ref={mainRef}
        style={{ "--task-drawer-width": `${drawerWidth}px` } as CSSProperties}
      >
        <div className="kanban-unified-tasks">
          <TasksToolbar
            creating={creating}
            onToggleCreate={() => setCreating((v) => !v)}
            projects={projects}
            createTask={(projectId, title) =>
              useDashboardStore.getState().createTask(projectId, title)
            }
            onCreated={() => setCreating(false)}
            hideDone={hideDone}
            onToggleHideDone={toggleHideDone}
          />
          {/* Issue: a blocked task's card badge is easy to scroll past on a
              large board. Only worth showing once something is actually
              blocked — an always-visible toggle that's always a no-op would
              just be noise. */}
          {hasBlockedTask && (
            <div className="tasks-panel-filter-bar">
              <button
                type="button"
                className={`sidebar-filter-chip tasks-panel-blocked-toggle${blockedOnly ? " active" : ""}`}
                aria-pressed={blockedOnly}
                onClick={toggleBlockedOnly}
              >
                <BlockedIcon size={11} aria-hidden="true" />
                Blocked only
              </button>
            </div>
          )}
          {/* Client-only render filter (see selectedProjectIds's own
              comment above) — only worth showing once there's more than
              one project to narrow down. */}
          {projects.length > 1 && (
            <div className="tasks-panel-filter-bar">
              <div className="sidebar-filter-chips" role="group" aria-label="Filter by project">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`sidebar-filter-chip${activeProjectIds.includes(p.id) ? " active" : ""}`}
                    aria-pressed={activeProjectIds.includes(p.id)}
                    onClick={() => toggleProjectFilter(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              {activeProjectIds.length > 0 && (
                <button
                  type="button"
                  className="tasks-panel-filter-clear"
                  title="Show every project"
                  aria-label="Show every project"
                  onClick={clearProjectFilter}
                >
                  Clear
                </button>
              )}
            </div>
          )}
          {/* #701 — only worth showing once at least one task actually has
              a parent, same "only worth showing once it'd narrow anything"
              posture as the project filter above. */}
          {parentOptions.length > 0 && (
            <div className="tasks-panel-filter-bar">
              <label
                className="tasks-panel-parent-filter-label"
                htmlFor="tasks-panel-parent-filter"
              >
                Phase
              </label>
              <select
                id="tasks-panel-parent-filter"
                className="tasks-panel-parent-filter"
                value={selectedParentKey}
                onChange={(e) => setSelectedParentKey(e.target.value)}
              >
                <option value="">All</option>
                {parentOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label} ({o.count})
                  </option>
                ))}
                <option value={PARENT_FILTER_NONE}>(no parent) ({noParentCount})</option>
              </select>
              {selectedParentKey !== "" && (
                <button
                  type="button"
                  className="tasks-panel-filter-clear"
                  title="Show every phase"
                  aria-label="Show every phase"
                  onClick={() => setSelectedParentKey("")}
                >
                  Clear
                </button>
              )}
            </div>
          )}
          {dragError && (
            <div className="task-detail-error tasks-panel-drag-error" role="status">
              {dragError}
            </div>
          )}
          {/* Shown ABOVE the columns, not instead of them — at zero tasks
              this used to replace the whole board, so a first-time user saw
              no workflow model and no drop targets at all. The seven empty
              columns underneath still communicate the board's shape.
              Gated on tasksLoaded (store.ts) too — without it this flashed
              on every board open, since the mount effect above always
              starts from tasks === [] until its own refreshTasks() lands. */}
          {tasksLoaded && tasks.length === 0 && (
            <EmptyStateNote>
              <LayersIcon size={20} />
              <div>No tasks yet.</div>
              <div className="tasks-panel-empty-hint">
                Label a GitHub issue <code>mullion-task</code>, or use "New task" above to create
                one locally.
              </div>
            </EmptyStateNote>
          )}
          {/* Distinct from the "No tasks yet." case above — there ARE
              tasks, an active filter just hides all of them. Same "above
              the columns, not instead of them" posture: the seven empty
              columns still show, so the board's shape stays legible and
              clearing whichever filter is responsible is one click away
              without leaving the board. Message and clear action are
              filter-aware rather than always blaming the project filter —
              a Blocked-only filter with zero blocked tasks isn't fixed by
              "Clear the project filter". */}
          {tasksLoaded && tasks.length > 0 && visibleTasks.length === 0 && (
            <EmptyStateNote>
              <LayersIcon size={20} />
              <div>
                {blockedOnly && activeProjectIds.length > 0
                  ? "No blocked tasks in the selected projects."
                  : blockedOnly
                    ? "No blocked tasks."
                    : selectedParentKey !== "" && activeProjectIds.length > 0
                      ? "No tasks match the selected phase in the selected projects."
                      : selectedParentKey !== ""
                        ? "No tasks match the selected phase."
                        : "No tasks in the selected projects."}
              </div>
              {blockedOnly && (
                <button
                  type="button"
                  className="tasks-panel-empty-hint-clear"
                  onClick={toggleBlockedOnly}
                >
                  Show every task
                </button>
              )}
              {activeProjectIds.length > 0 && (
                <button
                  type="button"
                  className="tasks-panel-empty-hint-clear"
                  onClick={clearProjectFilter}
                >
                  Clear the project filter
                </button>
              )}
              {selectedParentKey !== "" && (
                <button
                  type="button"
                  className="tasks-panel-empty-hint-clear"
                  onClick={() => setSelectedParentKey("")}
                >
                  Clear the phase filter
                </button>
              )}
            </EmptyStateNote>
          )}
          <div className="kanban-board tasks-board kanban-unified-columns">
            {TASK_COLUMNS.map((column) => {
              const columnTasks = orderTasksForColumn(visibleTasks, column.id);
              const acceptsDrop =
                draggingTask !== null &&
                (draggingTask.status === column.id ||
                  (canDragToColumn(draggingTask.status) && canDragToColumn(column.id)));
              return (
                <TaskColumn
                  key={column.id}
                  title={column.title}
                  projectsById={projectsById}
                  sessionsById={sessionsById}
                  theme={theme}
                  tasks={columnTasks}
                  taskMasterEnabled={taskMasterEnabled}
                  acceptsDrop={acceptsDrop}
                  onOpen={(task) => openDetail(task.id)}
                  onOpenSession={onOpenSession}
                  onDrop={(draggedId, index) => applyDrop(draggedId, column.id, index)}
                  onDragBegin={setDraggingId}
                  onDragFinish={() => setDraggingId(null)}
                  collapsed={hideDone && (column.id === "done" || column.id === "failed")}
                />
              );
            })}
          </div>
        </div>
        {detailTaskId !== null && (
          <>
            {/* Sibling BEFORE the aside, not inside it — the Tab focus-trap
                (onDrawerKeyDown below) only queries drawerRef.current's own
                subtree, and this is deliberately not a tab stop (mouse-only,
                matching Dock.tsx's own resize handle), so keeping it outside
                the aside is what keeps it from ever being counted as a
                focusable inside the trap. Hidden on mobile (styles.css) —
                the drawer there is a full-bleed fixed sheet with nothing to
                resize. */}
            <div className="kanban-detail-resize-handle" onMouseDown={onResizeMouseDown} />
            <aside
              ref={drawerRef}
              className="kanban-detail-drawer"
              role="dialog"
              aria-label="Task detail"
              onKeyDown={onDrawerKeyDown}
            >
              {/* A fixed header bar rather than the close button floating
                  absolutely over TaskDetail's own content — it used to sit
                  directly on top of TaskDetail's status badge (see
                  .task-detail-header's own padding-right comment in
                  styles.css) and was a 22px target, well under the 44px
                  mobile minimum where it's the drawer's only way out. Must
                  stay the drawer's first child, with the close button its
                  first (and only) focusable — the Tab focus-trap test
                  (UnifiedBoard.test.tsx) asserts shift-Tab from this button
                  wraps to the LAST focusable inside the aside, which only
                  holds if nothing focusable sits before it. */}
              <div className="kanban-detail-drawer-header">
                <span className="kanban-detail-drawer-header-label">Task</span>
                <button
                  ref={drawerCloseButtonRef}
                  type="button"
                  className="kanban-detail-drawer-close"
                  aria-label="Close task detail"
                  onClick={() => setDetailTaskId(null)}
                >
                  <CloseIcon size={18} />
                </button>
              </div>
              <TaskDetail params={{ taskId: detailTaskId }} onOpenSession={onOpenSession} />
            </aside>
          </>
        )}
      </div>
      <div className="kanban-unified-lane">
        <div className="kanban-lane-header">
          <button
            type="button"
            className="kanban-lane-collapse"
            onClick={() => setLaneCollapsed((v) => !v)}
            aria-expanded={!laneCollapsed}
            aria-controls="kanban-lane-body"
          >
            {laneCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
            Ad-hoc sessions (no task)
          </button>
          <span className="kanban-lane-count">{laneTotal}</span>
        </div>
        {!laneCollapsed && (
          <div className="kanban-lane-body" id="kanban-lane-body">
            {laneTotal === 0 ? (
              <div className="kanban-lane-empty">No sessions without a task.</div>
            ) : (
              // Filters by the same visible-card count the group's own
              // title uses below (Hermes review) — using the raw,
              // unfiltered laneColumns[id].length here rendered an empty
              // group header (title + a "0" count, no cards) whenever
              // every session in a group had a since-deleted project.
              LANE_COLUMN_ORDER.filter(
                (id) => laneColumns[id].filter((s) => projectsById.has(s.projectId)).length > 0,
              ).map((id) => {
                const columnSessions = laneColumns[id];
                const order = kanbanOrder[id] ?? [];
                const orderedSessions = orderSessionsForColumn(columnSessions, order);
                const visibleSessionCount = orderedSessions.filter((s) =>
                  projectsById.has(s.projectId),
                ).length;
                const acceptsDrop =
                  draggingSessionId !== null &&
                  columnSessions.some((s) => s.id === draggingSessionId);
                return (
                  <div className="kanban-lane-group" key={id}>
                    <div className="kanban-lane-group-title">
                      {laneColumnTitle(id)} <span>{visibleSessionCount}</span>
                    </div>
                    {orderedSessions.map((session, index) => {
                      const project = projectsById.get(session.projectId);
                      if (!project) return null;
                      return (
                        <LaneCard
                          key={session.id}
                          session={session}
                          project={project}
                          acceptsDrop={acceptsDrop}
                          onOpen={() => onOpenSession(session)}
                          // P9 — not `void`-discarded: SessionRow (nested
                          // inside LaneCard) now catches a rejection here
                          // and surfaces it inline, same fix as Sidebar.tsx's
                          // two identical onEnd call sites. LaneCard's own
                          // `onEnd: () => void` prop type doesn't need
                          // widening — TS's void-return bivariance already
                          // accepts this function's real Promise return
                          // value, and SessionRow's `Promise.resolve(onEnd())`
                          // sees the actual returned promise at runtime
                          // regardless of the narrower static type in
                          // between.
                          onEnd={() =>
                            useDashboardStore
                              .getState()
                              .deleteSession(session.id)
                              .then(() => onSessionEnded(session))
                          }
                          onDragBegin={() => setDraggingSessionId(session.id)}
                          onDragFinish={() => setDraggingSessionId(null)}
                          onReorder={(draggedId) => {
                            const next = computeKanbanReorder(
                              columnSessions,
                              order,
                              draggedId,
                              index,
                            );
                            useDashboardStore.getState().setKanbanColumnOrder(id, next);
                          }}
                        />
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
