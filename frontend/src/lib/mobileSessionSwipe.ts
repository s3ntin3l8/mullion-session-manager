// Horizontal travel (px) a swipe on MobileSessionSwitcher's trigger needs
// to switch sessions.
export const SWIPE_COMMIT_PX = 48;

// How long after a committed swipe a click on the trigger is treated as that
// swipe's own trailing click (and ignored) rather than a tap.
export const SWIPE_CLICK_SUPPRESS_MS = 400;

/** Next/previous item id for a swipe, wrapping at both ends. Swiping left
 * (negative dx) moves forward, like paging through cards. */
export function swipeTargetId(
  items: readonly { id: string }[],
  activeId: string | null,
  dx: number,
): string | null {
  if (items.length < 2) return null;
  const index = items.findIndex((item) => item.id === activeId);
  if (index === -1) return null;
  const step = dx < 0 ? 1 : -1;
  return items[(index + step + items.length) % items.length].id;
}
