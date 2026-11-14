// How an overlay that is not dragged (a menu, a popover, a dialog) leaves the
// way it came (docs/motion.md, "Things leave the way they came").
//
// The look lives in CSS: styles/motion.css plays an exit when the overlay
// carries `data-presence="leaving"`, from the motion tokens. What lives here is
// only the question "when may it unmount?", and the answer is the animations
// themselves: once the leaving attribute is on, the overlay waits for every
// finite, clock-driven animation in its subtree to finish. Nothing here knows
// how long an exit is (only a safety net, far past it), and there is no
// transition-end event, which the reduced-motion reset in tokens.css never
// fires.
//
// Nothing to wait for means "unmount now", synchronously:
// - reduced motion (the reset shortens CSS animations to 0.01ms anyway; this
//   skips even that frame, so the overlay simply goes);
// - no `getAnimations` (jsdom), the same rule BottomSheet follows for its
//   spring: where nothing animates, an overlay opens and closes exactly as it
//   did before it moved;
// - an overlay with no running exit (display: none, a stylesheet without one).

import { MOTION_LAYOUT_MS, prefersReducedMotion } from "./motion.js";

/** The attribute styles/motion.css keys every enter and exit on. */
export const PRESENCE_ATTR = "data-presence";
export type PresenceState = "open" | "leaving";

/**
 * Whether an exit can play at all here: an environment with Web Animations
 * introspection and no reduced-motion request. Checked before the leaving
 * attribute goes on, so a caller that cannot animate closes synchronously.
 */
export function canPlayExit(): boolean {
  if (typeof Element === "undefined") return false;
  if (typeof Element.prototype.getAnimations !== "function") return false;
  return !prefersReducedMotion();
}

/**
 * The longest an exit is waited on, whatever the animations say: a safety net,
 * not the exit's length (that comes from the stylesheet). An exit runs over
 * --motion-fade; this is the longest motion token, well past it. Without it,
 * an animation that never finishes (paused, or one a future stylesheet adds)
 * would leave an overlay mounted and invisible, and a dialog's `onClose`
 * would never be called.
 */
export const EXIT_SAFETY_MS = MOTION_LAYOUT_MS;

/** Driven by the clock, not by a scroll position (a scroll-timeline animation
 * only "finishes" when the user scrolls, so it must not be waited on). */
function onTheClock(animation: Animation): boolean {
  const timeline = animation.timeline;
  if (!timeline || typeof DocumentTimeline === "undefined") return true;
  return timeline instanceof DocumentTimeline;
}

/**
 * Resolves once every finite, clock-driven animation on `el` and its subtree
 * has finished, or `null` when there is nothing to wait for (see the header
 * comment). Not waited on: an infinite animation inside the overlay (a
 * spinner, a pulsing status dot) and a scroll-driven one (the soft edge of a
 * list), neither of which finishes on its own. Resolves after
 * `EXIT_SAFETY_MS` at the latest.
 *
 * Settles on cancel too (a cancelled animation rejects `finished`): the
 * caller decides from its own state whether that still means "gone". A
 * reopen while leaving cancels the exit, and the caller has already stopped
 * listening by then.
 */
export function exitFinished(el: Element | null | undefined): Promise<void> | null {
  if (!el || !canPlayExit()) return null;
  const running = el
    .getAnimations({ subtree: true })
    .filter((a) => onTheClock(a) && (a.effect?.getTiming().iterations ?? 1) !== Infinity);
  if (running.length === 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = Promise.allSettled(running.map((a) => a.finished)).then(() => undefined);
  const safety = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, EXIT_SAFETY_MS);
  });
  // An exit that finishes normally does not leave the safety timer pending.
  return Promise.race([finished, safety]).finally(() => clearTimeout(timer));
}
