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
      void updateTask(update.id, patch);
    }
  };

  return (
    <div className="tasks-panel">
      <TasksToolbar
        creating={creating}
        onToggleCreate={() => setCreating((v) => !v)}
        projects={projects}
        onCreate={(projectId, title) => createTask(projectId, title).then(() => setCreating(false))}
      />
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
            return (
              <TaskColumn
                key={column.id}
                title={column.title}
                projectsById={projectsById}
                tasks={columnTasks}
                taskMasterEnabled={taskMasterEnabled}
                onOpen={onOpenTask}
                onDrop={(draggedId, index) => applyDrop(draggedId, column.id, index)}
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
  onCreate,
}: {
  creating: boolean;
  onToggleCreate: () => void;
  projects: { id: number; name: string }[];
  onCreate: (projectId: number, title: string) => void;
}) {
  const [projectId, setProjectId] = useState<number | null>(projects[0]?.id ?? null);
  const [title, setTitle] = useState("");

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
            onChange={(e) => setProjectId(Number(e.target.value))}
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
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim() && projectId !== null) {
                onCreate(projectId, title.trim());
                setTitle("");
              }
            }}
          />
          <button
            className="tasks-panel-new-submit"
            disabled={!title.trim() || projectId === null}
            onClick={() => {
              if (!title.trim() || projectId === null) return;
              onCreate(projectId, title.trim());
              setTitle("");
            }}
          >
            Create
          </button>
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
  onOpen,
  onDrop,
}: {
  title: string;
  tasks: Task[];
  projectsById: Map<number, { id: number; name: string }>;
  taskMasterEnabled: boolean;
  onOpen: (task: Task) => void;
  onDrop: (draggedId: number, index: number) => void;
}) {
  const [dropTarget, setDropTarget] = useState(false);

  const acceptsDrag = (e: DragEvent<HTMLDivElement>) =>
    e.dataTransfer.types.includes(TASK_DRAG_MIME);

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
              onOpen={() => onOpen(task)}
              onReorder={(draggedId) => onDrop(draggedId, index)}
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
  onOpen,
  onReorder,
}: {
  task: Task;
  project: { id: number; name: string } | undefined;
  taskMasterEnabled: boolean;
  onOpen: () => void;
  onReorder: (draggedId: number) => void;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  const agentName = task.agentCommand ? commandToBinary(task.agentCommand) : null;

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TASK_DRAG_MIME, String(task.id));
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TASK_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(true);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropTarget(false);
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
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
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
