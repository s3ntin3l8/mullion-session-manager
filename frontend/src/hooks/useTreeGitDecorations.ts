import { useMemo } from "react";
import { useDashboardStore } from "../store/index.js";
import { buildGitDecorations } from "../lib/treeGitDecorations.js";

// What a file tree should show for git: the project's working-tree status, or —
// for a tree rooted at a session's own worktree — that session's. Both are
// already kept fresh by the store's git polling.
export function useTreeGitDecorations(projectId: number, sessionId: number | undefined) {
  const files = useDashboardStore((s) =>
    sessionId === undefined
      ? s.gitStatuses[projectId]?.files
      : s.sessionGitStatuses[sessionId]?.files,
  );
  return useMemo(() => buildGitDecorations(files), [files]);
}

/** Ask the store for fresh statuses (deduplicated while one is in flight) — after
 * something the tree itself did changed the working tree. */
export function refreshGitStatuses(): void {
  void useDashboardStore.getState().refreshGitStatuses();
}
