import { useCallback } from "react";
import { useLayoutContext } from "../lib/layoutTier.js";
import { useDashboardStore } from "../store/index.js";
import type { SidebarBack } from "../store/types.js";

// "Show me this task" from the board or from inside the right sidebar (a PR
// row's task chip, a branch's owning task, an issue's linked task). From 700px
// it selects it in the sidebar's Tasks view, so its status-first detail opens
// next to whatever the user was looking at (#2843, #3011: the one task detail
// surface; the right sidebar is docked on every width from 700px, #3006). The
// phone keeps the full-screen docked TaskDetail panel (requestOpenTask,
// resolved by useOpenTaskRequest), since it renders no right sidebar. Popping
// a task out to a docked panel on desktop is the Tasks detail header's own
// button, which calls requestOpenTask directly.
// `back` (from 700px) is where the task detail's Back returns, for a caller
// that is itself a sidebar detail (an issue, a PR): the same Tasks ↔ GitHub
// cross-link the shared status strip records.
export function useOpenTask(): (taskId: number, back?: SidebarBack) => void {
  const phone = useLayoutContext().tier === "phone";
  return useCallback(
    (taskId: number, back?: SidebarBack) => {
      const state = useDashboardStore.getState();
      if (phone) state.requestOpenTask(taskId);
      else if (back) state.openRightSidebarTask(taskId, back);
      else state.openRightSidebarTask(taskId);
    },
    [phone],
  );
}
