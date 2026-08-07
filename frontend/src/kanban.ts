// Pure column/order logic for the session-severity grouping originally built
// for issue #211's standalone KanbanBoard.tsx, now UnifiedBoard.tsx's ad-hoc
// session lane — split into its own module (rather than living alongside the
// component) purely so that component can stay component-only for
// react-refresh/only-export-components (Fast Refresh breaks once a component
// file also exports plain functions/constants) — same reasoning reorder.ts
// already exists separately from WorkspaceSwitcher.tsx for.
import { computeReorder } from "./reorder.js";
import type { ReorderItem } from "./reorder.js";
import type { Session } from "./api.js";

export type KanbanColumnId = "working" | "attention" | "finished" | "idle" | "exited";

export const KANBAN_COLUMNS: { id: KanbanColumnId; title: string }[] = [
  { id: "working", title: "Working" },
  { id: "attention", title: "Needs Attention" },
  { id: "finished", title: "Finished" },
  { id: "idle", title: "Idle" },
  { id: "exited", title: "Exited" },
];

// Keys off the backend's own derived `sessionStatusSeverity`
// (src/services/session-status.ts) rather than re-implementing a precedence
// chain over the raw live fields — this is what stopped Sidebar.tsx's own
// status-dot precedence and this column mapping from silently disagreeing
// with each other the way they used to (kanban.ts used to treat "killed" as
// Exited while Sidebar.tsx's own check only tested `status === "exited"`,
// leaving a killed session's card oddly still active-looking there — see the
// plan doc's Context section). Five columns, not one per severity: `failed`/
// `blocked`/`waiting` collapse into "Needs Attention"; `done` maps to
// "Finished" — each still renders its own distinct dot+label within the card
// (see sessionStatus.ts's STATUS_PRESENTATION), so nothing is lost, just
// grouped. No `default` branch: this switch is exhaustive over
// SessionSeverity's closed union, so a new severity added without a matching
// case here is a `make typecheck` failure ("not all code paths return a
// value"), not a silently-uncategorized card.
export function columnForSession(session: Session): KanbanColumnId {
  switch (session.sessionStatusSeverity) {
    case "gone":
      return "exited";
    case "failed":
    case "blocked":
    case "waiting":
      return "attention";
    case "done":
      return "finished";
    case "busy":
      return "working";
    case "dormant":
      return "idle";
  }
}

// Applies a column's stored custom order (an array of session ids, issue
// #211 — see store.ts's `kanbanOrder` doc comment) on top of that column's
// actual current session list: known ids keep the stored order, and any
// session not yet in the stored array (new arrivals, or a session that just
// moved into this column) is appended at the end in its incoming order.
// Pure and independent of React so it's directly unit-testable, same
// "DOM-free reindex math in its own function" shape as reorder.ts's
// computeReorder.
export function orderSessionsForColumn(sessions: Session[], order: number[]): Session[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const ordered: Session[] = [];
  for (const id of order) {
    const s = byId.get(id);
    if (s) {
      ordered.push(s);
      byId.delete(id);
    }
  }
  for (const s of sessions) {
    if (byId.has(s.id)) ordered.push(s);
  }
  return ordered;
}

// Computes the new stored order array for a column after dragging
// `draggedId` to `targetIndex` within it. Reuses reorder.ts's computeReorder
// for the actual reindex math (a single-bucket case of it — every card in a
// column shares one constant `groupId` here since cards never move between
// columns) rather than reimplementing that splice-and-reindex logic: this
// column's *current* effective order (orderSessionsForColumn above) becomes
// the ReorderItem[] input, `computeReorder` returns only the rows whose
// position actually changed (see reorder.test.ts), and this reconstructs
// the full id array from that — items it didn't return simply keep their
// original position. A `draggedId` not present in `sessions` (e.g. a card
// dragged in from a *different* column — cross-column drag between severity
// groups isn't supported, since column membership is derived from
// sessionStatusSeverity, not editable) is a no-op: computeReorder can't
// find it and returns no updates, so every item keeps its original position.
export function computeKanbanReorder(
  sessions: Session[],
  order: number[],
  draggedId: number,
  targetIndex: number,
): number[] {
  const ordered = orderSessionsForColumn(sessions, order);
  const items: ReorderItem[] = ordered.map((s, index) => ({
    id: s.id,
    groupId: 0,
    position: index,
  }));
  const updates = computeReorder(items, draggedId, targetIndex, 0);
  const updatedPositions = new Map(updates.map((u) => [u.id, u.position]));
  const result: number[] = new Array(items.length);
  for (const item of items) {
    result[updatedPositions.get(item.id) ?? item.position] = item.id;
  }
  return result;
}
