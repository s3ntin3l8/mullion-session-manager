// Where the left rail's workspace list opens as a popover (#3009).

const VIEWPORT_MARGIN_PX = 8;
const POPOVER_WIDTH_PX = 280;
const MAX_HEIGHT_PX = 520;

/** Beside the chip, top edges level, clamped into the viewport. The list
 * grows downward and scrolls inside its own max height. */
export function chipPopoverPosition(
  rect: Pick<DOMRect, "top" | "right">,
  viewportWidth: number,
  viewportHeight: number,
): { top: number; left: number; maxHeight: number } {
  const width = Math.min(POPOVER_WIDTH_PX, viewportWidth - 2 * VIEWPORT_MARGIN_PX);
  const left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(rect.right + 6, viewportWidth - width - VIEWPORT_MARGIN_PX),
  );
  // Keep at least 240px of list on screen, even for a chip low on the rail.
  const top = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(rect.top, viewportHeight - 240 - VIEWPORT_MARGIN_PX),
  );
  // A cap too, so a long list on a tall window scrolls instead of filling it.
  return {
    top,
    left,
    maxHeight: Math.min(MAX_HEIGHT_PX, viewportHeight - top - VIEWPORT_MARGIN_PX),
  };
}
