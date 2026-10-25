import { useDashboardStore } from "../store/index.js";
import { sessionCheckoutRoot, sessionIdOfPanel } from "../lib/sessionCheckout.js";

// The session whose own checkout the focused dockview panel is in, when that
// checkout is not the project's — a git worktree session. The sidebar's file
// tree follows it so what you browse is what that agent is editing, and a
// path you drag into its terminal means the file in ITS worktree. Null for
// anything else: a session working in the project's own checkout, a panel that
// isn't a session's (Git, Settings), or one of another project.
export function useFollowedCheckoutSession(projectId: number | null): number | null {
  const activePanelId = useDashboardStore((s) => s.activePanelId);
  const sessions = useDashboardStore((s) => s.sessions);
  const projects = useDashboardStore((s) => s.projects);
  const sessionId = sessionIdOfPanel(activePanelId);
  if (sessionId === null || projectId === null) return null;
  const session = sessions.find((x) => x.id === sessionId);
  const project = projects.find((x) => x.id === projectId);
  if (!session || !project || session.projectId !== projectId) return null;
  return sessionCheckoutRoot(session, project) === null ? null : sessionId;
}
