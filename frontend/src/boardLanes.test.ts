import { describe, it, expect } from "vitest";
import {
  taskLinkedSessionIds,
  adhocSessionsByColumn,
  LANE_COLUMN_ORDER,
  ADHOC_MAX_DOTS,
  adhocSummary,
  laneColumnTitle,
} from "./boardLanes.js";
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

describe("adhocSummary", () => {
  const group = (sessions: ReturnType<typeof makeSession>[]) =>
    adhocSessionsByColumn(sessions, new Set(), false);
  const shown = () => true;

  it("folds the five severity groups into running / need you / idle / ended", () => {
    const columns = group([
      makeSession({ id: 1, sessionStatusSeverity: "busy" }),
      makeSession({ id: 2, sessionStatusSeverity: "busy" }),
      makeSession({ id: 3, sessionStatusSeverity: "blocked" }),
      makeSession({ id: 4, sessionStatusSeverity: "failed" }),
      makeSession({ id: 5, sessionStatusSeverity: "done" }),
      makeSession({ id: 6, sessionStatusSeverity: "dormant" }),
      makeSession({ id: 7, sessionStatusSeverity: "gone" }),
    ]);
    const summary = adhocSummary(columns, shown);
    expect(summary.total).toBe(7);
    expect(summary.counts).toEqual({ attention: 2, running: 2, idle: 2, ended: 1 });
    expect(summary.text).toBe("2 running · 2 need you · 2 idle · 1 ended");
  });

  it("orders the dots attention first and leaves zero parts out of the text", () => {
    const columns = group([
      makeSession({ id: 1, sessionStatusSeverity: "busy" }),
      makeSession({ id: 2, sessionStatusSeverity: "blocked" }),
    ]);
    const summary = adhocSummary(columns, shown);
    expect(summary.dots).toEqual(["attention", "running"]);
    expect(summary.text).toBe("1 running · 1 need you");
  });

  it("does not count a session the caller says is not shown", () => {
    const columns = group([
      makeSession({ id: 1, projectId: 1, sessionStatusSeverity: "busy" }),
      makeSession({ id: 2, projectId: 99, sessionStatusSeverity: "busy" }),
    ]);
    const summary = adhocSummary(columns, (session) => session.projectId === 1);
    expect(summary.total).toBe(1);
    expect(summary.dots).toHaveLength(1);
  });

  it("caps the dots but not the count", () => {
    const many = Array.from({ length: ADHOC_MAX_DOTS + 6 }, (_, i) =>
      makeSession({ id: i + 1, sessionStatusSeverity: "busy" }),
    );
    const summary = adhocSummary(group(many), shown);
    expect(summary.total).toBe(ADHOC_MAX_DOTS + 6);
    expect(summary.dots).toHaveLength(ADHOC_MAX_DOTS);
  });

  it("is empty for no sessions", () => {
    const summary = adhocSummary(group([]), shown);
    expect(summary).toEqual({
      total: 0,
      counts: { attention: 0, running: 0, idle: 0, ended: 0 },
      dots: [],
      text: "",
    });
  });
});
