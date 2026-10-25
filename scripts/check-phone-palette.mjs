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
//
// The vocabulary of "hidden" is the same one the Dock's guard uses
// (scripts/check-dock-availability.ts): a rule can take the button out of the
// flow, make it invisible, or make it transparent — and `!important` counts,
// because the rule this script exists to catch was literally
// `.run-cmd-btn { display: none !important }`.
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
 * The content of the block whose opening brace is at `open`, and the index
 * just past its closing brace.
 */
function blockAt(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return { content: css.slice(open + 1, i), end: i + 1 };
    }
  }
  return { content: css.slice(open + 1), end: css.length };
}

/**
 * Expand `:where(...)` and `:is(...)` into the selectors they stand for.
 *
 * `:where(.run-cmd-btn)` matches the button exactly as `.run-cmd-btn` does,
 * so a scanner that stops at the `:` misses it. The house style makes that
 * shape common: the phone's own block is wrapped in
 * `:where(.app[data-tier="phone"])`.
 */
function expandFunctional(selector) {
  const match = /:(?:where|is)\(([^()]*)\)/i.exec(selector);
  if (!match) return [selector];
  const out = [];
  for (const inner of match[1].split(",")) {
    const rebuilt = `${selector.slice(0, match.index)} ${inner} ${selector.slice(
      match.index + match[0].length,
    )}`;
    out.push(...expandFunctional(rebuilt.replace(/\s+/g, " ").trim()));
  }
  return out;
}

/**
 * The SUBJECT of a selector: the element the rule applies to.
 *
 * The subject is the last compound of the selector — the part after the last
 * descendant / child / sibling combinator. `.run-cmd-btn .kbd` targets a
 * DESCENDANT of the button; `.run-cmd-btn`, `:where(.run-cmd-btn)` and
 * `.toolbar-actions>.run-cmd-btn` target the button itself. A trailing
 * pseudo-class (`:hover`, `:not(.x)`) does not change the subject.
 */
function subjectOf(selector) {
  const compounds = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const last = compounds[compounds.length - 1] ?? "";
  return last.replace(/::?[a-z-]+(\([^()]*\))?$/i, "");
}

/**
 * A class, matched on a class boundary: `.run-cmd-btn` is the button,
 * `.run-cmd-label` is not, and `.run-cmd-btn-extra` is neither.
 */
const classOf = (name) => new RegExp(`\\.${name}(?![\\w-])`);

// The button's own class, and the two classes of the things inside it.
const BUTTON_CLASS = classOf("run-cmd-btn");
const LABEL_CLASS = classOf("run-cmd-label");
const KBD_CLASS = classOf("kbd");

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
    .flatMap((part) => expandFunctional(part.trim()))
    .some((part) => BUTTON_CLASS.test(subjectOf(part)));
}

/**
 * Whether a selector targets a DESCENDANT of the button carrying `cls`.
 *
 * The descendant has to be INSIDE the button (`.run-cmd-btn .run-cmd-label`),
 * not merely share its name — a `.kbd` chip elsewhere on the page is not the
 * palette button's keycap.
 */
function targetsDescendant(selector, cls) {
  return selector
    .split(",")
    .flatMap((part) => expandFunctional(part.trim()))
    .some((part) => {
      const compounds = part.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
      const subject = (compounds[compounds.length - 1] ?? "").replace(
        /::?[a-z-]+(\([^()]*\))?$/i,
        "",
      );
      if (!cls.test(subject)) return false;
      return compounds.slice(0, -1).some((c) => BUTTON_CLASS.test(c));
    });
}

/**
 * The declarations of a rule body, as [property, value] pairs — the last
 * declaration of a property winning, as in CSS.
 *
 * Parsing declarations rather than pattern-matching the whole body is what
 * makes the value comparisons exact: `opacity: 0`, `opacity: 0.0` and
 * `opacity: .0` are all zero, `opacity: 0.5` is not, and `!important` is
 * not part of the value.
 */
function declarations(body) {
  const last = new Map();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    last.set(
      part.slice(0, colon).trim().toLowerCase(),
      part
        .slice(colon + 1)
        .replace(/!important/gi, "")
        .trim()
        .toLowerCase(),
    );
  }
  return last;
}

