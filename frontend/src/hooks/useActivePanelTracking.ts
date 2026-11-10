import { useEffect } from "react";
import type { DockviewApi } from "dockview-react";
import { useDashboardStore } from "../store/index.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseActivePanelTrackingParams {
  dockviewApi: DockviewApi | null;
  panelsVersion: number;
}

export function useActivePanelTracking({
  dockviewApi,
  panelsVersion,
}: UseActivePanelTrackingParams): void {
  // Issue #322: track which dockview panel is currently active so the
  // notification effect below can suppress desktop notifications for the
  // pane the user is currently looking at, even when the tab is visible.
  useEffect(() => {
    if (!dockviewApi) return;
    const setActivePanelId = useDashboardStore.getState().setActivePanelId;
    setActivePanelId(dockviewApi.activePanel?.id ?? null);
    const sub = dockviewApi.onDidActivePanelChange((e) => {
      useDashboardStore.getState().setActivePanelId(e.panel?.id ?? null);
    });
    return () => sub.dispose();
  }, [dockviewApi, panelsVersion]);
}
