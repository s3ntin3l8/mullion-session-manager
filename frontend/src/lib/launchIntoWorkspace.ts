import type { Session } from "../api/index.js";
import { api as http } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

/**
 * #3246 — a session started on the phone with another workspace chosen in
 * the launcher (LauncherWorkspaceRow) joins that workspace, not the one the
 * phone was showing. Records the open against the chosen workspace (#3033's
 * pending-opens route, which a desk client applies through
 * useApplyPendingOpens), then makes it the phone's active workspace and asks
 * for the session's pane there: the post-switch highlight
 * (usePostWorkspaceSwitchHighlight) opens it once the switch has happened,
 * so the pane never opens in the workspace being left.
 *
 * The phone never saves a layout; once the pane is open in the chosen
 * workspace, useFoldHalves' syncPendingOpens may record it again for the same
 * workspace, which the route treats as an upsert.
 */
export function launchIntoWorkspace(session: Session, workspaceId: number): void {
  const store = useDashboardStore.getState();
  void http.recordPendingOpen(workspaceId, session.id, null).catch(() => {});
  store.triggerPanelHighlight(`session-${session.id}`);
  store.showWorkspace(workspaceId);
}
