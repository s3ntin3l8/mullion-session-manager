import { GitHubIcon } from "./ui/icons.js";

// The grid GitHub panel is retired: the right sidebar's GitHub view renders
// the same content. This component replaces it as the `github` dockview
// component so panels/registry.tsx can keep the kind registered — an
// already-saved `workspaces.layout` blob (opaque to the backend) may still
// hold a `github-<projectId>` panel, and an unregistered kind makes dockview's
// fromJSON discard the ENTIRE restored layout (same reason as
// GitPanelRedirect.tsx). Never delete this key.
//
// On restore the panel is normally closed before it can mount:
// panelUtils.ts's closeLegacyPanels sweeps `github` panels by component kind
// and opens the sidebar's GitHub view for them. This stub is the registered
// fallback; its button does the same by hand.
export function GitHubPanelRedirect({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="tasks-panel-redirect">
      <GitHubIcon size={20} />
      <div className="tasks-panel-redirect-title">GitHub moved to the sidebar</div>
      <div className="tasks-panel-redirect-hint">
        GitHub now lives in the right sidebar. This panel can be closed.
      </div>
      <button type="button" className="tasks-panel-redirect-open" onClick={onOpen}>
        Open GitHub
      </button>
    </div>
  );
}
