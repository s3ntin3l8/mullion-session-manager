// scripts/lib/color-math.mjs is the arithmetic behind
// scripts/verify-ui-runtime.mjs's contrast check (audit item 3). It is the
// deliverable of that check: the browser hands back raw colour strings and
// layer lists, and this module decides what ratio they paint.
//
// Nothing pinned it until now, and a regression here fails SILENTLY — a
// parser that starts dropping the `color(srgb …)` form (which is how
// Chromium reports every `color-mix(…, transparent)` layer in this app)
// drops the tinted surfaces from the measurement, every ratio collapses
// toward a comfortable constant, and the run still says "pass". That is
// exactly the failure mode the check exists to catch, caught by the check
// itself.
//
// So these tests pin the maths against known WCAG pairs and against the
// token values in frontend/src/styles/tokens.css, and they pin the
// judgement rule: a de-emphasis that LIFTS on hover is judged engaged, and
// a fade that NEVER lifts is judged exactly as painted.
import { describe, it, expect } from "vitest";
import {
  compositeLayers,
  contrast,
  judgeStates,
  luminance,
  over,
  parseColor,
  renderSample,
} from "../../scripts/lib/color-math.mjs";

// The tokens this check measures against, from
// frontend/src/styles/tokens.css (dark theme).
const TOKENS = {
  fg: "#ededed",
  muted: "#9b9ba5",
  dim: "#8a8a94",
  chrome: "#1c1c1e",
  paneHd: "#242426",
  accentFill: "#0a7a53",
};

/** Close enough: the ratios below are quoted to two decimals. */
const near = (actual: number | null, expected: number, places = 2) => {
  expect(actual).not.toBeNull();
  expect(actual as number).toBeCloseTo(expected, places);
};

