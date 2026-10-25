#!/usr/bin/env node
// WCAG contrast for the design tokens, enforced.
//
// `--dim` was the color of 182 separate `color:` declarations across the
// stylesheets — session meta lines, section captions, inactive dockview tab
// labels — and it never once cleared WCAG AA's 4.5:1 against the app's own
// surfaces: 2.31:1 to 3.49:1 depending on the theme and the surface behind
// it. `--muted` failed in the light theme (3.90:1 on --pane-hd), and white
// text on the accent and ring fills was 2.54:1 to 3.39:1.
//
// Numbers like that drift the moment someone edits a hex, and nothing in
// the build notices. This script is the guard: it parses the tokens, and
// fails the lint step (and therefore the pre-push flow) when a token stops
// clearing its threshold.
//
// It lives here rather than in a vitest file for one concrete reason:
// Vitest stubs CSS imports (`css: false` in frontend/vitest.config.ts), so
// a test cannot read the stylesheet's text — the `?raw` import resolves to
// an empty string. This repo's own precedent for "assert something about a
// source file's contents" is a `scripts/check-*.mjs` node script wired
// into `npm run lint` (see check-case-collision.mjs, check-env-docs.mjs),
// and this is exactly that shape.
//
// Two checks:
//
//   1. TOKEN CONTRAST — each token, against the role it is used in. A
//      token's ROLE matters: a value tuned to be readable AS text on a dark
//      surface is the wrong value for a white-on-fill background, and vice
//      versa. `--ring` was 2.54:1 under white text, which is why the
//      palette now carries a separate `--accent-fill` for that job.
//
//   2. ROLE DRIFT — no stylesheet rule may put white text on a token that
//      is not a fill-role token. This is what stops check 1's fix from
//      quietly regressing: someone adds `background: var(--accent-solid)`
//      next to `color: #fff` and the fill-role rule is violated again.
//      It reads the stylesheets only — a colour written inline in a TSX
//      `style={{ ... }}` object is out of its reach.
//
//   3. FADED GRAPHICS — a graphical object that is deliberately de-emphasised
//      with `opacity` still has to clear 3:1 (WCAG 1.4.11) as the COMPOSITE
//      it paints, against the surface it sits on. Checks 1 and 2 compare a
//      token against a token, so neither of them can see an opacity fade:
//      `.ws-drag-handle` painted `--dim` — which clears 4.5:1 on every
//      surface on its own — at `opacity: 0.4`, and the composite over
//      `--sidebar` was 1.88:1 (dark) / 1.74:1 (light) (issue #1908).
//      The browser harness in `scripts/verify-ui-runtime.mjs` measures this
//      in a real browser, but it is a MANUAL gate, so the regression it
//      catches would not fail CI on its own.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseColor, renderSample } from "./lib/color-math.mjs";

const ROOT = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const STYLES_DIR = path.join(ROOT, "frontend", "src", "styles");

