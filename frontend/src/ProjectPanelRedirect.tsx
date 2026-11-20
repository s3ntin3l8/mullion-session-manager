import { FileTextIcon } from "./ui/icons.js";

// The Project panel (formerly ProjectHubPanel.tsx, a tabbed grid pane) is
// retired (#3406): its four editors live in the Project settings dialog and
// Skills is a drill-in of the sidebar's Project view. This component replaces
// it — and the five single-purpose panels the Project panel itself replaced
// (agent-rules, project-briefing, project-setup, dock-config, skills) — as
// their dockview component so panels/registry.tsx can keep every kind
// registered: an already-saved `workspaces.layout` blob may still name one,
// and an unregistered kind makes dockview's fromJSON discard the ENTIRE
// restored layout (TasksPanelRedirect.tsx's header has the walk-through).
// Never delete these keys.
//
// On restore the panel is normally closed before it can mount:
// panelUtils.ts's closeLegacyPanels sweeps these kinds right after fromJSON,
// without opening anything (a dialog popping up on a workspace switch would
// be a surprise). This stub is the registered fallback; its button opens the
// dialog by hand.
export function ProjectPanelRedirect({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="tasks-panel-redirect">
      <FileTextIcon size={20} />
      <div className="tasks-panel-redirect-title">Project settings moved to a dialog</div>
      <div className="tasks-panel-redirect-hint">
        Agent Rules, Briefing, Scaffold and Dock open from the sidebar&apos;s Project view. This
        panel can be closed.
      </div>
      <button type="button" className="tasks-panel-redirect-open" onClick={onOpen}>
        Open Project settings
      </button>
    </div>
  );
}
