import { describe, it, expect } from "vitest";
import {
  TASK_COLUMNS,
  statusLabel,
  canDragToColumn,
  orderTasksForColumn,
  computeTaskReorder,
  absoluteDropIndex,
} from "./tasksBoard.js";
import type { Task, TaskStatus } from "./api/index.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 1,
    projectId: 1,
    projectName: "demo",
    issueNumber: null,
    title: "Task",
    body: null,
    htmlUrl: null,
    status: "backlog",
    boardOrder: 0,
    sessionId: null,
    seedDelivered: null,
    reviewSessionId: null,
    reviewSeedDelivered: null,
    reviewFindings: null,
    reviewRounds: 0,
    worktreePath: null,
    branchName: null,
    agentCommand: null,
    prUrl: null,
    prNumber: null,
    assignee: null,
    failureReason: null,
    githubSyncError: null,
    baseSha: null,
    dependencyCount: null,
    blockedState: "clear",
    blockers: [],
    parentIssueNumber: null,
    parentIssueRepo: null,
    parentIssueTitle: null,
    subIssueTotal: null,
    subIssueCompleted: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    reviewingAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("TASK_COLUMNS", () => {
  it("covers every TaskStatus exactly once", () => {
    const ids = TASK_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const expected: TaskStatus[] = [
      "backlog",
      "ready",
      "claimed",
      "in_progress",
      "reviewing",
      "done",
      "failed",
    ];
    expect(ids).toEqual(expected);
  });
});

describe("statusLabel", () => {
  it("labels every column", () => {
    for (const column of TASK_COLUMNS) {
      expect(statusLabel(column.id)).toBe(column.title);
    }
  });
});

describe("canDragToColumn", () => {
  it("allows backlog and ready as drag targets", () => {
    expect(canDragToColumn("backlog")).toBe(true);
    expect(canDragToColumn("ready")).toBe(true);
  });

  it("disallows every autonomous-lifecycle column as a drag target", () => {
    expect(canDragToColumn("claimed")).toBe(false);
    expect(canDragToColumn("in_progress")).toBe(false);
    expect(canDragToColumn("reviewing")).toBe(false);
    expect(canDragToColumn("done")).toBe(false);
    expect(canDragToColumn("failed")).toBe(false);
  });
});

describe("orderTasksForColumn", () => {
  it("filters to the given status and sorts by boardOrder", () => {
    const t1 = makeTask({ id: 1, status: "ready", boardOrder: 2 });
    const t2 = makeTask({ id: 2, status: "ready", boardOrder: 0 });
    const t3 = makeTask({ id: 3, status: "backlog", boardOrder: 0 });
    expect(orderTasksForColumn([t1, t2, t3], "ready")).toEqual([t2, t1]);
  });

  it("breaks equal boardOrder ties by id", () => {
    const t1 = makeTask({ id: 5, status: "ready", boardOrder: 0 });
    const t2 = makeTask({ id: 2, status: "ready", boardOrder: 0 });
    expect(orderTasksForColumn([t1, t2], "ready")).toEqual([t2, t1]);
  });
});

describe("computeTaskReorder", () => {
  it("reindexes within the same column", () => {
    const t1 = makeTask({ id: 1, status: "ready", boardOrder: 0 });
    const t2 = makeTask({ id: 2, status: "ready", boardOrder: 1 });
    const t3 = makeTask({ id: 3, status: "ready", boardOrder: 2 });
    const updates = computeTaskReorder([t1, t2, t3], 3, "ready", 0);
    const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
    expect(byId[3]).toEqual({ id: 3, status: "ready", boardOrder: 0 });
    expect(byId[1]).toEqual({ id: 1, status: "ready", boardOrder: 1 });
    expect(byId[2]).toEqual({ id: 2, status: "ready", boardOrder: 2 });
  });

  it("moves a task across columns and reindexes both buckets", () => {
    const t1 = makeTask({ id: 1, status: "backlog", boardOrder: 0 });
    const t2 = makeTask({ id: 2, status: "ready", boardOrder: 0 });
    const t3 = makeTask({ id: 3, status: "ready", boardOrder: 1 });
    const updates = computeTaskReorder([t1, t2, t3], 1, "ready", 1);
    const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
    // Dragged into "ready" at index 1 -> [t2, t1, t3].
    expect(byId[1]).toEqual({ id: 1, status: "ready", boardOrder: 1 });
    expect(byId[3]).toEqual({ id: 3, status: "ready", boardOrder: 2 });
    // t2 didn't move (still index 0) — no update emitted for it.
    expect(byId[2]).toBeUndefined();
    // Source bucket (backlog) is now empty — no update needed there either.
  });

  it("is a no-op when dropped back at its own position", () => {
    const t1 = makeTask({ id: 1, status: "ready", boardOrder: 0 });
    const t2 = makeTask({ id: 2, status: "ready", boardOrder: 1 });
    expect(computeTaskReorder([t1, t2], 2, "ready", 1)).toEqual([]);
  });

  // Independent review, PR #477 — the pre-fix version fed reorder.ts's
  // computeReorder the raw `tasks` input order for tie-breaking equal
  // boardOrder values, which is GET /api/tasks's own `ORDER BY status,
  // boardOrder, createdAt` — not the same tie-break orderTasksForColumn
  // renders with (boardOrder, then id). This only surfaces when the input
  // array's relative order for TWO tied tasks disagrees with their id
  // order, which "is a no-op when dropped back" above doesn't exercise
  // (only one task there has a tie, and it's the dragged one itself).
  it("reindexes tied-boardOrder tasks in the same (boardOrder, id) order the column actually renders, not the input array's own order", () => {
    const t1 = makeTask({ id: 1, status: "ready", boardOrder: 0 });
    const t2 = makeTask({ id: 2, status: "ready", boardOrder: 0 });
    const t3 = makeTask({ id: 3, status: "ready", boardOrder: 1 });
    // Deliberately NOT in id order — t2 precedes t1, the opposite of
    // orderTasksForColumn's own displayed order (t1, t2, t3).
    const updates = computeTaskReorder([t2, t1, t3], 3, "ready", 0);
    const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
    // Dragging t3 to the front of the *displayed* order [t1, t2, t3]
    // produces [t3, t1, t2] — t1 (the lower id) must land at boardOrder 1,
    // not t2.
    expect(byId[3]).toEqual({ id: 3, status: "ready", boardOrder: 0 });
    expect(byId[1]).toEqual({ id: 1, status: "ready", boardOrder: 1 });
    expect(byId[2]).toEqual({ id: 2, status: "ready", boardOrder: 2 });
  });
});

