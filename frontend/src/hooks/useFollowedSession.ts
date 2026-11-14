import { useState } from "react";
import type { Session } from "../api/index.js";
import { sessionIdFromPanelId } from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";

// The session the right sidebar's per-session views (Browser) show: the one
// whose pane is focused, or, while a pane that belongs to no session has
// focus (Settings, a project's Git panel), the last one that was. Only a
// session of `projectId` counts, so a sidebar pinned to another project never
// shows a session it is not about. Dock sessions are monitors, not sessions
// anyone browses from, and are skipped.
//
// The "last one" is remembered for as long as the view is mounted, the same
// render-phase adjustment useFollowedProject uses for its last derived id.
export function useFollowedSession(projectId: number): Session | null {
  const activePanelId = useDashboardStore((s) => s.activePanelId);
  const sessions = useDashboardStore((s) => s.sessions);
  const derivedId = sessionIdFromPanelId(activePanelId);
  const [lastId, setLastId] = useState<number | null>(derivedId);
  if (derivedId != null && derivedId !== lastId) setLastId(derivedId);
  const id = derivedId ?? lastId;
  return (
    sessions.find(
      (s) => s.id === id && s.projectId === projectId && s.kind !== "dock" && s.status !== "killed",
    ) ?? null
  );
}
