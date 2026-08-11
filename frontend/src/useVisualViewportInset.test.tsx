// @vitest-environment jsdom
//
// jsdom (not the default "node" environment — see vitest.config.ts's own
// comment) because the hook coalesces via requestAnimationFrame, same
// reasoning as terminalRepaintRegistry.test.ts's own header comment.
import { describe, it, expect, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { useVisualViewportInset } from "./useVisualViewportInset.js";

/** Awaits the next animation frame — the hook's own update() is
 * rAF-coalesced, so every test needs to yield to it before asserting. */
function flushRaf(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** Reads the CSS custom property the hook writes directly to
 * document.documentElement.style — the hook itself has no return value
 * (Hermes review, PR #615 round 2: no React state, no re-renders), so this
 * is the only way to observe what it did. */
function kbInset(): string {
  return document.documentElement.style.getPropertyValue("--kb-inset");
}

// A minimal fake visualViewport — real EventTarget so addEventListener/
// removeEventListener/dispatchEvent all behave like the browser API this
// stands in for, rather than hand-rolling a listener registry.
class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop: number;
  scale: number;
  constructor(height: number, offsetTop = 0, scale = 1) {
    super();
    this.height = height;
    this.offsetTop = offsetTop;
    this.scale = scale;
  }
  resizeTo(height: number, offsetTop = 0, scale = 1) {
    this.height = height;
    this.offsetTop = offsetTop;
    this.scale = scale;
    this.dispatchEvent(new Event("resize"));
  }
}

function Harness() {
  useVisualViewportInset();
  return null;
}

function stubClientHeight(value: number) {
  Object.defineProperty(document.documentElement, "clientHeight", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  // @ts-expect-error — simulating "no visualViewport support" between tests;
  // restored per-test by whichever ones need it.
  delete window.visualViewport;
  // stubClientHeight defines an own-property directly on documentElement,
  // shadowing the real getter on Element.prototype (verified against
  // jsdom's own prototype chain — clientHeight lives there, not on
  // Document.prototype). `delete` here removes that shadow so the next
  // test starts from the prototype's real getter again, rather than
  // leaking the previous test's fixed value into whichever test runs next
  // in this file.
  // @ts-expect-error — same pattern as the visualViewport delete above.
  delete document.documentElement.clientHeight;
  document.documentElement.style.removeProperty("--kb-inset");
});

describe("useVisualViewportInset", () => {
  it("does not throw and sets no property when window.visualViewport is unavailable", () => {
    // @ts-expect-error — simulating a browser with no visualViewport support
    delete window.visualViewport;
    render(<Harness />);
    expect(kbInset()).toBe("");
  });

  it("is 0px when the visual viewport matches the layout viewport (keyboard closed)", async () => {
    stubClientHeight(800);
    Object.defineProperty(window, "visualViewport", {
      value: new FakeVisualViewport(800, 0),
      configurable: true,
    });
    render(<Harness />);
    await act(flushRaf);
    expect(kbInset()).toBe("0px");
  });

  it("reports the keyboard's height as clientHeight - (visualViewport.height + offsetTop)", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(500, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(<Harness />);
    await act(flushRaf);
    // 800 - (500 + 0) = 300px of keyboard.
    expect(kbInset()).toBe("300px");
  });

  // The regression this guards against: mobile Safari's innerHeight and
  // clientHeight diverge as the address bar collapses/expands (the same
  // quirk dvh/svh/lvh CSS units exist to work around) — reading innerHeight
  // here risked reporting a phantom keyboard inset with no keyboard open at
  // all. Deliberately sets them to different values so this fails if the
  // hook is ever changed back to window.innerHeight.
  it("uses clientHeight, not innerHeight, as the reference height", async () => {
    stubClientHeight(700);
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const vv = new FakeVisualViewport(700, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(<Harness />);
    await act(flushRaf);
    // clientHeight (700) matches visualViewport.height (700) exactly — 0px
    // if the hook reads clientHeight, but 100px (800 - 700) if it still
    // reads the stale innerHeight.
    expect(kbInset()).toBe("0px");
  });

  it("updates when visualViewport fires resize (keyboard opening/closing)", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(800, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(<Harness />);
    await act(flushRaf);
    expect(kbInset()).toBe("0px");

    act(() => vv.resizeTo(500, 0));
    await act(flushRaf);
    expect(kbInset()).toBe("300px");

    act(() => vv.resizeTo(800, 0));
    await act(flushRaf);
    expect(kbInset()).toBe("0px");
  });

  it("never goes negative", async () => {
    stubClientHeight(800);
    // A visual viewport taller than the layout viewport shouldn't happen in
    // practice, but the hook clamps defensively rather than reporting a
    // negative inset that would grow .app past its own bounds.
    const vv = new FakeVisualViewport(900, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(<Harness />);
    await act(flushRaf);
    expect(kbInset()).toBe("0px");
  });

  // Hermes review, PR #615 round 2 — pinch-zoom shrinks visualViewport.height
  // (and can move offsetTop) with no keyboard involved; without this guard
  // the hook would misread a zoom gesture as a keyboard opening and shrink
  // .app. Skips (doesn't zero) the update while zoomed, so a keyboard that
  // was genuinely open before the zoom started keeps its own last-known-good
  // inset rather than being erased mid-gesture.
  it("ignores visualViewport changes while pinch-zoomed (scale !== 1)", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(500, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    render(<Harness />);
    await act(flushRaf);
    expect(kbInset()).toBe("300px");

    // Pinch-zoom shrinks the visual viewport further with scale !== 1 — the
    // real keyboard inset (300px) must be left untouched, not overwritten
    // with whatever this zoomed height would otherwise compute to.
    act(() => vv.resizeTo(300, 0, 1.5));
    await act(flushRaf);
    expect(kbInset()).toBe("300px");

    // Zooming back out (scale returns to 1) resumes real updates.
    act(() => vv.resizeTo(800, 0, 1));
    await act(flushRaf);
    expect(kbInset()).toBe("0px");
  });
});
