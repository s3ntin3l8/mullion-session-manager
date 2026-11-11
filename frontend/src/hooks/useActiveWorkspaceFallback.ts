import { useEffect } from "react";
import type { Workspace } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseActiveWorkspaceFallbackParams {
  workspaces: Workspace[];
  activeWorkspaceId: number | null;
}

export function useActiveWorkspaceFallback({
  workspaces,
  activeWorkspaceId,
}: UseActiveWorkspaceFallbackParams): void {
  // If activeWorkspaceId (persisted in localStorage) points at a workspace
  // that no longer exists — deleted, or a stale value from a previous
  // install — fall back to the first available one.
  useEffect(() => {
    if (workspaces.length === 0) return;
    const stillExists = workspaces.some((w) => w.id === activeWorkspaceId);
    if (!stillExists) useDashboardStore.getState().setActiveWorkspaceId(workspaces[0].id);
  }, [workspaces, activeWorkspaceId]);
}
