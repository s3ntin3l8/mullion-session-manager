// Pure helpers for UnifiedBoard.tsx's ad-hoc session lane — split out for the
// same react-refresh/only-export-components reason kanban.ts and
// tasksBoard.ts document, so it's directly unit-testable without mounting
// anything.
import { KANBAN_COLUMNS, columnForSession } from "./kanban.js";
import type { KanbanColumnId } from "./kanban.js";
import type { Session, Task } from "./api.js";

// Every session id currently owned by a task — its worker and, when one was
// spawned, its advisory review agent. These render nested on their task's
// card (UnifiedBoard.tsx's TaskSessionSlot), so the ad-hoc lane below must
// exclude them: a task-linked session should appear exactly once, attributed
// to its task, not also as an unrelated card in the lane.
export function taskLinkedSessionIds(tasks: Task[]): Set<number> {
  const ids = new Set<number>();
  for (const t of tasks) {
    if (t.sessionId !== null) ids.add(t.sessionId);
    if (t.reviewSessionId !== null) ids.add(t.reviewSessionId);
  }
  return ids;
}

// KanbanBoard.tsx's own session grouping (issue #211), minus task-owned
// sessions. Filters are reproduced exactly as that component applied them —
// `kind === "terminal"` only (dock sessions are persistent per-project
// background monitors, not cards to triage), drop `status === "killed"`, and
// honor `hideEndedSessions` — with the task-linked exclusion applied BEFORE
// calling columnForSession, so each returned column's length is the count
// actually rendered, not a pre-filter count.
export function adhocSessionsByColumn(
  sessions: Session[],
  linkedSessionIds: ReadonlySet<number>,
  hideEndedSessions: boolean,
): Record<KanbanColumnId, Session[]> {
  const map: Record<KanbanColumnId, Session[]> = {
    working: [],
    attention: [],
    finished: [],
    idle: [],
    exited: [],
  };
  for (const session of sessions) {
    if (session.kind !== "terminal") continue;
    if (session.status === "killed") continue;
    if (hideEndedSessions && session.status === "exited") continue;
    if (linkedSessionIds.has(session.id)) continue;
    map[columnForSession(session)].push(session);
  }
  return map;
}

// The lane renders its five severity sub-groups attention-first — a triage
// strip, not a full board — rather than KANBAN_COLUMNS' own declaration
// order (Working first), which is what the standalone session board used.
export const LANE_COLUMN_ORDER: KanbanColumnId[] = [
  "attention",
  "working",
  "finished",
  "idle",
  "exited",
];

export function laneColumnTitle(id: KanbanColumnId): string {
  return KANBAN_COLUMNS.find((c) => c.id === id)?.title ?? id;
}
