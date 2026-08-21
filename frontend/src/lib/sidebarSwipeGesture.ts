// Floating-sidebar redesign, PR 4 — edge-swipe open/dismiss for the
// overlay sidebar (sidebar.css's `max-width: 1279.98px` block).
//
// Deliberately a discrete threshold+commit gesture, not a 1:1 drag-follow:
// the sidebar's own `transition: transform 0.24s ease` (sidebar.css)
// already animates the open/close motion for the existing tap-the-hamburger
// path, so reusing that CSS transition here means no per-frame transform
// writes, no "disable transition while dragging / re-enable on release"
// bookkeeping, and no interrupted-gesture cleanup — the only state this
// needs is "did the drag cross the commit distance." A live finger-follow
// drag is a real, larger feature (composing correctly with the CSS
// transition, and with zero unit-testable core) — out of scope here.
//
// No separate overlay DOM node for the edge zone: attaching a real
// hit-testable element in the leftmost slice of the screen would steal
// touchstart from whatever's rendered underneath it (a terminal pane can
// render flush against that same edge once the sidebar floats instead of
// docking), silently deadening PR #789's touch-scroll fix for any drag
// that happens to start there. Instead, `edgeZonePx` filters by the
// touch's start position against a shared ancestor (`.app-body`) — the
// terminal's own listener (attached directly to the xterm element, a
// descendant) still receives every touch event first (target phase runs
// before this ancestor's bubble-phase listener), completely unaffected by
// this one's presence. This one only ever acts (preventDefault, commit)
// once a same-gesture drag has both started in the edge slice AND resolved
// horizontal-dominant — a vertical scrollback drag starting in that slice
// locks "vertical" on its first few px of movement and this listener
// no-ops for the rest of that gesture.
//
// Known, accepted gap (review finding) — NOT the same situation as
// dockview's tab-strip `touch-action: pan-x` (xterm.css, PR #723): that's a
// native browser panning grant on the SAME horizontal axis this gesture
// also wants, not an orthogonal one. Per the touch-action spec, once an
// axis is natively granted, this listener's own `preventDefault()` can't
// take it back — so a rightward drag starting inside the edge zone, on top
// of an overflowing, edge-flush dockview tab strip, on a coarse pointer,
// can pan tabs natively AND still commit `onCommit()` here (computed from
// raw `deltaX`, not from whether preventDefault "worked"). Narrow — needs
// an overflowing strip flush against the exact edge this gesture claims —
// and not solved here: doing so would need this helper to know where every
// dockview group's own tab strip renders, real cross-cutting state well
// beyond this gesture helper's scope. See the `cancelable: false` test
// below, which documents (not fixes) this gap.

const AXIS_LOCK_THRESHOLD_PX = 6;
const COMMIT_THRESHOLD_PX = 60;

export function attachSidebarSwipeGesture(params: {
  element: HTMLElement;
  // 1: a rightward drag commits (edge-swipe open). -1: a leftward drag
  // commits (swipe-to-dismiss on the open sidebar itself).
  commitDirection: 1 | -1;
  onCommit: () => void;
  // Only touches starting within this many px of `element`'s own left
  // edge begin tracking. Omit to track touches starting anywhere on
  // `element` (the open sidebar's own dismiss gesture — draggable from
  // anywhere on the panel, not just one edge of it).
  edgeZonePx?: number;
}): () => void {
  const { element, commitDirection, onCommit, edgeZonePx } = params;

  let tracking = false;
  let committed = false;
  let startX = 0;
  let startY = 0;
  let axisLocked: "horizontal" | "vertical" | null = null;

  const reset = () => {
    tracking = false;
    committed = false;
    axisLocked = null;
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    if (edgeZonePx !== undefined) {
      const rect = element.getBoundingClientRect();
      if (touch.clientX - rect.left > edgeZonePx) {
        reset();
        return;
      }
    }
    tracking = true;
    committed = false;
    axisLocked = null;
    startX = touch.clientX;
    startY = touch.clientY;
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!tracking || committed) return;
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    if (axisLocked === null) {
      if (Math.abs(deltaX) < AXIS_LOCK_THRESHOLD_PX && Math.abs(deltaY) < AXIS_LOCK_THRESHOLD_PX) {
        return;
      }
      axisLocked = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
    }
    // Vertical-dominant for this gesture — never preventDefault, never
    // commit, for the rest of it (the browser/underlying scroller owns it).
    if (axisLocked === "vertical") return;

    if (event.cancelable) event.preventDefault();

    if (deltaX * commitDirection >= COMMIT_THRESHOLD_PX) {
      committed = true;
      onCommit();
    }
  };

  const onTouchEnd = () => reset();

  element.addEventListener("touchstart", onTouchStart);
  element.addEventListener("touchmove", onTouchMove, { passive: false });
  element.addEventListener("touchend", onTouchEnd);
  element.addEventListener("touchcancel", onTouchEnd);

  return () => {
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("touchcancel", onTouchEnd);
  };
}
