#!/usr/bin/env -S npx tsx
// Issue #1881 — the Dock's availability, and the CSS that decides it.
//
// The Dock is hidden by TWO rules:
//
//   - `frontend/src/styles/tablet.css` hides `.dock` under
//     `@media (pointer: coarse)`;
//   - `frontend/src/styles/mobile.css` hides it under the phone tier.
//
// So "is the Dock available?" is not one question but two, and the palette
// and the Settings section have to agree with the CSS about BOTH. They read
// one shared predicate (`frontend/src/lib/dockAvailability.ts`), so the
// remaining risk is that the predicate and the stylesheets drift apart — a
// stylesheet that stops hiding the Dock, or starts hiding it under a
// condition the predicate does not know.
//
// This script is that guard. It finds EVERY rule in EVERY stylesheet that
// hides `.dock`, works out the condition each one hangs under, and fails
// unless that set of conditions is exactly the predicate's own reason set.
// Two ways it can fail:
//
//   - a hiding rule under a condition the predicate does not know (a new
//     media query, say) — the palette would promise a Dock the CSS hides;
//   - a known condition with no hiding rule — the palette would warn about
//     a Dock that is actually there.
//
// It lives here rather than in a vitest file for one concrete reason: Vitest
// stubs CSS imports (`css: false` in frontend/vitest.config.ts), so a test
// cannot read a stylesheet's text — the `?raw` import resolves to an empty
// string. This repo's own precedent for "assert something about a source
// file's contents" is a `scripts/check-*` node script wired into
// `npm run lint` (see check-token-contrast.mjs, whose header comment says
// the same thing, and check-case-collision.mjs).
//
// A `.ts` file run via `tsx` rather than `.mjs` like this directory's other
// scripts — it needs the real, typed predicate from the frontend, so that
// the script and the frontend cannot disagree about what the reasons ARE
// (precedent: generate-ssh-agent-filter-vectors.ts, check-scope-leaks.ts).
// That only works because `dockAvailability.ts` is pure: it imports nothing
// but a type, so it pulls neither React nor the store into this script's
// typecheck or its runtime.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCK_UNAVAILABLE,
  dockUnavailableReason,
  type DockUnavailableReason,
} from "../frontend/src/lib/dockAvailability.js";
import type { LayoutTier } from "../frontend/src/lib/layoutTierTypes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STYLES_DIR = path.join(ROOT, "frontend", "src", "styles");

const TIERS: LayoutTier[] = ["phone", "tablet", "desktop"];

// CSS comments are stripped before anything is matched. The stylesheets
// explain their rules in comments that quote the very query the rule uses
// (`gated on `(pointer: coarse)``), and a scanner that read comments would
// find the comment's occurrence first, take the NEXT `{` as its block — which
// is the real rule's block — and pass even when the rule itself had been
// changed to something else. Matching comments is how this guard would have
// quietly stopped guarding.
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// The conditions the predicate knows, and the query each one is written as.
//
// The leading paren is part of the pattern on purpose: `(pointer: coarse)`
// and `(any-pointer: coarse)` are DIFFERENT queries — the first is the
// primary pointer, the second includes a touch screen on a device whose
// primary pointer is a mouse — and a guard that matched both would not be a
// guard.
const KNOWN_CONDITIONS: Array<{ pattern: RegExp; reason: DockUnavailableReason }> = [
  { pattern: /\(pointer:\s*coarse\)/, reason: "coarse-pointer" },
  { pattern: /\[data-tier="phone"\]/, reason: "phone-tier" },
];

interface LeafRule {
  // The blocks this rule hangs under, outermost first: an at-rule's prelude
  // (`@media (pointer: coarse)`), then any nested selector's own prelude.
  // The rule's own selector is NOT one of them — the selector says WHAT the
  // rule matches, the conditions say WHEN.
  conditions: string[];
  selector: string;
  body: string;
}

// The index of the `}` that closes the `{` at `open`.
function matchBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

/**
 * The leaf rules of a stylesheet, each with the conditions it hangs under.
 *
 * A leaf rule is one whose body holds declarations rather than nested
 * rules — so a `@media` block, and this repo's
 * `:where(.app[data-tier="phone"])` block, are not rules themselves; the
 * rules inside them are, carrying those blocks as their conditions.
 */
