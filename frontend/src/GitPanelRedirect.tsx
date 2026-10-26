import { GitBranchIcon } from "./ui/icons.js";

// The dock Git panel (formerly GitPanel.tsx) is retired: everything it did
// now lives in the Source Control right-sidebar view. This component replaces
// it as the `git` dockview component so panels/registry.tsx can keep the kind
// registered — an already-saved `workspaces.layout` blob (opaque to the
// backend) may still hold a `git-<projectId>` panel, and an unregistered kind
// makes dockview's fromJSON discard the ENTIRE restored layout (same reason
// as TasksPanelRedirect.tsx, whose header has the full dockview-core/ReactPart
// walk-through). Never delete this key.
//
// On restore the panel is normally closed before it can mount:
// panelUtils.ts's closeLegacyPanels sweeps `git` panels by component kind
// (ids are per project) right after fromJSON and opens Source Control for
// them. This stub is the registered fallback; its button does the same by hand.
export function GitPanelRedirect({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="tasks-panel-redirect">
      <GitBranchIcon size={20} />
      <div className="tasks-panel-redirect-title">Git moved to the sidebar</div>
      <div className="tasks-panel-redirect-hint">
        Source Control now lives in the right sidebar. This panel can be closed.
      </div>
      <button type="button" className="tasks-panel-redirect-open" onClick={onOpen}>
        Open Source Control
      </button>
    </div>
  );
}
