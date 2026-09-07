import { describe, it, expect } from "vitest";
import { HOLD_THRESHOLD_MS, resolveRelease } from "./pushToTalk.js";

describe("resolveRelease", () => {
  it("latches (toggles on) at exactly the threshold", () => {
    expect(resolveRelease(1000, 1000 + HOLD_THRESHOLD_MS)).toBe("latch");
  });

  it("latches below the threshold (a quick tap)", () => {
    expect(resolveRelease(1000, 1000 + HOLD_THRESHOLD_MS - 1)).toBe("latch");
  });

  it("stops just above the threshold (a genuine hold)", () => {
    expect(resolveRelease(1000, 1000 + HOLD_THRESHOLD_MS + 1)).toBe("stop");
  });

  it("stops for a long hold", () => {
    expect(resolveRelease(1000, 1000 + 5000)).toBe("stop");
  });

  it("honors a custom threshold", () => {
    expect(resolveRelease(0, 100, 50)).toBe("stop");
    expect(resolveRelease(0, 40, 50)).toBe("latch");
  });
});
