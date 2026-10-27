import { describe, expect, it } from "vitest";
import { formatDuration } from "./formatDuration.js";

describe("formatDuration", () => {
  it("shows seconds, minutes with seconds, then hours with minutes", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(8_400)).toBe("8s");
    expect(formatDuration(80_000)).toBe("1m 20s");
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
  });
  it("never goes negative", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});
