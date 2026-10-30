import { describe, it, expect } from "vitest";
import { ciGatingUnavailableText, needsHumanText } from "./needsHuman.js";

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

describe("ciGatingUnavailableText", () => {
  it("is null when the lookup works", () => {
    expect(ciGatingUnavailableText(null, null)).toBeNull();
    expect(ciGatingUnavailableText(undefined, undefined)).toBeNull();
  });

  it("names the reason and which credential answered", () => {
    expect(ciGatingUnavailableText("forbidden", "app")).toBe(
      "CI gating unavailable: required checks unreadable — permission denied (GitHub App)",
    );
    expect(ciGatingUnavailableText("not-found", "account")).toContain("no branch protection");
    expect(ciGatingUnavailableText("other", null)).toBe(
      "CI gating unavailable: required checks unreadable — lookup failed",
    );
  });
});
