import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDashboardStore } from "./store.js";
import { useShallow } from "zustand/react/shallow";
import {
  TASK_COLUMNS,
  canDragToColumn,
  orderTasksForColumn,
  computeTaskReorder,
} from "./tasksBoard.js";
import {
  taskLinkedSessionIds,
  adhocSessionsByColumn,
  LANE_COLUMN_ORDER,
  laneColumnTitle,
} from "./unifiedBoard.js";
import { orderSessionsForColumn, computeKanbanReorder } from "./kanban.js";
import { TaskDetail } from "./TaskDetail.js";
import type { Session, TaskStatus } from "./api.js";
import { ApiError } from "./api.js";
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, LayersIcon } from "./icons.js";
import { useDragResize } from "./hooks/useDragResize.js";
import { STORAGE_KEYS, readNumber, writeNumber } from "./lib/persistedState.js";
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

  // The task board's own overlay sits above the dockview grid (z-index 100
  // — see .kanban-board-overlay's comment in styles.css), so opening or
  // switching to a session's terminal panel from anywhere inside this board
  // (a card's nested session strip, the lane, or — once wired — the detail
  // drawer's Claim/Retry/"Open session") must switch back to list view
  // first, or the newly (re)activated panel would render invisibly behind
  // the overlay.
  const openSession = useCallback(
    (session: Session) => {
      useDashboardStore.getState().setViewMode("list");
      onOpenSession(session);
    },
    [onOpenSession],
  );

  const [creating, setCreating] = useState(false);
  // Same fire-and-forget-with-resync posture PR #477 established in
  // TasksPanel.tsx — surfaced here verbatim rather than reimplemented.
  const [dragError, setDragError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const draggingTask =
    draggingId !== null ? (tasks.find((t) => t.id === draggingId) ?? null) : null;

  const applyDrop = (draggedId: number, targetStatus: TaskStatus, targetIndex: number) => {
    const dragged = tasks.find((t) => t.id === draggedId);
    if (!dragged) return;
    if (
      dragged.status !== targetStatus &&
      !(canDragToColumn(dragged.status) && canDragToColumn(targetStatus))
    ) {
      return;
    }
    setDragError(null);
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
      // normal drawer close — openSession (the only path Claim/Retry/"Open
      // session" inside the drawer itself use) calls setViewMode("list")
      // BEFORE onOpenSession, and that view switch unmounts the whole board
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
          />
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
          <div className="kanban-board tasks-board kanban-unified-columns">
            {TASK_COLUMNS.map((column) => {
              const columnTasks = orderTasksForColumn(tasks, column.id);
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
                  onOpenSession={openSession}
                  onDrop={(draggedId, index) => applyDrop(draggedId, column.id, index)}
                  onDragBegin={setDraggingId}
                  onDragFinish={() => setDraggingId(null)}
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
                  <CloseIcon size={14} />
                </button>
              </div>
              <TaskDetail params={{ taskId: detailTaskId }} onOpenSession={openSession} />
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
                          onOpen={() => openSession(session)}
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
