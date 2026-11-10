import { useEffect, useRef } from "react";
import { useDashboardStore } from "../store/index.js";

/**
 * Clears the right sidebar's selected task when the followed project changes.
 *
 * The selection is store-global and the sidebar views are not keyed by project,
 * so without this, following another project keeps showing the last project's
 * task detail. Only a selection that predates the switch is cleared: one that
 * arrives with it (a notification click that selects a task and moves the
 * sidebar in the same step, even the task that was already selected) is kept.
 * "Arrives" is read from the store's selection sequence number, not the id. Mounted by RightSidebarPanel, so it runs
 * whichever view is showing. Mounted by RightSidebar, which stays mounted while
 * the drawer is collapsed (when the followed project usually changes).
 */
export function useClearTaskSelectionOnProjectChange(projectId: number | null): void {
  const selectedTaskId = useDashboardStore((s) => s.selectedTaskId);
  const lastProject = useRef(projectId);
  const seq = useDashboardStore((s) => s.taskSelectionSeq);
  const lastSeq = useRef(seq);
  useEffect(() => {
    if (lastProject.current !== projectId) {
      lastProject.current = projectId;
      if (selectedTaskId !== null && seq === lastSeq.current) {
        useDashboardStore.getState().selectTask(null);
      }
    }
    lastSeq.current = seq;
  }, [projectId, selectedTaskId, seq]);
}
