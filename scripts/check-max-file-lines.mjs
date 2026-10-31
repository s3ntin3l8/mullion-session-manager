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
// fail on all 59 existing files the day it landed. Instead each file is
// measured against a ceiling of its own, and so:
//
//   - a NEW file over 1,200 lines fails        (the global ceiling)
//   - an existing file that GREW fails        (its size at the reference)
//   - an existing file that did not grow passes
//
// WHAT THE CEILING IS, and why it is not one frozen number:
//
//   ceiling(file) = max(baseline entry, size at the reference commit)
//
// The baseline entry (`max-file-lines.baseline.json`) is where the file stood
// when the baseline was written — the floor, so the giants must not grow.
// The size at the reference commit is where the file stood where this branch
// forked from the default branch.
//
// The second term is what makes the guard survivable. Without it the baseline
// is a snapshot that goes stale the moment `main` grows one of these files —
// which it does, often, on these very files — and then EVERY later pull
// request fails, because the guard reads the whole tree and not just the
// files the pull request touched. With it, a pull request is only ever
// judged against what it actually changed, and `main`'s own growth is never
// mistaken for someone else's.
//
// So the policy is unchanged: the giants must not grow. What changed is that
// the guard enforces it against the change in front of it, rather than
// against a number that goes out of date on its own.
//
// A ceiling can still be LOWERED — that is the ratchet turning over, a
// deliberate reviewable act visible in the diff, and it is how the 59
// existing offenders get fixed. The script cannot see the baseline's PREVIOUS
// values, so a ceiling RAISED in the baseline is caught by that diff rather
// than by this check; that is why the baseline is a committed file and not a
// generated one.
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

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.mjs";
import { AUDIT_ROOTS, countFileLines, countSourceFiles } from "./lib/audit-loc-core.mjs";

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

/**
 * The commit this tree is compared against: the MERGE BASE with the default
 * branch. Everything is measured against where the branch forked, not against
 * the tip of `main`, so a change that `main` itself made afterwards is not
 * mistaken for this branch's growth.
 *
 * @param {string} root
 * @returns {string | null}
 */
function resolveReferenceCommit(root) {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    try {
      const base = execFileSync("git", [...GIT_NO_AUTO_GC, "merge-base", "HEAD", ref], {
        cwd: root,
        encoding: "utf8",
        env: gitEnv(),
      }).trim();
      if (base) return base;
    } catch {
      // No such ref, or not a git checkout — try the next one.
    }
  }
  return null;
}

/**
 * A file's code-line count at the reference commit, or null when it did not
 * exist there (a new file) or the reference is unavailable.
 *
 * @param {string} root
 * @param {string | null} reference
 * @param {string} relPath
 * @returns {number | null}
 */
function codeLinesAtReference(root, reference, relPath) {
  if (!reference) return null;
  try {
    const content = execFileSync("git", [...GIT_NO_AUTO_GC, "show", `${reference}:${relPath}`], {
      cwd: root,
      encoding: "utf8",
      env: gitEnv(),
      maxBuffer: 64 * 1024 * 1024,
      // A file that did not exist at the reference is a normal answer, not an
      // error — git's "fatal: path ... exists on disk, but not in ..." would
      // otherwise print for every new file in the tree.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return countFileLines(content, relPath).code;
  } catch {
    return null;
  }
}

const reference = resolveReferenceCommit(options.root);

/** Files that grew past their own ceiling. */
const failures = [];
/** Baselined files that shrank — the ratchet can turn over for these. */
const shrinkable = [];
/** Baseline entries whose file is gone. */
const stale = [];

for (const c of counts) {
  const recorded = baseline.files[c.path];
  // A file under the limit can never fail: its floor is the limit itself, so
  // the ceiling is at least the limit and the file is below it. That is the
  // overwhelming majority of the tree, and asking git about each one would
  // spawn a process per file for nothing.
  if (c.code <= baseline.limit) {
    if (recorded !== undefined && c.code < recorded) {
      shrinkable.push({ path: c.path, code: c.code, ceiling: recorded });
    }
    continue;
  }
  // The ceiling is the HIGHER of the two references:
  //
  //   - the baseline's recorded size, which is where the file stood when the
  //     baseline was written (the floor — the giants must not grow);
  //   - the file's size at the reference commit, which absorbs any growth
  //     `main` itself made after the baseline was written.
  //
  // Without the second term the guard would break the build of every later
  // pull request the moment `main` grew one of these files — a change the
  // pull request did not make. With it, a pull request is only ever judged
  // against what it actually changed.
  const atReference = codeLinesAtReference(options.root, reference, c.path);
  const floor = recorded === undefined ? baseline.limit : recorded;
  const ceiling = Math.max(floor, atReference ?? 0);

  if (c.code > ceiling) {
    failures.push({
      path: c.path,
      code: c.code,
      ceiling,
      reason:
        recorded === undefined
          ? "new file over the global ceiling"
          : "grew past the size it had at the reference commit",
    });
    continue;
  }
  if (recorded !== undefined && c.code < recorded) {
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
    `\nThe ceiling is ${baseline.limit} code lines for a new file, and for an\n` +
      "existing file the size it had at the reference commit — so this check\n" +
      "is asking whether THIS change made a file bigger, not whether the\n" +
      "file is bigger than it was once.\n" +
      "Split the file, or — if the growth is deliberate — record the new size\n" +
      "in the baseline file: it is a committed file, so a size that goes UP\n" +
      "shows up in the diff where a reviewer sees it, and one that goes DOWN\n" +
      "is the ratchet turning over. Either way the growth cannot be silent.",
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
