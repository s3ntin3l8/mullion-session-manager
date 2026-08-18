import { useEffect, useRef, useState } from "react";
import type { IDockviewHeaderActionsProps } from "dockview";
import { useDashboardStore } from "./store/index.js";
import { SplitDownIcon, SplitRightIcon } from "./ui/icons.js";

// Ported 1:1 from the design's pane-header anatomy (Cmux States.dc.html,
// section 02): split-right/split-down sit at the far right of a pane's
// header, past a flex spacer, just left of close/overflow. Neither design
// file wires a click handler for these icons (confirmed during extraction —
// no onClick, no data binding) so there's no literal behavior to port; this
// is an authored interaction, not a re-interpretation of a defined one.
//
// dockview's `rightHeaderActionsComponent` is the natural, minimal-diff home
// for this: a per-*group* action renderer (not per-tab), always visible,
// right-aligned — exactly where the design puts these icons, without
// duplicating them on every tab in a group. It receives no custom props
// (dockview owns the render), so — same as PaneTab.tsx already does for the
// same reason — this reads/writes the store directly rather than needing a
// prop channel from App.tsx.

// Issue: narrow headers overflow — below this GROUP width, these two
// buttons are hidden entirely, giving the tab strip's own more essential
// content (title, close, kebab) the room they were otherwise fighting it
// for. Split remains reachable via each tab's own kebab menu
// (PaneActionsMenu.tsx's "Split right"/"Split down" items). Roughly this
// component's own rendered footprint (two 24px `.pane-tab-btn`s + 6px gap +
// 4px right padding, ~58px) plus enough of the remainder for a single tab to
// sit at its own min-width (xterm.css's `.dv-tab`) without the two
// competing for the same space — not exact to the pixel, just a threshold
// comfortably clear of both.
const HIDE_SPLIT_ACTIONS_BELOW_GROUP_WIDTH_PX = 220;

export function PaneHeaderActions(props: IDockviewHeaderActionsProps) {
  const requestSplit = useDashboardStore((s) => s.requestSplit);
  const spanRef = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState(false);

  // Measures the immediate PARENT (.dv-tabs-and-actions-container — the
  // whole header row this span is one flex child of, alongside the tab
  // strip), not this span's own width: hiding this span's own children
  // would shrink ITS width toward zero the instant they hide, which would
  // immediately observe itself as "no longer too narrow" and un-hide again
  // — a feedback loop. The span itself always renders (even with zero
  // visible children) purely so this ref, and the observer it drives,
  // survives the hidden/visible transition instead of being torn down and
  // never able to re-observe a header that later widens back out.
  useEffect(() => {
    const el = spanRef.current?.parentElement;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setHidden(width < HIDE_SPLIT_ACTIONS_BELOW_GROUP_WIDTH_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!props.activePanel) return null;

  const split = (direction: "right" | "below") => {
    requestSplit(props.activePanel!.id, direction);
  };

  return (
    // height: "100%" matters, not just alignItems: "center" — dockview mounts
    // this span inside .dv-right-actions-container without giving it a fixed
    // height, so a content-height span top-aligns instead of centering
    // (issue #104). Mirrors .pane-tab's height:100%+align-items:center.
    <span
      ref={spanRef}
      style={{
        display: "flex",
        gap: 6,
        color: "var(--dim)",
        alignItems: "center",
        height: "100%",
        paddingRight: 4,
      }}
    >
      {!hidden && (
        <>
          <button className="pane-tab-btn" title="Split right" onClick={() => split("right")}>
            <SplitRightIcon size={15} />
          </button>
          <button className="pane-tab-btn" title="Split down" onClick={() => split("below")}>
            <SplitDownIcon size={15} />
          </button>
        </>
      )}
    </span>
  );
}
