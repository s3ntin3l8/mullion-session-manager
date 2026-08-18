import type { Terminal } from "@xterm/xterm";

// Mobile UI/UX overhaul follow-up — touch dragging over the terminal did
// nothing at all, so the gesture fell through to the browser's own
// pull-to-refresh instead of scrolling the scrollback.
//
// Root cause, verified against the installed @xterm/xterm (v6.0.0): v6
// replaced native overflow scrolling with a VS Code-derived synthetic
// `ScrollableElement`. It bundles VS Code's touch `Gesture` class, but
// `Gesture.addTarget()` is never called anywhere in the package and nothing
// listens for the `-xterm-gesturechange` event it would dispatch — the
// scrollable element only reacts to `wheel` and scrollbar drag. Touch drag
// is a genuine no-op in xterm itself, not a CSS problem.
//
// Deliberately calls `term.scrollLines()` rather than synthesizing a
// `WheelEvent` on the scrollable element: xterm's own `Viewport` tears down
// its wheel handling whenever the running program requests a mouse
// protocol (`onProtocolChange(c => updateOptions({ handleMouseWheel: !(c &
// 16) }))`), so a dispatched wheel event would scroll, get silently
// swallowed, or get forwarded to the PTY as mouse bytes depending on
// invisible TUI state. `scrollLines` is public, typed, and line-granular —
// see the two bail conditions below for how mouse-tracking and alt-screen
// TUIs are actually handled instead.
//
// No momentum/inertia by design: line-granular scrolling makes inertia
// visibly notchy, and an inertia animation would race live PTY output's own
// scroll-to-bottom-on-write behavior. Direct 1:1 finger-follow only.
//
// Attached unconditionally (not gated to the mobile breakpoint) — inert
// without touch events, and touchscreen laptops are real.
//
// Two accepted trade-offs, called out here so they read as decisions rather
// than surprises (Hermes review, PR #704): once a drag commits (i.e. has
// called preventDefault), the page owns the gesture for its duration, so
// adding a second finger mid-scroll can't start the browser's own
// pinch-zoom — a scroll and a pinch aren't composable mid-gesture either
// way, so there's no gesture this would need to hand off to. And once a
// two-finger touch resets tracking (the multi-touch abandonment below), a
// continuing single finger is ignored until the user fully lifts and
// re-touches, rather than resuming the scroll — simpler than trying to
// re-derive a clean baseline mid-gesture, at the cost of a beat of dead
// drag after an accidental second finger.

// A drag shorter than this is treated as a tap/jitter, not a scroll intent —
// keeps a tap-to-focus gesture from accidentally eating a couple of
// scrollback lines.
const MOVE_THRESHOLD_PX = 6;

function measureRowHeight(term: Terminal): number {
  // `.xterm-screen` is not public API, but both xterm renderers set an
  // explicit pixel height on it (DOM renderer directly; @xterm/addon-webgl
  // sets it on `core.screenElement` itself), so this is exact rather than
  // approximate wherever it's available. A v7 internal restructure would
  // degrade to the fallback below, not break.
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const measured = screen && term.rows > 0 ? screen.clientHeight / term.rows : 0;
  if (measured > 0) return measured;
  // jsdom (unit tests) and any environment that hasn't laid out yet report
  // clientHeight 0 — this fallback is the path those actually exercise, not
  // just a defensive guard.
  return (term.options.fontSize ?? 14) * (term.options.lineHeight ?? 1);
}

export function attachTerminalTouchScroll(params: {
  term: Terminal;
  element: HTMLElement;
}): () => void {
  const { term, element } = params;

  let tracking = false;
  let lastY = 0;
  let rowHeight = 0;
  let accumulatedLines = 0;
  let movedPastThreshold = false;

  const reset = () => {
    tracking = false;
    accumulatedLines = 0;
    movedPastThreshold = false;
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    // Bail without ever touching preventDefault — mouse-tracking TUIs (vim,
    // htop, ...) own drag gestures themselves once enabled, and forging SGR
    // mouse sequences from a touch would invent a semantics no TUI expects
    // (e.g. starting a visual-mode selection mid-scroll). Mirrors xterm's
    // own wheel-teardown behavior on mouse-protocol requests (see header).
    // Deliberately doesn't reset() on this path (or the alt-screen one
    // below): `tracking` still gates onTouchMove/onTouchEnd, and the next
    // valid touchstart overwrites lastY/rowHeight/accumulatedLines/
    // movedPastThreshold wholesale before they're read again.
    if (term.modes.mouseTrackingMode !== "none") return;
    // The alternate screen has no scrollback — scrollLines() would be a
    // silent no-op there, so there's nothing to bail *into*; translating
    // alt-screen drags into arrow keys for pager-likes is a possible future
    // enhancement, explicitly out of scope here.
    if (term.buffer.active.type === "alternate") return;

    tracking = true;
    lastY = event.touches[0].clientY;
    rowHeight = measureRowHeight(term);
    accumulatedLines = 0;
    movedPastThreshold = false;
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!tracking) return;
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    const currentY = event.touches[0].clientY;
    const deltaY = currentY - lastY;
    if (!movedPastThreshold) {
      if (Math.abs(deltaY) < MOVE_THRESHOLD_PX) return;
      movedPastThreshold = true;
    }
    lastY = currentY;

    if (event.cancelable) event.preventDefault();

    if (rowHeight <= 0) return;
    // Finger moving down the screen reveals earlier output, i.e. scrolls up
    // — scrollLines() takes negative to mean "scroll up" (xterm's own doc
    // comment), hence the negation.
    accumulatedLines += -deltaY / rowHeight;
    const wholeLines = Math.trunc(accumulatedLines);
    if (wholeLines !== 0) {
      term.scrollLines(wholeLines);
      accumulatedLines -= wholeLines;
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