function leafRules(css: string, conditions: string[] = []): LeafRule[] {
  const found: LeafRule[] = [];
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace === -1) break;
    const head = css.slice(i, brace);
    // What comes before this rule's selector may be the parent block's own
    // trailing declarations, so the selector starts after the last `;` or
    // `}` in the head.
    const cut = Math.max(head.lastIndexOf(";"), head.lastIndexOf("}"));
    const selector = (cut >= 0 ? head.slice(cut + 1) : head).trim();
    const close = matchBrace(css, brace);
    const body = css.slice(brace + 1, close);
    if (selector) {
      if (body.includes("{")) {
        found.push(...leafRules(body, [...conditions, selector]));
      } else {
        found.push({ conditions, selector, body });
      }
    }
    i = close + 1;
  }
  return found;
}

// Whether a selector's SUBJECT is the Dock element itself — `.dock`, not
// `.dock-header` or `.dock-group`.
function targetsDock(selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim().split(/\s+/).pop() ?? "")
    .some((compound) => compound.replace(/::?[a-z-]+(\([^)]*\))?$/i, "") === ".dock");
}

// The `!important` is part of the pattern on purpose: the rules this script
// guards against are literally `display: none !important`.
const HIDES = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)\s*(!important\s*)?(;|$)/i;

interface HidingRule {
  file: string;
  condition: string;
  reasons: DockUnavailableReason[];
  unknown: boolean;
}

/**
 * Every rule in every stylesheet that hides the Dock.
 *
 * `unknown` marks a hiding rule whose condition the predicate does not know
 * — that is the case where the CSS hides the Dock somewhere the app's
 * wording says it is available, and the script has to fail.
 */
function dockHidingRules(): HidingRule[] {
  const found: HidingRule[] = [];
  for (const file of readdirSync(STYLES_DIR).filter((f) => f.endsWith(".css"))) {
    const css = stripComments(readFileSync(path.join(STYLES_DIR, file), "utf8"));
    for (const rule of leafRules(css)) {
      if (!targetsDock(rule.selector)) continue;
      if (!HIDES.test(rule.body)) continue;
      const reasons: DockUnavailableReason[] = [];
      let unknown = false;
      for (const condition of rule.conditions) {
        const known = KNOWN_CONDITIONS.find((k) => k.pattern.test(condition));
        if (known) {
          if (!reasons.includes(known.reason)) reasons.push(known.reason);
        } else {
          unknown = true;
        }
      }
      found.push({
        file,
        condition: rule.conditions.length ? rule.conditions.join(" → ") : "(no condition)",
        reasons,
        unknown,
      });
    }
  }
  return found;
}

function fail(message: string): never {
  console.error(`FAIL — ${message}`);
  process.exit(1);
}

// The reasons the predicate can return, over every tier and both pointers.
function predicateReasons(): DockUnavailableReason[] {
  const reasons = new Set<DockUnavailableReason>();
  for (const tier of TIERS) {
    for (const coarsePointer of [false, true]) {
      const reason = dockUnavailableReason(tier, coarsePointer);
      if (reason) reasons.add(reason);
    }
  }
  return [...reasons].sort();
}

const predicate = predicateReasons();
const hiding = dockHidingRules();

// A hiding rule under a condition the predicate does not know: the CSS
// hides the Dock somewhere the app's wording says it is available.
const unknown = hiding.filter((h) => h.unknown);
if (unknown.length > 0) {
  fail(
    "the Dock is hidden under a condition the availability predicate does not know:\n" +
      unknown.map((h) => `  ${h.file}: ${h.condition}`).join("\n") +
      "\n  The predicate would promise a Dock the CSS hides. Add the condition to " +
      "lib/dockAvailability.ts (a new reason, and its wording), or narrow the rule.",
  );
}

// Every reason the predicate knows needs a hiding rule, and every hiding
// rule needs a reason.
const cssReasons = [...new Set(hiding.flatMap((h) => h.reasons))].sort();
if (JSON.stringify(predicate) !== JSON.stringify(cssReasons)) {
  fail(
    "the Dock's availability and the CSS that hides it disagree.\n" +
      `  the predicate says the Dock is unavailable for: ${predicate.join(", ") || "(nothing)"}\n` +
      `  the stylesheets hide it under:              ${cssReasons.join(", ") || "(nothing)"}\n` +
      "  every reason needs a hiding rule, and every hiding rule needs a reason.",
  );
}

// Every reason also needs its wording — a reason the surfaces cannot say
// is a reason the user never reads.
for (const reason of predicate) {
  const wording = DOCK_UNAVAILABLE[reason];
  if (!wording?.short || !wording.text) {
    fail(`the reason "${reason}" has no wording in DOCK_UNAVAILABLE.`);
  }
}

console.log(
  `OK — the Dock's availability and the CSS that hides it agree (${predicate.join(", ")}).`,
);
