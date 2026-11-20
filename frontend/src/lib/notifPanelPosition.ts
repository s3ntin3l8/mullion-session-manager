// Matches .notif-panel's CSS width (terminal.css) and its `max-width:
// calc(100vw - 16px)` phone floor.
const PANEL_WIDTH_PX = 380;
const VIEWPORT_MARGIN_PX = 8;

/** Anchors the panel under the bell, but clamped so it never runs past the
 * viewport's right edge — left-anchored at the bell, a 380px panel used to
 * overflow every phone screen (and let the page pan sideways). */
export type NotifPanelPosition = { top: number; left: number } | { bottom: number; left: number };

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

/** The left rail's bell (#3009) sits at the bottom of the screen, so the panel
 * opens beside it, its bottom edge level with the bell's, and grows upward.
 * Clamped like panelPosition so a narrow window never pushes it off-screen. */
export function railPanelPosition(
  rect: Pick<DOMRect, "bottom" | "right">,
  viewportWidth: number,
  viewportHeight: number,
): { bottom: number; left: number } {
  const width = Math.min(PANEL_WIDTH_PX, viewportWidth - 2 * VIEWPORT_MARGIN_PX);
  const maxLeft = viewportWidth - width - VIEWPORT_MARGIN_PX;
  return {
    bottom: Math.max(VIEWPORT_MARGIN_PX, viewportHeight - rect.bottom),
    left: Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.right + 6, maxLeft)),
  };
}
