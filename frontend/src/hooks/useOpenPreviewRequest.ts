import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { DockviewApi } from "dockview-react";
import { useDashboardStore } from "../store/index.js";

export interface UseOpenPreviewRequestParams {
  dockviewApi: DockviewApi | null;
  activeWorkspaceId: number | null;
  onOpenPreview: (
    projectId: number,
    slug: string,
    branch: string | null,
    targetName?: string,
  ) => void;
  restoringRef: MutableRefObject<boolean>;
  restoredWorkspaceIdRef: MutableRefObject<number | null>;
}

// Issues #2016/#2018 — resolves the store's requestOpenPreview intent: a
// Git/GitHub view asked to open a preview in the dock's browser pane, and has
// no panel opener of its own (a standalone GitHub panel, say). The preview
// twin of useOpenTaskRequest.ts, with the same gates: nothing opens before
// the active workspace's first restore (whose clear() would wipe the pane),
// and a request that lands mid-restore retries on a setTimeout(0) rather
// than waiting for an unrelated re-render. Like it, this must be called
// AFTER useWorkspacePersistence(...) in App.tsx's render body, with the SAME
// restoringRef/restoredWorkspaceIdRef objects.
export function useOpenPreviewRequest({
  dockviewApi,
  activeWorkspaceId,
  onOpenPreview,
  restoringRef,
  restoredWorkspaceIdRef,
}: UseOpenPreviewRequestParams): void {
  const request = useDashboardStore((s) => s.openPreviewRequest);
  const resolvedNonceRef = useRef(0);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!request) {
      // The nonce restarts at 1 once a resolved request is cleared, so forget
      // the one just resolved or the next request would be skipped.
      resolvedNonceRef.current = 0;
      return;
    }
    if (request.nonce === resolvedNonceRef.current) return;
    const workspaceRestored =
      activeWorkspaceId !== null && restoredWorkspaceIdRef.current === activeWorkspaceId;
    if (!dockviewApi || !workspaceRestored) return;
    if (restoringRef.current) {
      const timer = setTimeout(() => setRetryTick((t) => t + 1), 0);
      return () => clearTimeout(timer);
    }
    const { nonce, projectId, slug, branch } = request;
    const timer = setTimeout(() => {
      resolvedNonceRef.current = nonce;
      useDashboardStore.getState().clearOpenPreviewRequest(nonce);
      if (request.targetName) onOpenPreview(projectId, slug, branch, request.targetName);
      else onOpenPreview(projectId, slug, branch);
    }, 0);
    return () => clearTimeout(timer);
  }, [
    request,
    dockviewApi,
    activeWorkspaceId,
    onOpenPreview,
    retryTick,
    restoringRef,
    restoredWorkspaceIdRef,
  ]);
}
