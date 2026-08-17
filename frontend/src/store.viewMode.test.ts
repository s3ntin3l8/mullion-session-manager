// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "./store/index.js";

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

// Issue: selecting a workspace while Tasks (viewMode === "kanban") was
// active used to leave viewMode untouched — the workspace really did
// switch, just invisibly behind the Tasks board's own z-index-100 overlay.
describe("store.showWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
    useDashboardStore.setState({ viewMode: "kanban", activeWorkspaceId: null });
  });

  it("sets the active workspace AND resets viewMode to list", () => {
    useDashboardStore.getState().showWorkspace(7);
    expect(useDashboardStore.getState().activeWorkspaceId).toBe(7);
    expect(useDashboardStore.getState().viewMode).toBe("list");
    expect(localStorage.getItem("crs.viewMode")).toBe("list");
  });

  it("setActiveWorkspaceId alone does NOT touch viewMode — the boot/repair paths in App.tsx rely on this", () => {
    // Guards the deliberate split documented on showWorkspace's own doc
    // comment (store/slices/ui.ts): App.tsx's first-run bootstrap and its
    // stale-activeWorkspaceId recovery-on-load both call
    // setActiveWorkspaceId directly, not showWorkspace — folding the reset
    // into the low-level setter would silently kick a user out of a
    // persisted Tasks view on reload whenever a workspace had been deleted.
    useDashboardStore.getState().setActiveWorkspaceId(7);
    expect(useDashboardStore.getState().activeWorkspaceId).toBe(7);
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
  });
});
