import type { Project, Task, TaskBlocker } from "../api/index.js";
import { NO_EPIC, epicKeyOf } from "./taskFilters.js";

// Pure helpers for the board's presentation of a column (epic #2847, #2841): how the
// board is grouped into lanes, an epic's colour and progress, and which cards collapse
// into a blocked stack. Nothing here writes `tasks` or reorders anything: every card
// keeps the index it has in the list the column was handed, which is what keeps a drop
// translating through `absoluteDropIndex` (tasksBoard.ts, #610).

export type GroupBy = "none" | "epic" | "project";

export function isGroupBy(value: unknown): value is GroupBy {
  return value === "none" || value === "epic" || value === "project";
}

export type CardDensity = "compact" | "comfortable";

export function isCardDensity(value: unknown): value is CardDensity {
  return value === "compact" || value === "comfortable";
}

const LANE_COLOURS = 6;

/** A stable 1..6 slot for an epic key (`repo#number`), so an epic keeps its colour
 * across reloads and across the card edge, the tag and the lane header. */
export function epicColourSlot(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (h * 33 + key.charCodeAt(i)) >>> 0;
  return (h % LANE_COLOURS) + 1;
}

/** The CSS colour of a task's epic (`--lane-1…6` in tokens.css), or null with no epic. */
export function epicColourVar(task: Task): string | null {
  const key = epicKeyOf(task);
  return key === null ? null : `var(--lane-${epicColourSlot(key)})`;
}

export function epicUrl(task: Pick<Task, "parentIssueRepo" | "parentIssueNumber">): string | null {
  return task.parentIssueRepo !== null && task.parentIssueNumber !== null
    ? `https://github.com/${task.parentIssueRepo}/issues/${task.parentIssueNumber}`
    : null;
}

export interface Lane {
  /** Stable key: an epic key / NO_EPIC, a project id, or "" for the single ungrouped lane. */
  key: string;
  title: string;
  tasks: Task[];
}

/** The lane a task belongs to under a grouping. */
export function laneKeyOf(task: Task, groupBy: GroupBy): string {
  if (groupBy === "epic") return epicKeyOf(task) ?? NO_EPIC;
  if (groupBy === "project") return String(task.projectId);
  return "";
}

/**
 * Splits the visible tasks into lanes. Epic lanes sort by their title with "No epic"
 * last; project lanes by name. Each lane's tasks keep the order they came in.
 */
export function groupLanes(
  tasks: Task[],
  groupBy: GroupBy,
  projectsById: Map<number, Pick<Project, "name">>,
): Lane[] {
  if (groupBy === "none") return [{ key: "", title: "", tasks }];
  const lanes = new Map<string, Lane>();
  for (const task of tasks) {
    const key = laneKeyOf(task, groupBy);
    let lane = lanes.get(key);
    if (!lane) {
      const title =
        groupBy === "epic"
          ? key === NO_EPIC
            ? "No epic"
            : `#${task.parentIssueNumber} ${task.parentIssueTitle ?? ""}`.trim()
          : (projectsById.get(task.projectId)?.name ?? `Project ${task.projectId}`);
      lane = { key, title, tasks: [] };
      lanes.set(key, lane);
    } else if (groupBy === "epic" && key !== NO_EPIC && task.parentIssueTitle) {
      // A late-arriving parent title upgrades a lane first seen with a bare `#N`.
      lane.title = `#${task.parentIssueNumber} ${task.parentIssueTitle}`;
    }
    lane.tasks.push(task);
  }
  return [...lanes.values()].sort((a, b) => {
    if (a.key === NO_EPIC) return 1;
    if (b.key === NO_EPIC) return -1;
    return a.title.localeCompare(b.title);
  });
}

export interface EpicProgress {
  done: number;
  total: number;
  /** "closed" when read from the epic issue's own sub-issue counts, "done" when
   * counted from the child tasks Mullion knows about. */
  basis: "closed" | "done";
}

/**
 * An epic's progress, from fields the board already has (no fetch): the epic's own task
 * when it is on the board and carries sub-issue counts, else the done share of its child
 * tasks.
 */
export function epicProgress(allTasks: Task[], epicKey: string): EpicProgress | null {
  const children = allTasks.filter((t) => epicKeyOf(t) === epicKey);
  if (children.length === 0) return null;
  const first = children[0];
  // The epic's own counts, fetched by the backend (#2919): authoritative.
  const fetched = children.find((t) => (t.parentSubIssueTotal ?? 0) > 0);
  if (fetched) {
    return {
      done: fetched.parentSubIssueCompleted ?? 0,
      total: fetched.parentSubIssueTotal ?? 0,
      basis: "closed",
    };
  }
  const parent = allTasks.find(
    (t) =>
      t.issueNumber === first.parentIssueNumber &&
      t.subIssueTotal !== null &&
      t.subIssueTotal > 0 &&
      (t.htmlUrl ?? "").includes(`/${first.parentIssueRepo}/issues/`),
  );
  if (parent && parent.subIssueTotal !== null) {
    return { done: parent.subIssueCompleted ?? 0, total: parent.subIssueTotal, basis: "closed" };
  }
  return {
    done: children.filter((t) => t.status === "done").length,
    total: children.length,
    basis: "done",
  };
}

/** Cards blocked by the same tasks collapse once there are this many of them. */
export const BLOCKED_STACK_MIN = 3;

export type ColumnItem =
  | { kind: "card"; task: Task; index: number }
  | {
      kind: "stack";
      key: string;
      blockers: TaskBlocker[];
      members: Array<{ task: Task; index: number }>;
      /** Where a drop on the collapsed summary lands: before the first member. */
      firstIndex: number;
    };

// Only real, linkable blockers form a stack; the synthetic "N blockers not visible to
// this token" entry has no number to name.
function stackKey(task: Task): string | null {
  if (task.blockedState !== "blocked" || task.blockers.length === 0) return null;
  if (task.blockers.some((b) => b.htmlUrl === null)) return null;
  return task.blockers
    .map((b) => `${b.owner}/${b.repo}#${b.number}`)
    .sort()
    .join(",");
}

/**
 * The column's render list: three or more cards blocked by the same tasks become one
 * stack, placed where its first member was. Members that were not adjacent are therefore
 * hoisted together, so the rendered order can differ from boardOrder around a stack
 * (docs/tasks.md says so). Drops stay correct because `index` is always the card's
 * position in `tasks`, never in the grouped list, so a drop onto a card still names the
 * same slot `absoluteDropIndex` expects.
 */
export function columnItems(tasks: Task[]): ColumnItem[] {
  const groups = new Map<string, Array<{ task: Task; index: number }>>();
  tasks.forEach((task, index) => {
    const key = stackKey(task);
    if (key === null) return;
    const group = groups.get(key) ?? [];
    group.push({ task, index });
    groups.set(key, group);
  });
  const items: ColumnItem[] = [];
  const emitted = new Set<string>();
  tasks.forEach((task, index) => {
    const key = stackKey(task);
    const group = key === null ? null : groups.get(key);
    if (key === null || !group || group.length < BLOCKED_STACK_MIN) {
      items.push({ kind: "card", task, index });
      return;
    }
    if (emitted.has(key)) return;
    emitted.add(key);
    items.push({
      kind: "stack",
      key,
      blockers: task.blockers,
      members: group,
      firstIndex: group[0].index,
    });
  });
  return items;
}
