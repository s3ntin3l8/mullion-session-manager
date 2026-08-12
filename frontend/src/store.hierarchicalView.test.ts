// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "./store/index.js";

// Phase 5 (Track B, issue #195 5.5b)'s flat/hierarchical sidebar toggle
// (HierarchyToggle.tsx) — same localStorage-round-trip precedent as
// store.viewMode.test.ts's setViewMode, exercised against the real store
// rather than a mock for the same reason that file gives.
describe("store.setHierarchicalView", () => {
  beforeEach(() => {
    localStorage.clear();
    useDashboardStore.setState({ hierarchicalView: false });
  });

  it("defaults to flat (false)", () => {
    expect(useDashboardStore.getState().hierarchicalView).toBe(false);
  });

  it("switches to hierarchical and persists the choice to localStorage", () => {
    useDashboardStore.getState().setHierarchicalView(true);
    expect(useDashboardStore.getState().hierarchicalView).toBe(true);
    expect(localStorage.getItem("crs.hierarchicalView")).toBe("1");
  });

  it("switches back to flat and persists that too", () => {
    useDashboardStore.getState().setHierarchicalView(true);
    useDashboardStore.getState().setHierarchicalView(false);
    expect(useDashboardStore.getState().hierarchicalView).toBe(false);
    expect(localStorage.getItem("crs.hierarchicalView")).toBe("0");
  });
});
