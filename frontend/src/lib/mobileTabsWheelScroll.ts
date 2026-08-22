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
