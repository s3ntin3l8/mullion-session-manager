import { describe, expect, it } from "vitest";
import { computeFitFontSize, MIN_RENDER_FONT_SIZE } from "./terminalFontFit.js";

describe("computeFitFontSize", () => {
  it("keeps the configured size when the container already fits the target", () => {
    expect(computeFitFontSize(14, 50, 20, 40, 10)).toEqual({ fontSize: 14, achievable: true });
    // Exactly on the boundary still counts as fitting.
    expect(computeFitFontSize(14, 40, 10, 40, 10)).toEqual({ fontSize: 14, achievable: true });
  });

  it("shrinks proportionally to the tighter of the two axes", () => {
    // 20/40 = 0.5 cols ratio, 8/10 = 0.8 rows ratio — cols is the binding
    // constraint, so the font scales by 0.5, not 0.8.
    const result = computeFitFontSize(20, 20, 8, 40, 10);
    expect(result).toEqual({ fontSize: 10, achievable: true });
  });

  it("clamps at MIN_RENDER_FONT_SIZE and reports achievable:false when even the floor doesn't fit", () => {
    // Ratio 0.5 would need a fontSize of 5, well under the floor.
    const result = computeFitFontSize(10, 20, 8, 40, 10, 8);
    expect(result).toEqual({ fontSize: 8, achievable: false });
  });

  it("never clamps above configuredFontSize even when minFontSize is larger", () => {
    // Independent code review — a minFontSize above configuredFontSize
    // (currently unreachable in the app: Settings floors the configured
    // size well above MIN_RENDER_FONT_SIZE) must not push the result past
    // the "never larger than the user's setting" contract this function's
    // own doc comment promises.
    const result = computeFitFontSize(6, 20, 8, 40, 10, 8);
    expect(result.fontSize).toBeLessThanOrEqual(6);
  });

  it("never grows the font past what the user configured", () => {
    // A wildly generous proposed size shouldn't push the result above
    // configuredFontSize even if the arithmetic would allow it.
    const result = computeFitFontSize(14, 400, 200, 40, 10);
    expect(result.fontSize).toBeLessThanOrEqual(14);
  });

  it("is a fixpoint: re-measuring at the SAME configured baseline yields the same result", () => {
    // The critical property that keeps TerminalPane's caller from
    // oscillating — see that module's own doc comment. Calling this twice
    // with identical inputs (as happens when a pane's size hasn't changed
    // between two effect runs) must be idempotent.
    const first = computeFitFontSize(14, 20, 8, 40, 10);
    const second = computeFitFontSize(14, 20, 8, 40, 10);
    expect(second).toEqual(first);
  });

  it("does not ratchet when scaled from the configured baseline rather than a prior shrunk result", () => {
    // Simulates the caller's actual usage: always pass configuredFontSize
    // (20), never a previous call's shrunk output as a new baseline. A
    // container that only marginally grew (22 cols instead of 20, still
    // short of the 40-col target) should recompute a strictly larger — but
    // still shrunk — font, not silently keep shrinking from the prior call's
    // result.
    const shrunkOnce = computeFitFontSize(20, 20, 8, 40, 10);
    const afterSlightGrowth = computeFitFontSize(20, 22, 8, 40, 10);
    expect(afterSlightGrowth.fontSize).toBeGreaterThan(shrunkOnce.fontSize);
  });

  it("treats a zero/negative proposed or target size as unachievable rather than dividing by zero", () => {
    expect(computeFitFontSize(14, 0, 0, 40, 10)).toEqual({
      fontSize: MIN_RENDER_FONT_SIZE,
      achievable: false,
    });
  });

  it("falls back to the configured size instead of NaN/Infinity when a dimension isn't finite", () => {
    // A near-collapsed or `display:none` container can make
    // FitAddon.proposeDimensions()'s own parseInt(getComputedStyle(...))
    // resolve to NaN — the `<= 0` guard above doesn't catch NaN (every
    // comparison against NaN is false), so without this guard NaN would
    // flow through the ratio math and back out as the result, which the
    // caller's `fontSize === term.options.fontSize` no-op guard can never
    // match (NaN !== NaN), re-applying forever.
    expect(computeFitFontSize(14, NaN, 8, 40, 10)).toEqual({ fontSize: 14, achievable: false });
    expect(computeFitFontSize(14, 20, NaN, 40, 10)).toEqual({ fontSize: 14, achievable: false });
    expect(computeFitFontSize(14, Infinity, 8, 40, 10)).toEqual({
      fontSize: 14,
      achievable: false,
    });
    expect(computeFitFontSize(NaN, 20, 8, 40, 10)).toEqual({
      fontSize: NaN,
      achievable: false,
    });
  });
});
