import { useEffect, useMemo, useRef, useState } from "react";
import { useOpenTask } from "./hooks/useOpenTask.js";
import { useDashboardStore } from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import {
  BOARD_COLUMNS,
  TASK_COLUMNS,
  boardColumnOf,
  boardColumnTasks,
  canDragToColumn,
  computeTaskReorder,
  absoluteDropIndex,
  PHONE_SEGMENTS,
  defaultPhoneColumn,
  defaultPhoneSegment,
  foldClaimedCounts,
  phoneSegmentCount,
  visibleColumnWindow,
} from "./tasksBoard.js";
import type { PhoneSegmentId } from "./tasksBoard.js";
import { taskLinkedSessionIds, adhocSessionsByColumn } from "./boardLanes.js";
import type { Session, TaskStatus } from "./api/index.js";
import { ApiError } from "./api/index.js";
import { LayersIcon } from "./ui/icons.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import { TaskFilterBar } from "./unified-board/TaskFilterBar.js";
import { TaskFacetsPanel } from "./unified-board/TaskFacetsPanel.js";
import { useTaskFilters } from "./unified-board/useTaskFilters.js";
import { NO_EPIC, facetsOpen } from "./unified-board/taskFilters.js";
import type { TaskFilters } from "./unified-board/taskFilters.js";
import { TaskColumn } from "./unified-board/TaskColumn.js";
import { DisplayLayoutControls } from "./unified-board/DisplayLayoutControls.js";
import { TaskLaneHeader } from "./unified-board/TaskLaneHeader.js";
import {
  epicColourSlot,
  epicProgress,
  epicUrl,
  groupLanes,
  laneKeyOf,
} from "./unified-board/taskLanes.js";
import { AdhocLane } from "./unified-board/AdhocLane.js";
import { openEpicInSidebar } from "./lib/sidebarLinks.js";

// The window's inner width, for the facets panel's "Auto" setting.
function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

