import { api } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

/**
 * Starts the project's default-agent session on a worktree (`cwd`) or on a
 * branch (a worktree is made for it) and focuses it. The launcher is the same
 * one the command palette pre-selects: `agent:<defaultAgent>`, else the first.
 * Throws with a user-facing message; callers show it on the row.
 */
export async function openSessionOn(
  projectId: number,
  target: { cwd: string } | { branch: string },
): Promise<void> {
  const launchers = await api.listProjectActions(projectId);
  const state = useDashboardStore.getState();
  const launcher =
    launchers.find((l) => l.id === `agent:${state.settings.launchers.defaultAgent}`) ??
    launchers[0];
  if (!launcher) throw new Error("No launcher is configured for this project.");
  const session = await state.createSession(
    projectId,
    launcher.command,
    "cwd" in target ? { cwd: target.cwd } : { worktree: { branch: target.branch } },
  );
  state.requestOpenSession(session.id);
}
