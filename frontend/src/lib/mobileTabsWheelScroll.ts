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
  // Read all three geometry values into locals BEFORE either classList
  // write below (Hermes review) — toggling "at-start" first, then reading
  // scrollLeft/clientWidth/scrollWidth again for "at-end", interleaves a
  // style write between two geometry reads, forcing the browser to flush
  // layout twice instead of once. Matters here specifically because this
  // runs on every `scroll` event, i.e. potentially every frame of momentum
  // scrolling.
  const { scrollLeft, clientWidth, scrollWidth } = element;
  element.classList.toggle("at-start", scrollLeft <= 0);
  element.classList.toggle("at-end", scrollLeft + clientWidth >= scrollWidth - AT_END_EPSILON_PX);
}

/** Keeps `.at-start`/`.at-end` classes on `element` in sync with its scroll
 * position — set on attach, and re-evaluated on three independent signals,
 * each catching a change the others can't:
 *  - `scroll` (passive: the fade classes are pure CSS reads, nothing here
 *    needs to block the native scroll) — the user actually scrolling.
 *  - `ResizeObserver` on `element` itself — a CONTAINER size change (device
 *    rotation, the sidebar resizing, ...) that alters `clientWidth`.
 *  - `MutationObserver({ childList: true, subtree: true, characterData:
 *    true })` on `element` — a tab added/removed, OR a tab's own content
 *    changing width (a title getting longer, or the bar's own rename flow
 *    swapping a tab's label for an `<input>` — App.tsx's mobile-tab-wrap
 *    rename UI). `subtree`/`characterData` are load-bearing, not
 *    redundant: a plain `{childList: true}` on `element` only sees ITS OWN
 *    direct children change, not a grandchild inside a `.mobile-tab-wrap`
 *    (Hermes review, PR #1224 — reproduced in jsdom: swapping a tab's
 *    label for the rename input grows `scrollWidth` 400→460 with zero
 *    fires from a childList-only observer). Also not redundant with the
 *    ResizeObserver above: verified in real Chromium that adding tabs
 *    grows `scrollWidth` with ZERO ResizeObserver fires, since `element`'s
 *    OWN box (what a ResizeObserver on it actually watches) never changes
 *    when clipped overflow content grows — only `clientWidth`/`offsetWidth`
 *    do that, and those are exactly what stays fixed here. Without either
 *    piece, `.at-end` can go stale while already scrolled to the end, and
 *    only self-heals if something else happens to scroll the bar (e.g.
 *    the active-tab `scrollIntoView` in App.tsx — which a tab opened by
 *    another client/process, or a rename by that tab's own session, never
 *    triggers).
 * All three are torn down together by the returned cleanup. */
export function attachMobileTabsEdgeState(element: HTMLElement): () => void {
  updateMobileTabsEdgeState(element);

  const handleScroll = () => updateMobileTabsEdgeState(element);
  element.addEventListener("scroll", handleScroll, { passive: true });

  const resizeObserver = new ResizeObserver(() => updateMobileTabsEdgeState(element));
  resizeObserver.observe(element);

  const mutationObserver = new MutationObserver(() => updateMobileTabsEdgeState(element));
  mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });

  return () => {
    element.removeEventListener("scroll", handleScroll);
    resizeObserver.disconnect();
    mutationObserver.disconnect();
  };
}