// What the empty-board note says when filters hide every task.
function emptyBoardMessage(f: TaskFilters): string {
  const where = f.projectIds.length > 0 ? " in the selected projects" : "";
  if (f.agents.length > 0 || f.text.trim() !== "") return "No tasks match the current filters.";
  if (f.epicKeys.length > 0) {
    return `No tasks match the selected epic${f.epicKeys.length > 1 ? "s" : ""}${where}.`;
  }
  switch (f.view) {
    case "needs-me":
      return `No tasks need you${where}.`;
    case "running":
      return `No running tasks${where}.`;
    case "blocked":
      return `No blocked tasks${where}.`;
    case "awaiting-merge":
      return `No tasks awaiting merge${where}.`;
    default:
      return `No tasks in the selected projects.`;
  }
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
// own orchestration (task drag-and-drop, opening a task in the sidebar or the docked
// panel, the ad-hoc lane's collapse/grouping) while TaskFilterBar/TaskColumn/
// TaskCard/TaskSessionSlot/LaneCard live in unified-board/ as focused,
// mostly-presentational components.
export function UnifiedBoard({
  onOpenSession,
  onSessionEnded,
  phone = false,
  columnCount = 1,
  selectedTaskId: selectedTaskIdProp,
}: {
  onOpenSession: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
  // Phone tier: one column at a time behind a status strip, filters in a
  // sheet, no ad-hoc lane (the session picker covers those sessions), and
  // Android back closes the task detail. Unset elsewhere = the full board.
  phone?: boolean;
  // With `phone`: how many adjacent status columns show at once (1 on phone,
  // 2 on tablet, where the board has the width for a pair).
  columnCount?: number;
  // The task whose card is ringed. Unset = the store's selection (the task the
  // right sidebar shows in detail, #2842); the board holds no selection of its own.
  selectedTaskId?: number | null;
}) {
  const storeSelectedTaskId = useDashboardStore((s) => s.selectedTaskId);
  const selectedTaskId =
    selectedTaskIdProp === undefined ? storeSelectedTaskId : selectedTaskIdProp;

  // P1 perf fix — was a single bare `useDashboardStore()` (whole-store
  // subscription). `refreshTasks`/`updateTask`/`createTask`/`deleteSession`/
  // `setViewMode`/`setKanbanColumnOrder` are all pure action-callers (used
  // inside effects/handlers below, never read as a value) — see the
  // useDashboardStore.getState() calls at their own call sites instead of
  // subscribing to them here.
  const {
    tasks,
    tasksLoaded,
    tasksError,
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
      tasksError: s.tasksError,
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

  // Every board filter (project, quick view, epic, agent, text, hide done, archived)
  // lives in useTaskFilters (#2840). They are all client-only render-time filters, not
  // fetch params: `tasks` in the store always holds every task install-wide (see
  // store.ts's refreshTasks), and must keep doing so, because computeTaskReorder below
  // reindexes a target column's FULL contents on every drop, including whatever a
  // filter is currently hiding. #610 considered and cut a project filter for exactly
  // this hazard ("the drag/reorder math indexes against the rendered list, not the
  // full store list, and filtering would silently corrupt boardOrder on drop") —
  // applyDrop's use of absoluteDropIndex below is what closes that gap: it translates
  // a filtered TaskColumn's own rendered index back into the equivalent index against
  // the full, unfiltered column before computeTaskReorder ever sees it, whatever
  // combination of filters produced `visibleTasks`.
  // The project the right sidebar follows, for the project picker's "follow" option (#2858).
  const followedProjectId = useDashboardStore((s) => s.followedProjectId);
  const filterApi = useTaskFilters(tasks, projects, followedProjectId);
  const { visibleTasks, filters, effectiveHideDone: hideDone, density } = filterApi;
  // #2841 — grouping into lanes needs width and a second axis; phone shows one status
  // column at a time and stays flat.
  const groupBy = phone ? "none" : filterApi.groupBy;
  // Nothing to group yet (empty board, or a filter hid everything): the flat columns
  // still render so the board keeps its shape.
  const grouped = groupBy !== "none" && visibleTasks.length > 0;
  const lanes = useMemo(
    () => groupLanes(visibleTasks, grouped ? groupBy : "none", projectsById),
    [visibleTasks, grouped, groupBy, projectsById],
  );
  const activeProjectIds = filters.projectIds;
  const viewportWidth = useViewportWidth();
  const facetsShown = !phone && facetsOpen(filterApi.facets, viewportWidth, projects.length);

  const linkedSessionIds = useMemo(() => taskLinkedSessionIds(tasks), [tasks]);
  const laneColumns = useMemo(
    () => adhocSessionsByColumn(sessions, linkedSessionIds, hideEndedSessions),
    [sessions, linkedSessionIds, hideEndedSessions],
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
  // `scope` is the task list the dropped-on column rendered from: every visible task,
  // or one lane's tasks when the board is grouped. `laneKey` is that lane's key (null
  // when ungrouped). In progress also lists Claimed tasks, so a drop there is re-aimed
  // at the dragged task's own status before the index is translated.
  const applyDrop = (
    draggedId: number,
    columnId: TaskStatus,
    visibleIndex: number,
    scope: typeof visibleTasks = visibleTasks,
    laneKey: string | null = null,
  ) => {
    const dragged = tasks.find((t) => t.id === draggedId);
    if (!dragged) return;
    // A lane is an epic or a project: dropping into another one would change the
    // parent (or the project), which dragging never does. Refused, nothing written.
    if (laneKey !== null && laneKeyOf(dragged, groupBy) !== laneKey) return;
    let targetStatus = columnId;
    let columnIndex = visibleIndex;
    if (
      columnId === "in_progress" &&
      (dragged.status === "in_progress" || dragged.status === "claimed")
    ) {
      const running = scope.filter((t) => t.status === "in_progress").length;
      targetStatus = dragged.status;
      columnIndex =
        dragged.status === "claimed"
          ? Math.max(0, visibleIndex - running)
          : Math.min(visibleIndex, running);
    }
    if (
      dragged.status !== targetStatus &&
      !(canDragToColumn(dragged.status) && canDragToColumn(targetStatus))
    ) {
      return;
    }
    setDragError(null);
    const targetIndex = absoluteDropIndex(tasks, scope, targetStatus, columnIndex);
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

  // A card click selects the task and shows its detail (#2843: the board no
  // longer has a drawer of its own): in the sidebar's Tasks view on desktop,
  // in the full-screen docked panel on phone and tablet. useOpenTask owns that
  // tier decision for every caller (this board, the GitHub and Git views'
  // task chips, the issue view), so they cannot drift apart.
  const openTask = useOpenTask();

  // Per-status counts (after the board's filters) for the phone strip, and
  // which column the phone shows: the user's pick if it's still offered,
  // else the first actionable one (tasksBoard.ts's defaultPhoneColumn).
  const [phoneColumnChoice, setPhoneColumnChoice] = useState<TaskStatus | null>(null);
  const statusCounts = useMemo(() => {
    const counts = Object.fromEntries(TASK_COLUMNS.map((c) => [c.id, 0])) as Record<
      TaskStatus,
      number
    >;
    for (const task of visibleTasks) counts[task.status] += 1;
    // Queued tasks are listed under In progress (tasksBoard.ts BOARD_COLUMNS).
    return foldClaimedCounts(counts);
  }, [visibleTasks]);
  const phoneColumns = BOARD_COLUMNS.filter(
    (c) => !(hideDone && (c.id === "done" || c.id === "failed")),
  );
  const phoneColumn =
    phoneColumnChoice !== null && phoneColumns.some((c) => c.id === phoneColumnChoice)
      ? phoneColumnChoice
      : defaultPhoneColumn(
          statusCounts,
          phoneColumns.map((c) => c.id),
        );

  // Phone proper (one column wide) shows four segments rather than a chip per
  // status; tablet keeps the per-status window above (tasksBoard.ts).
  const segmented = phone && columnCount === 1;
  const [phoneSegmentChoice, setPhoneSegmentChoice] = useState<PhoneSegmentId | null>(null);
  const phoneSegments = PHONE_SEGMENTS.filter((seg) => !(hideDone && seg.id === "done"));
  const phoneSegment =
    phoneSegmentChoice !== null && phoneSegments.some((seg) => seg.id === phoneSegmentChoice)
      ? phoneSegmentChoice
      : defaultPhoneSegment(
          statusCounts,
          phoneSegments.map((seg) => seg.id),
        );
  const visibleColumnIds: TaskStatus[] = segmented
    ? [...(PHONE_SEGMENTS.find((seg) => seg.id === phoneSegment)?.statuses ?? [])]
    : visibleColumnWindow(
        phoneColumns.map((c) => c.id),
        phoneColumn,
        columnCount,
      );

  // Keep the selected chip visible: with all seven columns the strip
  // overflows a phone, and the default pick (In Progress) is 4th. Optional
  // call: jsdom has no scrollIntoView.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The four segments always fit; only the tablet's per-status chips scroll.
    if (!phone || segmented) return;
    stripRef.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [phone, segmented, phoneColumn]);

  return (
    <div className="kanban-unified">
      <div className="kanban-unified-main">
        {!tasksLoaded && (
          <span className="visually-hidden" role="status">
            Loading tasks
          </span>
        )}
        <div
          className={`kanban-unified-tasks task-density-${density}`}
          // Busy marks the columns in flux, not the announcement. The
          // status is a sibling of this element: aria-busy tells assistive
          // technology to defer anything inside the subtree, so nesting the
          // status here would silence it. A role="status" on the region
          // itself would also read the toolbar out.
          aria-busy={tasksLoaded ? undefined : true}
        >
          <TaskFilterBar
            api={filterApi}
            projects={projects}
            phone={phone}
            facetsShown={facetsShown}
            creating={creating}
            onToggleCreate={() => setCreating((v) => !v)}
            createTask={(projectId, title) =>
              useDashboardStore.getState().createTask(projectId, title)
            }
            onCreated={() => setCreating(false)}
            clearDoneTasks={(opts) => useDashboardStore.getState().clearDoneTasks(opts)}
            displayExtra={
              <DisplayLayoutControls
                groupBy={filterApi.groupBy}
                onGroupBy={filterApi.setGroupBy}
                density={density}
                onDensity={filterApi.setDensity}
                showGroupBy={!phone}
              />
            }
          />
          {segmented && (
            <div
              className="tasks-phone-strip tasks-phone-strip--segmented"
              role="group"
              aria-label="Task status"
            >
              {phoneSegments.map((segment) => (
                <button
                  key={segment.id}
                  type="button"
                  className="tasks-phone-strip-chip"
                  aria-pressed={segment.id === phoneSegment}
                  onClick={() => setPhoneSegmentChoice(segment.id)}
                >
                  {segment.title}
                  <span className="tasks-phone-strip-count">
                    {phoneSegmentCount(statusCounts, segment)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {phone && !segmented && (
            <div ref={stripRef} className="tasks-phone-strip" role="group" aria-label="Task status">
              {phoneColumns.map((column) => (
                <button
                  key={column.id}
                  type="button"
                  className="tasks-phone-strip-chip"
                  // "On screen", not "the one selected": `phone` here is the compact
                  // board layout, so on tablet this strip shows and both columns
                  // of the visible pair read as pressed.
                  aria-pressed={visibleColumnIds.includes(column.id)}
                  onClick={() => {
                    // Picking a chip already on screen keeps the pair put.
                    if (columnCount > 1 && visibleColumnIds.includes(column.id)) return;
                    setPhoneColumnChoice(column.id);
                  }}
                >
                  {column.title}
                  <span className="tasks-phone-strip-count">{statusCounts[column.id]}</span>
                </button>
              ))}
            </div>
          )}
          {dragError && (
            <div className="task-detail-error tasks-panel-drag-error" role="status">
              {dragError}
            </div>
          )}
          {/* Audit finding 15 — a FAILED task fetch is NOT an empty task
              list. The tasks slice keeps the last-known-good list on
              failure (so `tasks` is still []) and records the failure in
              `tasksError`; before this, the board said "No tasks yet." and
              invited the user to create a task, which is actively
              misleading when the real cause is that the list could not be
              loaded. Same "above the columns, not instead of them"
              posture as the empty state below — the seven empty columns
              still communicate the board's shape. The failure is spelled
              out in words (never by colour alone), and Retry re-runs the
              fetch. */}
          {tasksError && (
            <EmptyStateNote>
              <LayersIcon size={20} />
              {tasks.length > 0 ? (
                // The tasks ARE on screen — the columns below are the last
                // known good ones, not nothing. Saying "Couldn't load
                // tasks." here would read as if there were no tasks at
                // all, and the board's real state (a populated board that
                // could not be re-synced) would be a lie. Same split
                // Sidebar ("showing the last known list") and Source Control
                // (its stale marker) already make.
                <>
                  <div>Could not refresh tasks — showing the last known list.</div>
                  <div className="tasks-panel-empty-hint">{tasksError}</div>
                </>
              ) : (
                <>
                  <div>Couldn't load tasks.</div>
                  <div className="tasks-panel-empty-hint">{tasksError}</div>
                </>
              )}
              <button
                type="button"
                className="git-panel-fetch-btn"
                onClick={() => void useDashboardStore.getState().refreshTasks()}
              >
                Retry
              </button>
            </EmptyStateNote>
          )}
          {/* Shown ABOVE the columns, not instead of them — at zero tasks
              this used to replace the whole board, so a first-time user saw
              no workflow model and no drop targets at all. The seven empty
              columns underneath still communicate the board's shape.
              Gated on tasksLoaded (store.ts) too — without it this flashed
              on every board open, since the mount effect above always
              starts from tasks === [] until its own refreshTasks() lands.
              Gated on !tasksError too — a failed fetch is not an empty
              list (see the error note above). */}
          {tasksLoaded && tasks.length === 0 && !tasksError && (
            <EmptyStateNote>
              <LayersIcon size={20} />
              <div>No tasks yet.</div>
              <div className="tasks-panel-empty-hint">
                Label a GitHub issue <code>mullion-task</code>, or use "New task" above to create
                one locally.
              </div>
            </EmptyStateNote>
          )}
          {/* Distinct from the "No tasks yet." case above — there ARE tasks, an active
              filter just hides all of them. Same "above the columns, not instead of
              them" posture: the empty columns still show, so the board's shape stays
              legible and clearing whichever filter is responsible is one click away
              without leaving the board. Message and clear actions are filter-aware
              rather than always blaming the project filter — a Blocked view with zero
              blocked tasks isn't fixed by "Clear the project filter". */}
          {tasksLoaded && tasks.length > 0 && visibleTasks.length === 0 && (
            <EmptyStateNote>
              <LayersIcon size={20} />
              <div>{emptyBoardMessage(filters)}</div>
              {filters.view !== "all" && (
                <button
                  type="button"
                  className="tasks-panel-empty-hint-clear"
                  onClick={() => filterApi.setView("all")}
                >
                  Show every task
                </button>
              )}
              {activeProjectIds.length > 0 && (
                <button
                  type="button"
                  className="tasks-panel-empty-hint-clear"
                  onClick={() => filterApi.setProjectIds([])}
                >
                  Clear the project filter
                </button>
              )}
              {filters.epicKeys.length > 0 && (
                <button
                  type="button"
                  className="tasks-panel-empty-hint-clear"
                  onClick={() => filterApi.setEpicKeys([])}
                >
                  Clear the epic filter
                </button>
              )}
              {(filters.agents.length > 0 || filters.text.trim() !== "") && (
                <button
                  type="button"
                  className="tasks-panel-empty-hint-clear"
                  onClick={filterApi.clearFilters}
                >
                  Clear all filters
                </button>
              )}
            </EmptyStateNote>
          )}
          <div className={`task-board-body${facetsShown ? " task-board-body--facets" : ""}`}>
            {facetsShown && <TaskFacetsPanel api={filterApi} projects={projects} />}
            <div className="task-board-lanes">
              {lanes.map((lane) => {
                const epicKey = groupBy === "epic" && lane.key !== NO_EPIC ? lane.key : null;
                const sample = lane.tasks[0];
                const progress = epicKey !== null ? epicProgress(tasks, epicKey) : null;
                return (
                  <section
                    key={lane.key}
                    className={grouped ? "task-lane" : "task-lane task-lane-flat"}
                    aria-label={grouped ? lane.title : undefined}
                  >
                    {grouped && (
                      <TaskLaneHeader
                        title={lane.title}
                        count={lane.tasks.length}
                        colour={epicKey !== null ? `var(--lane-${epicColourSlot(epicKey)})` : null}
                        progress={progress}
                        href={epicKey !== null && sample ? epicUrl(sample) : null}
                        onOpen={sample ? () => openEpicInSidebar(tasks, sample) : undefined}
                      />
                    )}
                    <div
                      className={`kanban-board tasks-board kanban-unified-columns${phone && columnCount > 1 ? " kanban-unified-columns--split" : ""}`}
                    >
                      {(phone
                        ? BOARD_COLUMNS.filter((c) => visibleColumnIds.includes(c.id))
                        : BOARD_COLUMNS
                      ).map((column) => {
                        const columnTasks = boardColumnTasks(lane.tasks, column.id);
                        // A card can only be dropped in its own lane: a lane is an epic or
                        // a project, and dragging never changes either.
                        const acceptsDrop =
                          draggingTask !== null &&
                          (!grouped || laneKeyOf(draggingTask, groupBy) === lane.key) &&
                          (boardColumnOf(draggingTask.status) === column.id ||
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
                            onOpen={(task) => openTask(task.id)}
                            onOpenSession={onOpenSession}
                            onDrop={(draggedId, index) =>
                              applyDrop(
                                draggedId,
                                column.id,
                                index,
                                lane.tasks,
                                grouped ? lane.key : null,
                              )
                            }
                            onDragBegin={setDraggingId}
                            onDragFinish={() => setDraggingId(null)}
                            collapsed={hideDone && (column.id === "done" || column.id === "failed")}
                            loading={!tasksLoaded}
                            rail={!phone}
                            selectedTaskId={selectedTaskId}
                          />
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <AdhocLane
        laneColumns={laneColumns}
        projectsById={projectsById}
        kanbanOrder={kanbanOrder}
        onOpenSession={onOpenSession}
        onSessionEnded={onSessionEnded}
      />
    </div>
  );
}
