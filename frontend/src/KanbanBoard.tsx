import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import { useDashboardStore } from "./store.js";
import { SessionRow } from "./Sidebar.js";
import {
  KANBAN_COLUMNS,
  columnForSession,
  computeKanbanReorder,
  orderSessionsForColumn,
} from "./kanban.js";
import type { KanbanColumnId } from "./kanban.js";
import type { Project, Session } from "./api.js";

// Issue #211 — the Kanban board view. A pure-frontend alternative to
// Sidebar.tsx's per-project list: instead of grouping sessions by project,
// this groups every "terminal" session (across ALL projects — a global,
// dashboard-style board, not scoped to one project's own sessions the way
// the sidebar's list is) into three fixed columns by status/attention — see
// kanban.ts's columnForSession for the exact precedence rule. Rendered as
// an overlay over the dockview grid area (see App.tsx) rather than inside
// the sidebar itself — a global 3-column board needs more width than the
// sidebar's own SIDEBAR_MAX_WIDTH (store.ts) affords.
//
// Cards reuse SessionRow wholesale (dot/logo/title/status label/event line/
// git-details toggle/kill button, plus its existing `application/x-mullion-
// session` draggable — see Sidebar.tsx) rather than a rebuilt, Kanban-only
// card component: the row content itself doesn't need to change, only its
// container (a project-name badge is added here since a cross-project board
// needs that context, which SessionRow itself never shows).
//
// Drag-and-drop reuses the *same* native HTML5 DnD + transfer-type pattern
// as the rest of the app (SessionRow's own onDragStart, WorkspaceSwitcher's
// reorder — no new library). A card being dragged still carries the exact
// payload App.tsx's own drop targets already understand, so dropping a
// Kanban card onto the tiled grid (once toggled back to list view) opens it
// as a panel exactly like dragging it out of the sidebar would — dropping
// it onto another card in the *same* column instead reorders locally, which
// is all issue #211 asks for (cross-column drag — i.e. changing a session's
// status by dragging it — isn't a thing: column membership is derived, not
// editable).
export function KanbanBoard({
  onOpenSession,
  onSessionEnded,
}: {
  onOpenSession: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
}) {
  const { sessions, projects, kanbanOrder, setKanbanColumnOrder, deleteSession, setViewMode } =
    useDashboardStore();

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  // Same `kind === "terminal"` scoping as Sidebar.tsx's own project-list
  // filter (dock sessions are persistent per-project background monitors,
  // not really "cards to triage" — they never appear in the sidebar's list
  // either, see Sidebar.tsx's own filter comment).
  const grouped = useMemo(() => {
    const map: Record<KanbanColumnId, Session[]> = { running: [], attention: [], exited: [] };
    for (const session of sessions) {
      if (session.kind !== "terminal") continue;
      map[columnForSession(session)].push(session);
    }
    return map;
  }, [sessions]);

  return (
    <div className="kanban-board">
      {KANBAN_COLUMNS.map((column) => {
        const columnSessions = grouped[column.id];
        const order = kanbanOrder[column.id] ?? [];
        const orderedSessions = orderSessionsForColumn(columnSessions, order);
        return (
          <div className="kanban-column" key={column.id}>
            <div className="kanban-column-header">
              <span className="kanban-column-title">{column.title}</span>
              <span className="kanban-column-count">{orderedSessions.length}</span>
            </div>
            <div className="kanban-column-body">
              {orderedSessions.length === 0 ? (
                <div className="kanban-column-empty">No sessions</div>
              ) : (
                orderedSessions.map((session, index) => {
                  const project = projectsById.get(session.projectId);
                  // A session whose project was deleted out from under it
                  // (rare — see Sidebar.tsx's own equivalent edge cases) has
                  // nothing sensible to render (SessionRow requires a real
                  // Project for its worktree/branch lookups) — skip it
                  // rather than render a broken card. The column's own
                  // count above already reflects `orderedSessions.length`,
                  // not a post-filter count, matching how rare/edge this is.
                  if (!project) return null;
                  return (
                    <KanbanCard
                      key={session.id}
                      session={session}
                      project={project}
                      onOpen={() => {
                        setViewMode("list");
                        onOpenSession(session);
                      }}
                      onEnd={() =>
                        void deleteSession(session.id).then(() => onSessionEnded(session))
                      }
                      onReorder={(draggedId) => {
                        const next = computeKanbanReorder(columnSessions, order, draggedId, index);
                        setKanbanColumnOrder(column.id, next);
                      }}
                    />
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({
  session,
  project,
  onOpen,
  onEnd,
  onReorder,
}: {
  session: Session;
  project: Project;
  onOpen: () => void;
  onEnd: () => void;
  onReorder: (draggedId: number) => void;
}) {
  const [dropTarget, setDropTarget] = useState(false);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("application/x-mullion-session")) return;
    e.preventDefault();
    setDropTarget(true);
  };

  const onDragLeave = () => setDropTarget(false);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const idStr = e.dataTransfer.getData("application/x-mullion-session");
    setDropTarget(false);
    const draggedId = Number(idStr);
    if (!idStr || !Number.isFinite(draggedId)) return;
    e.preventDefault();
    if (draggedId === session.id) return;
    onReorder(draggedId);
  };

  return (
    <div
      className={`kanban-card${dropTarget ? " kanban-card-drop-target" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="kanban-card-project" title={project.cwd}>
        {project.name}
      </div>
      <SessionRow session={session} project={project} onOpen={onOpen} onEnd={onEnd} />
    </div>
  );
}
