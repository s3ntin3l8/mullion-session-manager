import { useEffect, useRef } from "react";
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
// A restored panel that actually mounts opens Source Control for its project
// once and then closes itself (via the wrapper's `onOpen`); one that is never
// mounted (a hidden tab) is swept by panelUtils.ts's closeLegacyPanels, which
// matches by component kind because the ids are per project. The visible
// stub is only a fallback for the instant before the panel closes.
export function GitPanelRedirect({ onOpen }: { onOpen: () => void }) {
  // The effect must fire once per mount even under StrictMode's double-invoke.
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    onOpen();
  }, [onOpen]);

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
