import { useEffect, useState } from "react";
import { useDragResize } from "../hooks/useDragResize.js";
import { useFollowedProject } from "../hooks/useFollowedProject.js";
import type { LayoutTier } from "../lib/layoutTier.js";
import { useDashboardStore } from "../store/index.js";
import { RIGHT_SIDEBAR_MAX_WIDTH, RIGHT_SIDEBAR_MIN_WIDTH } from "../store/constants.js";
import { RightRail } from "./RightRail.js";
import { RightSidebarPanel } from "./RightSidebarPanel.js";
import { RIGHT_SIDEBAR_VIEWS, type RightSidebarActions } from "./views.js";

export interface RightSidebarProps {
  tier: LayoutTier;
  actions: RightSidebarActions;
}

// Pinnable right sidebar: an icon rail plus a view drawer. Pinned (desktop
// only) the drawer docks beside the grid and pushes it; otherwise — and always
// on tablet — it floats over the grid with a click-away scrim. Rendered as
// siblings of `.grid-area` inside `.app-body`. Not rendered on phone, where
// the navigator panel already carries Source Control.
export function RightSidebar({ tier, actions }: RightSidebarProps) {
  const viewId = useDashboardStore((s) => s.rightSidebarView);
  const open = useDashboardStore((s) => s.rightSidebarOpen);
  const pinned = useDashboardStore((s) => s.rightSidebarPinned);
  const storedWidth = useDashboardStore((s) => s.rightSidebarWidth);
  const setPinned = useDashboardStore((s) => s.setRightSidebarPinned);
  const setStoredWidth = useDashboardStore((s) => s.setRightSidebarWidth);
  const close = useDashboardStore((s) => s.closeRightSidebar);
  const followed = useFollowedProject();

  const [width, setWidth] = useState(storedWidth);
  const { dragging, onMouseDown } = useDragResize({
    axis: "x",
    invert: true,
    min: RIGHT_SIDEBAR_MIN_WIDTH,
    getMax: () => RIGHT_SIDEBAR_MAX_WIDTH,
    value: width,
    onChange: setWidth,
    onCommit: setStoredWidth,
    cursor: "col-resize",
  });

  const desktop = tier === "desktop";
  // A pin saved on desktop is ignored (not erased) below desktop width.
  const docked = desktop && pinned;
  const overlay = open && !docked;

  // Escape dismisses the floating drawer. A docked one is part of the layout,
  // so Escape (which terminals need) leaves it alone.
  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay, close]);

  if (tier === "phone") return null;

  const view = RIGHT_SIDEBAR_VIEWS.find((v) => v.id === viewId) ?? RIGHT_SIDEBAR_VIEWS[0];

  return (
    <>
      {overlay && <div className="right-sidebar-scrim" onClick={close} />}
      {open && (
        <aside
          className={`right-sidebar-panel${docked ? " docked" : " overlay"}${dragging ? " resizing" : ""}`}
          style={{ width }}
          aria-label={`${view.label} sidebar`}
        >
          {desktop && <div className="right-sidebar-resize-handle" onMouseDown={onMouseDown} />}
          <RightSidebarPanel
            view={view}
            followed={followed}
            actions={actions}
            canPin={desktop}
            pinned={pinned}
            onTogglePin={() => setPinned(!pinned)}
            onClose={close}
          />
        </aside>
      )}
      <RightRail projectId={followed.effectiveProjectId} />
    </>
  );
}
