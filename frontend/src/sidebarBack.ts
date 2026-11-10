import { useDashboardStore } from "./store/index.js";
import type { SidebarBack } from "./store/types.js";

/**
 * The Back of a sidebar detail reached through a Tasks ↔ GitHub cross-link
 * (epic #2847) returns to where the user came from; any other Back is the
 * view's own (`fallback`, normally the list). The store records the pairing
 * for the destination only, so a stale entry never reroutes a later Back.
 */
export function goSidebarBack(to: SidebarBack, fallback: () => void): void {
  const store = useDashboardStore.getState();
  const back = store.takeSidebarBack(to);
  if (!back) {
    fallback();
    return;
  }
  if (back.kind === "task") store.openRightSidebarTask(back.taskId);
  else if (back.kind === "pr") store.openRightSidebarPr(back.projectId, back.number);
  else store.openRightSidebarIssue(back.projectId, back.number);
}
