import { useState } from "react";
import type { DragEvent } from "react";
import type { Project, Session, Task } from "../api/index.js";
import type { Theme } from "../store/index.js";
import { TASK_DRAG_MIME } from "./dragTypes.js";
import { TaskCard } from "./TaskCard.js";
import { BlockedIcon } from "../ui/icons.js";

// Split out of UnifiedBoard.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md) — one status column of the
// board (backlog/ready/claimed/...), rendering its own drop target and the
// TaskCard.tsx list. Drop-target acceptance itself (`acceptsDrop`) stays a
// prop computed by the board — see UnifiedBoard.tsx's own
// "Same lifted-state pattern as TaskColumn's acceptsDrop" comment on
// `draggingSessionId` for why that pattern is lifted rather than owned
// locally.
export function TaskColumn({
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

  // Issue: a blocked task's own on-card badge is easy to miss while
  // scrolling past it — a column-level count makes "how many of these can I
  // actually work on" answerable at a glance, without opening each card.
  const blockedCount = tasks.filter((t) => t.blockedState === "blocked").length;

  return (
    <div className={`kanban-column${tasks.length === 0 ? " kanban-column-is-empty" : ""}`}>
      <div className="kanban-column-header">
        <span className="kanban-column-title">{title}</span>
        <span className="kanban-column-count">{tasks.length}</span>
        {blockedCount > 0 && (
          <span
            className="kanban-column-blocked-count"
            role="img"
            title={`${blockedCount} blocked`}
            aria-label={`${blockedCount} blocked`}
          >
            <BlockedIcon size={10} aria-hidden="true" />
            {blockedCount}
          </span>
        )}
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
