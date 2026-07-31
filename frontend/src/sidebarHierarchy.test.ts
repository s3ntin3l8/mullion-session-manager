import { describe, it, expect } from "vitest";
import { buildHierarchicalRows, liveChildCount } from "./sidebarHierarchy.js";

// Phase 5 (Track B, issue #195 5.5b). Fixtures are `{id, parentSessionId}`
// only, thanks to buildHierarchicalRows' generic `Pick<>` signature — same
// pattern panelUtils.test.ts's attentionTransitionPanelIds tests use.
describe("buildHierarchicalRows", () => {
  it("renders a flat list (no parents) all at depth 0, in the original order", () => {
    const sessions = [
      { id: 1, parentSessionId: null },
      { id: 2, parentSessionId: null },
    ];
    expect(buildHierarchicalRows(sessions)).toEqual([
      { session: sessions[0], depth: 0 },
      { session: sessions[1], depth: 0 },
    ]);
  });

  it("nests a child immediately after its parent, at depth 1", () => {
    const parent = { id: 1, parentSessionId: null };
    const child = { id: 2, parentSessionId: 1 };
    const otherRoot = { id: 3, parentSessionId: null };
    expect(buildHierarchicalRows([otherRoot, parent, child])).toEqual([
      { session: otherRoot, depth: 0 },
      { session: parent, depth: 0 },
      { session: child, depth: 1 },
    ]);
  });

  it("nests every child of the same parent, each at depth 1", () => {
    const parent = { id: 1, parentSessionId: null };
    const childA = { id: 2, parentSessionId: 1 };
    const childB = { id: 3, parentSessionId: 1 };
    const rows = buildHierarchicalRows([parent, childA, childB]);
    expect(rows).toEqual([
      { session: parent, depth: 0 },
      { session: childA, depth: 1 },
      { session: childB, depth: 1 },
    ]);
  });

  // Orphan rule (required by the plan): a session whose parent is NOT in
  // this same filtered list — because Sidebar's own filter already dropped
  // it (killed, or hidden by "hide ended sessions") — must render at TOP
  // LEVEL, not vanish.
  it("renders a child whose parent isn't in the list at top level (orphan rule)", () => {
    const orphan = { id: 2, parentSessionId: 999 }; // parent 999 filtered out upstream
    expect(buildHierarchicalRows([orphan])).toEqual([{ session: orphan, depth: 0 }]);
  });

  it("treats a promoted session (parentSessionId null) as an ordinary root", () => {
    const promoted = { id: 5, parentSessionId: null };
    expect(buildHierarchicalRows([promoted])).toEqual([{ session: promoted, depth: 0 }]);
  });

  // Cross-project regression guard (issue #441) — this function's own
  // generic signature has no `projectId` at all; same-project membership is
  // guaranteed by the CALLER (Sidebar.tsx's ProjectSection, which only ever
  // invokes this per-project), not by this function. A parent/child pair
  // whose `projectId`s differ (which can't happen via the real API today —
  // createSessionRecord enforces same-project — but nothing here would
  // catch it if that enforcement were ever relaxed) still nests correctly,
  // since project membership plays no part in this function's logic.
  it("nests a parent/child pair correctly even when their projectId differs (function has no project awareness)", () => {
    const parent = { id: 1, parentSessionId: null, projectId: 1 };
    const child = { id: 2, parentSessionId: 1, projectId: 2 };
    expect(buildHierarchicalRows([parent, child])).toEqual([
      { session: parent, depth: 0 },
      { session: child, depth: 1 },
    ]);
  });

  it("handles an empty list", () => {
    expect(buildHierarchicalRows([])).toEqual([]);
  });
});

// Phase 5 (Track B, issue #196 5.6).
describe("liveChildCount", () => {
  it("counts only active children of the given parent", () => {
    const sessions = [
      { parentSessionId: 1, status: "active" as const },
      { parentSessionId: 1, status: "active" as const },
      { parentSessionId: 1, status: "killed" as const },
      { parentSessionId: 2, status: "active" as const },
      { parentSessionId: null, status: "active" as const },
    ];
    expect(liveChildCount(sessions, 1)).toBe(2);
  });

  // Independent review finding (PR #435) — pins the `=== "active"` boundary
  // against the third `status` value (`"exited"`, distinct from
  // user-initiated `"killed"`): a plausible future refactor toward the
  // `!== "killed"` idiom used a few lines away in Sidebar.tsx's own session
  // filter would silently start counting an exited child as live without
  // this failing.
  it("does not count an exited child as live", () => {
    const sessions = [
      { parentSessionId: 1, status: "active" as const },
      { parentSessionId: 1, status: "exited" as const },
    ];
    expect(liveChildCount(sessions, 1)).toBe(1);
  });

  it("returns 0 for a session with no children", () => {
    const sessions = [{ parentSessionId: 2, status: "active" as const }];
    expect(liveChildCount(sessions, 1)).toBe(0);
  });

  it("is unaffected by an already-filtered/subset list — counts against whatever it's given", () => {
    expect(liveChildCount([], 1)).toBe(0);
  });
});
