// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { attachMobileTabsWheelScroll } from "./mobileTabsWheelScroll.js";

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
