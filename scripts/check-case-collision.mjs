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

// Only files a TypeScript import can resolve are at risk: an asset is
// always imported WITH its extension ("./favicon.svg"), so two assets that
// share a stem are unambiguous. A module is imported by name
// ("./UnifiedBoard.js"), and the extension is what the resolver guesses —
// which is exactly where a case-only difference bites.
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
  // directory -> lowercased import name -> the file names that map to it
  const byName = new Map();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      if (!MODULE_EXTENSIONS.has(moduleExtension(entry.name))) continue;
      const key = importName(entry.name).toLowerCase();
      const list = byName.get(key) ?? [];
      list.push(entry.name);
      byName.set(key, list);
    }
  }
  for (const [key, list] of byName) {
    if (list.length > 1) {
      collisions.push({
        dir: path.relative(ROOT, dir) || ".",
        key,
        files: list.sort(),
      });
    }
  }
}

walk(ROOT);

if (collisions.length > 0) {
  console.error("These file names differ only in case, in the same directory:");
  for (const c of collisions) {
    console.error(`  ${c.dir}/ — ${c.files.join("  and  ")}`);
  }
  console.error(
    "\nAn extensionless import specifier cannot tell them apart on a\n" +
      'case-insensitive filesystem (macOS): "./Name.js" resolves to\n' +
      "whichever the filesystem finds first, and TypeScript fails the build\n" +
      "with TS1149. Rename one of them so the names differ by more than\n" +
      "case (issue #1803).",
  );
  process.exit(1);
}

console.log("OK — no two file names in a directory differ only in case.");
