import { useState } from "react";
import type { DragEvent } from "react";
import type { Project, Session } from "../api/index.js";
import { SessionRow } from "../Sidebar.js";

// Split out of UnifiedBoard.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md) — a card in the ad-hoc session
// lane beneath the task columns, for any session not owned by a task. Unlike
// TaskCard.tsx's own nested TaskSessionSlot.tsx (deliberately NOT
// SessionRow — see that component's own comment), this reuses SessionRow
// verbatim: the lane is the session's primary home on this board, not a
// secondary status strip, so its full git/kill/rename/promote/subagent
// surface is warranted here.
export function LaneCard({
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
      // originated in (Hermes review — see UnifiedBoard.tsx's
      // `draggingSessionId` comment): dragover can't read the dragged id
      // itself, only its MIME type.
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
