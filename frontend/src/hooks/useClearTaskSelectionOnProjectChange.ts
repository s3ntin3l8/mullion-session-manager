import { useEffect, useRef } from "react";
import { useDashboardStore } from "../store/index.js";

/**
 * Clears the right sidebar's selected task when the followed project changes.
 *
 * The selection is store-global and the sidebar views are not keyed by project,
 * so without this, following another project keeps showing the last project's
 * task detail. Only a selection that predates the switch is cleared: one that
 * arrives with it (a notification click that selects a task and moves the
 * sidebar in the same step) is kept. Mounted by RightSidebarPanel, so it runs
 * whichever view is showing.
 */
export function useClearTaskSelectionOnProjectChange(projectId: number | null): void {
  const selectedTaskId = useDashboardStore((s) => s.selectedTaskId);
  const lastProject = useRef(projectId);
  const lastSelected = useRef(selectedTaskId);
  useEffect(() => {
    if (lastProject.current !== projectId) {
      lastProject.current = projectId;
      if (selectedTaskId !== null && selectedTaskId === lastSelected.current) {
        useDashboardStore.getState().selectTask(null);
      }
    }
    lastSelected.current = selectedTaskId;
  }, [projectId, selectedTaskId]);
}
