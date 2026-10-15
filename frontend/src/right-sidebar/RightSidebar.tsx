import { useEffect, useRef, useState } from "react";
import { useDragResize } from "../hooks/useDragResize.js";
import { useFollowedProject } from "../hooks/useFollowedProject.js";
import { usePhoneBackStack } from "../hooks/usePhoneBackStack.js";
import { attachSidebarSwipeGesture } from "../lib/sidebarSwipeGesture.js";
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
  // A request to show a specific project (palette "Edit project files") pins
  // the picker to it — render-phase adjustment keyed on the request's nonce.
  // The request is deliberately never cleared: the nonce is the only dedupe,
  // and resetting it to null would let a later request reuse an already-handled
  // nonce and be skipped.
  const projectRequest = useDashboardStore((s) => s.rightSidebarProjectRequest);
  const [handledNonce, setHandledNonce] = useState(projectRequest?.nonce ?? 0);
  if (projectRequest && projectRequest.nonce !== handledNonce) {
    setHandledNonce(projectRequest.nonce);
    followed.setPinnedProjectId(projectRequest.projectId);
  }

  const [width, setWidth] = useState(storedWidth);
  // Follow the store if it changes from outside this component's own drag
  // (another action, a future "reset width") — render-phase adjustment, not
  // an effect (react-hooks/set-state-in-effect).
  const [lastStoredWidth, setLastStoredWidth] = useState(storedWidth);
  if (storedWidth !== lastStoredWidth) {
    setLastStoredWidth(storedWidth);
    setWidth(storedWidth);
  }
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
  // so Escape (which terminals need) leaves it alone. Even when floating, an
  // Escape that something already handled (defaultPrevented) or that came
  // from inside a terminal belongs to that terminal (vim, an agent TUI), not
  // to the drawer.
  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(".xterm")) return;
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay, close]);

  // Tablet: Android back / the back gesture closes the floating drawer, and
  // so does a rightward swipe on it (the mirror of the left navigator).
  const tablet = tier === "tablet";
  usePhoneBackStack(tablet && overlay, close);
  const panelRef = useRef<HTMLElement>(null);
  const panelMounted = open && !docked;
  useEffect(() => {
    if (!tablet || !panelMounted) return;
    const el = panelRef.current;
    if (!el) return;
    return attachSidebarSwipeGesture({ element: el, commitDirection: 1, onCommit: close });
  }, [tablet, panelMounted, close]);

  // A tier change (rotate, fold/unfold, window resize) that lands on phone,
  // or takes a floating drawer from tablet to desktop, closes it like the
  // left navigator does — `open` is persisted state, so it would otherwise
  // linger invisibly (phone) or as a stale overlay (desktop). A pinned drawer
  // simply docks on desktop and stays. The reverse, desktop → tablet, never
  // closes: a docked drawer just becomes a floating one, which is intended.
  const lastTier = useRef(tier);
  useEffect(() => {
    const prev = lastTier.current;
    lastTier.current = tier;
    if (prev === tier || !open) return;
    if (tier === "phone" || (prev === "tablet" && tier === "desktop" && !pinned)) close();
  }, [tier, open, pinned, close]);

  if (tier === "phone") return null;

  const view = RIGHT_SIDEBAR_VIEWS.find((v) => v.id === viewId) ?? RIGHT_SIDEBAR_VIEWS[0];

  return (
    <>
      {overlay && <div className="right-sidebar-scrim" onClick={close} />}
      {open && (
        <aside
          className={`right-sidebar-panel${docked ? " docked" : " overlay"}${dragging ? " resizing" : ""}`}
          ref={panelRef}
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
