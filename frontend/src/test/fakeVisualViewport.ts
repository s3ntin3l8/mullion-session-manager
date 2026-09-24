// A minimal fake window.visualViewport for jsdom tests (jsdom has none) —
// real EventTarget so addEventListener/removeEventListener/dispatchEvent all
// behave like the browser API this stands in for, rather than hand-rolling a
// listener registry. Shared by useVisualViewportInset's own tests and the
// portaled menus that follow a visual-viewport pan (issue #1399).
export class FakeVisualViewport extends EventTarget {
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
  /** An iOS pan with the keyboard open: only offsetTop moves. */
  panTo(offsetTop: number) {
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event("scroll"));
  }
}

/** Installs a fresh FakeVisualViewport as window.visualViewport. */
export function installFakeVisualViewport(height = 800, offsetTop = 0): FakeVisualViewport {
  const vv = new FakeVisualViewport(height, offsetTop);
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return vv;
}

/** Removes window.visualViewport — "no visualViewport support". */
export function uninstallFakeVisualViewport(): void {
  // @ts-expect-error — the real property is readonly; tests own it here.
  delete window.visualViewport;
}

/** Awaits the next animation frame — for rAF-coalesced listeners. */
export function flushRaf(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
