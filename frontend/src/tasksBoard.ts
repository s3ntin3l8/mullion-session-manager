// Pure column/order/drag logic for the task board (Phase 6 Task Master,
// 6.5/#218 — originally TasksPanel.tsx, now UnifiedBoard.tsx's task columns)
// — split into its own module for the same react-refresh/
// only-export-components reason kanban.ts documents, and so it's directly
// unit-testable without mounting anything.
import { computeReorder } from "./reorder.js";
import type { ReorderItem } from "./reorder.js";
import { TASK_STATUSES } from "./api/index.js";
import type { Task, TaskStatus } from "./api/index.js";

export const TASK_COLUMNS: { id: TaskStatus; title: string }[] = [
  { id: "backlog", title: "Backlog" },
  { id: "ready", title: "Ready" },
  { id: "claimed", title: "Claimed" },
  { id: "in_progress", title: "In Progress" },
  { id: "reviewing", title: "Reviewing" },
  { id: "done", title: "Done" },
  { id: "failed", title: "Failed" },
];

// Exhaustive over TaskStatus's closed union (no `default` branch) — an
// unhandled status added to TASK_STATUSES without a matching case here is a
// `make typecheck` failure ("not all code paths return a value"), the same
// convention kanban.ts's columnForSession follows for SessionSeverity.
export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "backlog":
      return "Backlog";
    case "ready":
      return "Ready";
    case "claimed":
      return "Claimed";
    case "in_progress":
      return "In Progress";
    case "reviewing":
      return "Reviewing";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
  }
}

// The only statuses routes/tasks.ts's plain PATCH endpoint can write
// directly (see its own doc comment) — every other transition requires the
// dedicated claim/approve/reject endpoints, which are actions, not drag
// targets. A card can therefore only be dragged between these two columns;
// dropping one onto "claimed"/"in_progress"/"reviewing"/"done"/"failed" is
// not a valid drag operation.
const DRAG_EDITABLE_STATUSES: readonly TaskStatus[] = ["backlog", "ready"];

export function canDragToColumn(status: TaskStatus): boolean {
  return DRAG_EDITABLE_STATUSES.includes(status);
}

// Groups + orders tasks by their persisted boardOrder (Phase 6's own
// render/ordering tier, distinct from status). Unlike kanban.ts's sessions
// (which have no server-side order at all, hence its own client-only
// `kanbanOrder`), a task's order is already a real column — this just sorts
// by it, with `id` as a stable tiebreaker for equal/default boardOrder
// values (e.g. two tasks both left at the 0 default).
export function orderTasksForColumn(tasks: Task[], status: TaskStatus): Task[] {
  return tasks
    .filter((t) => t.status === status)
    .sort((a, b) => a.boardOrder - b.boardOrder || a.id - b.id);
}

// Maps each TaskStatus to a stable numeric index so reorder.ts's
// computeReorder (whose ReorderItem.groupId is `number | null`, matching
// WorkspaceSwitcher.tsx's own numeric group ids) can be reused for the
// reindex math here too, rather than reimplementing it. Purely an
// implementation detail of this function — never exposed.
const STATUS_INDEX: Record<TaskStatus, number> = Object.fromEntries(
  TASK_STATUSES.map((status, index) => [status, index]),
) as Record<TaskStatus, number>;

export interface TaskReorderUpdate {
  id: number;
  status: TaskStatus;
  boardOrder: number;
}

// Computes the {id, status, boardOrder} writes needed after dragging
// `draggedId` to `targetIndex` within `targetStatus`'s column — cross-column
// (status change) or same-column (pure reindex), both handled by
// computeReorder's own source/target-bucket logic (WorkspaceSwitcher.tsx's
// precedent: a real, persisted reorder, not kanban.ts's in-memory-only
// `kanbanOrder`). Callers are expected to only invoke this for a
// `targetStatus` that passes canDragToColumn — this function itself doesn't
// enforce that, since it has no way to also validate the *source* status
// without the caller's context (a card already sitting in a non-drag-
// editable column, e.g. reordering within "claimed", still needs the same
// reindex math; only *changing* status is restricted).
export function computeTaskReorder(
  tasks: Task[],
  draggedId: number,
  targetStatus: TaskStatus,
  targetIndex: number,
): TaskReorderUpdate[] {
  // Hermes review, PR #477 — computeReorder's own bucketOf sorts by
  // `position` (boardOrder) but breaks ties by whatever order `tasks`
  // arrived in, which for the live store is GET /api/tasks's own
  // `ORDER BY status, boardOrder, createdAt` — not the same tiebreak
  // orderTasksForColumn uses to actually render the column (boardOrder,
  // then id). Two tasks sharing a boardOrder (e.g. both left at the column
  // default of 0) could therefore reindex into a different order than what
  // was on screen. Pre-sorting here with the exact same (boardOrder, id)
  // comparator as orderTasksForColumn makes the two agree.
  const sorted = [...tasks].sort((a, b) => a.boardOrder - b.boardOrder || a.id - b.id);
  const items: ReorderItem[] = sorted.map((t) => ({
    id: t.id,
    groupId: STATUS_INDEX[t.status],
    position: t.boardOrder,
  }));
  const updates = computeReorder(items, draggedId, targetIndex, STATUS_INDEX[targetStatus]);
  return updates.map((u) => ({
    id: u.id,
    status: TASK_STATUSES[u.groupId as number],
    boardOrder: u.position,
  }));
}

// A project filter renders a column from a subset of `tasks` (see
// UnifiedBoard.tsx's `visibleTasks`), but computeTaskReorder above must
// still run against the FULL, unfiltered column — it reindexes every task
// in the target bucket, including ones a filter is currently hiding, and
// running it against only the visible subset would silently drop those
// hidden tasks' boardOrder right off the end of the column. TaskColumn's
// own onDrop only ever hands back an index into whatever list it rendered
// (`unified-board/TaskColumn.tsx`), so a filtered drop needs that visible
// index translated into what it would have been against the full column
// before it reaches computeTaskReorder.
//
// This does NOT correct computeReorder's own index semantics (`reorder.ts`'s
// bucketOf excludes the dragged item before splicing at `targetIndex`) — it
// reproduces them. `full` here, like `visibleTasks` passed in, still
// includes the dragged task; an anchor-id lookup against it therefore lands
// on the exact same index computeTaskReorder already expects when no filter
// is active, by construction (visibleTasks === full then, so
// `full.findIndex(anchor) === visibleIndex` trivially). Do not try to also
// account for the dragged item's own position — that's computeReorder's
// job, not this one's.
export function absoluteDropIndex(
  allTasks: Task[],
  visibleTasks: Task[],
  targetStatus: TaskStatus,
  visibleIndex: number,
): number {
  const full = orderTasksForColumn(allTasks, targetStatus);
  const visibleColumn = orderTasksForColumn(visibleTasks, targetStatus);
  if (visibleIndex >= visibleColumn.length) return full.length;
  const anchor = visibleColumn[visibleIndex];
  const found = full.findIndex((t) => t.id === anchor.id);
  return found === -1 ? full.length : found;
}
