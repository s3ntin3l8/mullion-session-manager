// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePhoneTasksNavigator } from "./usePhoneTasksNavigator.js";
import { useDashboardStore } from "../store/index.js";
import { resetStore } from "../test/resetStore.js";

type P = Parameters<typeof usePhoneTasksNavigator>[0];

describe("usePhoneTasksNavigator", () => {
  beforeEach(() => resetStore());

  it("opens the navigator when Tasks is requested while it is closed", () => {
    const setSidebarOpen = vi.fn();
    renderHook(() =>
      usePhoneTasksNavigator({
        isMobile: true,
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
      initialProps: { isMobile: true, viewMode: "kanban", sidebarOpen: true, setSidebarOpen },
    });
    rerender({ isMobile: true, viewMode: "kanban", sidebarOpen: false, setSidebarOpen });
    expect(setViewMode).toHaveBeenCalledWith("list");
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });

  it("does nothing off phone", () => {
    const setSidebarOpen = vi.fn();
    renderHook(() =>
      usePhoneTasksNavigator({
        isMobile: false,
        viewMode: "kanban",
        sidebarOpen: false,
        setSidebarOpen,
      }),
    );
    expect(setSidebarOpen).not.toHaveBeenCalled();
  });
});
