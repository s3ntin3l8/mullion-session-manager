/* eslint-disable react-hooks/exhaustive-deps -- dependency arrays are the
   original App.tsx arrays. Passed-in refs and useState setters are stable
   and were not listed there; adding them would not change when the effect
   runs. */
import { useEffect } from "react";
import type { RefObject } from "react";
import type { Workspace } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

const DEFAULT_WORKSPACE_NAME = "Default";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseDefaultWorkspaceBootstrapParams {
  workspacesLoaded: boolean;
  workspaces: Workspace[];
  bootstrappedRef: RefObject<boolean>;
}

export function useDefaultWorkspaceBootstrap({
  workspacesLoaded,
  workspaces,
  bootstrappedRef,
}: UseDefaultWorkspaceBootstrapParams): void {
  // First-ever load (no workspaces exist at all, anywhere) auto-creates
  // "Default" and selects it. Gated on workspacesLoaded so this can't fire
  // on the pre-fetch render where `workspaces` is still `[]` merely because
  // the request hasn't resolved yet. The ref re-arms itself once the list is
  // non-empty (rather than latching permanently true), so deleting every
  // workspace later — e.g. via the sidebar's own delete button — still
  // recovers a fresh "Default" instead of leaving the app with zero
  // workspaces and a dead activeWorkspaceId pointing nowhere.
  useEffect(() => {
    if (!workspacesLoaded) return;
    if (workspaces.length > 0) {
      bootstrappedRef.current = false;
      return;
    }
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    // The backend seeds "Default" itself on an empty GET /api/workspaces
    // (issue #1618), so this is only a version-skew fallback. A failure is
    // logged and left: resetting the ref would not retry, because this
    // effect's deps (workspacesLoaded, workspaces.length) do not change
    // when the create rejects (issue #1638).
    useDashboardStore
      .getState()
      .createWorkspace(DEFAULT_WORKSPACE_NAME)
      .then(
        (workspace) => {
          useDashboardStore.getState().setActiveWorkspaceId(workspace.id);
        },
        (err: unknown) => {
          console.error("[workspace] failed to create the default workspace", err);
        },
      );
  }, [workspacesLoaded, workspaces.length]);
}
