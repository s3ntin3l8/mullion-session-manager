// The house motion values (docs/motion.md), for code that animates from
// TypeScript (the spring in ./spring.ts, Web Animations calls). CSS uses the
// `--motion-*` tokens in styles/tokens.css; motion.test.ts pins the two copies
// to each other.

/** Press feedback: the scale and tint a control shows the moment it is touched. */
export const MOTION_PRESS_MS = 110;
/** A short fade: content arriving in place, and what travel becomes under reduced motion. */
export const MOTION_FADE_MS = 160;
/** A layout change that is not driven by a finger (a card moving to its new lane). */
export const MOTION_LAYOUT_MS = 420;
/** The house curve for anything that arrives and settles. */
export const MOTION_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** The curve for press feedback. */
export const MOTION_EASE_PRESS = "cubic-bezier(0, 0, 0.58, 1)";

/**
 * Whether the user has asked the OS to reduce motion. The one place the app
 * decides it: the spring jumps instead of travelling when this is true, and a
 * caller that wants a short fade in place of the travel asks here too.
 *
 * Read at call time, not cached, so a change to the OS setting applies to the
 * next animation without a reload.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
