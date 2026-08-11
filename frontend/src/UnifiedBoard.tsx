import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDashboardStore } from "./store.js";
import type { Theme } from "./store.js";
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
import { SessionRow } from "./Sidebar.js";
import { TaskDetail } from "./TaskDetail.js";
import type { GitHubCiStatus, Project, Session, Task, TaskStatus } from "./api.js";
import { commandToBinary, resolveAgentLogo } from "./cliLogos.js";
import {
  STATUS_PRESENTATION,
  formatStatusLabel,
  rowClassNameForSeverity,
} from "./sessionStatus.js";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  GitHubIcon,
  LayersIcon,
  PlusIcon,
  TerminalPromptIcon,
  WarningTriangleIcon,
} from "./icons.js";
import { ApiError } from "./api.js";
import { formatRelativeAge } from "./relativeTime.js";

const TASK_DRAG_MIME = "application/x-mullion-task";

// Same "success/failure/in_progress/null -> good/bad/pending/none" mapping
// as Sidebar.tsx's sessionPrDotClass/GitHubPanel.tsx's ciDotClass —
// duplicated rather than imported, this codebase's own established
// precedent for this exact small guard (see Sidebar.tsx's own comment).
function taskCardPrDotClass(status: GitHubCiStatus): "good" | "bad" | "pending" | "none" {
  if (status === "success") return "good";
  if (status === "failure") return "bad";
  if (status === "in_progress") return "pending";
  return "none";
}

