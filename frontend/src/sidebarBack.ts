import { useDashboardStore } from "./store/index.js";
import type { SidebarBack } from "./store/types.js";

/**
 * Back in a sidebar detail pops the navigation history (#2918): a task → PR →
 * task → PR chain unwinds one step at a time. With no entry for this detail
 * Back is the view's own (`fallback`, normally the list). Each entry is tagged
 * with its destination, so a stale one never reroutes a Back from elsewhere.
 * Popping passes `null` as the origin so the step back is not itself recorded.
 */
export function goSidebarBack(to: SidebarBack, fallback: () => void): void {
  const store = useDashboardStore.getState();
  const back = store.takeSidebarBack(to);
  if (!back) {
    fallback();
    return;
  }
  if (back.kind === "task") store.openRightSidebarTask(back.taskId, null);
  else if (back.kind === "pr") store.openRightSidebarPr(back.projectId, back.number, null);
  else store.openRightSidebarIssue(back.projectId, back.number, null);
}
