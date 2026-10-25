// The colour maths behind `scripts/verify-ui-runtime.mjs`'s contrast check.
//
// This is a separate, dependency-free module on purpose: the contrast
// arithmetic IS the deliverable of that check. A parser that quietly starts
// dropping a layer makes every ratio wrong and every failure SILENT — the
// run still says "pass". So the maths has to be pinnable against known WCAG
// pairs without booting a browser, which is what
// `test/scripts/color-math.test.ts` does.
//
// Everything here is pure: no DOM, no browser, no I/O.

/**
 * Parse a computed colour into 8-bit channels plus an alpha.
 *
 * The `color(srgb …)` form matters more than it looks: Chromium reports a
 * `color-mix()` with `transparent` — which is how every tinted and hovered
 * surface in this app is written — as
 * `color(srgb 0.929412 0.929412 0.929412 / 0.09)`, NOT as `rgba()`. A parser
 * that only understands `rgb()`/`rgba()` silently drops every one of those
 * layers and measures the plain surface behind them, which is the very gap
 * the check exists to close.
 *
 * @param {unknown} value a computed colour string
 * @returns {{r:number,g:number,b:number,a:number}|null} null when the value
 *   is not a colour this module understands, or is fully transparent (which
 *   paints nothing and must not be composited as if it did).
 */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v === "transparent") return null;

  // rgb() / rgba(), comma- or space-separated, with an optional alpha.
  let m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channels = parts.slice(0, 3).map(parseChannel);
    if (channels.some((c) => c === null)) return null;
    const alpha = parts.length > 3 ? parseAlpha(parts[3]) : 1;
    if (alpha === null) return null;
    return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
  }

  // color(srgb r g b / a) — the form Chromium uses for color-mix().
  m = /^color\(srgb\s+([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channels = parts.slice(0, 3).map((p) => {
      const n = Number(p);
      if (Number.isNaN(n)) return null;
      return Math.round(n * 255);
    });
    if (channels.some((c) => c === null)) return null;
    const alpha = parts.length > 3 ? parseAlpha(parts[3]) : 1;
    if (alpha === null) return null;
    return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
  }

  // #rgb, #rgba, #rrggbb, #rrggbbaa.
  m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const hex = m[1];
    const expanded =
      hex.length === 3 || hex.length === 4
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    if (expanded.length !== 6 && expanded.length !== 8) return null;
    const n = parseInt(expanded.slice(0, 6), 16);
    const a = expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }

  return null;
}

/** One 0-255 channel, from a number or a percentage. */
function parseChannel(part) {
  if (part.endsWith("%")) {
    const pct = Number(part.slice(0, -1));
    if (Number.isNaN(pct)) return null;
    return Math.round((pct / 100) * 255);
  }
  const n = Number(part);
  if (Number.isNaN(n)) return null;
  return Math.round(n);
}

/** One alpha, from a number or a percentage. */
function parseAlpha(part) {
  if (part.endsWith("%")) {
    const pct = Number(part.slice(0, -1));
    if (Number.isNaN(pct)) return null;
    return pct / 100;
  }
  const n = Number(part);
  if (Number.isNaN(n)) return null;
  return n;
}

/**
 * Composite `fg` over `bg` (source-over).
 *
 * @param {{r:number,g:number,b:number,a:number}} fg
 * @param {{r:number,g:number,b:number,a:number}} bg
 */
export function over(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}

/** WCAG relative luminance. */
export function luminance(c) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** WCAG contrast ratio between two colours. */
export function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Composite background layers into the one colour actually painted behind
 * the text.
 *
 * `layers` is innermost-first — `layers[0]` is painted on top of
 * `layers[1]`, and so on out to the page background. A translucent layer
 * (every `color-mix(…, transparent)` in this app) has to be composited over
 * whatever it sits on, or the measured ratio is the ratio against a surface
 * nobody ever sees.
 *
 * @param {Array<{r:number,g:number,b:number,a:number}|null>} layers
 */
