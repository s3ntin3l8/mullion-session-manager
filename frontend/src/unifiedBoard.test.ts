import { describe, it, expect } from "vitest";
import {
  taskLinkedSessionIds,
  adhocSessionsByColumn,
  LANE_COLUMN_ORDER,
  laneColumnTitle,
} from "./unifiedBoard.js";
import { makeSession, makeTask } from "./test/fixtures.js";

describe("taskLinkedSessionIds", () => {
  it("collects both sessionId and reviewSessionId", () => {
    const tasks = [makeTask({ id: 1, sessionId: 10, reviewSessionId: 11 })];
    expect(taskLinkedSessionIds(tasks)).toEqual(new Set([10, 11]));
  });

  it("drops nulls", () => {
    const tasks = [makeTask({ id: 1, sessionId: null, reviewSessionId: null })];
    expect(taskLinkedSessionIds(tasks)).toEqual(new Set());
  });

  it("dedups across tasks", () => {
    const tasks = [
      makeTask({ id: 1, sessionId: 10, reviewSessionId: null }),
      makeTask({ id: 2, sessionId: 10, reviewSessionId: null }),
    ];
    expect(taskLinkedSessionIds(tasks)).toEqual(new Set([10]));
  });
});

describe("adhocSessionsByColumn", () => {
  it("excludes a task-linked session before grouping, so counts match", () => {
    const linked = new Set([1]);
    const sessions = [
      makeSession({ id: 1, sessionStatusSeverity: "busy" }),
      makeSession({ id: 2, sessionStatusSeverity: "busy" }),
    ];
    const grouped = adhocSessionsByColumn(sessions, linked, false);
    expect(grouped.working.map((s) => s.id)).toEqual([2]);
  });

  it("excludes dock sessions", () => {
    const sessions = [makeSession({ id: 1, kind: "dock" })];
    const grouped = adhocSessionsByColumn(sessions, new Set(), false);
    expect(Object.values(grouped).flat()).toHaveLength(0);
  });

  it("excludes killed sessions", () => {
    const sessions = [makeSession({ id: 1, status: "killed" })];
    const grouped = adhocSessionsByColumn(sessions, new Set(), false);
    expect(Object.values(grouped).flat()).toHaveLength(0);
  });

  it("honors hideEndedSessions", () => {
    const sessions = [makeSession({ id: 1, status: "exited", sessionStatusSeverity: "gone" })];
    expect(Object.values(adhocSessionsByColumn(sessions, new Set(), true)).flat()).toHaveLength(0);
    expect(Object.values(adhocSessionsByColumn(sessions, new Set(), false)).flat()).toHaveLength(1);
  });

  it("groups by severity via columnForSession", () => {
    const sessions = [
      makeSession({ id: 1, sessionStatusSeverity: "failed" }),
      makeSession({ id: 2, sessionStatusSeverity: "done" }),
    ];
    const grouped = adhocSessionsByColumn(sessions, new Set(), false);
    expect(grouped.attention.map((s) => s.id)).toEqual([1]);
    expect(grouped.finished.map((s) => s.id)).toEqual([2]);
  });
});

describe("LANE_COLUMN_ORDER", () => {
  it("puts attention first, and covers all five columns exactly once", () => {
    expect(LANE_COLUMN_ORDER[0]).toBe("attention");
    expect(new Set(LANE_COLUMN_ORDER).size).toBe(5);
  });
});

describe("laneColumnTitle", () => {
  it("resolves a KANBAN_COLUMNS title", () => {
    expect(laneColumnTitle("attention")).toBe("Needs Attention");
  });
});
