import { describe, it, expect } from "vitest";
import { columnForSession, computeKanbanReorder, orderSessionsForColumn } from "./kanban.js";
import type { Session } from "./api.js";

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 1,
    projectId: 1,
    name: null,
    nameLocked: false,
    command: "claude code",
    cwd: null,
    liveCwd: null,
    kind: "terminal",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: null,
    alive: true,
    subscriberCount: 0,
    activity: "working",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    liveBranch: null,
    // Rich statuses (issue: extend surfaced session statuses).
    exitCode: null,
    attentionKind: null,
    errorDetail: null,
    lastAssistantMessage: null,
    compactState: "idle",
    subagentCount: 0,
    elicitationState: "idle",
    elicitationServer: null,
    lastTurnEndedAt: null,
    sessionStatus: "working",
    sessionStatusSeverity: "busy",
    sessionStatusDetail: null,
    sessionStatusAttentionRequired: false,
    ...overrides,
  };
}

describe("columnForSession", () => {
  // columnForSession now keys off the backend-derived sessionStatusSeverity
  // (session-status.ts) rather than the raw status/attention/activity
  // fields — these set that field directly rather than the fields that used
  // to drive the (now-removed) precedence chain, matching what the function
  // actually reads today.
  it("puts a busy (working) session in Working", () => {
    expect(columnForSession(makeSession({ sessionStatusSeverity: "busy" }))).toBe("working");
  });

  it("puts a dormant (idle) session in Idle", () => {
    expect(columnForSession(makeSession({ sessionStatusSeverity: "dormant" }))).toBe("idle");
  });

  it.each(["failed", "blocked", "done", "waiting"] as const)(
    "puts a %s-severity session in Needs Attention",
    (severity) => {
      expect(columnForSession(makeSession({ sessionStatusSeverity: severity }))).toBe("attention");
    },
  );

  it("puts a gone (exited/killed) session in Exited", () => {
    expect(columnForSession(makeSession({ sessionStatusSeverity: "gone" }))).toBe("exited");
  });
});

describe("orderSessionsForColumn", () => {
  const s1 = makeSession({ id: 1 });
  const s2 = makeSession({ id: 2 });
  const s3 = makeSession({ id: 3 });

  it("returns sessions in their natural order when no custom order is stored", () => {
    expect(orderSessionsForColumn([s1, s2, s3], [])).toEqual([s1, s2, s3]);
  });

  it("applies a stored custom order for known ids", () => {
    expect(orderSessionsForColumn([s1, s2, s3], [3, 1, 2])).toEqual([s3, s1, s2]);
  });

  it("appends a new arrival (not yet in the stored order) at the end", () => {
    expect(orderSessionsForColumn([s1, s2, s3], [2, 1])).toEqual([s2, s1, s3]);
  });

  it("ignores stored ids for sessions no longer in this column", () => {
    // id 3 was reordered while in this column but has since moved elsewhere
    // (status change) — orderSessionsForColumn is only ever given this
    // column's *current* sessions, so id 3 simply isn't in the input.
    expect(orderSessionsForColumn([s1, s2], [3, 2, 1])).toEqual([s2, s1]);
  });
});

describe("computeKanbanReorder", () => {
  const s1 = makeSession({ id: 1 });
  const s2 = makeSession({ id: 2 });
  const s3 = makeSession({ id: 3 });

  it("moves a dragged session to the target index within the column", () => {
    // Natural order [1,2,3], drag id 3 to index 0 -> [3,1,2].
    const next = computeKanbanReorder([s1, s2, s3], [], 3, 0);
    expect(next).toEqual([3, 1, 2]);
  });

  it("is a no-op when dropped back at its own position", () => {
    const next = computeKanbanReorder([s1, s2, s3], [1, 2, 3], 2, 1);
    expect(next).toEqual([1, 2, 3]);
  });

  it("respects a previously-stored order as the starting point", () => {
    // Stored order [3,1,2] — drag id 1 (currently at index 1) to index 0.
    const next = computeKanbanReorder([s1, s2, s3], [3, 1, 2], 1, 0);
    expect(next).toEqual([1, 3, 2]);
  });

  it("is a no-op for a draggedId that isn't in this column (cross-column drop, unsupported)", () => {
    const next = computeKanbanReorder([s1, s2, s3], [], 999, 0);
    expect(next).toEqual([1, 2, 3]);
  });
});
