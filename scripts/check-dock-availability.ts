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
// This script is that guard. It reads the stylesheets, finds the conditions
// under which `.dock` is hidden, and fails when that set is not exactly the
// predicate's own reason set. Change tablet.css's query to
// `(any-pointer: coarse)`, or drop either `.dock { display: none }` rule, and
// this fails.
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

import { readFileSync } from "node:fs";
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

// CSS comments are stripped before anything is matched. Both stylesheets
// explain their rule in a comment that quotes the very query the rule uses
// (`gated on `(pointer: coarse)``), and a scanner that read comments would
// find the comment's occurrence first, take the NEXT `{` as its block — which
// is the real rule's block — and pass even when the rule itself had been
// changed to something else. Matching comments is how this guard would have
// quietly stopped guarding.
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// The text inside the block whose opening brace is at `open`.
function blockAt(css: string, open: number): string {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open, i);
    }
  }
  return css.slice(open);
}

// The rules that hide the Dock, and the condition each one hangs under.
//
// The leading paren is part of the pattern on purpose: `(pointer: coarse)`
// and `(any-pointer: coarse)` are DIFFERENT queries — the first is the
// primary pointer, the second includes a touch screen on a device whose
// primary pointer is a mouse — and a guard that matched both would not be a
// guard.
const HIDING_RULES: Array<{ file: string; pattern: RegExp; reason: DockUnavailableReason }> = [
  {
    file: "tablet.css",
    pattern: /\(pointer:\s*coarse\)/,
    reason: "coarse-pointer",
  },
  {
    file: "mobile.css",
    pattern: /\[data-tier="phone"\]/,
    reason: "phone-tier",
  },
];

function dockHidingConditions(): DockUnavailableReason[] {
  const found: DockUnavailableReason[] = [];
  for (const { file, pattern, reason } of HIDING_RULES) {
    const css = stripComments(readFileSync(path.join(STYLES_DIR, file), "utf8"));
    // Every occurrence of the condition, and the Dock has to be hidden
    // INSIDE one of their blocks — not merely somewhere below them.
    for (const match of css.matchAll(new RegExp(pattern.source, "g"))) {
      const open = css.indexOf("{", match.index);
      if (open < 0) continue;
      if (/\.dock\s*\{[^}]*display:\s*none/.test(blockAt(css, open))) {
        found.push(reason);
        break;
      }
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
const css = [...new Set(dockHidingConditions())].sort();

// The two sets have to be the same. Either one alone is a lie: the
// predicate's set is what the UI says, and the CSS's set is what the
// browser does.
if (JSON.stringify(predicate) !== JSON.stringify(css)) {
  fail(
    `the Dock's availability and the CSS that hides it disagree.\n` +
      `  the predicate says the Dock is unavailable for: ${predicate.join(", ") || "(nothing)"}\n` +
      `  the stylesheets hide it under:              ${css.join(", ") || "(nothing)"}\n` +
      `  every reason needs a hiding rule, and every hiding rule needs a reason.`,
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
