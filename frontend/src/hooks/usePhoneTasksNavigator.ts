import { useEffect, useRef } from "react";
import { useDashboardStore } from "../store/index.js";

// Phone: Tasks is a navigator tab (the board renders inside the drawer), so
// viewMode "kanban" and the navigator being open must move together.
export function usePhoneTasksNavigator({
  isMobile,
  viewMode,
  sidebarOpen,
  setSidebarOpen,
}: {
  isMobile: boolean;
  viewMode: string;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}) {
  // True once the navigator has shown the Tasks board; distinguishes "the user
  // closed the navigator" from "Tasks was just requested while it was closed".
  const shown = useRef(false);
  useEffect(() => {
    if (!isMobile) return;
    if (viewMode === "kanban" && !sidebarOpen) {
      // Closed after showing Tasks (✕, swipe, back, opening a session): leave
      // Tasks. Never shown yet (palette set viewMode): open the navigator.
      if (shown.current) useDashboardStore.getState().setViewMode("list");
      else setSidebarOpen(true);
    }
    shown.current = viewMode === "kanban" && sidebarOpen;
  }, [isMobile, viewMode, sidebarOpen, setSidebarOpen]);
}
