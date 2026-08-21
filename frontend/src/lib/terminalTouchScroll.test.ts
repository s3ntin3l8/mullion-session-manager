// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachTerminalTouchScroll } from "./terminalTouchScroll.js";
import type { Terminal } from "@xterm/xterm";

// jsdom (v30 here) implements the `TouchEvent` constructor but not `Touch`,
// so a real `new TouchEvent(..., { touches: [new Touch(...)] })` throws.
// The handler under test only ever reads `touches[0].clientY`,
// `touches.length`, `cancelable`, and calls `preventDefault()` — a plain
// Event with those fields bolted on round-trips through dispatchEvent fine
// and keeps this test independent of jsdom's Touch support.
function touchEvent(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: { clientY: number }[],
  opts: { cancelable?: boolean } = {},
): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: opts.cancelable ?? true }), {
    touches,
  });
}

function createFakeTerm(overrides: Partial<Terminal> = {}) {
  const element = document.createElement("div");
  return {
    element,
    rows: 24,
    options: { fontSize: 14, lineHeight: 1 },
    modes: { mouseTrackingMode: "none" },
    buffer: { active: { type: "normal" } },
    scrollLines: vi.fn(),
    ...overrides,
  } as unknown as Terminal;
}

describe("attachTerminalTouchScroll", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  // No `.xterm-screen` element and jsdom's clientHeight is always 0, so
  // every test here exercises the fontSize*lineHeight fallback row height
  // (14px), not the (untestable-in-jsdom) measured one.

  it("scrolls up (negative) when the finger drags down, once past the movement threshold, and claims the gesture via preventDefault", () => {
    const term = createFakeTerm();
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    // 14px fallback row height, threshold is 6px — 20px down covers both.
    const move = touchEvent("touchmove", [{ clientY: 20 }]);
    const prevented = !container.dispatchEvent(move);

    expect(term.scrollLines).toHaveBeenCalledWith(-1);
    // The only thing stopping the browser from scrolling the phantom
    // .xterm-viewport (styles/xterm.css) on a committed drag — a regression
    // here would otherwise be silent under jsdom.
    expect(prevented).toBe(true);
    detach();
  });

  it("scrolls down (positive) when the finger drags up", () => {
    const term = createFakeTerm();
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 40 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 26 }]));

    expect(term.scrollLines).toHaveBeenCalledWith(1);
    detach();
  });

  it("accumulates fractional deltas across multiple small moves instead of dropping them", () => {
    const term = createFakeTerm();
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    // Cross the threshold first (no scrollLines call expected yet: 7px / 14 < 1 line).
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 7 }]));
    expect(term.scrollLines).not.toHaveBeenCalled();
    // Another 7px down: 14px total accumulated => exactly one line.
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 14 }]));

    expect(term.scrollLines).toHaveBeenCalledTimes(1);
    expect(term.scrollLines).toHaveBeenCalledWith(-1);
    detach();
  });

  it("does not scroll or preventDefault for a sub-threshold move (tap jitter)", () => {
    const term = createFakeTerm();
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    const move = touchEvent("touchmove", [{ clientY: 3 }]);
    const prevented = !container.dispatchEvent(move);

    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
    detach();
  });

  // Mouse-tracking and alt-screen TUIs (Claude Code among them — see this
  // module's own header comment for the live-session evidence) get
  // scrollLines()'d nothing: there's no scrollback to move (alt-screen) or
  // the scrollback that matters lives inside the TUI, not xterm (mouse
  // tracking). A synthetic wheel event on term.element is the same input a
  // desktop mouse wheel already produces over the same session, and reaches
  // xterm's own wheel handler.
  it("dispatches a wheel event on term.element, not scrollLines, when mouse tracking is active", () => {
    const term = createFakeTerm({ modes: { mouseTrackingMode: "vt200" } } as never);
    const wheelListener = vi.fn();
    term.element!.addEventListener("wheel", wheelListener);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    // Finger drags down 40px — scrolls up, i.e. negative deltaY (same sign
    // convention as the scrollLines path's own negation).
    const move = touchEvent("touchmove", [{ clientY: 40 }]);
    const prevented = !container.dispatchEvent(move);

    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(wheelListener).toHaveBeenCalledTimes(1);
    expect((wheelListener.mock.calls[0]![0] as WheelEvent).deltaY).toBe(-40);
    // Committed once past the movement threshold, same as the scrollLines
    // path — the page must not also handle this drag (pull-to-refresh, a
    // background scroll) once xterm owns it.
    expect(prevented).toBe(true);
    detach();
  });

  // xterm's own consumeWheelEvent (CoreMouseService.ts) multiplies any
  // dispatched |deltaY| under 50 by 0.3 — a correction for trackpad
  // acceleration a synthetic touch delta has no equivalent of. Left
  // uncompensated this makes the whole gesture ~3.3x slower than the
  // scrollLines() path's own 1:1 rate (see this module's own
  // TRACKPAD_DAMPING_* comment). A 10px move (raw deltaY -10, magnitude
  // under 50*0.3=15) must be divided back out to -33.33 so that after
  // xterm's own 0.3x cut it nets back out to roughly the original -10.
  it("compensates the dispatched deltaY for xterm's own trackpad-damping heuristic on a small move", () => {
    const term = createFakeTerm({ modes: { mouseTrackingMode: "vt200" } } as never);
    const wheelListener = vi.fn();
    term.element!.addEventListener("wheel", wheelListener);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 10 }]));

    expect((wheelListener.mock.calls[0]![0] as WheelEvent).deltaY).toBeCloseTo(-10 / 0.3);
    detach();
  });

  // The compensation only applies while the corrected value would still
  // land under xterm's own 50px threshold (i.e. the original delta was
  // under 15) — past that, a single touchmove already covers enough
  // distance that xterm's heuristic doesn't dampen it either, so this
  // module must not pre-multiply it. 20px is past 15 (no compensation,
  // matches the existing 40px test above) but still under 50 (xterm itself
  // would still dampen it, just not by this module's own doing).
  it("does not compensate a move already past the compensation's own cutoff", () => {
    const term = createFakeTerm({ modes: { mouseTrackingMode: "vt200" } } as never);
    const wheelListener = vi.fn();
    term.element!.addEventListener("wheel", wheelListener);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 20 }]));

    expect((wheelListener.mock.calls[0]![0] as WheelEvent).deltaY).toBe(-20);
    detach();
  });

  // The whole reason mode is checked per-move (this module's own header
  // comment) rather than once at touchstart: a TUI can flip mouse tracking
  // or the alt-screen mid-gesture, and the dispatch target must follow.
  it("switches from wheel dispatch to scrollLines mid-drag when mouse tracking turns off", () => {
    const term = createFakeTerm({ modes: { mouseTrackingMode: "vt200" } } as never);
    const wheelListener = vi.fn();
    term.element!.addEventListener("wheel", wheelListener);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 40 }]));
    expect(wheelListener).toHaveBeenCalledTimes(1);
    expect(term.scrollLines).not.toHaveBeenCalled();

    (term.modes as unknown as { mouseTrackingMode: string }).mouseTrackingMode = "none";
    // 14px fallback row height, threshold is 6px — another 20px down covers
    // both and yields exactly one more line via the scrollLines path.
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 60 }]));

    expect(wheelListener).toHaveBeenCalledTimes(1);
    expect(term.scrollLines).toHaveBeenCalledWith(-1);
    detach();
  });

  it("switches from scrollLines to wheel dispatch mid-drag when the alt-screen activates", () => {
    const term = createFakeTerm();
    const wheelListener = vi.fn();
    term.element!.addEventListener("wheel", wheelListener);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 20 }]));
    expect(term.scrollLines).toHaveBeenCalledTimes(1);
    expect(wheelListener).not.toHaveBeenCalled();

    (term.buffer as unknown as { active: { type: string } }).active.type = "alternate";
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 40 }]));

    expect(term.scrollLines).toHaveBeenCalledTimes(1);
    expect(wheelListener).toHaveBeenCalledTimes(1);
    detach();
  });

  it("dispatches a wheel event with the opposite sign when the finger drags up", () => {
    const term = createFakeTerm({ modes: { mouseTrackingMode: "vt200" } } as never);
    const wheelListener = vi.fn();
    term.element!.addEventListener("wheel", wheelListener);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 40 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 0 }]));

    expect((wheelListener.mock.calls[0]![0] as WheelEvent).deltaY).toBe(40);
    detach();
  });

  it("dispatches a wheel event, not scrollLines, on the alternate screen (no scrollback to scroll)", () => {
    const term = createFakeTerm({ buffer: { active: { type: "alternate" } } } as never);
    const wheelListener = vi.fn();
    term.element!.addEventListener("wheel", wheelListener);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    const move = touchEvent("touchmove", [{ clientY: 40 }]);
    const prevented = !container.dispatchEvent(move);

    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(wheelListener).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
    detach();
  });

  it("does not dispatch a wheel event below the movement threshold on the alternate screen", () => {
    const term = createFakeTerm({ buffer: { active: { type: "alternate" } } } as never);
    const wheelListener = vi.fn();
    term.element!.addEventListener("wheel", wheelListener);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    const move = touchEvent("touchmove", [{ clientY: 3 }]);
    const prevented = !container.dispatchEvent(move);

    expect(wheelListener).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
    detach();
  });

  it("does not throw, and does not scroll, when term.element is undefined", () => {
    const term = createFakeTerm({
      buffer: { active: { type: "alternate" } },
      element: undefined,
    } as never);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    expect(() => container.dispatchEvent(touchEvent("touchmove", [{ clientY: 40 }]))).not.toThrow();

    expect(term.scrollLines).not.toHaveBeenCalled();
    detach();
  });

  it("abandons the gesture on a second touch (pinch) instead of scrolling", () => {
    const term = createFakeTerm();
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 0 }, { clientY: 100 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 40 }]));

    expect(term.scrollLines).not.toHaveBeenCalled();
    detach();
  });

  it("resets tracking state on touchcancel, same as touchend", () => {
    const term = createFakeTerm();
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchcancel", []));
    // A move after cancel, with no preceding touchstart for this gesture,
    // should be ignored entirely.
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 100 }]));

    expect(term.scrollLines).not.toHaveBeenCalled();
    detach();
  });

  it("stops handling events after detach", () => {
    const term = createFakeTerm();
    const detach = attachTerminalTouchScroll({ term, element: container });
    detach();

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 40 }]));

    expect(term.scrollLines).not.toHaveBeenCalled();
  });
});
