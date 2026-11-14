import type { RailPaneInput } from "../lib/railPanes.js";
import { RailPanes } from "./RailPaneList.js";
import { WorkspaceChip } from "./WorkspaceChip.js";

export interface RailWorkspaceSectionProps {
  onSelectWorkspace: (workspaceId: number) => void;
  /** Coarse pointer: the workspace list opens as a sheet. */
  sheet: boolean;
  /** The left sidebar is not showing, so the rail lists the open panes. */
  showPanes: boolean;
  panes: readonly RailPaneInput[];
  activePanelId: string | null;
  onFocusPane: (panelId: string) => void;
  /** The "+" under the panes; App routes every "new session" through one function. */
  onNewSession: () => void;
}

// What the left rail's middle region holds in Workspace mode (#3009): the
// workspace chip, and while the left sidebar is not showing, the workspace's
// open panes with a "+" under them.
export function RailWorkspaceSection({
  onSelectWorkspace,
  sheet,
  showPanes,
  panes,
  activePanelId,
  onFocusPane,
  onNewSession,
}: RailWorkspaceSectionProps) {
  return (
    <>
      <WorkspaceChip onSelectWorkspace={onSelectWorkspace} sheet={sheet} />
      {showPanes && (
        <>
          <span className="left-rail-sep" aria-hidden="true" />
          <RailPanes
            panes={panes}
            activePanelId={activePanelId}
            onFocus={onFocusPane}
            onAdd={onNewSession}
          />
        </>
      )}
    </>
  );
}
