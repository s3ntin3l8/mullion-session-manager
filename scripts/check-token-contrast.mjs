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
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

if (failures.length > 0) {
  console.error("Design token contrast failures:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nWCAG 2.x thresholds: 4.5:1 for text (1.4.3), 3:1 for UI components and\n" +
      "focus indicators (1.4.11). Fix the token values in\n" +
      "frontend/src/styles/tokens.css, or use a fill-role token for a\n" +
      "white-on-fill background.",
  );
  process.exit(1);
}

console.log("OK — every design token clears its WCAG contrast threshold.");
