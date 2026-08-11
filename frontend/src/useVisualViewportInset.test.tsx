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

// A minimal fake visualViewport — real EventTarget so addEventListener/
// removeEventListener/dispatchEvent all behave like the browser API this
// stands in for, rather than hand-rolling a listener registry.
class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop: number;
  constructor(height: number, offsetTop = 0) {
    super();
    this.height = height;
    this.offsetTop = offsetTop;
  }
  resizeTo(height: number, offsetTop = 0) {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event("resize"));
  }
}

function Harness() {
  const inset = useVisualViewportInset();
  return <div data-testid="inset">{inset}</div>;
}

// Independent code review, PR #615 — the hook reads
// document.documentElement.clientHeight (the box .app's fixed positioning is
// actually sized against), not window.innerHeight, specifically because the
// two aren't reliably equal on mobile Safari. Setting clientHeight here
// rather than innerHeight is the point of these tests, not an arbitrary
// choice — see stubClientHeight's own comment and the "distinguishes
// clientHeight from innerHeight" case below, which would fail if the hook
// ever regressed back to reading innerHeight.
function stubClientHeight(value: number) {
  Object.defineProperty(document.documentElement, "clientHeight", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  // @ts-expect-error — simulating "no visualViewport support" between tests;
  // restored per-test by whichever ones need it, same as before.
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
});

describe("useVisualViewportInset", () => {
  it("is 0 when window.visualViewport is unavailable", () => {
    // @ts-expect-error — simulating a browser with no visualViewport support
    delete window.visualViewport;
    const { getByTestId } = render(<Harness />);
    expect(getByTestId("inset").textContent).toBe("0");
  });

  it("is 0 when the visual viewport matches the layout viewport (keyboard closed)", async () => {
    stubClientHeight(800);
    Object.defineProperty(window, "visualViewport", {
      value: new FakeVisualViewport(800, 0),
      configurable: true,
    });
    const { getByTestId } = render(<Harness />);
    await act(flushRaf);
    expect(getByTestId("inset").textContent).toBe("0");
  });

  it("reports the keyboard's height as clientHeight - (visualViewport.height + offsetTop)", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(500, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    const { getByTestId } = render(<Harness />);
    await act(flushRaf);
    // 800 - (500 + 0) = 300px of keyboard.
    expect(getByTestId("inset").textContent).toBe("300");
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
    const { getByTestId } = render(<Harness />);
    await act(flushRaf);
    // clientHeight (700) matches visualViewport.height (700) exactly — 0 if
    // the hook reads clientHeight, but 100 (800 - 700) if it still reads the
    // stale innerHeight.
    expect(getByTestId("inset").textContent).toBe("0");
  });

  it("updates when visualViewport fires resize (keyboard opening/closing)", async () => {
    stubClientHeight(800);
    const vv = new FakeVisualViewport(800, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    const { getByTestId } = render(<Harness />);
    await act(flushRaf);
    expect(getByTestId("inset").textContent).toBe("0");

    act(() => vv.resizeTo(500, 0));
    await act(flushRaf);
    expect(getByTestId("inset").textContent).toBe("300");

    act(() => vv.resizeTo(800, 0));
    await act(flushRaf);
    expect(getByTestId("inset").textContent).toBe("0");
  });

  it("never goes negative", async () => {
    stubClientHeight(800);
    // A visual viewport taller than the layout viewport shouldn't happen in
    // practice, but the hook clamps defensively rather than reporting a
    // negative inset that would grow .app past its own bounds.
    const vv = new FakeVisualViewport(900, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    const { getByTestId } = render(<Harness />);
    await act(flushRaf);
    expect(getByTestId("inset").textContent).toBe("0");
  });
});
