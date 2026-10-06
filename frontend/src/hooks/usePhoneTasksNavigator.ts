import { useEffect, useRef } from "react";
import { useDashboardStore } from "../store/index.js";

// Phone and tablet: Tasks is a navigator tab (the board renders inside the drawer), so
// viewMode "kanban" and the navigator being open must move together.
export function usePhoneTasksNavigator({
  compact,
  viewMode,
  sidebarOpen,
  setSidebarOpen,
}: {
  compact: boolean;
  viewMode: string;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}) {
  // True once the navigator has shown the Tasks board; distinguishes "the user
  // closed the navigator" from "Tasks was just requested while it was closed".
  const shown = useRef(false);
  useEffect(() => {
    if (!compact) {
      // Off the compact tiers the desktop overlay owns Tasks; forget the
      // navigator state so a later return to tablet reopens it instead of
      // reading a stale "shown" as the user having closed it.
      shown.current = false;
      return;
    }
    if (viewMode === "kanban" && !sidebarOpen) {
      // Closed after showing Tasks (✕, swipe, back, opening a session): leave
      // Tasks. Never shown yet (palette set viewMode): open the navigator.
      if (shown.current) useDashboardStore.getState().setViewMode("list");
      else setSidebarOpen(true);
    }
    shown.current = viewMode === "kanban" && sidebarOpen;
  }, [compact, viewMode, sidebarOpen, setSidebarOpen]);
}
