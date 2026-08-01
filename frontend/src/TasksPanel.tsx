import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import { useDashboardStore } from "./store.js";
import {
  TASK_COLUMNS,
  canDragToColumn,
  orderTasksForColumn,
  computeTaskReorder,
} from "./tasksBoard.js";
import type { Task, TaskStatus } from "./api.js";
import { commandToBinary } from "./cliLogos.js";
import { BotIcon, GitHubIcon, LayersIcon, PlusIcon, TerminalPromptIcon } from "./icons.js";
import { ApiError } from "./api.js";

const TASK_DRAG_MIME = "application/x-mullion-task";

// Intentionally empty — the first global panel (6.5/#218): a single
// constant "tasks" panel id, not scoped to any one project.
export type TasksPanelParams = Record<string, never>;

// Phase 6 (6.5/#218) — the full task board, replacing the 2.5 thin slice's
// sidebar TasksSection. Board render, local CRUD, and drag work regardless
// of taskMasterEnabled (6.9's own binding decision); only Claim/Approve/
// Reject (TaskDetail.tsx) are disabled with an explanatory hint when the
// flag is off, since those spawn/promote autonomous agents.
export function TasksPanel({ onOpenTask }: { onOpenTask: (task: Task) => void }) {
  const { tasks, projects, taskMasterEnabled, refreshTasks, updateTask, createTask } =
    useDashboardStore();

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const [creating, setCreating] = useState(false);
  // Hermes review, PR #477 — a failed reorder PATCH used to be a silent
  // fire-and-forget with no error surface and no resync, leaving the board
  // showing a reindex that never actually landed server-side. Now caught,
  // surfaced here, and followed by a refetch so the board reflects whatever
  // subset of the drag's updates actually succeeded rather than staying on
  // stale optimistic-looking state (there's no real optimistic state here —
  // `tasks` only changes once refreshTasks lands — but a failed PATCH mid-
  // drag can still leave some rows updated and others not).
  const [dragError, setDragError] = useState<string | null>(null);
  // Independent review, PR #477 — every column used to highlight as a valid
  // drop target on dragover, since the check only looked at the MIME type
  // (present for ANY task drag, from any column). A drop into a non-drag-
  // editable column (e.g. "done") then silently no-op'd in applyDrop below
  // with no visible explanation — the affordance was lying. Tracking which
  // task is actually being dragged lets each column compute its own real
  // validity (dataTransfer's payload isn't readable during dragover, only
  // its `types`, so this can't be derived from the drag event itself).
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const draggingTask =
    draggingId !== null ? (tasks.find((t) => t.id === draggingId) ?? null) : null;

  const applyDrop = (draggedId: number, targetStatus: TaskStatus, targetIndex: number) => {
    const dragged = tasks.find((t) => t.id === draggedId);
    if (!dragged) return;
    // Same-column reorder is always allowed (boardOrder alone is editable
    // regardless of status — routes/tasks.ts's PATCH only guards the
    // `status` field). A cross-column move additionally requires BOTH the
    // source and target status to be drag-editable (backlog<->ready) — see
    // canDragToColumn's own doc comment on why every other column is a
    // read-only, action-driven state.
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
      // Only the dragged row's own status can actually change here — every
      // other returned update is a same-column reindex whose status is
      // unchanged, so `status` stays out of their patch entirely. The cast
      // is safe: the guard above already restricts a real status change to
      // the backlog<->ready pair.
      if (update.id === draggedId && update.status !== dragged.status) {
        patch.status = update.status as "backlog" | "ready";
      }
      updateTask(update.id, patch).catch((err) => {
        setDragError(err instanceof ApiError ? err.message : "Failed to save the reordered task");
        void refreshTasks();
      });
    }
  };

  return (
    <div className="tasks-panel">
      <TasksToolbar
        creating={creating}
        onToggleCreate={() => setCreating((v) => !v)}
        projects={projects}
        createTask={createTask}
        onCreated={() => setCreating(false)}
      />
      {dragError && <div className="task-detail-error tasks-panel-drag-error">{dragError}</div>}
      {tasks.length === 0 ? (
        <div className="github-panel-empty">
          <LayersIcon size={20} />
          <div>No tasks yet.</div>
          <div className="tasks-panel-empty-hint">
            Label a GitHub issue <code>mullion-task</code>, or use "New task" above to create one
            locally.
          </div>
        </div>
      ) : (
        <div className="kanban-board tasks-board">
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
                tasks={columnTasks}
                taskMasterEnabled={taskMasterEnabled}
                acceptsDrop={acceptsDrop}
                onOpen={onOpenTask}
                onDrop={(draggedId, index) => applyDrop(draggedId, column.id, index)}
                onDragBegin={setDraggingId}
                onDragFinish={() => setDraggingId(null)}
              />
            );
          })}
        </div>
      )}
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
  // Hermes review, PR #477 — this used to be `useState(projects[0]?.id ??
  // null)`, read only once at mount, so opening the panel before `projects`
  // had loaded (or the previously-picked project being deleted) left the
  // selection stuck at null/a stale id with no visible indication why
  // Create stayed disabled. Deriving it fresh every render — manualProjectId
  // is null until the user actually picks something — means it's always
  // valid without an effect (React's own "you might not need an effect"
  // guidance: this is plain derived state, not a sync-with-external-system
  // case).
  const [manualProjectId, setManualProjectId] = useState<number | null>(null);
  const projectId =
    manualProjectId !== null && projects.some((p) => p.id === manualProjectId)
      ? manualProjectId
      : (projects[0]?.id ?? null);
  const [title, setTitle] = useState("");
  // Hermes review, PR #477 — createTask had no in-flight guard (a double
  // click/Enter-then-click could fire two creates) and no error surface (a
  // failed create silently left the form open with nothing to show for it).
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
  taskMasterEnabled,
  acceptsDrop,
  onOpen,
  onDrop,
  onDragBegin,
  onDragFinish,
}: {
  title: string;
  tasks: Task[];
  projectsById: Map<number, { id: number; name: string }>;
  taskMasterEnabled: boolean;
  acceptsDrop: boolean;
  onOpen: (task: Task) => void;
  onDrop: (draggedId: number, index: number) => void;
  onDragBegin: (id: number) => void;
  onDragFinish: () => void;
}) {
  const [dropTarget, setDropTarget] = useState(false);

  // `acceptsDrop` (computed by the parent from the dragged task's own
  // status) gates whether this column is a *legal* target at all;
  // `dataTransfer.types` alone only proves SOME task is being dragged, not
  // that it's allowed here — see the parent's own doc comment.
  const acceptsDrag = (e: DragEvent<HTMLDivElement>) =>
    acceptsDrop && e.dataTransfer.types.includes(TASK_DRAG_MIME);

  return (
    <div className="kanban-column">
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
              taskMasterEnabled={taskMasterEnabled}
              acceptsDrop={acceptsDrop}
              onOpen={() => onOpen(task)}
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
  taskMasterEnabled,
  acceptsDrop,
  onOpen,
  onReorder,
  onDragBegin,
  onDragFinish,
}: {
  task: Task;
  project: { id: number; name: string } | undefined;
  taskMasterEnabled: boolean;
  acceptsDrop: boolean;
  onOpen: () => void;
  onReorder: (draggedId: number) => void;
  onDragBegin: () => void;
  onDragFinish: () => void;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  const agentName = task.agentCommand ? commandToBinary(task.agentCommand) : null;

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TASK_DRAG_MIME, String(task.id));
    e.dataTransfer.effectAllowed = "move";
    onDragBegin();
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

  return (
    <div
      className={`task-card${dropTarget ? " kanban-card-drop-target" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDropTarget(false)}
      onDrop={onDrop}
      onDragEnd={onDragFinish}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="task-card-title">{task.title}</div>
      <div className="task-card-meta">
        {project && <span className="task-card-project">{project.name}</span>}
        {task.issueNumber !== null && (
          <span className="task-card-issue" title={task.htmlUrl ?? undefined}>
            <GitHubIcon size={11} />#{task.issueNumber}
          </span>
        )}
        {agentName && (
          <span className="task-card-agent" title={`Agent: ${agentName}`}>
            <BotIcon size={11} />
            {agentName}
          </span>
        )}
        {task.sessionId !== null && (
          <span className="task-card-session" title="Has a linked session">
            <TerminalPromptIcon size={11} />
          </span>
        )}
      </div>
      {task.status === "ready" && !taskMasterEnabled && (
        <div className="task-card-hint">Claiming is disabled — Task Master is off</div>
      )}
    </div>
  );
}
