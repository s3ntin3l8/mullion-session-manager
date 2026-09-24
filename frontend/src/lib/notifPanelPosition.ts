// Matches .notif-panel's CSS width (terminal.css) and its `max-width:
// calc(100vw - 16px)` phone floor.
const PANEL_WIDTH_PX = 380;
const VIEWPORT_MARGIN_PX = 8;

/** Anchors the panel under the bell, but clamped so it never runs past the
 * viewport's right edge — left-anchored at the bell, a 380px panel used to
 * overflow every phone screen (and let the page pan sideways). */
export function panelPosition(
  rect: Pick<DOMRect, "bottom" | "left">,
  viewportWidth: number,
): { top: number; left: number } {
  const width = Math.min(PANEL_WIDTH_PX, viewportWidth - 2 * VIEWPORT_MARGIN_PX);
  const maxLeft = viewportWidth - width - VIEWPORT_MARGIN_PX;
  return {
    top: rect.bottom + 6,
    left: Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.left, maxLeft)),
  };
}
