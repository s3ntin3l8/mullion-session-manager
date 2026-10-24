#!/usr/bin/env node
// Issue #1803 — two files in the same directory whose names differ only in
// case make an extensionless import specifier AMBIGUOUS on a
// case-insensitive filesystem (macOS's default APFS volume): "./UnifiedBoard.js"
// then resolves to whichever of the two the filesystem finds first, and
// TypeScript reports TS1149 ("File name … differs from already included
// file name … only in casing") — the frontend does not build at all on a
// Mac.
//
// This is not hypothetical: frontend/src/UnifiedBoard.tsx (the component) and
// frontend/src/unifiedBoard.ts (its lane helpers) sat side by side for
// months, and the frontend build failed on a Mac with:
//
//   src/panels/registry.tsx(47,10): error TS1149: File name
//     '…/frontend/src/UnifiedBoard.ts' differs from already included file
//     name '…/frontend/src/unifiedBoard.ts' only in casing.
//
// Linux CI is green because ext4 is case-sensitive, so the two files coexist
// there and every specifier resolves unambiguously.
//
// This check is the guard: it fails when the tree grows a pair like that
// again, in CI on Linux, before a Mac build trips over it.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The tree to check: this repository by default, or the directory given as
// the first argument (that is what the test drives it with).
const ROOT = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);

// Directories that are never part of the source tree (and where a pair like
// this is nobody's problem).
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".wt",
  ".mullion-worktrees",
  "playwright-report",
  "test-results",
]);

// The name a file is imported BY: its basename without the last extension
// ("UnifiedBoard.tsx" -> "UnifiedBoard", "unifiedBoard.ts" -> "unifiedBoard").
// The extension is what distinguishes the two files on a case-sensitive
// filesystem — and what an extensionless specifier cannot use.
function importName(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

// Two rules, because they catch different things:
//
//   1. the same STEM ignoring case, for module files — an extensionless
//      specifier cannot tell "Foo.ts" from "foo.tsx" apart on a
//      case-insensitive filesystem, and TypeScript fails the build with
//      TS1149. Only files a TypeScript import can resolve are at risk
//      here: a module is imported BY NAME ("./UnifiedBoard.js") and the
//      extension is what the resolver guesses.
//   2. the same FULL NAME ignoring case, for ANY file and any directory —
//      "favicon.svg" and "Favicon.svg" cannot even coexist on a
//      case-insensitive filesystem: a git checkout collapses one into the
//      other and the tree silently diverges from the index. A directory
//      and a file are the same story (they cannot share a name, case
//      aside).
//
// Rule 1 alone would miss the asset pairs; rule 2 alone would miss the
// "Foo.ts" vs "foo.tsx" pair (different full names). So both are checked.
const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function moduleExtension(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot) : "";
}

const collisions = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const stems = new Map();
  const fullNames = new Map();
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
    } else if (!entry.isFile()) {
      continue;
    }
    const full = fullNames.get(name.toLowerCase()) ?? [];
    full.push(entry.isDirectory() ? `${name}/` : name);
    fullNames.set(name.toLowerCase(), full);
    if (entry.isFile() && MODULE_EXTENSIONS.has(moduleExtension(name))) {
      const key = importName(name).toLowerCase();
      const list = stems.get(key) ?? [];
      list.push(name);
      stems.set(key, list);
    }
  }
  const where = path.relative(ROOT, dir) || ".";
  const reported = new Set();
  for (const list of stems.values()) {
    if (list.length > 1) {
      const files = list.slice().sort();
      reported.add(files.join("|"));
      const extensions = new Set(files.map((f) => moduleExtension(f)));
      collisions.push({
        dir: where,
        reason:
          extensions.size > 1
            ? "the same name ignoring case, with different extensions — an import specifier cannot tell them apart"
            : "the same name ignoring case",
        files,
      });
    }
  }
  for (const list of fullNames.values()) {
    if (list.length > 1) {
      const files = list.slice().sort();
      // A pair the stem rule already reported is not reported twice.
      if (reported.has(files.join("|"))) continue;
      collisions.push({
        dir: where,
        reason:
          "the same name ignoring case — they cannot coexist on a case-insensitive filesystem",
        files,
      });
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      walk(path.join(dir, entry.name));
    }
  }
}

walk(ROOT);

if (collisions.length > 0) {
  console.error("These file names differ only in case, in the same directory:");
  for (const c of collisions) {
    console.error(`  ${c.dir}/ — ${c.files.join("  and  ")}`);
    console.error(`      ${c.reason}`);
  }
  console.error(
    "\nOn a case-insensitive filesystem (macOS's default) two such names\n" +
      "cannot coexist: a git checkout collapses one into the other, and the\n" +
      "tree silently diverges from the index. An import specifier cannot\n" +
      'tell them apart either ("./Name.js" resolves to whichever the\n' +
      "filesystem finds first), and TypeScript fails the build with TS1149.\n" +
      "Rename one of them so the names differ by more than case (issue\n" +
      "#1803).",
  );
  process.exit(1);
}

console.log("OK — no two file names in a directory differ only in case.");
