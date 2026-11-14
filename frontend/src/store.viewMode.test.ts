// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { readStoredViewMode } from "./store/helpers.js";

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

// #3009 — the two first-level modes are viewMode's two values: "list" is
// Workspace mode, "kanban" is Tasks mode.
describe("store modes (#3009)", () => {
  beforeEach(() => {
    localStorage.clear();
    useDashboardStore.setState({
      viewMode: "list",
      selectedTaskId: null,
      openSessionRequest: null,
    });
  });

  it("toggleViewMode switches Workspace to Tasks and back, persisting each", () => {
    useDashboardStore.getState().toggleViewMode();
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
    expect(localStorage.getItem("crs.viewMode")).toBe("kanban");
    useDashboardStore.getState().toggleViewMode();
    expect(useDashboardStore.getState().viewMode).toBe("list");
    expect(localStorage.getItem("crs.viewMode")).toBe("list");
  });

  it("restores the last-used mode at start, and reads anything else as Workspace", () => {
    localStorage.setItem("crs.viewMode", "kanban");
    expect(readStoredViewMode()).toBe("kanban");
    localStorage.setItem("crs.viewMode", "list");
    expect(readStoredViewMode()).toBe("list");
    localStorage.setItem("crs.viewMode", "board");
    expect(readStoredViewMode()).toBe("list");
    localStorage.removeItem("crs.viewMode");
    expect(readStoredViewMode()).toBe("list");
  });

  it("openSessionInWorkspace switches to Workspace, opens the session and keeps the task", () => {
    useDashboardStore.setState({ viewMode: "kanban" });
    useDashboardStore.getState().openRightSidebarTask(42);
    useDashboardStore.getState().openSessionInWorkspace(7);
    const s = useDashboardStore.getState();
    expect(s.viewMode).toBe("list");
    expect(localStorage.getItem("crs.viewMode")).toBe("list");
    expect(s.openSessionRequest?.sessionId).toBe(7);
    expect(s.selectedTaskId).toBe(42);
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("tasks");
  });

  // #3014 — the phone's back gesture returns to Tasks after a cross-link.
  it("records a cross-link from Tasks, with the task it came from", () => {
    useDashboardStore.setState({ viewMode: "kanban", crossLinkReturn: null });
    useDashboardStore.getState().openRightSidebarTask(42);
    useDashboardStore.getState().openSessionInWorkspace(7);
    expect(useDashboardStore.getState().crossLinkReturn).toEqual({ taskId: 42 });
  });

  it("records no cross-link when already in Workspace", () => {
    useDashboardStore.setState({ viewMode: "list", crossLinkReturn: null });
    useDashboardStore.getState().openSessionInWorkspace(7);
    expect(useDashboardStore.getState().crossLinkReturn).toBeNull();
  });

  it("forgets the cross-link on any other mode change", () => {
    useDashboardStore.setState({ viewMode: "list", crossLinkReturn: { taskId: 1 } });
    useDashboardStore.getState().setViewMode("list");
    expect(useDashboardStore.getState().crossLinkReturn).toBeNull();
  });

  it("returnFromCrossLink goes back to Tasks and reopens the task, once", () => {
    useDashboardStore.setState({ viewMode: "kanban", crossLinkReturn: null });
    useDashboardStore.getState().openRightSidebarTask(42);
    useDashboardStore.getState().openSessionInWorkspace(7);
    useDashboardStore.getState().closeRightSidebar();
    useDashboardStore.getState().returnFromCrossLink();
    const s = useDashboardStore.getState();
    expect(s.viewMode).toBe("kanban");
    expect(s.selectedTaskId).toBe(42);
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.crossLinkReturn).toBeNull();
    // Nothing left to return from.
    useDashboardStore.getState().setViewMode("list");
    useDashboardStore.getState().returnFromCrossLink();
    expect(useDashboardStore.getState().viewMode).toBe("list");
  });

  it("returnFromCrossLink with no task only switches the mode", () => {
    useDashboardStore.setState({
      viewMode: "list",
      crossLinkReturn: { taskId: null },
      rightSidebarOpen: false,
    });
    useDashboardStore.getState().returnFromCrossLink();
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });
});
