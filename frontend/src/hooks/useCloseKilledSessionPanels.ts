import { useEffect } from "react";
import type { DockviewApi } from "dockview-react";
import type { Session } from "../api/index.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseCloseKilledSessionPanelsParams {
  sessions: Session[];
  dockviewApi: DockviewApi | null;
}

export function useCloseKilledSessionPanels({
  sessions,
  dockviewApi,
}: UseCloseKilledSessionPanelsParams): void {
  // Close any dockview panel whose session has been killed — catches cases
  // where the layout was saved before the kill and then restored (workspace
  // switch, page reload), causing the killed session's panel to reappear.
  // Harmless no-op when the panel was already closed via the normal kill
  // flow (PaneTab's sync close before the API call in armOrKill).  Pairs
  // with the post-restore cleanup in the workspace restore effect
  // (useWorkspacePersistence.ts, in the `try` block that removes stale
  // panels after `fromJSON`) — when
  // sessions haven't loaded yet during restore, this effect takes over once
  // `sessions` populates.
  useEffect(() => {
    if (!dockviewApi) return;
    for (const session of sessions) {
      if (session.status === "killed") {
        dockviewApi.getPanel(`session-${session.id}`)?.api.close();
      }
    }

    const staleTimelineOrBrowserPane: string[] = [];
    for (const panel of dockviewApi.panels) {
      if (panel.id.startsWith("timeline-") || panel.id.startsWith("browserPane-")) {
        let sessionId = (panel.params as { sessionId?: number } | undefined)?.sessionId;
        if (sessionId == null) {
          const match = panel.id.match(/^(?:timeline|browserPane)-(\d+)$/);
          if (match) sessionId = parseInt(match[1], 10);
        }
        if (sessionId != null) {
          const session = sessions.find((s) => s.id === sessionId);
          if (!session || session.status === "killed" || session.status === "exited") {
            staleTimelineOrBrowserPane.push(panel.id);
          }
        }
      }
    }
    for (const id of staleTimelineOrBrowserPane) {
      dockviewApi.getPanel(id)?.api.close();
    }
  }, [sessions, dockviewApi]);
}
