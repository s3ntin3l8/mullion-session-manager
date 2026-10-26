import { useEffect } from "react";
import type { MutableRefObject } from "react";
import type { DockviewApi } from "dockview-react";
import { useDashboardStore } from "../store/index.js";

// Issues #2016/#2018 — resolves the store's requestOpenPreview intent: a
// Git/GitHub view asked to open a preview in the dock's browser pane, and has
// no panel opener of its own (a standalone GitHub panel, say). Waits out a
// workspace restore, which would otherwise replace the freshly added panel.
export function useOpenPreviewRequest({
  dockviewApi,
  restoringRef,
  onOpenPreview,
}: {
  dockviewApi: DockviewApi | null;
  restoringRef: MutableRefObject<boolean>;
  onOpenPreview: (projectId: number, slug: string, branch: string | null) => void;
}): void {
  const request = useDashboardStore((s) => s.openPreviewRequest);
  useEffect(() => {
    if (!request || !dockviewApi || restoringRef.current) return;
    onOpenPreview(request.projectId, request.slug, request.branch);
    useDashboardStore.getState().clearOpenPreviewRequest(request.nonce);
  }, [request, dockviewApi, onOpenPreview, restoringRef]);
}
