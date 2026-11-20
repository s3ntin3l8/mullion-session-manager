import { describe, it, expect } from "vitest";
import { panelPosition, railPanelPosition } from "./notifPanelPosition.js";

describe("panelPosition", () => {
  it("anchors under the bell when the panel fits", () => {
    expect(panelPosition({ bottom: 44, left: 60 }, 1280)).toEqual({ top: 50, left: 60 });
  });

  it("clamps left so a 380px panel never runs past a phone's right edge", () => {
    // 390px phone: panel shrinks to 374px (8px margins), so left clamps to 8.
    expect(panelPosition({ bottom: 44, left: 58 }, 390)).toEqual({ top: 50, left: 8 });
  });

  it("shifts left just enough on a viewport wider than the panel", () => {
    // 500px viewport: 380px panel must start at or before 500 - 380 - 8 = 112.
    expect(panelPosition({ bottom: 44, left: 300 }, 500)).toEqual({ top: 50, left: 112 });
  });
});

describe("railPanelPosition", () => {
  it("opens beside the rail's bell, bottom edges level, growing upward", () => {
    expect(railPanelPosition({ bottom: 700, right: 48 }, 1280, 760)).toEqual({
      bottom: 60,
      left: 54,
    });
  });

  it("clamps into the viewport on a narrow window", () => {
    // 400px wide: a 380px panel must start at or before 400 - 380 - 8 = 12,
    // and a bell below the viewport's bottom still leaves the 8px margin.
    expect(railPanelPosition({ bottom: 900, right: 48 }, 400, 880)).toEqual({
      bottom: 8,
      left: 12,
    });
  });
});
