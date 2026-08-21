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
// Two distinct dispatch paths, chosen per-move rather than once at
// touchstart (a TUI can flip mouse-tracking or the alt-screen mid-gesture):
//
// - Normal buffer, no mouse tracking: `term.scrollLines()` — public, typed,
//   line-granular, and moves the real scrollback directly.
// - Alt-screen and/or mouse-tracking TUIs (Claude Code among them — its own
//   tracked terminal state, read via this repo's Mullion scrollback-replay
//   preamble against a live session, is alt-screen + ANY-motion mouse
//   tracking + SGR encoding): `scrollLines()` is the wrong verb here. On the
//   alt-screen there is no scrollback for it to move — a silent no-op — and
//   under mouse tracking the scrollback the user actually wants lives
//   inside the TUI's own pager, not in xterm. A synthetic `WheelEvent`
//   dispatched on `term.element` is the same input a desktop mouse wheel
//   already produces over the same session, and reaches xterm's own single
//   `wheel` listener (`@xterm/xterm`'s installed `CoreBrowserTerminal`,
//   `_bindMouse`), which already handles exactly this branch: if the
//   running program requested wheel events (`CoreMouseEventType.WHEEL`),
//   they're encoded to mouse bytes in whatever protocol/encoding the
//   program asked for; otherwise, when `!buffer.hasScrollback` (the
//   alt-screen case), it synthesizes `ESC[A`/`ESC[B` (or `ESC O A`/`ESC O B`
//   under `applicationCursorKeys`) so pagers and TUIs scroll by line. xterm
//   picks the right behavior; this shim doesn't need to know which.
//   Deliberately raw pixel deltas (with one magnitude correction — see
//   TRACKPAD_DAMPING_* below), no notch-size accumulation of our own:
//   xterm's own `coreMouseService.consumeWheelEvent()` (both branches above
//   call it) already accumulates sub-cell deltas across calls via its own
//   `_wheelPartialScroll`, so re-accumulating here would double up.
//
// This dispatch never reaches `Viewport`'s own wheel handling (the actual
// scrollback-scrolling one, on the normal buffer) — not because
// `handleMouseWheel` happens to be false while a mouse protocol is active
// (that's true, but irrelevant to why this specific dispatch is safe: it
// would also need to hold on the alt-screen with mouse tracking OFF, where
// `handleMouseWheel` is true), but because `Viewport`'s own scrollable
// element is a DOM *descendant* of `term.element`, appended via
// `element.appendChild(this._scrollableElement.getDomNode())`
// (`@xterm/xterm`'s installed `Viewport`) — a `dispatchEvent` call only
// visits the target and its ancestors, never its descendants, so a
// descendant-only listener is structurally unreachable from a dispatch on
// `term.element` regardless of any option flag. Moving the dispatch target
// to `screenElement` (which the scrollable element wraps directly) would
// break this; dispatching on `term.element` specifically is load-bearing.
//
// No momentum/inertia by design: line-granular scrolling makes inertia
// visibly notchy, and an inertia animation would race live PTY output's own
// scroll-to-bottom-on-write behavior. Direct 1:1 finger-follow on the
// scrollLines() path; see TRACKPAD_DAMPING_* below for why the wheel-dispatch
// path needs one deliberate correction to also land at roughly 1:1, rather
// than the ~3.3x-slower rate it would otherwise get from a heuristic xterm
// applies for a different input device.
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
//
// `preventDefault` deliberately stays off `touchstart` in both paths: a
// sub-threshold move (a tap) must still produce the browser's own
// compatibility mouse events so a tap reaches the running program as a
// click, while only a drag that actually clears the movement threshold
// claims the gesture.

// A drag shorter than this is treated as a tap/jitter, not a scroll intent —
// keeps a tap-to-focus gesture from accidentally eating a couple of
// scrollback lines.
const MOVE_THRESHOLD_PX = 6;

// Verified against the installed @xterm/xterm v6.0.0
// (common/services/CoreMouseService.ts, consumeWheelEvent): any dispatched
// `deltaY` with magnitude under this threshold is treated as "likely a
// trackpad" and multiplied by TRACKPAD_DAMPING_FACTOR — a correction for
// OS-level trackpad acceleration (a real trackpad's own deltaY is already
// amplified relative to physical finger travel) that a raw synthetic touch
// delta has no equivalent of. Left uncompensated, a per-move touch delta
// (almost always well under this threshold) gets that same cut on every
// single dispatch, making the whole gesture ~1/TRACKPAD_DAMPING_FACTOR
// (≈3.3x) slower than the scrollLines() path's own 1:1 rate, for its entire
// typical range — not a one-off, since xterm's own `_wheelPartialScroll`
// accumulator persists the dampened amount across calls with no later
// correction. Divided back out below, but only while the compensated value
// would still land under this same threshold (i.e. the original delta was
// under THRESHOLD * FACTOR) — past that a single touchmove already covers
// enough physical distance in one frame that xterm's own heuristic no
// longer applies to it either, and pre-multiplying further would overshoot
// instead. These are unexported magic numbers from xterm's own internals,
// not a public API contract — re-verify against consumeWheelEvent's source
// on any @xterm/xterm upgrade.
const TRACKPAD_DAMPING_THRESHOLD_PX = 50;
const TRACKPAD_DAMPING_FACTOR = 0.3;

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

    // Checked per-move, not once at touchstart — the running program can
    // flip mouse tracking or enter/exit the alt-screen mid-drag (see this
    // module's own header comment for why each state needs a different
    // dispatch target). Claiming the gesture via preventDefault above
    // applies uniformly to both paths: once committed, a touch-drag over a
    // mouse-tracking session is always captured as a wheel gesture rather
    // than left available for some other touch-driven interaction with the
    // program (e.g. a TUI using DRAG/ANY mouse mode for something other than
    // scrolling) — mobile browsers don't synthesize continuous compatibility
    // mousemove/mousedrag events from a touch anyway, so there was no such
    // interaction actually reachable through this gesture before this change
    // either.
    if (term.modes.mouseTrackingMode !== "none" || term.buffer.active.type === "alternate") {
      if (!term.element) return;
      // Finger moving down the screen reveals earlier output, i.e. scrolls
      // up — the DOM convention xterm's own wheel handler reads is negative
      // deltaY for "up" (CoreBrowserTerminal's `ev.deltaY < 0 ? 'A' : 'B'`),
      // the same sign this shim's scrollLines path below already uses,
      // hence the same negation.
      let wheelDeltaY = -deltaY;
      if (Math.abs(wheelDeltaY) < TRACKPAD_DAMPING_THRESHOLD_PX * TRACKPAD_DAMPING_FACTOR) {
        wheelDeltaY /= TRACKPAD_DAMPING_FACTOR;
      }
      term.element.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: wheelDeltaY,
          deltaMode: 0, // WheelEvent.DOM_DELTA_PIXEL
          bubbles: true,
          cancelable: true,
        }),
      );
      return;
    }

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
