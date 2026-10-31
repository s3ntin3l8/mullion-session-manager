#!/usr/bin/env node
// The evidence generator for Mullion's code-health audit.
//
// It prints the per-file line-of-code map the audit reports quote: the
// per-area totals, the size histogram, the largest files, the non-test files
// over the size ceiling, and (with --churn) how much each file has changed in
// the last year.
//
// WHY a script and not a committed artifact: the audit skill's rule is
// "Evidence: a command, never a link to a file". A committed table is a
// snapshot that goes stale the moment somebody lands a commit; a committed
// command is always current. So this script IS the evidence, and the reports
// quote its output.
//
// The counting lives in `scripts/lib/audit-loc-core.mjs`, shared with the
// file-size guardrail (`scripts/check-max-file-lines.mjs`) — the report's
// numbers and the guardrail's ceilings must be the same numbers.
//
// Usage:
//   node scripts/audit-loc.mjs [root] [--top N] [--json] [--tsv] [--churn]
//
//   root     the repository to audit (default: the repo this script lives in)
//   --top N  how many files the "largest files" table lists (default 30)
//   --json   print the whole map as JSON
//   --tsv    print one TSV row per file (path, total, code, blank, comment)
//   --churn  add the 12-month churn table (needs a git checkout)

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUDIT_ROOTS,
  areaOf,
  countSourceFiles,
  histogram,
  summariseByArea,
} from "./lib/audit-loc-core.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");

/** The size ceiling the audit reports against — the guardrail's limit. */
const SIZE_CEILING = 1200;

/**
 * @param {string[]} argv
 * @returns {{root: string, top: number, json: boolean, tsv: boolean, churn: boolean}}
 */
function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    top: 30,
    json: false,
    tsv: false,
    churn: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--top") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) options.top = Math.floor(value);
      i += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--tsv") {
      options.tsv = true;
    } else if (arg === "--churn") {
      options.churn = true;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) options.root = path.resolve(positional[0]);
  return options;
}

/**
 * The 12-month churn of every production file: lines added, and the number of
 * commits that touched it. A file that is both large AND heavily churned is
 * where the next change is most likely to break something.
 *
 * @param {string} root
 * @returns {{path: string, added: number, commits: number}[]}
 */
function churnTable(root) {
  let output;
  try {
    output = execFileSync(
      "git",
      ["log", "--since=12 months ago", "--numstat", "--format=", "--", "src/**", "frontend/src/**"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return [];
  }
  /** @type {Map<string, {added: number, commits: number}>} */
  const byFile = new Map();
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = Number(parts[0]);
    if (!Number.isFinite(added)) continue;
    const file = parts[2];
    const entry = byFile.get(file) ?? { path: file, added: 0, commits: 0 };
    entry.added += added;
    entry.commits += 1;
    byFile.set(file, entry);
  }
  return [...byFile.values()].sort((a, b) => b.added - a.added);
}

const options = parseArgs(process.argv.slice(2));
const counts = countSourceFiles(options.root, AUDIT_ROOTS);
const production = counts.filter(
  (c) => !/\.test\.tsx?$/.test(c.path) && areaOf(c.path) !== "other",
);
const over = production.filter((c) => c.code > SIZE_CEILING);

if (options.tsv) {
  for (const c of counts) {
    console.log(`${c.path}\t${c.total}\t${c.code}\t${c.blank}\t${c.comment}`);
  }
}

if (options.json) {
  console.log(
    JSON.stringify(
      {
        root: options.root,
        total: {
          files: counts.length,
          code: counts.reduce((n, c) => n + c.code, 0),
          total: counts.reduce((n, c) => n + c.total, 0),
        },
        areas: summariseByArea(counts),
        histogram: histogram(counts),
        largest: [...counts].sort((a, b) => b.code - a.code).slice(0, options.top),
        productionOverCeiling: { ceiling: SIZE_CEILING, files: over },
        files: counts,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log("Mullion — code-size map");
console.log(`Root: ${options.root}`);
console.log("");

console.log("== Per-area totals ==");
console.log("  Area                                 Files      Code     Total");
for (const area of summariseByArea(counts)) {
  console.log(
    `  ${area.area.padEnd(38)} ${String(area.files).padStart(5)} ${String(area.code).padStart(9)} ${String(area.total).padStart(9)}`,
  );
}
console.log(
  `  ${"TOTAL".padEnd(38)} ${String(counts.length).padStart(5)} ${String(counts.reduce((n, c) => n + c.code, 0)).padStart(9)} ${String(counts.reduce((n, c) => n + c.total, 0)).padStart(9)}`,
);
console.log("");

console.log("== Size histogram (code lines) ==");
for (const bucket of histogram(counts)) {
  console.log(`  ${bucket.label.padEnd(12)} ${String(bucket.files).padStart(5)} files`);
}
console.log("");

console.log(`== Largest ${options.top} files (code lines) ==`);
console.log("     Code    Total  Path");
for (const c of [...counts].sort((a, b) => b.code - a.code).slice(0, options.top)) {
  console.log(`  ${String(c.code).padStart(7)} ${String(c.total).padStart(8)}  ${c.path}`);
}
console.log("");

console.log(`== Non-test files over ${SIZE_CEILING} code lines (${over.length}) ==`);
for (const c of [...over].sort((a, b) => b.code - a.code)) {
  console.log(`  ${String(c.code).padStart(7)}  ${c.path}`);
}

if (options.churn) {
  console.log("");
  console.log("== Churn, last 12 months (production files) ==");
  console.log("     Added  Commits  Path");
  for (const entry of churnTable(options.root).slice(0, options.top)) {
    console.log(
      `  ${String(entry.added).padStart(7)} ${String(entry.commits).padStart(8)}  ${entry.path}`,
    );
  }
}
