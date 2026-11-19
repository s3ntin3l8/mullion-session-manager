import { describe, expect, it } from "vitest";
import { parseRelativeResetDuration } from "../../src/services/relative-reset-duration.js";

const BASE = new Date("2026-11-17T10:00:00.000Z");
const CAPTURED =
  "generating and executing: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 102h16m12s.";

describe("parseRelativeResetDuration (#3234)", () => {
  it("parses the captured agy message", () => {
    const reset = parseRelativeResetDuration(CAPTURED, BASE);
    expect(reset?.getTime()).toBe(BASE.getTime() + (102 * 3600 + 16 * 60 + 12) * 1000);
  });

  it.each([
    ["Resets in 5m.", 300],
    ["Resets in 3h", 10_800],
    ["Resets in 45s", 45],
    ["resets in 1h2s", 3602],
    ["Quota hit. Resets in 2h30m, sorry", 9000],
    ["Resets in 1h 30m", 5400],
    ["Resets in 30m 10s", 1810],
  ])("parses %s", (text, seconds) => {
    expect(parseRelativeResetDuration(text, BASE)?.getTime()).toBe(BASE.getTime() + seconds * 1000);
  });

  it.each([
    "no reset here",
    "Resets in soon",
    "Resets in 0s",
    "Resets in 0h0m0s",
    "Resets in ",
    "",
  ])("returns null for %j", (text) => {
    expect(parseRelativeResetDuration(text, BASE)).toBeNull();
  });

  it("returns null for a missing message", () => {
    expect(parseRelativeResetDuration(null, BASE)).toBeNull();
    expect(parseRelativeResetDuration(undefined, BASE)).toBeNull();
  });
});
