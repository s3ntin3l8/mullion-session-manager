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

  it("scrolls up (negative) when the finger drags down, once past the movement threshold", () => {
    const term = createFakeTerm();
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    // 14px fallback row height, threshold is 6px — 20px down covers both.
    container.dispatchEvent(touchEvent("touchmove", [{ clientY: 20 }]));

    expect(term.scrollLines).toHaveBeenCalledWith(-1);
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

  it("bails without scrolling or calling preventDefault when mouse tracking is active", () => {
    const term = createFakeTerm({ modes: { mouseTrackingMode: "vt200" } } as never);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    const move = touchEvent("touchmove", [{ clientY: 40 }]);
    const prevented = !container.dispatchEvent(move);

    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
    detach();
  });

  it("bails without scrolling on the alternate screen (no scrollback to scroll)", () => {
    const term = createFakeTerm({ buffer: { active: { type: "alternate" } } } as never);
    const detach = attachTerminalTouchScroll({ term, element: container });

    container.dispatchEvent(touchEvent("touchstart", [{ clientY: 0 }]));
    const move = touchEvent("touchmove", [{ clientY: 40 }]);
    const prevented = !container.dispatchEvent(move);

    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(prevented).toBe(false);
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
