// Pure column/order logic for KanbanBoard.tsx (issue #211) — split into its
// own module (rather than living alongside the component) purely so
// KanbanBoard.tsx can stay component-only for react-refresh/only-export-
// components (Fast Refresh breaks once a component file also exports plain
// functions/constants) — same reasoning reorder.ts already exists
// separately from WorkspaceSwitcher.tsx for.
import { computeReorder } from "./reorder.js";
import type { ReorderItem } from "./reorder.js";
import type { Session } from "./api.js";

export type KanbanColumnId = "working" | "attention" | "idle" | "exited";

export const KANBAN_COLUMNS: { id: KanbanColumnId; title: string }[] = [
  { id: "working", title: "Working" },
  { id: "attention", title: "Needs Attention" },
  { id: "idle", title: "Idle" },
  { id: "exited", title: "Exited" },
];

// Same precedence SessionRow.tsx's own status-dot branch uses — attention
// wins over working/idle, and an exited session shows as Exited regardless of
// a possibly still-true `attention` flag. The working/idle split (four
// columns, not three) mirrors the design's own States doc treating
// Working/Idle/Attention/Exited as four peers, and SessionRow's own
// `activity === "working"` branch. Killed sessions are filtered out entirely
// at the board level (KanbanBoard.tsx, matching Sidebar.tsx's list), so the
// `killed` case here is now just a defensive fallback rather than a column any
// card actually lands in.
export function columnForSession(session: Session): KanbanColumnId {
  if (session.status === "exited" || session.status === "killed") return "exited";
  if (session.attention) return "attention";
  if (session.activity === "working") return "working";
  return "idle";
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
// dragged in from a *different* column — cross-column drag isn't supported,
// see KanbanBoard.tsx's own doc comment) is a no-op: computeReorder can't
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
