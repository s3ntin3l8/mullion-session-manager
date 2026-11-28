import { createContext } from "react";
import { useDashboardStore } from "../store/index.js";

// #3537 — projects pinned to a workspace (server-side, per workspace; see
// Workspace.pinnedProjectIds). Not to be confused with useFollowedProject's
// `pinnedProjectId`, the right sidebar picker's own local choice.

const NO_PINS: readonly number[] = Object.freeze([]);

/**
 * True where pinning to the active workspace is offered: the Sidebar sets it
 * when its tree is workspace-scoped (desktop with a restored workspace). The
 * default, false, hides the pin item and indicator — the phone tier, which
 * has no workspaces, and any surface outside a scoped Sidebar.
 */
export const WorkspacePinScopeContext = createContext(false);

/** The active workspace's pinned project ids, or a stable empty array. */
export function useActiveWorkspacePinnedIds(): readonly number[] {
  return useDashboardStore((s) => {
    if (s.activeWorkspaceId == null) return NO_PINS;
    const ids = s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.pinnedProjectIds;
    return ids && ids.length > 0 ? ids : NO_PINS;
  });
}

/**
 * Pins `projectId` to the active workspace, or unpins it when it is already
 * pinned. Returns an error message, or null on success (or when there is no
 * active workspace to pin to).
 */
export async function toggleActiveWorkspacePin(projectId: number): Promise<string | null> {
  const { activeWorkspaceId, workspaces, projects, projectsLoaded, setWorkspacePinnedProjects } =
    useDashboardStore.getState();
  if (activeWorkspaceId == null) return null;
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!workspace) return null;
  // The server already dropped the pin of a project deleted or merged away
  // (cascade), but this copy of the workspace may still list it; sending it
  // back would be a 400 on every later toggle in this workspace. Only once
  // the project list has loaded: filtering against a list that is not there
  // yet would unpin everything, since the PATCH replaces the whole set.
  const stored = workspace.pinnedProjectIds ?? [];
  const known = new Set(projects.map((p) => p.id));
  const current = projectsLoaded ? stored.filter((id) => known.has(id)) : stored;
  const next = current.includes(projectId)
    ? current.filter((id) => id !== projectId)
    : [...current, projectId];
  try {
    await setWorkspacePinnedProjects(activeWorkspaceId, next);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
