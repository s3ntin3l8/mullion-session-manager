import { useCallback } from "react";
import { api } from "../api/index.js";
import type { Session } from "../api/types.js";
import { useDashboardStore } from "../store/index.js";

/** Where the new session's worktree comes from: an existing branch (a PR head)
 *  or a fresh branch cut from the project's default branch (an issue). */
export type StartSessionWorktree = { branch: string } | { branchName: string };

export interface StartSessionFromOpts {
  worktree: StartSessionWorktree;
  seedPrompt: string;
}

/**
 * Starts the user's default-agent session in a worktree seeded with a prompt
 * and opens it — the launcher behaviour behind "Start session" on an issue and
 * "Hand off" on a PR. Rejects with a readable error when the project has no
 * launcher; callers surface `err.message`.
 */
export function useStartSessionFrom(projectId: number) {
  return useCallback(
    async ({ worktree, seedPrompt }: StartSessionFromOpts): Promise<Session> => {
      const state = useDashboardStore.getState();
      const launchers = await api.listProjectActions(projectId);
      const launcher =
        launchers.find((l) => l.id === `agent:${state.settings.launchers.defaultAgent}`) ??
        launchers[0];
      if (!launcher) throw new Error("No launcher is configured for this project.");
      let target: { baseRef: string; branchName?: string } | { branch: string };
      if ("branch" in worktree) {
        target = worktree;
      } else {
        const branches = state.gitBranchesByProject[projectId];
        const project = state.projects.find((p) => p.id === projectId);
        target = {
          baseRef: branches?.defaultBranch ?? project?.currentBranch ?? "origin/main",
          branchName: worktree.branchName,
        };
      }
      const session = await state.createSession(projectId, launcher.command, {
        worktree: target,
        seedPrompt,
      });
      state.requestOpenSession(session.id);
      return session;
    },
    [projectId],
  );
}
