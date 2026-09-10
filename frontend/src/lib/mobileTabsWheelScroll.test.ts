// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { attachMobileTabsWheelScroll, attachMobileTabsEdgeState } from "./mobileTabsWheelScroll.js";

function setOverflowing(el: HTMLElement, overflowing: boolean) {
  Object.defineProperty(el, "scrollWidth", { value: overflowing ? 400 : 100, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 100, configurable: true });
}

function dispatchWheel(el: HTMLElement, deltaY: number, deltaMode = 0) {
  const event = new Event("wheel", { bubbles: true, cancelable: true }) as WheelEvent;
  Object.defineProperty(event, "deltaY", { value: deltaY });
  Object.defineProperty(event, "deltaMode", { value: deltaMode });
  el.dispatchEvent(event);
  return event;
}

describe("attachMobileTabsWheelScroll", () => {
  let el: HTMLDivElement;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    setOverflowing(el, true);
  });

  it("translates vertical wheel events into horizontal scrollLeft adjustments", () => {
    const detach = attachMobileTabsWheelScroll(el);
    el.scrollLeft = 0;

    dispatchWheel(el, 40);
    expect(el.scrollLeft).toBe(40);

    dispatchWheel(el, -20);
    expect(el.scrollLeft).toBe(20);

    detach();
  });

  it("scales line-mode wheel deltas instead of applying them as pixels", () => {
    const detach = attachMobileTabsWheelScroll(el);
    el.scrollLeft = 0;

    // deltaMode 1 = DOM_DELTA_LINE; a 3-line wheel tick should not collapse
    // to a near-imperceptible 3px scroll.
    dispatchWheel(el, 3, 1);
    expect(el.scrollLeft).toBe(48);

    detach();
  });

  it("prevents the default vertical scroll so the ancestor doesn't also page-scroll", () => {
    const detach = attachMobileTabsWheelScroll(el);

    const event = dispatchWheel(el, 40);
    expect(event.defaultPrevented).toBe(true);

    detach();
  });

  it("leaves vertical scroll alone when the bar doesn't overflow", () => {
    setOverflowing(el, false);
    const detach = attachMobileTabsWheelScroll(el);
    el.scrollLeft = 0;

    const event = dispatchWheel(el, 40);
    expect(event.defaultPrevented).toBe(false);
    expect(el.scrollLeft).toBe(0);

    detach();
  });

  it("stops reacting to wheel events once detached", () => {
    const detach = attachMobileTabsWheelScroll(el);
    detach();
    el.scrollLeft = 0;

    const event = dispatchWheel(el, 40);
    expect(event.defaultPrevented).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });
});