// #610 considered and cut a project filter on this board because "the
// drag/reorder math indexes against the rendered list, not the full store
// list, and filtering would silently corrupt boardOrder on drop."
// absoluteDropIndex (UnifiedBoard.tsx's applyDrop) is what closes that gap —
// these cases are the ones a filtered drop can actually hit.
describe("absoluteDropIndex", () => {
  // Six "ready" tasks, alternating project A (visible under the filter used
  // below) and project B (hidden) — ids 1/3/5 are A, 2/4/6 are B.
  const tasks: Task[] = [
    makeTask({ id: 1, projectId: 1, status: "ready", boardOrder: 0 }),
    makeTask({ id: 2, projectId: 2, status: "ready", boardOrder: 1 }),
    makeTask({ id: 3, projectId: 1, status: "ready", boardOrder: 2 }),
    makeTask({ id: 4, projectId: 2, status: "ready", boardOrder: 3 }),
    makeTask({ id: 5, projectId: 1, status: "ready", boardOrder: 4 }),
    makeTask({ id: 6, projectId: 2, status: "ready", boardOrder: 5 }),
  ];
  const projectAOnly = tasks.filter((t) => t.projectId === 1); // rendered order: 1, 3, 5

  it("is the identity function when no filter is active (visibleTasks === allTasks)", () => {
    for (let i = 0; i <= tasks.length; i++) {
      expect(absoluteDropIndex(tasks, tasks, "ready", i)).toBe(i);
    }
  });

  it("maps a drop past the end of a filtered column to the end of the full column", () => {
    // projectAOnly has 3 rendered cards; dropping into the empty space below
    // them is index 3 in TaskColumn's own rendered list.
    expect(absoluteDropIndex(tasks, projectAOnly, "ready", 3)).toBe(tasks.length);
  });

  it("resolves a drop between two filtered cards to its position in the full column, with hidden tasks on both sides", () => {
    // visibleIndex 1 in [1, 3, 5] is task 3 — hidden task 2 precedes it and
    // hidden task 4 follows it in the full column.
    expect(absoluteDropIndex(tasks, projectAOnly, "ready", 1)).toBe(
      tasks.findIndex((t) => t.id === 3),
    );
  });

  // The discriminating case: reorder.ts's computeReorder excludes the
  // dragged item from its own bucket before splicing at targetIndex
  // (reorder.ts:50-53's bucketOf), so for a same-column drag where the
  // dragged card sits ABOVE the drop target, the "index in the full list
  // including the dragged item" and "index after the dragged item is
  // removed" differ by one. absoluteDropIndex must NOT correct for that —
  // its only job is to reproduce the index this drop would have had against
  // the full column. Verified here by equivalence: dragging task 1 (visible
  // index 0 under the project-A filter) onto task 5 (visible index 2, with
  // hidden tasks 2 and 4 both between them) must land the board in exactly
  // the state a direct, unfiltered drag of task 1 onto task 5 would.
  it("produces the same computeTaskReorder result as the equivalent unfiltered drag, dragged card above a target with hidden tasks between them", () => {
    const filteredIndex = absoluteDropIndex(tasks, projectAOnly, "ready", 2); // onto task 5
    const unfilteredIndex = tasks.findIndex((t) => t.id === 5); // same drop, no filter
    expect(filteredIndex).toBe(unfilteredIndex);

    const updates = computeTaskReorder(tasks, 1, "ready", filteredIndex);
    const byId = Object.fromEntries(updates.map((u) => [u.id, u]));
    expect(byId[2]).toEqual({ id: 2, status: "ready", boardOrder: 0 });
    expect(byId[3]).toEqual({ id: 3, status: "ready", boardOrder: 1 });
    expect(byId[4]).toEqual({ id: 4, status: "ready", boardOrder: 2 });
    expect(byId[5]).toEqual({ id: 5, status: "ready", boardOrder: 3 });
    expect(byId[1]).toEqual({ id: 1, status: "ready", boardOrder: 4 });
    // Task 6 doesn't move — no update emitted for it.
    expect(byId[6]).toBeUndefined();
    expect(updates).toHaveLength(5);
  });
});
