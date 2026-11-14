import { useCallback } from "react";
import type { DockviewApi } from "dockview-react";
import { PaneActionsMenu } from "../PaneActionsMenu.js";
import type { TerminalPaneParams } from "../TerminalPane.js";
import { canGoRight } from "../lib/foldHalves.js";
import type { Half } from "../lib/foldHalves.js";
import { describeError } from "../lib/describeError.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import type { RailPaneEntry } from "../lib/railPanes.js";
import { focusPanelForTier, isTiledPanel, panelSessionId } from "../panelUtils.js";
import type { RailEntryMenuItem } from "../rail/RailPaneList.js";
import { useDashboardStore } from "../store/index.js";

// #3010 — what the two halves' rails and headers do with a pane: move it to
// the other half, show or hide a right-rail session, rename it, close it.
// `tiledLeftCount` is the left half's tiled panes: a move that would leave
// none is not offered (the left half shows a tiled pane by maximizing it).
export function useHalfActions(
  dockviewApi: DockviewApi | null,
  layoutTier: LayoutTier,
  tiledLeftCount: number,
) {
  const moveToHalf = useCallback(
    (panelId: string, half: Half) => {
      if (!dockviewApi) return;
      const store = useDashboardStore.getState();
      store.moveToHalf(
        panelId,
        half,
        dockviewApi.panels.filter(isTiledPanel).map((p) => p.id),
      );
      if (half === "right") {
        // The moved session shows on the right half, uncovering it.
        if (store.rightSidebarOpen) store.closeRightSidebar();
        store.setFocusedHalf("right");
      } else {
        const panel = dockviewApi.getPanel(panelId);
        if (panel) focusPanelForTier(dockviewApi, panel, layoutTier);
      }
    },
    [dockviewApi, layoutTier],
  );
  // A right-rail session behaves like a view tab: tap shows it on the right
  // half, tap again hides it; while a view covers the half, a tap uncovers it.
  const toggleRightRailPane = useCallback((panelId: string) => {
    const store = useDashboardStore.getState();
    if (store.rightSidebarOpen) {
      store.closeRightSidebar();
      store.showRightPane(panelId);
      store.setFocusedHalf("right");
      return;
    }
    store.toggleRightPane(panelId);
    const ws = store.activeWorkspaceId;
    const shown = ws === null ? null : useDashboardStore.getState().foldHalves[ws]?.shownRight;
    store.setFocusedHalf(shown === panelId ? "right" : "left");
  }, []);
  // #3010 — the halves hide dockview's tab strip, so each half's header
  // carries the pane's menu (rename, close the pane, end the session), as
  // the phone picker does.
  const renderHalfActions = useCallback(
    (panelId: string) => (startRename: () => void) => {
      const panel = dockviewApi?.getPanel(panelId);
      if (!dockviewApi || !panel) return null;
      return (
        <PaneActionsMenu
          api={panel.api}
          params={panel.params as TerminalPaneParams | undefined}
          containerApi={dockviewApi}
          onRename={startRename}
          triggerClassName="half-header-btn half-header-menu"
        />
      );
    },
    [dockviewApi],
  );
  const renameHalfPane = useCallback(
    (panelId: string, value: string) => {
      const panel = dockviewApi?.getPanel(panelId);
      if (!panel) return;
      const sessionId = panelSessionId(panel);
      const previous = panel.title ?? "";
      panel.api.setTitle(value);
      if (sessionId === undefined) return;
      void useDashboardStore
        .getState()
        .renameSession(sessionId, value)
        .catch((err) => {
          panel.api.setTitle(previous);
          useDashboardStore
            .getState()
            .reportError("Could not rename the session.", describeError(err));
        });
    },
    [dockviewApi],
  );
  const closeHalfPane = useCallback(
    (panelId: string) => dockviewApi?.getPanel(panelId)?.api.close(),
    [dockviewApi],
  );
  const halfMenuItems = useCallback(
    (half: Half) =>
      (entry: RailPaneEntry): RailEntryMenuItem[] => [
        ...(half === "left"
          ? canGoRight(entry.panelId) && tiledLeftCount > 1
            ? [
                {
                  label: "Move to the right half",
                  onSelect: () => moveToHalf(entry.panelId, "right"),
                },
              ]
            : []
          : [
              { label: "Move to the left half", onSelect: () => moveToHalf(entry.panelId, "left") },
            ]),
        // Detaches the pane; the session keeps running.
        { label: "Close pane", onSelect: () => closeHalfPane(entry.panelId) },
      ],
    [moveToHalf, tiledLeftCount, closeHalfPane],
  );
  return {
    moveToHalf,
    toggleRightRailPane,
    renderHalfActions,
    renameHalfPane,
    halfMenuItems,
  };
}