/** The WCAG 2.x relative luminance of a `#rrggbb` colour. */
function luminance(hex) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const channel = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG 2.x contrast ratio between two `#rrggbb` colours. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `--token: #value;` declaration inside one CSS block. */
function tokensIn(css, blockSelector) {
  const start = css.indexOf(blockSelector);
  if (start === -1) return null;
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  if (open === -1 || close === -1) return null;
  const body = css.slice(open + 1, close);
  const out = {};
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

/**
 * Resolve a token's value to a literal colour.
 *
 * Some tokens are aliases rather than literals — `--bg: var(--bg-dark)`,
 * `--field: var(--sidebar)` — so they have to be followed to the hex they
 * point at. The alias may live in the theme block or, for the two
 * background colours, in the `:root` block that sits above both themes.
 */
function resolveValue(name, scopes) {
  for (const scope of scopes) {
    const raw = scope[name];
    if (!raw) continue;
    const ref = /^var\(\s*--([\w-]+)\s*\)$/.exec(raw);
    if (ref) return resolveValue(ref[1], scopes);
    if (/^#[0-9a-fA-F]{3,8}$/.test(raw)) return raw;
    return null;
  }
  return null;
}

const tokensCss = readFileSync(path.join(STYLES_DIR, "tokens.css"), "utf8");
const rootTokens = tokensIn(tokensCss, ":root {");
const darkRaw = tokensIn(tokensCss, ".cmux-root {");
const lightRaw = tokensIn(tokensCss, ".cmux-root.light {");

if (!darkRaw || !lightRaw || !rootTokens) {
  console.error("Could not find the token blocks in frontend/src/styles/tokens.css.");
  process.exit(1);
}

function resolveTheme(raw) {
  const out = {};
  for (const name of Object.keys(raw)) {
    out[name] = resolveValue(name, [raw, rootTokens]);
  }
  return out;
}

const dark = resolveTheme(darkRaw);
const light = resolveTheme(lightRaw);

/**
 * The surfaces a piece of text can sit on in each theme.
 *
 * `--field` is included because it is a real input background, and it is
 * `--sidebar` in the dark theme / `#ffffff` in the light one — the token is
 * re-declared per theme, so it is read from the parsed values rather than
 * assumed.
 */
function surfaces(theme) {
  const field = theme.field ?? theme.sidebar;
  return [
    theme.bg,
    theme.chrome,
    theme.sidebar,
    theme["sidebar-2"],
    theme["pane-hd"],
    theme.term,
    field,
  ];
}

/**
 * Tokens whose value is used as the COLOUR OF TEXT — they have to clear
 * 4.5:1 (WCAG 1.4.3) against every surface they can appear on.
 *
 * `--accent-solid` is in this list because a lot of the stylesheets use it
 * as a text colour (link and label text in the settings sections), not only
 * as a fill.
 */
const TEXT_ROLE_TOKENS = ["fg", "muted", "dim", "accent-solid"];

/**
 * Tokens whose value is used as the BACKGROUND of a badge or button that
 * carries WHITE text — they have to clear 4.5:1 against white.
 */
const FILL_ROLE_TOKENS = ["accent-fill", "badge-dim"];

/**
 * Tokens used as a focus ring or a status marker — non-text UI
 * components, which WCAG 1.4.11 puts at 3:1.
 */
const NON_TEXT_ROLE_TOKENS = ["ring"];

const failures = [];

for (const [themeName, theme] of [
  ["dark", dark],
  ["light", light],
]) {
  for (const token of TEXT_ROLE_TOKENS) {
    const value = theme[token];
    if (!value) {
      failures.push(`${themeName}: --${token} is not defined`);
      continue;
    }
    for (const surface of surfaces(theme)) {
      const ratio = contrast(value, surface);
      if (ratio < 4.5) {
        failures.push(
          `${themeName}: --${token} (${value}) on ${surface} is ${ratio.toFixed(2)}:1 — ` +
            `below the 4.5:1 AA threshold for text`,
        );
      }
    }
  }

  for (const token of FILL_ROLE_TOKENS) {
    const value = theme[token];
    if (!value) {
      failures.push(`${themeName}: --${token} is not defined`);
      continue;
    }
    const ratio = contrast(value, "#ffffff");
    if (ratio < 4.5) {
      failures.push(
        `${themeName}: --${token} (${value}) under white text is ${ratio.toFixed(2)}:1 — ` +
          `below the 4.5:1 AA threshold`,
      );
    }
  }

  for (const token of NON_TEXT_ROLE_TOKENS) {
    const value = theme[token];
    if (!value) {
      failures.push(`${themeName}: --${token} is not defined`);
      continue;
    }
    for (const surface of surfaces(theme)) {
      const ratio = contrast(value, surface);
      if (ratio < 3) {
        failures.push(
          `${themeName}: --${token} (${value}) on ${surface} is ${ratio.toFixed(2)}:1 — ` +
            `below the 3:1 threshold for UI components`,
        );
      }
    }
  }
}

// Role drift: white text on a token that is not a fill-role token. The
// fill-role values are the darker ones; the text-role ones are tuned for
// legibility AS text and are much lighter, so white on them is unreadable.
//
// Every spelling of "white" a stylesheet can use has to be caught here —
// the guard is only as good as its matcher. `#fff` alone is not enough:
// `#ffffff`, `#FFF`, `#ffffffff` and `rgb(255, 255, 255)` are all the
// same colour and all have to be caught.
//
// SCOPE: this reads the stylesheets only. It cannot see a colour written
// inline in a TSX `style={{ ... }}` object — nothing in this repo writes
// one today, and the check says so rather than pretending otherwise.
const WHITE_TEXT_RE =
  /color\s*:\s*(?:#f{3,8}\b|white\b|rgba?\(\s*255(?:\s*,\s*|\s+)255(?:\s*,\s*|\s+)255\b)/i;

for (const file of readdirSync(STYLES_DIR).filter((f) => f.endsWith(".css"))) {
  const css = readFileSync(path.join(STYLES_DIR, file), "utf8");
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].replace(/\s+/g, " ").trim();
    const body = rule[2];
    if (!WHITE_TEXT_RE.test(body)) continue;
    for (const match of body.matchAll(/background(?:-color)?\s*:\s*var\(--([\w-]+)\)/g)) {
      const token = match[1];
      if (FILL_ROLE_TOKENS.includes(token)) continue;
      failures.push(
        `${file}: "${selector}" puts white text on var(--${token}), which is not a fill-role ` +
          `token (${FILL_ROLE_TOKENS.join(", ")} are) — use one of those instead`,
      );
    }
  }
}

// Faded graphics: a graphical object that is deliberately de-emphasised with
// `opacity` still has to clear 3:1 (WCAG 1.4.11) as the COMPOSITE it paints.
//
// The two checks above cannot see this class of defect: they compare a token
// against a token, so an `opacity` fade — which is what turns a legible token
// into an illegible pixel — is invisible to them. The workspace row's drag
// handle was the shipped example (issue #1908): `--dim` at `opacity: 0.4`
// composited over `--sidebar` to 1.88:1 (dark) / 1.74:1 (light), and the
// handle was a graphical object.
//
// Each entry names the rule that paints the object at REST, the surface it is
// painted on, the minimum the composite has to clear, and the rule that lifts
// the de-emphasis when the user engages with it.
//
// SCOPE: this reads the AUTHORED rules, and matches the selector EXACTLY.
// `.ws-drag-handle` is the resting rule; `.workspace-item:hover
// .ws-drag-handle` and `.workspace-item.active .ws-drag-handle` are
// different selectors and are deliberately not merged into it. A rule that
// reaches the same element through a compound selector — or inside an
// `@media` block — would not be seen here;
// `scripts/verify-ui-runtime.mjs` measures the real thing in a browser, and
// says as much in its own report.
//
// Paint is `color`, or — when the object is a filled mark rather than an
// icon — `background-color` / a solid `background`. A dot painted only with
// `background: var(--dim)` is the same kind of object; reporting "declares
// no colour" for it would be the check refusing to see the pixel.
const FADED_GRAPHICS = [
  {
    file: "sidebar.css",
    selector: ".ws-drag-handle",
    liftSelector: ".workspace-item:hover .ws-drag-handle",
    surface: "sidebar",
    minRatio: 3,
    what: "the workspace row's drag handle at rest",
  },
  {
    file: "sidebar.css",
    selector: ".project-git-dot",
    liftSelector: ".project-git-dot.clean",
    surface: "sidebar",
    minRatio: 3,
    what: "the project row's quiet git dot at rest",
  },
];

// Rules that must declare `opacity: 1` themselves. Inheriting a faded
// ancestor is not a contrast failure once that ancestor clears 3:1: white
// at the drag handle's resting 0.75 over `--accent-fill` is 3.74:1 (dark) /
// 4.28:1 (light), so `scripts/verify-ui-runtime.mjs`'s 3:1 guard would not
// catch dropping the declaration. This pin is what still catches it.
const FULL_STRENGTH_PINS = [
  {
    file: "sidebar.css",
    selector: ".workspace-item.active .ws-drag-handle",
    what: "the active workspace row's drag handle",
  },
];

/**
 * The stylesheet's top-level rules, with its comments stripped.
 *
 * Rules inside an at-rule block (`@media`, `@supports`) are skipped: this
 * guard judges the rule as authored, and a conditional override is a
 * different question — the browser harness in
 * `scripts/verify-ui-runtime.mjs` measures the real thing, viewport and all.
 */
function rulesIn(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let cursor = 0;
  while (cursor < stripped.length) {
    const open = stripped.indexOf("{", cursor);
    if (open === -1) break;
    const header = stripped.slice(cursor, open).trim();
    // The matching close brace, so a nested block is not read as a rule.
    let depth = 1;
    let end = open + 1;
    while (end < stripped.length && depth > 0) {
      const ch = stripped[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      end++;
    }
    if (!header.startsWith("@")) {
      rules.push({
        selectors: header.split(",").map((s) => s.replace(/\s+/g, " ").trim()),
        body: stripped.slice(open + 1, end - 1),
      });
    }
    cursor = end;
  }
  return rules;
}

/**
 * The declarations that apply to one exact selector, merged in source order.
 *
 * Later declarations win, as they do in the cascade for rules of equal
 * specificity — which is what makes this a faithful reading of the
 * stylesheet rather than a search for one declaration.
 */
function declarationsFor(rules, selector) {
  const declarations = new Map();
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    for (const declaration of rule.body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (property) declarations.set(property, value);
    }
  }
  return declarations;
}

/** A declaration's colour, resolved to a hex for the theme at hand. */
function resolvePainted(value, theme) {
  const token = /^var\(\s*--([\w-]+)\s*\)$/.exec(value);
  if (token) return theme[token[1]] ?? null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  return null;
}

/** Drop a trailing `!important` so `0.75 !important` is still a number. */
function bareValue(raw) {
  return String(raw)
    .replace(/!important\s*$/i, "")
    .trim();
}

/**
 * The opacity a rule paints, or 1 when it declares none.
 *
 * `opacity: 0.75 !important` is 0.75. A value this cannot read (a calc, a
 * custom property) is reported rather than treated as opaque.
 */
function readOpacity(declarations) {
  if (!declarations.has("opacity"))
    return { present: false, opacity: 1, raw: null, readable: true };
  const raw = declarations.get("opacity");
  const opacity = Number(bareValue(raw));
  return { present: true, opacity, raw, readable: Number.isFinite(opacity) };
}

/**
 * Every solid paint the object declares.
 *
 * `color` is the icon. `background-color`, or a `background` that is a
 * single colour, is a filled mark. An object that declares both is measured
 * on both — first-match would let a failing fill hide behind a passing
 * text colour. A `background` shorthand that is not one solid colour — a
 * gradient, a `color-mix`, `var(--dim) no-repeat`, a `var()` with a
 * fallback — is not a paint this check can composite. It is returned
 * separately, not dropped: when it is the object's only paint, "nothing
 * paints it" would be the wrong diagnosis for a rule that does paint.
 */
function paintedDeclarations(declarations) {
  const paints = [];
  const cannotComposite = [];
  for (const property of ["color", "background-color", "background"]) {
    if (!declarations.has(property)) continue;
    const value = bareValue(declarations.get(property));
    if (property === "background" && !/^(?:var\(\s*--[\w-]+\s*\)|#[0-9a-fA-F]{3,8})$/.test(value)) {
      cannotComposite.push({ property, value });
      continue;
    }
    paints.push({ property, value });
  }
  return { paints, cannotComposite };
}

for (const faded of FADED_GRAPHICS) {
  const file = path.join(STYLES_DIR, faded.file);
  let css;
  try {
    css = readFileSync(file, "utf8");
  } catch {
    failures.push(
      `${faded.file}: cannot be read, so "${faded.selector}" (${faded.what}) cannot be checked`,
    );
    continue;
  }
  const rules = rulesIn(css);
  const resting = declarationsFor(rules, faded.selector);
  if (resting.size === 0) {
    failures.push(
      `${faded.file}: "${faded.selector}" (${faded.what}) is gone — nothing paints it any more`,
    );
    continue;
  }

  // The de-emphasis itself: the object must still be quieter than full
  // strength at rest, and must still come to full strength when the user
  // engages with it. A handle that is dim at rest AND dim when hovered is a
  // permanent fade, which is the state the browser harness judges hardest.
  //
  // Raising the rest all the way to 1 is the MORE accessible state, and it
  // is not a WCAG failure. The check still refuses it, because the quiet
  // rest is a deliberate presentation state, not a contrast requirement.
  const { opacity, raw: opacityRaw, readable } = readOpacity(resting);
  if (!readable) {
    failures.push(
      `${faded.file}: "${faded.selector}" has an opacity this check cannot read ` +
        `(${opacityRaw})`,
    );
    continue;
  }
  if (opacity >= 1) {
    failures.push(
      `${faded.file}: "${faded.selector}" (${faded.what}) must stay de-emphasised at rest ` +
        `(an opacity below 1). Full strength is the more accessible state, and this is ` +
        `not a WCAG failure — it is the deliberate de-emphasis the design wants kept. ` +
        `It is at ${opacity}`,
    );
  }

  const lift = declarationsFor(rules, faded.liftSelector);
  const liftOpacity = readOpacity(lift);
  // An absent opacity is NOT full strength. `readOpacity` reports 1 when the
  // property is missing so a resting rule with no fade is judged opaque —
  // the right reading for the rest. On the lift it is the opposite: a rule
  // that kept some other declaration and dropped `opacity: 1` would inherit
  // the resting fade, which is the permanent de-emphasis this check exists
  // to refuse. The declaration has to be there.
  if (!lift.size) {
    failures.push(
      `${faded.file}: "${faded.liftSelector}" is gone, so "${faded.selector}" ` +
        `(${faded.what}) never lifts — the de-emphasis has to lift when the user engages with it`,
    );
  } else if (!liftOpacity.present || !liftOpacity.readable || liftOpacity.opacity !== 1) {
    failures.push(
      `${faded.file}: "${faded.liftSelector}" must lift "${faded.selector}" to full strength ` +
        `(opacity: 1) — it is at ${liftOpacity.present ? lift.get("opacity") : "unset"}`,
    );
  }

  const { paints, cannotComposite } = paintedDeclarations(resting);
  if (paints.length === 0) {
    if (cannotComposite.length > 0) {
      // The shorthand is there. It is not a single solid colour, so this
      // check cannot composite it — that is a different defect from a rule
      // that declares no paint at all.
      for (const skipped of cannotComposite) {
        failures.push(
          `${faded.file}: "${faded.selector}" (${faded.what}) declares ${skipped.property} ` +
            `${skipped.value} — a shorthand this check cannot composite, because it is not ` +
            `a single solid colour`,
        );
      }
    } else {
      failures.push(
        `${faded.file}: "${faded.selector}" (${faded.what}) declares no colour and no solid ` +
          `background — nothing paints it any more`,
      );
    }
    continue;
  }

  // Every paint below is measured against `--surface` (the surface the
  // entry names). That is right for a fill, and for an icon whose only
  // paint is `color` — both sit on that surface.
  //
  // An entry that declares BOTH a `color` and a background paints its text
  // ON the fill, not on the surface: the icon's backdrop is the fill, so a
  // `color` measured here would be against the wrong pixel. Nothing has
  // both today. When the next entry does, composite `color` over the fill
  // colour instead of the surface, or the number is misleading.
  for (const painted of paints) {
    for (const [themeName, theme] of [
      ["dark", dark],
      ["light", light],
    ]) {
      const surface = theme[faded.surface];
      const color = resolvePainted(painted.value, theme);
      if (!color || !surface) {
        failures.push(
          `${faded.file}: "${faded.selector}" (${faded.what}) paints ${painted.value} ` +
            `(${painted.property}) on --${faded.surface}, which cannot be resolved in the ` +
            `${themeName} theme`,
        );
        continue;
      }
      const rendered = renderSample({
        color,
        layers: [parseColor(surface)],
        opacity,
      });
      if (!rendered.resolved || rendered.ratio === null) {
        failures.push(
          `${faded.file}: "${faded.selector}" (${faded.what}) paints ${painted.value} at ` +
            `opacity ${opacity} on --${faded.surface} (${surface}) in the ${themeName} theme, ` +
            `which cannot be measured`,
        );
        continue;
      }
      if (rendered.ratio < faded.minRatio) {
        failures.push(
          `${faded.file}: "${faded.selector}" (${faded.what}) paints ${painted.property} ` +
            `${painted.value} at opacity ${opacity} on --${faded.surface} (${surface}) — ` +
            `${rendered.ratio.toFixed(2)}:1 in the ${themeName} theme, below the ` +
            `${faded.minRatio}:1 WCAG 1.4.11 asks of a graphical object`,
        );
      }
    }
  }
}

for (const pin of FULL_STRENGTH_PINS) {
  const file = path.join(STYLES_DIR, pin.file);
  let css;
  try {
    css = readFileSync(file, "utf8");
  } catch {
    failures.push(
      `${pin.file}: cannot be read, so "${pin.selector}" (${pin.what}) cannot be pinned`,
    );
    continue;
  }
  const declared = declarationsFor(rulesIn(css), pin.selector);
  const { present, opacity, readable } = readOpacity(declared);
  if (!declared.size) {
    failures.push(
      `${pin.file}: "${pin.selector}" (${pin.what}) is gone — nothing pins it at full strength`,
    );
  } else if (!readable || !present || opacity !== 1) {
    failures.push(
      `${pin.file}: "${pin.selector}" (${pin.what}) must declare opacity: 1 itself. ` +
        `Inheriting the resting fade still clears 3:1 — white at 0.75 over --accent-fill ` +
        `is 3.74:1 (dark) / 4.28:1 (light) — so the runtime check would not catch dropping it. ` +
        `It is at ${present ? declared.get("opacity") : "unset"}`,
    );
  }
}

if (failures.length > 0) {
  console.error("Design token contrast failures:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nWCAG 2.x thresholds: 4.5:1 for text (1.4.3), 3:1 for UI components and\n" +
      "focus indicators (1.4.11). A faded graphical object that fails is an\n" +
      "opacity or a paint colour in the stylesheet named above. A token that\n" +
      "fails is a value in frontend/src/styles/tokens.css, and white text on a\n" +
      "flat surface wants a fill-role token instead.",
  );
  process.exit(1);
}

console.log(
  "OK — every design token clears its WCAG contrast threshold, and every\n" +
    "de-emphasised graphical object clears 3:1 as the composite it paints.",
);
