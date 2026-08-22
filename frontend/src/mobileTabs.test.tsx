// @vitest-environment jsdom
import { useEffect, useRef } from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

// Mirrors App.tsx's .mobile-tabs wheel handling: a manually-attached,
// non-passive native `wheel` listener (not a JSX `onWheel` prop) — React
// registers JSX onWheel handlers as passive, so preventDefault() called from
// one is a silent no-op in real browsers.
function MobileTabs() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      el.scrollLeft += delta;
      e.preventDefault();
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <div className="mobile-tabs" ref={ref}>
      <button className="mobile-tab">Tab 1</button>
      <button className="mobile-tab">Tab 2</button>
    </div>
  );
}

function dispatchWheel(el: HTMLDivElement, deltaY: number, deltaMode = 0) {
  const event = new Event("wheel", { bubbles: true, cancelable: true }) as WheelEvent;
  Object.defineProperty(event, "deltaY", { value: deltaY });
  Object.defineProperty(event, "deltaMode", { value: deltaMode });
  el.dispatchEvent(event);
  return event;
}

describe("Mobile Tabs horizontal scrolling", () => {
  it("translates vertical wheel events into horizontal scrollLeft adjustments", () => {
    const { container } = render(<MobileTabs />);
    const tabsContainer = container.querySelector(".mobile-tabs") as HTMLDivElement;
    expect(tabsContainer).not.toBeNull();
    tabsContainer.scrollLeft = 0;

    dispatchWheel(tabsContainer, 40);
    expect(tabsContainer.scrollLeft).toBe(40);

    dispatchWheel(tabsContainer, -20);
    expect(tabsContainer.scrollLeft).toBe(20);
  });

  it("scales line-mode wheel deltas instead of applying them as pixels", () => {
    const { container } = render(<MobileTabs />);
    const tabsContainer = container.querySelector(".mobile-tabs") as HTMLDivElement;
    tabsContainer.scrollLeft = 0;

    // deltaMode 1 = DOM_DELTA_LINE; a 3-line wheel tick should not collapse
    // to a near-imperceptible 3px scroll.
    dispatchWheel(tabsContainer, 3, 1);
    expect(tabsContainer.scrollLeft).toBe(48);
  });

  it("prevents the default vertical scroll so the ancestor doesn't also page-scroll", () => {
    const { container } = render(<MobileTabs />);
    const tabsContainer = container.querySelector(".mobile-tabs") as HTMLDivElement;

    const event = dispatchWheel(tabsContainer, 40);
    expect(event.defaultPrevented).toBe(true);
  });
});