describe("color-math: parseColor", () => {
  it("parses the comma-separated rgb() form", () => {
    expect(parseColor("rgb(237, 237, 237)")).toEqual({ r: 237, g: 237, b: 237, a: 1 });
  });

  it("parses the space-separated rgb() form Chromium also emits", () => {
    expect(parseColor("rgb(237 237 237)")).toEqual({ r: 237, g: 237, b: 237, a: 1 });
  });

  it("parses an alpha channel in either spelling", () => {
    expect(parseColor("rgba(138, 138, 148, 0.5)")).toEqual({ r: 138, g: 138, b: 148, a: 0.5 });
    expect(parseColor("rgb(138 138 148 / 0.5)")).toEqual({ r: 138, g: 138, b: 148, a: 0.5 });
  });

  // The form the whole tinted-surface argument depends on: Chromium reports
  // `color-mix(in srgb, var(--fg) 9%, transparent)` as `color(srgb …)`, NOT
  // as `rgba()`. A parser that misses it measures the plain surface behind
  // the tint and every ratio comes out comfortable and wrong.
  it("parses the color(srgb …) form Chromium reports color-mix() as", () => {
    expect(parseColor("color(srgb 0.929412 0.929412 0.929412 / 0.09)")).toEqual({
      r: 237,
      g: 237,
      b: 237,
      a: 0.09,
    });
    expect(parseColor("color(srgb 0.929412 0.929412 0.929412)")).toEqual({
      r: 237,
      g: 237,
      b: 237,
      a: 1,
    });
  });

  it("parses hex in all four lengths", () => {
    expect(parseColor("#8a8a94")).toEqual({ r: 138, g: 138, b: 148, a: 1 });
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#ffffff80")).toEqual({ r: 255, g: 255, b: 255, a: 128 / 255 });
    // The 4-digit form is #RGBA, so #fff8 is white at 0x88 alpha.
    expect(parseColor("#fff8")).toEqual({ r: 255, g: 255, b: 255, a: 136 / 255 });
  });

  it("parses percentage channels and a percentage alpha", () => {
    expect(parseColor("rgb(100%, 0%, 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("rgba(255, 0, 0, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
  });

  it("returns null for anything that is not a colour", () => {
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor("none")).toBeNull();
    expect(parseColor("rgb(1, 2)")).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(parseColor(42)).toBeNull();
  });
});

describe("color-math: compositing", () => {
  it("composites a translucent layer over the surface beneath it", () => {
    // 9% of #ededed over #1c1c1e — the keycap chip's own fill.
    const composited = over({ r: 237, g: 237, b: 237, a: 0.09 }, { r: 28, g: 28, b: 30, a: 1 });
    near(composited.r, 46.81);
    near(composited.b, 48.63);
    expect(composited.a).toBeCloseTo(1, 6);
  });

  it("composites a background layer stack, innermost first", () => {
    const layers = [
      { r: 237, g: 237, b: 237, a: 0.09 },
      { r: 28, g: 28, b: 30, a: 1 },
    ];
    const composited = compositeLayers(layers);
    // The @returns annotation on compositeLayers says it never returns
    // null — and under allowJs without checkJs that annotation is a CLAIM
    // the compiler does not verify, so this assertion is what makes it
    // true: a future `return null` in the .mjs fails HERE, loudly,
    // instead of breaking every caller silently.
    expect(composited).not.toBeNull();
    near(composited.r, 46.81);
    near(composited.b, 48.63);
  });

  it("falls back to white when there is no background at all", () => {
    expect(compositeLayers([])).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
});

describe("color-math: contrast", () => {
  it("puts black at 0 and white at 1", () => {
    expect(luminance({ r: 0, g: 0, b: 0, a: 1 })).toBeCloseTo(0, 6);
    expect(luminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 6);
  });

  it("measures black on white as 21:1", () => {
    near(contrast({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }), 21);
  });

  it("measures a colour against itself as 1:1", () => {
    const c = { r: 138, g: 138, b: 148, a: 1 };
    near(contrast(c, c), 1);
  });

  it("is symmetric", () => {
    const a = { r: 138, g: 138, b: 148, a: 1 };
    const b = { r: 28, g: 28, b: 30, a: 1 };
    near(contrast(a, b), contrast(b, a));
  });

  it("puts --dim on --pane-hd at the 4.53:1 the token guard quotes", () => {
    near(contrast(parseColor(TOKENS.dim)!, parseColor(TOKENS.paneHd)!), 4.53);
  });
});

describe("color-math: renderSample", () => {
  const bg = (hex: string) => [parseColor(hex)!];

  it("measures --dim on the accent fill the active workspace row paints", () => {
    const rendered = renderSample({
      color: TOKENS.dim,
      layers: bg(TOKENS.accentFill),
      opacity: 1,
    });
    expect(rendered.resolved).toBe(true);
    near(rendered.ratio, 1.57);
  });

  it("measures white on that fill — what the fix changed it to", () => {
    const rendered = renderSample({
      color: "#ffffff",
      layers: bg(TOKENS.accentFill),
      opacity: 1,
    });
    near(rendered.ratio, 5.35);
  });

  // The opacity has to REACH the ratio. Judged as if it were opaque, this
  // would report 5.35:1 for something painted at 40% strength.
  it("folds the element's opacity into the ratio", () => {
    const rendered = renderSample({
      color: "#ffffff",
      layers: bg(TOKENS.accentFill),
      opacity: 0.4,
    });
    near(rendered.ratio, 2.1);
  });

  it("measures --dim on the keycap chip's own fill", () => {
    const rendered = renderSample({
      color: TOKENS.dim,
      layers: [
        { r: 237, g: 237, b: 237, a: 0.09 },
        { r: 28, g: 28, b: 30, a: 1 },
      ],
      opacity: 1,
    });
    near(rendered.ratio, 3.92);
  });

  it("measures --fg on that same chip", () => {
    const rendered = renderSample({
      color: TOKENS.fg,
      layers: [
        { r: 237, g: 237, b: 237, a: 0.09 },
        { r: 28, g: 28, b: 30, a: 1 },
      ],
      opacity: 1,
    });
    near(rendered.ratio, 11.45);
  });

  it("reports an unresolvable foreground instead of a bogus ratio", () => {
    const rendered = renderSample({
      color: "not-a-colour",
      layers: bg(TOKENS.chrome),
      opacity: 1,
    });
    expect(rendered.resolved).toBe(false);
    expect(rendered.ratio).toBeNull();
  });
});

describe("color-math: judgeStates", () => {
  it("judges an element that never fades on its painted ratio", () => {
    const judged = judgeStates([
      { ratio: 5.29, opacity: 1 },
      { ratio: 4.6, opacity: 1 },
    ]);
    near(judged.judgedRatio, 4.6);
    near(judged.paintedRatio, 5.29);
    expect(judged.lifts).toBe(false);
  });

  // The design's de-emphasis: the workspace row's drag handle sits at 0.4
  // until the row is hovered. That is a reversible presentation state, so
  // the engaged state is the one that carries the meaning.
  it("judges a de-emphasis that lifts on engagement by its engaged ratio", () => {
    const judged = judgeStates([
      { ratio: 1.88, opacity: 0.4 },
      { ratio: 4.6, opacity: 1 },
    ]);
    near(judged.judgedRatio, 4.6);
    near(judged.paintedRatio, 1.88);
    expect(judged.lifts).toBe(true);
  });

  // The regression this rule exists to catch: a fade that NEVER lifts is a
  // permanent readability problem, and judging it as if it were opaque
  // would report a ratio it does not have.
  it("judges a fade that never lifts by the ratio it is painted at", () => {
    const judged = judgeStates([{ ratio: 2.4, opacity: 0.5 }]);
    near(judged.judgedRatio, 2.4);
    near(judged.paintedRatio, 2.4);
    expect(judged.lifts).toBe(false);
  });

  it("ignores a state with no usable ratio", () => {
    const judged = judgeStates([
      { ratio: null, opacity: 1 },
      { ratio: 4.5, opacity: 1 },
    ]);
    near(judged.judgedRatio, 4.5);
  });

  it("reports nothing to judge when there are no states", () => {
    const judged = judgeStates([]);
    expect(judged.judgedRatio).toBeNull();
    expect(judged.lifts).toBe(false);
  });
});
