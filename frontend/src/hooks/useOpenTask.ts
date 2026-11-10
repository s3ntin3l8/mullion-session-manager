import { useCallback } from "react";
import { isCompactTier, useLayoutContext } from "../lib/layoutTier.js";
import { useDashboardStore } from "../store/index.js";

// "Show me this task" from inside the right sidebar (a PR row's task chip, a
// branch's owning task, an issue's linked task). Desktop selects it in the
// sidebar's Tasks view, so its status-first detail opens next to whatever the
// user was looking at (#2843: the one task detail surface). Phone and tablet
// keep the full-screen docked TaskDetail panel (requestOpenTask, resolved by
// useOpenTaskRequest): phone renders no right sidebar, and tablet floats it
// over the navigator drawer. Popping a task out to a docked panel on desktop
// is the Tasks detail header's own button, which calls requestOpenTask directly.
export function useOpenTask(): (taskId: number) => void {
  const compact = isCompactTier(useLayoutContext().tier);
  return useCallback(
    (taskId: number) => {
      const state = useDashboardStore.getState();
      if (compact) state.requestOpenTask(taskId);
      else state.openRightSidebarTask(taskId);
    },
    [compact],
  );
}
