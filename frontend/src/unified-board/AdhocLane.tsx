import { useId, useMemo, useState } from "react";
import type { Project, Session } from "../api/index.js";
import { adhocSummary, LANE_COLUMN_ORDER, laneColumnTitle } from "../boardLanes.js";
import { computeKanbanReorder, orderSessionsForColumn } from "../kanban.js";
import type { KanbanColumnId } from "../kanban.js";
import { useDashboardStore } from "../store/index.js";
import { ChevronDownIcon, ChevronRightIcon } from "../ui/icons.js";
import { LaneCard } from "./LaneCard.js";

// The board's ad-hoc strip: every session that no task owns. Collapsed it is a
// single row — the title, a count, one dot per session and a "9 running · 3
// need you · 8 idle" line — so the board still tells you something is waiting
// without spending a screen on it; expanded it is the severity groups of
// LaneCards it always was. Split out of UnifiedBoard.tsx (#2845) so the phone
// (new there) and the desktop render the same component.
export function AdhocLane({
  laneColumns,
  projectsById,
  kanbanOrder,
  onOpenSession,
  onSessionEnded,
}: {
  laneColumns: Record<KanbanColumnId, Session[]>;
  projectsById: ReadonlyMap<number, Project>;
  kanbanOrder: Partial<Record<KanbanColumnId, number[]>>;
  onOpenSession: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  // The body only exists while expanded, so the toggle points at it only then,
  // and the id is per instance: desktop and phone both render this component.
  const bodyId = useId();
  // Hermes review — dragover can only see dataTransfer.types, not the
  // dragged id itself (getData is drop-only), so a card can't tell on its
  // own whether an incoming x-mullion-session drag belongs to its own
  // severity group. Every group sits contiguous in one lane, so without this
  // a card in a different group still highlights as a valid target and the
  // drop then silently no-ops (computeKanbanReorder can't find the id in that
  // group's list). Same lifted-state pattern as TaskColumn.tsx's acceptsDrop.
  const [draggingSessionId, setDraggingSessionId] = useState<number | null>(null);

  // Counts only sessions that actually render a card below (Hermes review —
  // a session whose project has since been deleted is still counted by
  // adhocSessionsByColumn, since that partition has no project data to
  // check, but the render loop skips it; without this filter the header count
  // could exceed what's visible).
  const summary = useMemo(
    () => adhocSummary(laneColumns, (session) => projectsById.has(session.projectId)),
    [laneColumns, projectsById],
  );

  return (
    <div className="kanban-unified-lane">
      <div className="kanban-lane-header">
        <button
          type="button"
          className="kanban-lane-collapse"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
        >
          {collapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
          Ad-hoc sessions (no task)
        </button>
        <span className="kanban-lane-count">{summary.total}</span>
        {summary.total > 0 && (
          <>
            <span className="kanban-lane-dots" aria-hidden="true">
              {summary.dots.map((tone, index) => (
                <i key={index} className={`kanban-lane-dot kanban-lane-dot--${tone}`} />
              ))}
              {summary.total > summary.dots.length && (
                <span className="kanban-lane-dots-more">
                  +{summary.total - summary.dots.length}
                </span>
              )}
            </span>
            <span className="kanban-lane-summary">{summary.text}</span>
          </>
        )}
      </div>
      {!collapsed && (
        <div className="kanban-lane-body" id={bodyId}>
          {summary.total === 0 ? (
            <div className="kanban-lane-empty">No sessions without a task.</div>
          ) : (
            // Filters by the same visible-card count the group's own title
            // uses below (Hermes review) — using the raw, unfiltered
            // laneColumns[id].length here rendered an empty group header
            // (title + a "0" count, no cards) whenever every session in a
            // group had a since-deleted project.
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
                        // P9 — not `void`-discarded: SessionRow (nested inside
                        // LaneCard) catches a rejection here and surfaces it
                        // inline, same as Sidebar.tsx's two identical onEnd
                        // call sites. LaneCard's own `onEnd: () => void` prop
                        // type doesn't need widening — TS's void-return
                        // bivariance already accepts this function's real
                        // Promise return value, and SessionRow's
                        // `Promise.resolve(onEnd())` sees the actual returned
                        // promise at runtime.
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
  );
}
