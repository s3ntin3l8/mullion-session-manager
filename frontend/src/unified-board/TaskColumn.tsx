import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import type { Project, Session, Task, TaskStatus } from "../api/index.js";
import type { Theme } from "../store/index.js";
import { TASK_DRAG_MIME } from "./dragTypes.js";
import { TaskCard } from "./TaskCard.js";
import { columnItems } from "./taskLanes.js";
import type { ColumnItem } from "./taskLanes.js";
import { BlockedIcon, ChevronDownIcon, ChevronRightIcon } from "../ui/icons.js";
import { Skeleton } from "../ui/Skeleton.js";

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
  collapsed,
  loading = false,
  rail = false,
  selectedTaskId = null,
  headless = false,
  status,
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
  // #746 — the hide-done board filter collapses this column to header-only
  // (title + count) rather than removing it, so the count stays visible
  // without needing to hunt through a hidden column.
  collapsed?: boolean;
  // First task fetch hasn't landed. An empty column would say "No tasks"
  // before we know that, which is the same lie as the board-level "No
  // tasks yet." flash. Card-shaped bones keep the column's shape instead.
  loading?: boolean;
  // #2841 — an empty column shrinks to a narrow rail (name + count) instead of a
  // full-width "No tasks" box. It opens again while a card that can land here is being
  // dragged, so it stays a drop target. Off on phone, which shows one column at a time.
  rail?: boolean;
  // The task the detail view is showing; its card is ringed.
  selectedTaskId?: number | null;
  // The stacked board's sections draw their own header (title, count, the
  // needs-you dot, the fold), so the column renders its body only.
  headless?: boolean;
  // The lane's status, as data-status, so a jump from the left rail can find it.
  status?: TaskStatus;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  // Which blocked stacks the user has opened, by stack key. Local to the column: a
  // stack is a view of the list, not state anyone else reads.
  const [openStacks, setOpenStacks] = useState<ReadonlySet<string>>(new Set());
  const items = useMemo(() => columnItems(tasks), [tasks]);

  const acceptsDrag = (e: DragEvent<HTMLDivElement>) =>
    acceptsDrop && e.dataTransfer.types.includes(TASK_DRAG_MIME);

  // Issue: a blocked task's own on-card badge is easy to miss while
  // scrolling past it — a column-level count makes "how many of these can I
  // actually work on" answerable at a glance, without opening each card.
  const blockedCount = tasks.filter((t) => t.blockedState === "blocked").length;
  // Not an empty column yet — we haven't been told there are no tasks.
  const pending = loading && tasks.length === 0;

  const header = (
    <div className="kanban-column-header">
      <span className="kanban-column-title">{title}</span>
      {/* Length is 0 until the first fetch lands, which is not an answer
          to "how many tasks". Omit the pill entirely: an empty span still
          paints the track (background and padding). */}
      {!pending && <span className="kanban-column-count">{tasks.length}</span>}
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
  );

  if (collapsed) {
    return (
      <div className="kanban-column kanban-column-collapsed" data-status={status}>
        {header}
      </div>
    );
  }

  if (rail && tasks.length === 0 && !pending && !acceptsDrop) {
    return (
      <div className="kanban-column kanban-column-rail" data-status={status}>
        <span className="kanban-column-title">{title}</span>
        <span className="kanban-column-count">0</span>
      </div>
    );
  }

  const renderCard = (task: Task, index: number, inStack = false) => (
    <TaskCard
      key={task.id}
      task={task}
      project={projectsById.get(task.projectId)}
      workerSession={task.sessionId !== null ? sessionsById.get(task.sessionId) : null}
      reviewSession={task.reviewSessionId !== null ? sessionsById.get(task.reviewSessionId) : null}
      theme={theme}
      taskMasterEnabled={taskMasterEnabled}
      acceptsDrop={acceptsDrop}
      onOpen={() => onOpen(task)}
      onOpenSession={onOpenSession}
      onReorder={(draggedId) => onDrop(draggedId, index)}
      onDragBegin={() => onDragBegin(task.id)}
      onDragFinish={onDragFinish}
      selected={selectedTaskId === task.id}
      inStack={inStack}
    />
  );

  const toggleStack = (key: string) =>
    setOpenStacks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderStack = (item: Extract<ColumnItem, { kind: "stack" }>) => {
    const open = openStacks.has(item.key);
    const first = item.blockers[0];
    const label = `${item.members.length} blocked by #${first.number}${
      item.blockers.length > 1 ? ` +${item.blockers.length - 1}` : ""
    }`;
    return (
      <div key={`stack:${item.key}`} className="task-stack">
        <div
          className="task-stack-head"
          // A card dragged onto the summary lands before the stack's first member.
          onDragOver={(e) => {
            if (!acceptsDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={(e) => {
            if (!acceptsDrag(e)) return;
            const draggedId = Number(e.dataTransfer.getData(TASK_DRAG_MIME));
            if (!Number.isFinite(draggedId)) return;
            e.preventDefault();
            e.stopPropagation();
            onDrop(draggedId, item.firstIndex);
          }}
        >
          <button
            type="button"
            className="task-stack-summary"
            aria-expanded={open}
            onClick={() => toggleStack(item.key)}
          >
            <BlockedIcon size={12} aria-hidden="true" />
            <span>{label}</span>
            {open ? (
              <ChevronDownIcon size={12} aria-hidden="true" />
            ) : (
              <ChevronRightIcon size={12} aria-hidden="true" />
            )}
          </button>
          {first.htmlUrl && (
            <a
              className="task-stack-link"
              href={first.htmlUrl}
              target="_blank"
              rel="noreferrer"
              title={first.title}
              aria-label={`Open blocker #${first.number} on GitHub`}
            >
              #{first.number} ↗
            </a>
          )}
        </div>
        {open && (
          <div className="task-stack-cards">
            {item.members.map((m) => renderCard(m.task, m.index, true))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`kanban-column${tasks.length === 0 && !pending ? " kanban-column-is-empty" : ""}`}
      data-status={status}
    >
      {!headless && header}
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
        {pending ? (
          <>
            <Skeleton height={72} radius={9} />
            <Skeleton height={48} radius={9} />
          </>
        ) : tasks.length === 0 ? (
          <div className="kanban-column-empty">No tasks</div>
        ) : (
          items.map((item) =>
            item.kind === "card" ? renderCard(item.task, item.index) : renderStack(item),
          )
        )}
      </div>
    </div>
  );
}