// Merges Mullion's two Kanban surfaces (issue #211's session-only
// KanbanBoard.tsx + 6.5/#218's TasksPanel.tsx, both deleted) into one: task
// status columns are the board, every session not owned by a task collects
// in an "ad-hoc sessions" lane beneath it, and a task-owned session instead
// renders nested on its own card (TaskSessionSlot below). The sole
// `viewMode === "kanban"` overlay surface in App.tsx.
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
  // Same lifted-state pattern as TaskColumn's acceptsDrop.
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

  return (
    <div className="kanban-unified">
      <div className="kanban-unified-main">
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
            <div className="github-panel-empty">
              <LayersIcon size={20} />
              <div>No tasks yet.</div>
              <div className="tasks-panel-empty-hint">
                Label a GitHub issue <code>mullion-task</code>, or use "New task" above to create
                one locally.
              </div>
            </div>
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

function TasksToolbar({
  creating,
  onToggleCreate,
  projects,
  createTask,
  onCreated,
}: {
  creating: boolean;
  onToggleCreate: () => void;
  projects: { id: number; name: string }[];
  createTask: (projectId: number, title: string) => Promise<unknown>;
  onCreated: () => void;
}) {
  const [manualProjectId, setManualProjectId] = useState<number | null>(null);
  const projectId =
    manualProjectId !== null && projects.some((p) => p.id === manualProjectId)
      ? manualProjectId
      : (projects[0]?.id ?? null);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!title.trim() || projectId === null || submitting) return;
    setSubmitting(true);
    setError(null);
    createTask(projectId, title.trim())
      .then(() => {
        setTitle("");
        onCreated();
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Failed to create task");
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="tasks-panel-toolbar">
      <button className="tasks-panel-new-btn" onClick={onToggleCreate}>
        <PlusIcon size={12} strokeLinecap="round" strokeWidth={2.2} />
        New task
      </button>
      {creating && (
        <div className="tasks-panel-new-form">
          <select
            className="tasks-panel-new-project"
            value={projectId ?? ""}
            onChange={(e) => setManualProjectId(Number(e.target.value))}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className="tasks-panel-new-title"
            placeholder="Task title"
            value={title}
            autoFocus
            disabled={submitting}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button
            className="tasks-panel-new-submit"
            disabled={!title.trim() || projectId === null || submitting}
            onClick={submit}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
          {error && <span className="task-detail-error">{error}</span>}
        </div>
      )}
    </div>
  );
}

function TaskColumn({
  title,
  tasks,
  projectsById,
  sessionsById,
  theme,
  taskMasterEnabled,
  acceptsDrop,
  onOpen,
  onOpenSession,
  onDrop,
  onDragBegin,
  onDragFinish,
}: {
  title: string;
  tasks: Task[];
  projectsById: Map<number, Project>;
  sessionsById: Map<number, Session>;
  theme: Theme;
  taskMasterEnabled: boolean;
  acceptsDrop: boolean;
  onOpen: (task: Task) => void;
  onOpenSession: (session: Session) => void;
  onDrop: (draggedId: number, index: number) => void;
  onDragBegin: (id: number) => void;
  onDragFinish: () => void;
}) {
  const [dropTarget, setDropTarget] = useState(false);

  const acceptsDrag = (e: DragEvent<HTMLDivElement>) =>
    acceptsDrop && e.dataTransfer.types.includes(TASK_DRAG_MIME);

  return (
    <div className={`kanban-column${tasks.length === 0 ? " kanban-column-is-empty" : ""}`}>
      <div className="kanban-column-header">
        <span className="kanban-column-title">{title}</span>
        <span className="kanban-column-count">{tasks.length}</span>
      </div>
      <div
        className={`kanban-column-body${dropTarget ? " kanban-card-drop-target" : ""}`}
        onDragOver={(e) => {
          if (!acceptsDrag(e)) return;
          e.preventDefault();
          setDropTarget(true);
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(e) => {
          setDropTarget(false);
          if (!acceptsDrag(e)) return;
          e.preventDefault();
          const idStr = e.dataTransfer.getData(TASK_DRAG_MIME);
          const draggedId = Number(idStr);
          if (!idStr || !Number.isFinite(draggedId)) return;
          onDrop(draggedId, tasks.length);
        }}
      >
        {tasks.length === 0 ? (
          <div className="kanban-column-empty">No tasks</div>
        ) : (
          tasks.map((task, index) => (
            <TaskCard
              key={task.id}
              task={task}
              project={projectsById.get(task.projectId)}
              workerSession={task.sessionId !== null ? sessionsById.get(task.sessionId) : null}
              reviewSession={
                task.reviewSessionId !== null ? sessionsById.get(task.reviewSessionId) : null
              }
              theme={theme}
              taskMasterEnabled={taskMasterEnabled}
              acceptsDrop={acceptsDrop}
              onOpen={() => onOpen(task)}
              onOpenSession={onOpenSession}
              onReorder={(draggedId) => onDrop(draggedId, index)}
              onDragBegin={() => onDragBegin(task.id)}
              onDragFinish={onDragFinish}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  project,
  workerSession,
  reviewSession,
  theme,
  taskMasterEnabled,
  acceptsDrop,
  onOpen,
  onOpenSession,
  onReorder,
  onDragBegin,
  onDragFinish,
}: {
  task: Task;
  project: { id: number; name: string } | undefined;
  // null = task.sessionId/reviewSessionId is null (no session was ever
  // linked); undefined = a session WAS linked but is no longer in
  // store.sessions (killed/reaped) — TaskSessionSlot renders differently
  // for each, see its own doc comment.
  workerSession: Session | undefined | null;
  reviewSession: Session | undefined | null;
  theme: Theme;
  taskMasterEnabled: boolean;
  acceptsDrop: boolean;
  onOpen: () => void;
  onOpenSession: (session: Session) => void;
  onReorder: (draggedId: number) => void;
  onDragBegin: () => void;
  onDragFinish: () => void;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  const agentName = task.agentCommand ? commandToBinary(task.agentCommand) : null;

  // Matched client-side against the project's unfiltered PR list, same
  // posture as Sidebar.tsx's own matchedPr (its doc comment explains why:
  // avoids firing a `?branch=` request per card). Joined on task.branchName
  // — deterministic (`mullion/task-<id>`, set at claim time) — rather than
  // SessionRow's own displayBranch precedence dance, which exists only to
  // handle a worktree session's hook-reported branch lagging its actual
  // one; a task's branchName has no such ambiguity.
  const prsStatus = useDashboardStore((s) => (project ? s.prsByProject[project.id] : undefined));
  const matchedPr =
    task.branchName && prsStatus?.prs
      ? prsStatus.prs.find((pr) => pr.headBranch === task.branchName)
      : undefined;

  // Hermes review — the same click-after-drag issue TaskSessionSlot had
  // (see its own comment below): a completed reorder drop on an accepting
  // column still fires a plain click on the source card right after
  // dragend, which would pop the drawer open uninvited. Unlike the strip,
  // this card can't just drop `draggable` — the drag IS the reorder. Guard
  // the click instead: dragend fires BEFORE that trailing click, so the
  // flag has to clear on a timeout, not synchronously in onDragEnd, or it'd
  // already be false by the time the click lands.
  const suppressClickRef = useRef(false);

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TASK_DRAG_MIME, String(task.id));
    e.dataTransfer.effectAllowed = "move";
    suppressClickRef.current = true;
    onDragBegin();
  };

  const handleDragEnd = () => {
    onDragFinish();
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleClick = () => {
    if (suppressClickRef.current) return;
    onOpen();
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!acceptsDrop || !e.dataTransfer.types.includes(TASK_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(true);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropTarget(false);
    if (!acceptsDrop) return;
    const idStr = e.dataTransfer.getData(TASK_DRAG_MIME);
    const draggedId = Number(idStr);
    if (!idStr || !Number.isFinite(draggedId)) return;
    e.preventDefault();
    e.stopPropagation();
    if (draggedId === task.id) return;
    onReorder(draggedId);
  };

  // A blocked/failed/waiting worker should be visible at column-scan
  // distance, not just inside its own nested strip — the mitigation for
  // losing the standalone "Needs Attention" session column (see the plan's
  // feature ledger). Only the worker session drives this, not the review
  // session (advisory, secondary).
  const severityClass = workerSession
    ? rowClassNameForSeverity(workerSession.sessionStatusSeverity)
    : "";

  // D3 — time in the task's current status, at scan distance rather than
  // only in the drawer's own "Created ... Claimed ... Completed" footer
  // (TaskDetail.tsx). The timestamp that means "how long has this been
  // sitting here" changes with the column: claimedAt for claimed/
  // in_progress (still not started, or actively running), reviewingAt once
  // it's waiting on a look, completedAt once it's settled, createdAt
  // otherwise (backlog/ready, never yet claimed). Task's own timestamps are
  // ISO strings (api.ts) but formatRelativeAge takes epoch ms, same
  // Date.parse TaskDetail.tsx's own footer already does.
  const statusTimestamp =
    task.status === "claimed" || task.status === "in_progress"
      ? task.claimedAt
      : task.status === "reviewing"
        ? task.reviewingAt
        : task.status === "done"
          ? task.completedAt
          : task.createdAt;
  const statusAge = statusTimestamp ? formatRelativeAge(Date.parse(statusTimestamp)) : null;

  return (
    <div
      className={`task-card${severityClass ? ` ${severityClass}` : ""}${dropTarget ? " kanban-card-drop-target" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDropTarget(false)}
      onDrop={onDrop}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {/* D1 — the title is 2-line-clamped (styles.css), so a truncated one
          was previously unreadable even on hover: nothing carried the full
          text. */}
      <div className="task-card-title" title={task.title}>
        {task.title}
      </div>
      <div className="task-card-meta">
        {project && <span className="task-card-project">{project.name}</span>}
        {task.issueNumber !== null &&
          (task.htmlUrl ? (
            // D2 — was a <span> whose only use of htmlUrl was as a tooltip;
            // the URL is right there, so make it a real link. Mirrors the PR
            // badge below, including its suppressClickRef guard, so a drag
            // that ends on this badge doesn't also navigate.
            <a
              className="task-card-issue"
              href={task.htmlUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClickRef.current) e.preventDefault();
              }}
            >
              <GitHubIcon size={11} />#{task.issueNumber}
            </a>
          ) : (
            <span className="task-card-issue">
              <GitHubIcon size={11} />#{task.issueNumber}
            </span>
          ))}
        {matchedPr && (
          <a
            className="task-card-pr"
            href={matchedPr.htmlUrl}
            target="_blank"
            rel="noreferrer"
            title={matchedPr.title}
            // Hermes review, PR #577/#580 — this badge sits inside the
            // draggable card; a drag started on it still ends with the
            // trailing post-drop click landing on this anchor.
            // stopPropagation alone only stops handleClick (the card's own
            // drawer-open handler) from firing — it doesn't stop the
            // anchor's own default navigation, so the PR would still open
            // in a new tab as an unwanted side effect of the drag. Same
            // suppressClickRef guard the card's own handleClick uses above.
            onClick={(e) => {
              e.stopPropagation();
              if (suppressClickRef.current) e.preventDefault();
            }}
          >
            <span className={`github-panel-ci-dot ${taskCardPrDotClass(matchedPr.ciStatus)}`} />#
            {matchedPr.number}
          </a>
        )}
        {agentName && (
          <span className="task-card-agent" title={`Agent: ${agentName}`}>
            <BotIcon size={11} />
            {agentName}
          </span>
        )}
        {statusAge && <span className="task-card-age">{statusAge}</span>}
        {/* D4 — #485's own drawer-only sync-error banner (TaskDetail.tsx)
            defeats its own stated motivation if a task can be happily
            in_progress while its GitHub sync is silently broken and nothing
            on the board says so. */}
        {task.githubSyncError && (
          <span className="task-card-sync-error" title={`GitHub sync: ${task.githubSyncError}`}>
            <WarningTriangleIcon size={11} />
          </span>
        )}
      </div>
      {/* D5 — a Failed column of several identical-looking cards conveys
          nothing on its own; the reason is the one thing worth a glance. */}
      {task.status === "failed" && task.failureReason && (
        <div className="task-card-failure-reason" title={task.failureReason}>
          <WarningTriangleIcon size={11} />
          {task.failureReason}
        </div>
      )}
      {/* D5 — "sent back to the worker once" is the single most useful fact
          about a task sitting in Reviewing (mirrors TaskDetail.tsx's own
          round indicator in the drawer). */}
      {task.status === "reviewing" && task.reviewRounds > 0 && (
        <div className="task-card-review-round">Round {task.reviewRounds} · returned to worker</div>
      )}
      {task.sessionId !== null && (
        <TaskSessionSlot
          session={workerSession ?? undefined}
          role="worker"
          theme={theme}
          onOpenSession={onOpenSession}
        />
      )}
      {task.reviewSessionId !== null && (
        <TaskSessionSlot
          session={reviewSession ?? undefined}
          role="review"
          theme={theme}
          onOpenSession={onOpenSession}
        />
      )}
      {task.status === "ready" && !taskMasterEnabled && (
        <div className="task-card-hint">Claiming is disabled — Task Master is off</div>
      )}
    </div>
  );
}

// A compact, non-SessionRow strip nested on a task card (unlike the ad-hoc
// lane's LaneCard, which reuses SessionRow verbatim — SessionRow's git/
// kill/rename/promote/subagent surface is far too heavy for a ~250px task
// column). `session` is `undefined` only once the linked id is fully
// reaped off the backend's own session list (GET /api/sessions returns
// killed rows too — see adhocSessionsByColumn's own `status === "killed"`
// filter, which would be dead code otherwise — so a killed-but-not-yet-
// reaped session still resolves here and renders the live path below with
// an "exited" presentation, tinted via .status-exited, not this "ended"
// chip). Since Task.sessionId/reviewSessionId are never cleared
// server-side, the chip is still the common eventual state for any
// completed task — just not the immediate one.
function TaskSessionSlot({
  session,
  role,
  theme,
  onOpenSession,
}: {
  session: Session | undefined;
  role: "worker" | "review";
  theme: Theme;
  onOpenSession: (session: Session) => void;
}) {
  if (!session) {
    return (
      <span className="task-card-session-strip is-gone">
        <TerminalPromptIcon size={11} />
        {role} · ended
      </span>
    );
  }

  const presentation = STATUS_PRESENTATION[session.sessionStatus];
  const logo = resolveAgentLogo(session.command, theme);
  const label = formatStatusLabel(presentation, session.sessionStatusDetail);
  const tint = rowClassNameForSeverity(session.sessionStatusSeverity);

  const open = () => onOpenSession(session);

  // Deliberately NOT draggable, and deliberately not its own tab stop.
  //
  // Hermes review caught a real bug in an earlier version of this component:
  // it WAS draggable with this same MIME, on the (wrong) assumption that
  // dropping it anywhere had no reachable target while the board is open.
  // The ad-hoc lane's own LaneCard, elsewhere in this same board, accepts
  // exactly this MIME for its own reorder — dragging this strip onto a lane
  // card highlighted it as a valid target, silently no-op'd the reorder
  // (task-linked ids are excluded from every lane column), and a completed
  // drag on some browsers still fires a plain click on the source element,
  // which then opened the session and kicked the user out of the board —
  // a misleading affordance actively doing the wrong thing, not a harmlessly
  // dead one. Simplest correct fix: don't make it draggable at all.
  //
  // Not a tabIndex={0}/role="button" element either — this strip already
  // sits inside the task card's own role="button"/tabIndex={0}, and nesting
  // two independently-focusable interactive elements with unrelated actions
  // is bad for keyboard/screen-reader users. Click (mouse only) still opens
  // the session directly; keyboard users reach the same session via the
  // card's own Enter/Space (which opens the drawer) and its Claim/Retry/
  // "Open session" actions.
  return (
    <span
      className={`task-card-session-strip${tint ? ` ${tint}` : ""}`}
      title={`${role}: ${label}`}
      aria-label={`${role} session: ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
    >
      <span className="session-dot-wrap">
        <span className={`session-dot-${presentation.tone}`} />
      </span>
      {logo ? (
        <img src={logo} alt="" className="task-card-session-strip-logo" />
      ) : (
        <BotIcon size={10} />
      )}
      {/* Hermes review — role lived only in title/aria-label, which a
          non-focusable span with no role doesn't reliably expose to screen
          readers. Putting it in the visible text too matches the "ended"
          chip above, which already reads "worker · ended". */}
      <span className="task-card-session-strip-label">
        {role} · {label}
      </span>
    </span>
  );
}

function LaneCard({
  session,
  project,
  acceptsDrop,
  onOpen,
  onEnd,
  onDragBegin,
  onDragFinish,
  onReorder,
}: {
  session: Session;
  project: Project;
  acceptsDrop: boolean;
  onOpen: () => void;
  onEnd: () => void;
  onDragBegin: () => void;
  onDragFinish: () => void;
  onReorder: (draggedId: number) => void;
}) {
  const [dropTarget, setDropTarget] = useState(false);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!acceptsDrop || !e.dataTransfer.types.includes("application/x-mullion-session")) return;
    e.preventDefault();
    setDropTarget(true);
  };

  const onDragLeave = () => setDropTarget(false);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const idStr = e.dataTransfer.getData("application/x-mullion-session");
    setDropTarget(false);
    if (!acceptsDrop) return;
    const draggedId = Number(idStr);
    if (!idStr || !Number.isFinite(draggedId)) return;
    e.preventDefault();
    if (draggedId === session.id) return;
    onReorder(draggedId);
  };

  return (
    <div
      className={`kanban-card${dropTarget ? " kanban-card-drop-target" : ""}`}
      // SessionRow (nested below) owns the actual draggable element and its
      // own dragstart — it doesn't stop propagation, so these bubble up
      // from it. This is how the lane knows which severity group a drag
      // originated in (Hermes review — see draggingSessionId's comment):
      // dragover can't read the dragged id itself, only its MIME type.
      onDragStart={onDragBegin}
      onDragEnd={onDragFinish}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="kanban-card-project" title={project.cwd}>
        {project.name}
      </div>
      <SessionRow
        session={session}
        project={project}
        onOpen={onOpen}
        onEnd={onEnd}
        showSubagents={false}
      />
    </div>
  );
}
