// @ts-check
// The line-counting core behind `scripts/audit-loc.mjs` (the code-health
// audit's evidence generator) and `scripts/check-max-file-lines.mjs` (the
// file-size guardrail).
//
// This is a separate, dependency-free module on purpose: the COUNT IS the
// deliverable of both tools. If the two scripts counted lines differently, the
// audit's tables and the guardrail's baseline would disagree — the report
// would quote a number the guardrail does not enforce, and the baseline's
// ceilings would drift from reality one comment at a time. So the counting
// lives in ONE place and both tools import it.
//
// Everything here is pure apart from the filesystem reads: no network, no
// dependencies, no I/O beyond reading the files being counted.
//
// `// @ts-check` (issue #1921) makes the compiler verify these bodies against
// their JSDoc instead of trusting it — a `return` slipped into a function
// annotated as never-undefined is an error here, not a silent break in its
// callers. This module is type-checked because the test imports it directly
// (see `test/scripts/check-max-file-lines.test.ts`).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The file extensions that count as source for this audit. CSS, Markdown,
 * YAML and SQL are deliberately excluded: they are not the surface this audit
 * is about, and counting them would put a stylesheet's line count next to a
 * route module's in a table that is meant to compare code.
 */
export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Directories that are never part of the source tree.
 *
 * - `node_modules`, `dist`, `build`, `coverage` — build and install output.
 * - `.wt` — this repo's OWN developer worktrees (AGENTS.md's "two worktree
 *   concepts" invariant), each a full separate checkout with its own copy of
 *   `src/`. Counting one would double-count the whole backend.
 * - `.mullion-worktrees` — Mullion's own PRODUCT feature
 *   (`src/services/git-worktree.ts`), the same class of directory under a
 *   different root.
 * - `.claude` — agent-isolation worktrees and agent config.
 *
 * The same exclusion set is documented in `vitest.shared.ts`'s
 * `worktreeExcludes`, so the audit and the coverage run agree about what the
 * source tree is.
 */
export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".wt",
  ".mullion-worktrees",
  ".claude",
]);

/**
 * The directories this audit covers, relative to the repository root.
 *
 * `src/` is the backend, `frontend/src/` the React workspace, `test/` the
 * backend's test tree (it MIRRORS `src/` rather than living beside it — see
 * AGENTS.md's "Tests live in `test/`, mirror `src/`"), and `scripts/` the
 * repo's own tooling, which this audit counts because it ships the guardrails.
 */
export const AUDIT_ROOTS = ["src", "frontend/src", "test", "scripts"];

/**
 * @typedef {object} FileCounts
 * @property {string} path          repo-relative POSIX path
 * @property {number} total         every line in the file
 * @property {number} code          lines that are neither blank nor comment
 * @property {number} blank         lines that are empty or whitespace only
 * @property {number} comment       lines that are wholly a comment
 */

/**
 * @typedef {object} AreaCounts
 * @property {string} area          the area label
 * @property {number} files         how many files
 * @property {number} code          summed code lines
 * @property {number} total         summed total lines
 */

/**
 * Count one file's lines, classifying each as code, blank or comment.
 *
 * The classification is deliberately conservative about what counts as CODE: a
 * line counts as code only if it has code on it. A block comment that opens
 * and closes on the same line contributes its trailing code (`/* x *\/ y` ->
 * one code line) and the rest of that line's comment is counted as comment;
 * a block comment that spans lines contributes no code until the line it
 * closes on, and only if that line has something after the closer.
 *
 * This is the same algorithm that produced the audit's baseline numbers, so
 * the numbers in the report and the numbers the guardrail enforces are the
 * same numbers.
 *
 * @param {string} text  the file's contents
 * @param {string} relPath  repo-relative POSIX path, for the result
 * @returns {FileCounts}
 */
