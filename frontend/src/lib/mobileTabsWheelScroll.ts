// React registers its onWheel/onTouchMove JSX handlers as passive listeners,
// so calling preventDefault() from a plain `onWheel` prop is a silent no-op
// in real browsers — the synthetic event reports defaultPrevented=true but
// the underlying native event doesn't, and the page still scrolls vertically
// underneath the tab bar. Attaching the listener manually with
// { passive: false } is the only way to actually stop that propagation.

// deltaMode 1 ("line") reports small integer deltas, not pixels; scale up so
// wheel scrolling isn't imperceptible.
const LINE_DELTA_PX = 16;

export function attachMobileTabsWheelScroll(element: HTMLElement): () => void {
  const handleWheel = (event: WheelEvent) => {
    if (!event.deltaY) return;
    // Only intervene when the bar actually overflows horizontally —
    // otherwise this would permanently block vertical page scroll over a
    // tab bar with nothing to scroll.
    if (element.scrollWidth <= element.clientWidth) return;
    const delta = event.deltaMode === 1 ? event.deltaY * LINE_DELTA_PX : event.deltaY;
    element.scrollLeft += delta;
    event.preventDefault();
  };

  element.addEventListener("wheel", handleWheel, { passive: false });
  return () => element.removeEventListener("wheel", handleWheel);
}

// Issue #960 (Hermes review, PR #1224) — the right-edge fade correctly goes
// invisible once there's nothing left to scroll TO (it sits past the last
// tab, in empty track, so it blends into the bar's own background), but the
// left-edge fade is the FIRST flex item, so it always overlaps the leading
// ~24px of tab 1 regardless of scroll position — including at rest, with
// nothing to scroll to on that side at all. Sticky positioning alone can't
// distinguish "at the very start" from "scrolled partway"; these two classes
// close that gap, and sidebar.css keys each edge's opacity off them.
// 1px epsilon on the "at end" check absorbs the same kind of sub-pixel
// rounding a real (non-integer-DPR) layout can produce between scrollLeft +
// clientWidth and scrollWidth.
const AT_END_EPSILON_PX = 1;

function updateMobileTabsEdgeState(element: HTMLElement): void {
  element.classList.toggle("at-start", element.scrollLeft <= 0);
  element.classList.toggle(
    "at-end",
    element.scrollLeft + element.clientWidth >= element.scrollWidth - AT_END_EPSILON_PX,
  );
}

/** Keeps `.at-start`/`.at-end` classes on `element` in sync with its scroll
 * position — set on attach, and re-evaluated on `scroll` (passive: the fade
 * classes are pure CSS reads, nothing here needs to block the native
 * scroll) and on any `ResizeObserver` fire (a tab added/removed changes
 * `scrollWidth` without necessarily firing `scroll`). Both listeners are
 * torn down together by the returned cleanup. */
export function attachMobileTabsEdgeState(element: HTMLElement): () => void {
  updateMobileTabsEdgeState(element);

  const handleScroll = () => updateMobileTabsEdgeState(element);
  element.addEventListener("scroll", handleScroll, { passive: true });

  const observer = new ResizeObserver(() => updateMobileTabsEdgeState(element));
  observer.observe(element);

  return () => {
    element.removeEventListener("scroll", handleScroll);
    observer.disconnect();
  };
}
