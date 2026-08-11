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

afterEach(() => {
  cleanup();
  // @ts-expect-error — restoring to the jsdom default (undefined isn't it,
  // but nothing else in this file depends on the exact shape once torn down)
  delete window.visualViewport;
});

describe("useVisualViewportInset", () => {
  it("is 0 when window.visualViewport is unavailable", () => {
    // @ts-expect-error — simulating a browser with no visualViewport support
    delete window.visualViewport;
    const { getByTestId } = render(<Harness />);
    expect(getByTestId("inset").textContent).toBe("0");
  });

  it("is 0 when the visual viewport matches the layout viewport (keyboard closed)", async () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "visualViewport", {
      value: new FakeVisualViewport(800, 0),
      configurable: true,
    });
    const { getByTestId } = render(<Harness />);
    await act(flushRaf);
    expect(getByTestId("inset").textContent).toBe("0");
  });

  it("reports the keyboard's height as innerHeight - (visualViewport.height + offsetTop)", async () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const vv = new FakeVisualViewport(500, 0);
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    const { getByTestId } = render(<Harness />);
    await act(flushRaf);
    // 800 - (500 + 0) = 300px of keyboard.
    expect(getByTestId("inset").textContent).toBe("300");
  });

  it("updates when visualViewport fires resize (keyboard opening/closing)", async () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
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
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
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
