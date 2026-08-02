import { describe, it, expect } from "vitest";
import {
  TASK_COLUMNS,
  statusLabel,
  canDragToColumn,
  orderTasksForColumn,
  computeTaskReorder,
} from "./tasksBoard.js";
import type { Task, TaskStatus } from "./api.js";

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
    reviewSessionId: null,
    reviewSeedDelivered: null,
    worktreePath: null,
    branchName: null,
    agentCommand: null,
    prUrl: null,
    assignee: null,
    failureReason: null,
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