export function countFileLines(text, relPath) {
  const lines = text.split("\n");
  // A file ending in a newline yields a trailing empty element that is not a
  // line. An EMPTY file yields [""] which is likewise not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let code = 0;
  let blank = 0;
  let comment = 0;
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (inBlock) {
      comment += 1;
      if (line.includes("*/")) {
        inBlock = false;
        // Everything up to and including the FIRST closer is comment; what
        // follows it is code.
        const rest = line.replace(/^[^*]*\*\//, "");
        if (rest.trim() !== "") code += 1;
      }
      continue;
    }

    if (line === "") {
      blank += 1;
      continue;
    }

    if (line.startsWith("//")) {
      comment += 1;
      continue;
    }

    if (line.startsWith("/*")) {
      comment += 1;
      if (!line.includes("*/")) {
        inBlock = true;
      } else {
        const rest = line.replace(/^[^*]*\*\//, "");
        if (rest.trim() !== "") code += 1;
      }
      continue;
    }

    code += 1;
  }

  return { path: relPath, total: lines.length, code, blank, comment };
}

/**
 * Collect every source file under the given sub-directories, recursively.
 *
 * The walk is over the FILESYSTEM rather than `git ls-files` on purpose: the
 * guardrail has to catch a file that is over the ceiling even when it is not
 * committed yet, and the check script has to be drivable against a fixture
 * tree that is not a git repository at all. On a clean checkout the two agree
 * exactly (the audit's own numbers were cross-checked against `git ls-files`).
 *
 * @param {string} root  the directory to walk
 * @param {string[]} [subdirs]  the sub-directories to walk, relative to `root`
 * @returns {string[]}  repo-relative POSIX paths, sorted
 */
export function collectSourceFiles(root, subdirs = AUDIT_ROOTS) {
  /** @type {string[]} */
  const found = [];

  /**
   * @param {string} dir
   */
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };

  for (const sub of subdirs) {
    const dir = path.join(root, sub);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a fixture tree need not have every root
    }
    void entries;
    walk(dir);
  }

  return found.sort();
}

/**
 * Count every source file under the given sub-directories.
 *
 * @param {string} root  the directory to walk
 * @param {string[]} [subdirs]  the sub-directories to walk, relative to `root`
 * @returns {FileCounts[]}
 */
export function countSourceFiles(root, subdirs = AUDIT_ROOTS) {
  const results = [];
  for (const rel of collectSourceFiles(root, subdirs)) {
    let text;
    try {
      text = readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    results.push(countFileLines(text, rel));
  }
  return results;
}

/**
 * Label the area a file belongs to, the way the audit's tables group them.
 *
 * @param {string} relPath
 * @returns {string}
 */
export function areaOf(relPath) {
  if (relPath.startsWith("src/")) return "backend production (src/)";
  if (relPath.startsWith("test/")) return "backend tests (test/)";
  if (relPath.startsWith("scripts/")) return "tooling (scripts/)";
  if (relPath.startsWith("frontend/src/")) {
    // The frontend keeps its tests COLOCATED, beside the file they cover,
    // rather than in a mirrored tree the way the backend does.
    return /\.test\.tsx?$/.test(relPath)
      ? "frontend tests (colocated)"
      : "frontend production (frontend/src/)";
  }
  return "other";
}

/**
 * Group counted files into the audit's per-area summary.
 *
 * @param {FileCounts[]} counts
 * @returns {AreaCounts[]}
 */
export function summariseByArea(counts) {
  /** @type {Map<string, AreaCounts>} */
  const byArea = new Map();
  for (const c of counts) {
    const area = areaOf(c.path);
    const entry = byArea.get(area) ?? { area, files: 0, code: 0, total: 0 };
    entry.files += 1;
    entry.code += c.code;
    entry.total += c.total;
    byArea.set(area, entry);
  }
  const order = [
    "backend production (src/)",
    "frontend production (frontend/src/)",
    "backend tests (test/)",
    "frontend tests (colocated)",
    "tooling (scripts/)",
    "other",
  ];
  return order.map((area) => byArea.get(area)).filter((entry) => entry !== undefined);
}

/**
 * Bucket files by their code-line count, for the size histogram.
 *
 * @param {FileCounts[]} counts
 * @param {number} [bucketSize]
 * @returns {{label: string, files: number}[]}
 */
export function histogram(counts, bucketSize = 250) {
  /** @type {Map<number, number>} */
  const buckets = new Map();
  for (const c of counts) {
    const key = Math.floor(c.code / bucketSize) * bucketSize;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, files]) => ({
      label: `${start}-${start + bucketSize - 1}`,
      files,
    }));
}
