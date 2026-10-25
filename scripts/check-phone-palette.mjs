#!/usr/bin/env node
// The phone tier keeps the command palette reachable (issue #1880).
//
// The palette was hidden on the phone tier by a single CSS rule —
// `styles/mobile.css`'s `.run-cmd-btn { display: none !important }` — inside
// the phone's own `:where(.app[data-tier="phone"])` block. Nothing else
// changed: the button was in the DOM the whole time, and the phone had no
// way to reach the palette at all. ⌘K is the desktop's power path and a
// phone has no keyboard.
//
// The rule is gone, so the palette's button is back on the phone. This script
// is the guard that keeps it there: it fails if any stylesheet hides the
// button again — the exact regression this issue was filed for, and the one
// most likely to come back by someone tidying the phone toolbar.
//
// It lives here rather than in a vitest file for one concrete reason: Vitest
// stubs CSS imports (`css: false` in frontend/vitest.config.ts), so a test
// cannot read a stylesheet's text — the `?raw` import resolves to an empty
// string, and `import.meta.glob(..., { as: "raw" })` resolves to one too.
// This repo's own precedent for "assert something about a source file's
// contents" is a `scripts/check-*` node script wired into `npm run lint`
// (see check-token-contrast.mjs, whose header comment says the same thing).
//
// Two checks:
//
//   1. REACHABLE — no stylesheet may hide the palette's button itself. The
//      button's DESCENDANTS may be hidden (the "Run command…" label and the
//      ⌘K keycap are hidden on the phone, and the keycap is hidden on the
//      tablet's compact picker) — that is what makes it icon-only, and it
//      is not the same thing as hiding the button.
//
//   2. ICON-ONLY ON THE PHONE — the phone tier must hide the button's label
//      and keycap. The desktop's button is a bordered pill with the text
//      "Run command…" and a ⌘K chip; at phone width that does not fit, and
//      the rule that hid the whole button was replaced by one that trims it
//      to its icon instead.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STYLES_DIR = path.join(ROOT, "frontend", "src", "styles");

const fail = (message) => {
  console.error(`FAIL — ${message}`);
  process.exit(1);
};

// CSS comments are stripped before anything is matched: a comment that
// QUOTES a rule (this repo's stylesheets explain their own rules in prose,
// and the comment above quotes `display: none !important` out loud) is not a
// rule, and a scanner that read comments would fail on the explanation.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The leaf rules of a stylesheet, as { selector, body }.
 *
 * The same shape as check-token-contrast.mjs's own walker: a rule whose
 * body contains no braces. That skips the CONTAINERS — the `@media` blocks
 * and this repo's `:where(.app[data-tier="phone"])` block, which nest their
 * rules inside them — and yields the rules themselves, which is what these
 * two checks are about.
 */
function leafRules(css) {
  const found = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    found.push({ selector: match[1].replace(/\s+/g, " ").trim(), body: match[2] });
  }
  return found;
}

/**
 * The content of the block whose opening brace is at `open`.
 */
function blockAt(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return css.slice(open + 1);
}

/**
 * Whether a selector's SUBJECT is the palette button itself.
 *
 * The subject is the last compound of the selector: `.run-cmd-btn .kbd`
 * targets a DESCENDANT of the button, `.run-cmd-btn` and
 * `.toolbar--compact-picker .run-cmd-btn` target the button. A pseudo-class
 * suffix (`:hover`, `:active`) does not change the subject.
 */
function targetsButton(selector) {
  return selector
    .split(",")
    .map((part) => part.trim().split(/\s+/).pop() ?? "")
    .some((compound) =>
      compound.replace(/::?[a-z-]+(\([^)]*\))?$/i, "").startsWith(".run-cmd-btn"),
    );
}

// The `!important` is part of the pattern on purpose: the rule this script
// guards against was literally `.run-cmd-btn { display: none !important }`,
// and a pattern that only matched a bare `display: none` would have passed
// the regression it exists to catch.
const HIDE = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)\s*(!important\s*)?(;|$)/i;

const cssFiles = readdirSync(STYLES_DIR).filter((f) => f.endsWith(".css"));

// ---- 1. The button is never hidden -------------------------------------

const hidden = [];
for (const file of cssFiles) {
  const css = stripComments(readFileSync(path.join(STYLES_DIR, file), "utf8"));
  for (const rule of leafRules(css)) {
    if (!targetsButton(rule.selector)) continue;
    if (!HIDE.test(rule.body)) continue;
    hidden.push(`${file}: ${rule.selector}`);
  }
}
if (hidden.length > 0) {
  fail(
    `the command palette's toolbar button is hidden again:\n` +
      hidden.map((h) => `  ${h}`).join("\n") +
      `\n  It is the phone tier's only route to the palette (issue #1880).`,
  );
}

// ---- 2. Icon-only on the phone ------------------------------------------

const mobile = stripComments(readFileSync(path.join(STYLES_DIR, "mobile.css"), "utf8"));
const phoneSelector = ':where(.app[data-tier="phone"])';
const phoneAt = mobile.indexOf(phoneSelector);
if (phoneAt < 0) {
  fail('mobile.css has no :where(.app[data-tier="phone"]) block to check the palette in.');
}
const phoneOpen = mobile.indexOf("{", phoneAt);
const phoneCss = blockAt(mobile, phoneOpen);

const hides = (selector) =>
  leafRules(phoneCss).some(
    (rule) =>
      rule.selector.includes(selector) && /(^|;)\s*display\s*:\s*none\s*(;|$)/i.test(rule.body),
  );
if (!hides(".run-cmd-label") || !hides(".kbd")) {
  fail(
    "the phone tier does not hide the palette button's label and keycap, so the " +
      'desktop\'s bordered pill ("Run command…" plus a ⌘K chip) does not fit the ' +
      "phone toolbar (issue #1880).",
  );
}

console.log(
  "OK — the command palette's toolbar button is reachable on the phone, and icon-only there.",
);