// Issue #960 (Hermes review, PR #1224) — a real Chromium render found the
// left fade always overlapping tab 1's leading edge even at rest, since
// sticky positioning alone can't tell "at the very start" from "scrolled
// partway". These classes are what sidebar.css keys the fade's opacity off.
describe("attachMobileTabsEdgeState", () => {
  let el: HTMLDivElement;
  // jsdom has no real ResizeObserver — stubbed to capture the callback so
  // tests can fire it manually, same shape as PaneTab.test.tsx's stub but
  // capturing (rather than discarding) the callback since this suite
  // exercises the observer firing, not just that observe()/disconnect()
  // don't throw.
  let resizeCallback: (() => void) | null;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    resizeCallback = null;
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function (this: unknown, callback: () => void) {
        resizeCallback = callback;
        // A real ResizeObserver stops notifying once disconnected — mirror
        // that here (rather than a bare `vi.fn()`) so the "stops reacting
        // once detached" test below is exercising realistic semantics, not
        // a stub that keeps firing after disconnect.
        return {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(() => (resizeCallback = null)),
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setScrollState(overrides: {
    scrollLeft?: number;
    scrollWidth?: number;
    clientWidth?: number;
  }) {
    if (overrides.scrollLeft !== undefined) {
      Object.defineProperty(el, "scrollLeft", { value: overrides.scrollLeft, configurable: true });
    }
    if (overrides.scrollWidth !== undefined) {
      Object.defineProperty(el, "scrollWidth", {
        value: overrides.scrollWidth,
        configurable: true,
      });
    }
    if (overrides.clientWidth !== undefined) {
      Object.defineProperty(el, "clientWidth", {
        value: overrides.clientWidth,
        configurable: true,
      });
    }
  }

  it("sets both at-start and at-end immediately when the bar doesn't overflow at all", () => {
    setScrollState({ scrollLeft: 0, scrollWidth: 100, clientWidth: 100 });
    const detach = attachMobileTabsEdgeState(el);

    expect(el.classList.contains("at-start")).toBe(true);
    expect(el.classList.contains("at-end")).toBe(true);

    detach();
  });

  it("is at-start only when scrolled to the very beginning of an overflowing bar", () => {
    setScrollState({ scrollLeft: 0, scrollWidth: 400, clientWidth: 100 });
    const detach = attachMobileTabsEdgeState(el);

    expect(el.classList.contains("at-start")).toBe(true);
    expect(el.classList.contains("at-end")).toBe(false);

    detach();
  });

  it("is neither at-start nor at-end when scrolled partway", () => {
    setScrollState({ scrollLeft: 0, scrollWidth: 400, clientWidth: 100 });
    const detach = attachMobileTabsEdgeState(el);

    setScrollState({ scrollLeft: 150 });
    el.dispatchEvent(new Event("scroll"));

    expect(el.classList.contains("at-start")).toBe(false);
    expect(el.classList.contains("at-end")).toBe(false);

    detach();
  });

  it("is at-end only once scrolled to the far end, tolerating sub-pixel rounding", () => {
    setScrollState({ scrollLeft: 0, scrollWidth: 400, clientWidth: 100 });
    const detach = attachMobileTabsEdgeState(el);

    // 300.5 + 99.5 = 400 exactly; a non-integer-DPR layout can land here.
    setScrollState({ scrollLeft: 300.5, clientWidth: 99.5 });
    el.dispatchEvent(new Event("scroll"));

    expect(el.classList.contains("at-start")).toBe(false);
    expect(el.classList.contains("at-end")).toBe(true);

    detach();
  });

  it("re-evaluates when the ResizeObserver fires, not just on scroll", () => {
    setScrollState({ scrollLeft: 0, scrollWidth: 400, clientWidth: 100 });
    const detach = attachMobileTabsEdgeState(el);
    expect(el.classList.contains("at-end")).toBe(false);

    // A tab was removed, e.g. a session closed — content now fits, so
    // scrollWidth shrinks to clientWidth, with no 'scroll' event involved.
    setScrollState({ scrollWidth: 100 });
    resizeCallback?.();

    expect(el.classList.contains("at-start")).toBe(true);
    expect(el.classList.contains("at-end")).toBe(true);

    detach();
  });

  // Hermes review, PR #1224 — verified in real Chromium that a
  // ResizeObserver on `.mobile-tabs` itself is a DEAD signal for a tab
  // being added: the container's own box (clientWidth) doesn't change when
  // clipped overflow content grows, only scrollWidth does, so adding 6
  // tabs produced zero ResizeObserver fires beyond the mandatory initial
  // one. jsdom implements a real (non-stubbed) MutationObserver, so this
  // test mutates the DOM for real rather than faking a callback.
  it("re-evaluates when a tab is added/removed (MutationObserver), which the ResizeObserver above provably can't see", async () => {
    setScrollState({ scrollLeft: 0, scrollWidth: 100, clientWidth: 100 });
    const detach = attachMobileTabsEdgeState(el);
    expect(el.classList.contains("at-end")).toBe(true);

    // A tab was added — scrollWidth grows, but clientWidth (what a
    // ResizeObserver on `el` watches) doesn't, so this is exercising the
    // MutationObserver path specifically.
    const tab = document.createElement("div");
    el.appendChild(tab);
    setScrollState({ scrollWidth: 250 });

    // MutationObserver callbacks fire as a microtask, not synchronously.
    await Promise.resolve();

    expect(el.classList.contains("at-end")).toBe(false);

    detach();
  });

  // Hermes review round 2, PR #1224 — reproduced with a custom jsdom probe:
  // a plain `{childList: true}` on `.mobile-tabs` only sees ITS OWN direct
  // children change, not a grandchild inside a `.mobile-tab-wrap` — exactly
  // what the bar's own rename flow does (App.tsx: swaps a tab's label for
  // an `<input>`) or a title growing longer. `subtree`/`characterData` are
  // what closes this.
  it("re-evaluates when a tab's OWN content changes (subtree), not just when a tab is added/removed", async () => {
    const wrap = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = "Short";
    wrap.appendChild(label);
    el.appendChild(wrap);
    setScrollState({ scrollLeft: 0, scrollWidth: 100, clientWidth: 100 });
    const detach = attachMobileTabsEdgeState(el);
    expect(el.classList.contains("at-end")).toBe(true);

    // Simulates the rename flow swapping the label for an <input> — a
    // childList change on `wrap` (a GRANDCHILD of `el`), not on `el`
    // itself.
    const input = document.createElement("input");
    wrap.replaceChild(input, label);
    setScrollState({ scrollWidth: 250 });
    await Promise.resolve();

    expect(el.classList.contains("at-end")).toBe(false);

    detach();
  });

  it("re-evaluates when a tab's text content grows (characterData), e.g. a title update", async () => {
    const wrap = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = "Short";
    wrap.appendChild(label);
    el.appendChild(wrap);
    setScrollState({ scrollLeft: 0, scrollWidth: 100, clientWidth: 100 });
    const detach = attachMobileTabsEdgeState(el);
    expect(el.classList.contains("at-end")).toBe(true);

    label.firstChild!.textContent = "A much longer session title than before";
    setScrollState({ scrollWidth: 250 });
    await Promise.resolve();

    expect(el.classList.contains("at-end")).toBe(false);

    detach();
  });

  it("stops reacting to scroll, resize, and DOM mutation once detached", async () => {
    setScrollState({ scrollLeft: 0, scrollWidth: 400, clientWidth: 100 });
    const detach = attachMobileTabsEdgeState(el);
    detach();

    setScrollState({ scrollLeft: 350 });
    el.dispatchEvent(new Event("scroll"));
    resizeCallback?.();
    el.appendChild(document.createElement("div"));
    await Promise.resolve();

    // Still reflects the state as of detach, not any post-detach change.
    expect(el.classList.contains("at-start")).toBe(true);
    expect(el.classList.contains("at-end")).toBe(false);
  });
});
