// @vitest-environment jsdom
// Right sidebar state: open/close/pin/width actions must write through to
// localStorage (persistedState.ts) and clamp the width, and a pinned drawer —
// and only a pinned one — must come back open after a reload.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDashboardStore } from "./index.js";
import { RIGHT_SIDEBAR_MAX_WIDTH, RIGHT_SIDEBAR_MIN_WIDTH } from "./constants.js";

beforeEach(() => {
  localStorage.clear();
  useDashboardStore.setState({
    rightSidebarView: "git",
    rightSidebarOpen: false,
    rightSidebarPinned: false,
    rightSidebarWidth: 340,
  });
});

describe("right sidebar actions", () => {
  it("toggleRightSidebarView opens a closed drawer on that view and persists it", () => {
    useDashboardStore.getState().toggleRightSidebarView("github");

    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("github");
    expect(localStorage.getItem("crs.rightSidebarView")).toBe("github");
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBe("1");
  });

  it("toggleRightSidebarView on the open view closes it but remembers the view", () => {
    useDashboardStore.getState().toggleRightSidebarView("git");
    useDashboardStore.getState().toggleRightSidebarView("git");

    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(false);
    expect(s.rightSidebarView).toBe("git");
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBe("0");
  });

  it("toggleRightSidebarView on a different view switches without closing", () => {
    useDashboardStore.getState().toggleRightSidebarView("git");
    useDashboardStore.getState().toggleRightSidebarView("github");

    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("github");
  });

  it("toggleRightSidebar reopens the last view", () => {
    useDashboardStore.setState({ rightSidebarView: "github" });

    useDashboardStore.getState().toggleRightSidebar();
    expect(useDashboardStore.getState()).toMatchObject({
      rightSidebarOpen: true,
      rightSidebarView: "github",
    });

    useDashboardStore.getState().toggleRightSidebar();
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });

  it("closeRightSidebar closes an open drawer and is a no-op when already closed", () => {
    useDashboardStore.getState().closeRightSidebar();
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBeNull();

    useDashboardStore.setState({ rightSidebarOpen: true });
    useDashboardStore.getState().closeRightSidebar();
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
    expect(localStorage.getItem("crs.rightSidebarOpen")).toBe("0");
  });

  it("setRightSidebarPinned persists the flag", () => {
    useDashboardStore.getState().setRightSidebarPinned(true);

    expect(useDashboardStore.getState().rightSidebarPinned).toBe(true);
    expect(localStorage.getItem("crs.rightSidebarPinned")).toBe("1");
  });

  it("setRightSidebarWidth clamps to the min/max and persists the clamped value", () => {
    useDashboardStore.getState().setRightSidebarWidth(10);
    expect(useDashboardStore.getState().rightSidebarWidth).toBe(RIGHT_SIDEBAR_MIN_WIDTH);

    useDashboardStore.getState().setRightSidebarWidth(99999);
    expect(useDashboardStore.getState().rightSidebarWidth).toBe(RIGHT_SIDEBAR_MAX_WIDTH);
    expect(localStorage.getItem("crs.rightSidebarWidth")).toBe(String(RIGHT_SIDEBAR_MAX_WIDTH));
  });
});

describe("right sidebar hydration", () => {
  async function freshStore() {
    vi.resetModules();
    return (await import("./index.js")).useDashboardStore;
  }

  it("reopens a drawer that was pinned and open", async () => {
    localStorage.setItem("crs.rightSidebarPinned", "1");
    localStorage.setItem("crs.rightSidebarOpen", "1");
    localStorage.setItem("crs.rightSidebarView", "github");
    localStorage.setItem("crs.rightSidebarWidth", "400");

    const s = (await freshStore()).getState();

    expect(s).toMatchObject({
      rightSidebarPinned: true,
      rightSidebarOpen: true,
      rightSidebarView: "github",
      rightSidebarWidth: 400,
    });
  });

  it("does not reopen an unpinned overlay", async () => {
    localStorage.setItem("crs.rightSidebarOpen", "1");

    const s = (await freshStore()).getState();

    expect(s.rightSidebarOpen).toBe(false);
  });

  it("falls back to the git view at the default width", async () => {
    const s = (await freshStore()).getState();

    expect(s.rightSidebarView).toBe("git");
    expect(s.rightSidebarWidth).toBe(340);
  });
});
