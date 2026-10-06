// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePhoneTasksNavigator } from "./usePhoneTasksNavigator.js";
import { useDashboardStore } from "../store/index.js";
import { resetStore } from "../test/resetStore.js";

type P = Parameters<typeof usePhoneTasksNavigator>[0];

describe("usePhoneTasksNavigator", () => {
  beforeEach(() => resetStore());

  it("forgets that the navigator showed Tasks once the tier leaves compact", () => {
    // tablet (Tasks shown) -> desktop -> tablet must reopen the navigator, not
    // read the stale "shown" as the user closing it and drop Tasks.
    const setSidebarOpen = vi.fn();
    useDashboardStore.getState().setViewMode("kanban");
    const { rerender } = renderHook((p: P) => usePhoneTasksNavigator(p), {
      initialProps: { compact: true, viewMode: "kanban", sidebarOpen: true, setSidebarOpen },
    });
    rerender({ compact: false, viewMode: "kanban", sidebarOpen: false, setSidebarOpen });
    rerender({ compact: true, viewMode: "kanban", sidebarOpen: false, setSidebarOpen });
    expect(useDashboardStore.getState().viewMode).toBe("kanban");
    expect(setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it("opens the navigator when Tasks is requested while it is closed", () => {
    const setSidebarOpen = vi.fn();
    renderHook(() =>
      usePhoneTasksNavigator({
        compact: true,
        viewMode: "kanban",
        sidebarOpen: false,
        setSidebarOpen,
      }),
    );
    expect(setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it("leaves Tasks when the navigator is closed after showing the board", () => {
    const setSidebarOpen = vi.fn();
    const setViewMode = vi.spyOn(useDashboardStore.getState(), "setViewMode");
    const { rerender } = renderHook((p: P) => usePhoneTasksNavigator(p), {
      initialProps: { compact: true, viewMode: "kanban", sidebarOpen: true, setSidebarOpen },
    });
    rerender({ compact: true, viewMode: "kanban", sidebarOpen: false, setSidebarOpen });
    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });

  it("does nothing on the desktop tier", () => {
    const setSidebarOpen = vi.fn();
    renderHook(() =>
      usePhoneTasksNavigator({
        compact: false,
        viewMode: "kanban",
        sidebarOpen: false,
        setSidebarOpen,
      }),
    );
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });
});
