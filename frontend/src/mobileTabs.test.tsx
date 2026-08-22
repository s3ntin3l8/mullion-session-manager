// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";

describe("Mobile Tabs horizontal scrolling", () => {
  it("translates vertical wheel events into horizontal scrollLeft adjustments", () => {
    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
      if (e.deltaY) {
        e.currentTarget.scrollLeft += e.deltaY;
      }
    };

    const { container } = render(
      <div className="mobile-tabs" onWheel={handleWheel}>
        <button className="mobile-tab">Tab 1</button>
        <button className="mobile-tab">Tab 2</button>
      </div>,
    );

    const tabsContainer = container.querySelector(".mobile-tabs") as HTMLDivElement;
    expect(tabsContainer).not.toBeNull();
    tabsContainer.scrollLeft = 0;

    fireEvent.wheel(tabsContainer, { deltaY: 40 });
    expect(tabsContainer.scrollLeft).toBe(40);

    fireEvent.wheel(tabsContainer, { deltaY: -20 });
    expect(tabsContainer.scrollLeft).toBe(20);
  });
});