export function compositeLayers(layers) {
  const painted = (layers ?? []).filter((c) => c && c.a > 0);
  if (painted.length === 0) return { r: 255, g: 255, b: 255, a: 1 };

  // The outermost fully opaque layer is the base; everything inside it is
  // composited over that, innermost last.
  let baseIdx = -1;
  for (let i = painted.length - 1; i >= 0; i--) {
    if (painted[i].a >= 0.999) {
      baseIdx = i;
      break;
    }
  }
  let current = baseIdx >= 0 ? painted[baseIdx] : { r: 255, g: 255, b: 255, a: 1 };
  const start = baseIdx >= 0 ? baseIdx - 1 : painted.length - 1;
  for (let i = start; i >= 0; i--) current = over(painted[i], current);
  return current;
}

/**
 * The contrast of a colour as ACTUALLY PAINTED: its own alpha multiplied by
 * the element's effective opacity, composited over the background layers.
 *
 * The opacity is the point. An element drawn at `opacity: 0.4` paints a
 * 40%-strength colour, and judging it as if it were fully opaque reports a
 * ratio the user never sees.
 *
 * @param {{color:unknown, layers:Array, opacity?:number}} sample
 * @returns {{resolved:boolean, ratio:number|null, foreground:object|null,
 *   background:object|null}} `resolved` is false when the foreground colour
 *   could not be parsed — a check that cannot resolve the colour is
 *   measuring nothing, and says so rather than reporting a bogus ratio.
 */
export function renderSample({ color, layers, opacity = 1 }) {
  const fg = parseColor(color);
  if (!fg) return { resolved: false, ratio: null, foreground: null, background: null };

  const behind = compositeLayers(layers);
  // A background that never reaches opacity is composited over the page's
  // white so the ratio is measured against a real colour.
  const background = behind.a >= 0.999 ? behind : over(behind, { r: 255, g: 255, b: 255, a: 1 });

  const alpha = Math.max(0, Math.min(1, opacity));
  const foreground = over({ r: fg.r, g: fg.g, b: fg.b, a: fg.a * alpha }, background);
  return {
    resolved: true,
    ratio: contrast(foreground, background),
    foreground,
    background,
  };
}

/**
 * Decide which of an element's observed states it is judged on.
 *
 * An element can be deliberately de-emphasised at rest — this app drops a
 * workspace row's drag handle to `opacity: 0.4` until the row is hovered —
 * and that is a reversible presentation state, not a readability problem: the
 * moment the user engages with it, it is at full strength.
 *
 * A fade that NEVER lifts is a different thing entirely. It is a permanent
 * readability problem, and it has to be judged on the state it is actually
 * painted in, or a `opacity: 0.5` that never lifts would report a contrast
 * ratio it does not have.
 *
 * So the rule is: judge on the worst state at the element's HIGHEST observed
 * opacity. If that highest opacity is the base opacity — the fade never
 * lifted — the base state is what gets judged, and a low-contrast fade
 * fails. If the element was seen at full strength, that is the state it is
 * judged on.
 *
 * @param {Array<{ratio:number|null, opacity:number}>} states the base state
 *   first, then any state observed while something was hovered.
 */
export function judgeStates(states) {
  const usable = (states ?? []).filter(
    (s) => s && s.ratio !== null && typeof s.opacity === "number" && Number.isFinite(s.opacity),
  );
  if (usable.length === 0) {
    return {
      judgedRatio: null,
      paintedRatio: null,
      engagedRatio: null,
      lifts: false,
      maxOpacity: null,
    };
  }

  const base = usable[0];
  const maxOpacity = Math.max(...usable.map((s) => s.opacity));
  const engaged = usable.filter((s) => s.opacity >= maxOpacity - 1e-9);
  const engagedRatio = Math.min(...engaged.map((s) => s.ratio));

  return {
    judgedRatio: engagedRatio,
    paintedRatio: base.ratio,
    engagedRatio,
    // Did the de-emphasis ever lift? If it did not, the base state is the
    // state the element lives in, and that is what is judged.
    lifts: maxOpacity > base.opacity + 1e-9,
    maxOpacity,
  };
}
