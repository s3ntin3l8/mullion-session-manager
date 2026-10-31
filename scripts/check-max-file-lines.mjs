#!/usr/bin/env node
// The file-size guardrail: no source file may grow past the size ceiling.
//
// WHY this exists: Mullion's codebase has 59 source files over 1,200 code
// lines — 15 of them production, the largest of which hold 59 and 93 route
// handlers respectively. A file that size does not fail loudly — it just gets
// slower to change safely, one edit at a time, until the next change to it
// touches something nobody remembers. The ceiling turns that slow decay into
// a build failure at the moment it happens.
//
// THIS IS A RATCHET, NOT A THRESHOLD. A flat "max 1,200 lines" rule would
// fail on all 59 existing files the day it landed. Instead
// `max-file-lines.baseline.json` records each existing offender's CURRENT
// count, and a file fails only when it exceeds ITS OWN recorded ceiling. So:
//
//   - a NEW file over 1,200 lines fails        (the global ceiling)
//   - a baselined file over ITS ceiling fails  (its ceiling, not the global one)
//   - a baselined file UNDER its ceiling passes, and the script says by how
//     much its ceiling could be lowered
//
// Lowering a ceiling is the ratchet turning over: it is a deliberate,
// reviewable act visible in the diff, and it is how the 59 existing offenders
// get fixed.
//
// The script cannot see the baseline's PREVIOUS values — it only reads the
// file as it stands — so a ceiling RAISED in the baseline is not caught by
// this check. It is caught by the DIFF: recording a larger size for a file
// is a visible change to a committed file, and a reviewer sees it. That is
// why the baseline is a committed file and not a generated one. The policy
// is that ceilings only go DOWN (the giants must shrink); the check
// enforces that growth cannot happen quietly, and the diff is what holds
// the policy.
//
// ONE CONSEQUENCE, and it is not a hypothetical one: the baseline records
// sizes as of a particular commit, so when `main` grows a baselined file —
// which it does, often, on these very files — the next pull request that
// touches it fails this check until the baseline is refreshed. That is
// deliberate: the refresh puts the growth in a diff where a reviewer sees
// it, rather than letting a giant grow unnoticed. Refresh it with
// `node scripts/audit-loc.mjs` and the baseline's own counts.
//
// The counting is shared with the audit that motivates this check
// (`scripts/lib/audit-loc-core.mjs`), so the numbers the reports quote and the
// numbers this enforces are the same numbers.
//
// Usage:
//   node scripts/check-max-file-lines.mjs [root] [--baseline <path>]
//
//   root       the tree to check (default: the repo this script lives in)
//   --baseline the baseline file to read (default: the one beside this script)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AUDIT_ROOTS, countSourceFiles } from "./lib/audit-loc-core.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_BASELINE = path.join(SCRIPT_DIR, "max-file-lines.baseline.json");

/** The fallback ceiling when the baseline does not carry one. */
const FALLBACK_LIMIT = 1200;

/**
 * @param {string[]} argv
 * @returns {{root: string, baseline: string}}
 */
function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, baseline: DEFAULT_BASELINE };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline") {
      if (argv[i + 1]) options.baseline = path.resolve(argv[i + 1]);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) options.root = path.resolve(positional[0]);
  return options;
}

/**
 * @typedef {object} Baseline
 * @property {number} limit
 * @property {Record<string, number>} files
 */

/**
 * @param {string} file
 * @returns {Baseline}
 */
function readBaseline(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    console.error(
      `No baseline file at ${file}. Without one every file over the ceiling ` +
        `fails — the baseline is what records the existing offenders at their ` +
        `current size.`,
    );
    return { limit: FALLBACK_LIMIT, files: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`The baseline file is not valid JSON: ${file}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const limit = typeof parsed.limit === "number" ? parsed.limit : FALLBACK_LIMIT;
  /** @type {Record<string, number>} */
  const files = {};
  for (const [key, value] of Object.entries(parsed.files ?? {})) {
    if (typeof value === "number") files[key] = value;
  }
  return { limit, files };
}

const options = parseArgs(process.argv.slice(2));
const baseline = readBaseline(options.baseline);
const counts = countSourceFiles(options.root, AUDIT_ROOTS);

/** Files that grew past their own ceiling. */
const failures = [];
/** Baselined files that shrank — the ratchet can turn over for these. */
const shrinkable = [];
/** Baseline entries whose file is gone. */
const stale = [];

for (const c of counts) {
  const recorded = baseline.files[c.path];
  if (recorded === undefined) {
    if (c.code > baseline.limit) {
      failures.push({
        path: c.path,
        code: c.code,
        ceiling: baseline.limit,
        reason: "new file over the global ceiling",
      });
    }
    continue;
  }
  if (c.code > recorded) {
    failures.push({
      path: c.path,
      code: c.code,
      ceiling: recorded,
      reason: "grew past its recorded ceiling",
    });
  } else if (c.code < recorded) {
    shrinkable.push({ path: c.path, code: c.code, ceiling: recorded });
  }
}

const counted = new Set(counts.map((c) => c.path));
for (const file of Object.keys(baseline.files)) {
  if (!counted.has(file)) stale.push(file);
}

if (failures.length > 0) {
  console.error("These files are over their size ceiling:");
  for (const f of failures) {
    console.error(`  ${f.path} — ${f.code} code lines, ceiling ${f.ceiling} (${f.reason})`);
  }
  console.error(
    `\nThe ceiling is ${baseline.limit} code lines for a new file, and each\n` +
      "baselined file's own recorded ceiling for an existing one.\n" +
      "Split the file, or record its new size in the baseline file — the\n" +
      "baseline is a committed file, so a size that goes UP shows up in the\n" +
      "diff where a reviewer sees it, and one that goes DOWN is the ratchet\n" +
      "turning over. Either way the growth cannot be silent.",
  );
  process.exit(1);
}

const baselinedHere = counts.filter((c) => baseline.files[c.path] !== undefined);
// Every baselined file sits AT its ceiling until someone lowers it — that is
// what a ratchet is. So the useful list is not "who is about to trip" (all of
// them are one line from tripping) but "whose ceiling is cheapest to lower":
// the small files, which are the ones most likely to be edited next and the
// ones a split would fix.
const smallest = [...baselinedHere]
  .sort((a, b) => baseline.files[a.path] - baseline.files[b.path])
  .slice(0, 10);

console.log(
  `OK — no file is over its size ceiling (${baseline.limit} for a new file; ` +
    `${baselinedHere.length} baselined, all within their own ceilings).`,
);
console.log("");
console.log("Smallest baselined files — the cheapest ceilings to lower:");
for (const c of smallest) {
  console.log(`  ${String(c.code).padStart(7)} / ${baseline.files[c.path]}  ${c.path}`);
}
if (shrinkable.length > 0) {
  console.log("");
  console.log("These files shrank — lower their recorded ceilings to turn the ratchet over:");
  for (const s of shrinkable) {
    console.log(`  ${s.path} — ${s.ceiling} -> ${s.code}`);
  }
}
if (stale.length > 0) {
  console.log("");
  console.log("These baseline entries have no file any more — remove them:");
  for (const s of stale) {
    console.log(`  ${s}`);
  }
}
