import { describe, it, expect } from "vitest";
import { swipeTargetId } from "./mobileSessionSwipe.js";

const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("swipeTargetId", () => {
  it("moves forward on a leftward swipe and back on a rightward one", () => {
    expect(swipeTargetId(items, "b", -80)).toBe("c");
    expect(swipeTargetId(items, "b", 80)).toBe("a");
  });

  it("wraps around at both ends", () => {
    expect(swipeTargetId(items, "c", -80)).toBe("a");
    expect(swipeTargetId(items, "a", 80)).toBe("c");
  });

  it("returns null with fewer than two items or an unknown active id", () => {
    expect(swipeTargetId([{ id: "a" }], "a", -80)).toBeNull();
    expect(swipeTargetId(items, "zzz", -80)).toBeNull();
  });
});
