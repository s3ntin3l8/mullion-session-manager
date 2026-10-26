import { describe, it, expect } from "vitest";
import { needsHumanText } from "./needsHuman.js";

describe("needsHumanText", () => {
  it("names each reason the automatic loop stopped", () => {
    expect(needsHumanText("cap")).toBe("round cap reached");
    expect(needsHumanText("no-progress")).toBe("worker returned without a change");
    expect(needsHumanText("finding-persisted")).toBe("same finding still open after two rounds");
  });

  it("reads a missing reason as the round cap — the original, still most common, case", () => {
    expect(needsHumanText(null)).toBe("round cap reached");
    expect(needsHumanText(undefined)).toBe("round cap reached");
  });
});
