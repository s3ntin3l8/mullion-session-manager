import type { IDockviewHeaderActionsProps } from "dockview";
import { useDashboardStore } from "./store.js";
import { SplitDownIcon, SplitRightIcon } from "./icons.js";

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
export function PaneHeaderActions(props: IDockviewHeaderActionsProps) {
  const requestSplit = useDashboardStore((s) => s.requestSplit);

  if (!props.activePanel) return null;

  const split = (direction: "right" | "below") => {
    requestSplit(props.activePanel!.id, direction);
  };

  return (
    <span
      style={{
        display: "flex",
        gap: 6,
        color: "var(--dim)",
        alignItems: "center",
        paddingRight: 4,
      }}
    >
      <button className="pane-tab-btn" title="Split right" onClick={() => split("right")}>
        <SplitRightIcon size={15} />
      </button>
      <button className="pane-tab-btn" title="Split down" onClick={() => split("below")}>
        <SplitDownIcon size={15} />
      </button>
    </span>
  );
}