/**
 * Whether a CSS opacity value is exactly zero.
 *
 * The spellings are many — `0`, `0.0`, `.0`, `0.00`, `.00` — and only the
 * ones that ARE zero hide anything: `opacity: 0.5` must not be mistaken
 * for a hidden button.
 */
function isZeroOpacity(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n === 0;
}

/**
 * Whether a rule body hides what it applies to.
 *
 * The hide vocabulary is the Dock guard's
 * (scripts/check-dock-availability.ts): out of the flow, invisible, or
 * transparent. `!important` is part of the vocabulary on purpose: the rule
 * this script exists to catch was literally `.run-cmd-btn { display: none
 * !important }`, and a pattern that only matched a bare `display: none`
 * would have passed the regression it exists to catch.
 */
function hides(body) {
  return [...declarations(body)].some(
    ([property, value]) =>
      (property === "display" && value === "none") ||
      (property === "visibility" && value === "hidden") ||
      (property === "content-visibility" && value === "hidden") ||
      (property === "opacity" && isZeroOpacity(value)),
  );
}

/**
 * Whether a rule body takes what it applies to OUT OF THE FLOW — removed
 * from the layout, not merely invisible.
 *
 * The desktop pill's WIDTH is what does not fit on a phone, so a label
 * hidden with `opacity: 0` would leave the pill just as wide as before.
 */
function removes(body) {
  return [...declarations(body)].some(
    ([property, value]) => property === "display" && value === "none",
  );
}

const cssFiles = readdirSync(STYLES_DIR).filter((f) => f.endsWith(".css"));

// ---- 1. The button is never hidden -------------------------------------

const hidden = [];
for (const file of cssFiles) {
  const css = stripComments(readFileSync(path.join(STYLES_DIR, file), "utf8"));
  for (const rule of leafRules(css)) {
    if (!targetsButton(rule.selector)) continue;
    if (!hides(rule.body)) continue;
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

/**
 * Every phone block in mobile.css, in source order.
 *
 * There is more than one (four, as of this writing), and they are all
 * top-level, so the LAST rule among them wins — exactly as in the browser.
 * Looking only at the first block would let a later block quietly undo the
 * trim.
 */
function phoneBlocks(css) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(phoneSelector, from);
    if (at < 0) break;
    const open = css.indexOf("{", at);
    const { content, end } = blockAt(css, open);
    blocks.push(content);
    from = end;
  }
  return blocks;
}

/**
 * The rule body the phone's own CSS ends up with for one of the button's
 * descendants — the last rule that says anything about its `display`, across
 * all the phone blocks.
 *
 * The descendant must end up REMOVED FROM THE FLOW, not merely made
 * invisible: `opacity: 0` would leave the desktop pill exactly as wide as
 * before, which is the whole reason the label has to go.
 */
function phoneRule(blocks, cls) {
  let decided = null;
  for (const block of blocks) {
    for (const rule of leafRules(block)) {
      if (!targetsDescendant(rule.selector, cls)) continue;
      if (!declarations(rule.body).has("display")) continue;
      decided = rule.body;
    }
  }
  return decided;
}

const blocks = phoneBlocks(mobile);
if (blocks.length === 0) {
  fail('mobile.css has no :where(.app[data-tier="phone"]) block to check the palette in.');
}
const labelBody = phoneRule(blocks, LABEL_CLASS);
const kbdBody = phoneRule(blocks, KBD_CLASS);
if (!removes(labelBody ?? "") || !removes(kbdBody ?? "")) {
  const displayOf = (body) => (body === null ? "unset" : declarations(body).get("display"));
  fail(
    "the phone tier does not hide the palette button's label and keycap " +
      `(label: ${displayOf(labelBody)}, keycap: ${displayOf(kbdBody)}), so the ` +
      'desktop\'s bordered pill ("Run command…" plus a ⌘K chip) does not fit the ' +
      "phone toolbar (issue #1880).",
  );
}

console.log(
  "OK — the command palette's toolbar button is reachable on the phone, and icon-only there.",
);
