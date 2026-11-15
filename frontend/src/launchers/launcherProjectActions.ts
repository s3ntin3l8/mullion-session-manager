import { createContext } from "react";
import type { Session } from "../api/index.js";

// What the launcher's project management needs from App (#3048): closing the
// panes of a deleted project's sessions, and Settings → Projects (the
// "Configure search roots" of an empty discovery).
export interface LauncherProjectActions {
  onSessionEnded: (session: Session) => void;
  onOpenSettingsProjects: () => void;
}
export const LauncherProjectActionsContext = createContext<LauncherProjectActions>({
  onSessionEnded: () => {},
  onOpenSettingsProjects: () => {},
});
