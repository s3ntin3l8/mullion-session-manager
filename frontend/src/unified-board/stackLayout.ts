// Pure helpers for the stacked board (#3011): when the board's own width has
// room for fewer than three status lanes, it shows one section per status
// instead, active statuses first. Kept apart from StackedBoard.tsx (a different name: the two would collide on a case-insensitive filesystem) for the
// react-refresh/only-export-components reason tasksBoard.ts documents.
import type { Task, TaskStatus } from "../api/index.js";
import { needsYouReason } from "../github/taskMasterSummary.js";
import { BOARD_COLUMNS, boardColumnTasks } from "../tasksBoard.js";

// Three lanes at the unified board's own column floor (160px, empty-states.css
// `.kanban-unified-columns .kanban-column`), two 14px gaps between them and the
// board's 16px padding on each side. Narrower than this, a third lane would
// only be reachable by scrolling sideways, so the board stacks instead.
export const LANE_MIN_WIDTH = 160;
export const LANE_GAP = 14;
export const BOARD_PADDING = 16;
export const STACKED_BELOW_WIDTH = 3 * LANE_MIN_WIDTH + 2 * LANE_GAP + 2 * BOARD_PADDING;

/**
 * Whether a board this wide stacks its statuses. A width of 0 means "not
 * measured" (no layout yet, a hidden board, jsdom): that keeps the lanes, the
 * board's shape before this existed.
 */
export function boardStacks(width: number): boolean {
  return width > 0 && width < STACKED_BELOW_WIDTH;
}

// The order the stacked board lists its statuses: the ones being worked on
// first (design section 2, frame 2b), then the ones that are not. Failed is not
// in the design's five sections, but a failed task always needs the owner, so
// it sits right after the active ones, open, and only while it holds a task.
// Backlog and Done start collapsed.
export const STACK_ORDER: readonly TaskStatus[] = [
  "reviewing",
  "in_progress",
  "ready",
  "failed",
  "backlog",
  "done",
];

const COLLAPSED_BY_DEFAULT: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["backlog", "done"]);

export interface StackSection {
  id: TaskStatus;
  title: string;
  /** The section's tasks in board order (Claimed folded into In progress). */
  tasks: Task[];
  /** Whether a task in it needs the owner (the board's "Needs me" definition). */
  needsYou: boolean;
}

/** The stacked board's sections for the board's (already filtered) tasks. */
export function stackSections(tasks: Task[]): StackSection[] {
  const sections: StackSection[] = [];
  for (const id of STACK_ORDER) {
    const sectionTasks = boardColumnTasks(tasks, id);
    if (id === "failed" && sectionTasks.length === 0) continue;
    sections.push({
      id,
      title: BOARD_COLUMNS.find((c) => c.id === id)?.title ?? id,
      tasks: sectionTasks,
      needsYou: sectionTasks.some((t) => needsYouReason(t) !== null),
    });
  }
  return sections;
}

/**
 * Which sections start open: every section but Backlog and Done, plus the one
 * holding the selected task, so the card the user just tapped is never folded
 * away by the switch to stacked.
 */
export function initialOpenSections(selectedStatus: TaskStatus | null): Set<TaskStatus> {
  const open = new Set(STACK_ORDER.filter((id) => !COLLAPSED_BY_DEFAULT.has(id)));
  if (selectedStatus !== null) open.add(selectedStatus);
  return open;
}
