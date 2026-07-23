// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "./store.js";

// Issue #211's list/Kanban view switcher (ViewModeToggle.tsx) — a
// client-only UI preference persisted via localStorage, same convention as
// sidebarCollapsed/sidebarWidth (store.ts's SIDEBAR_COLLAPSED_KEY/
// SIDEBAR_WIDTH_KEY). Exercises the real store (not the SessionRow.test.tsx/
// KanbanBoard.test.tsx-style mock) since the thing under test — the
// localStorage round-trip — is exactly what a mocked store would skip.
describe("store.setViewMode", () => {
  beforeEach(() => {
    localStorage.clear();
    useDashboardStore.setState({ viewMode: "list" });
  });

  it("defaults to list view", () => {
    expect(useDashboardStore.getState().viewMode).toBe("list");
  });

  it("switches to kanban and persists the choice to localStorage", () => {
    useDashboardStore.getState().setViewMode("kanban");
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
    expect(localStorage.getItem("crs.viewMode")).toBe("kanban");
  });

  it("switches back to list and persists that too", () => {
    useDashboardStore.getState().setViewMode("kanban");
    useDashboardStore.getState().setViewMode("list");
    expect(useDashboardStore.getState().viewMode).toBe("list");
    expect(localStorage.getItem("crs.viewMode")).toBe("list");
  });
});
