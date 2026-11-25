#!/usr/bin/env node
// Issue #2412 — the shared-type guardrail.
//
// WHY THIS EXISTS
//
// The frontend used to hand-maintain a copy of every API shape the backend
// declares: `frontend/src/api/types.ts` and its neighbours carried ~95 types
// with a same-named backend twin, kept in sync by hand with no compiler
// enforcement, and several had quietly drifted (a field the backend sends but
// the frontend never learned about, a union member one side lacked, a `Date`
// typed `string` on one side only). Two waves moved those declarations into
// `src/shared/types.ts` (and the per-area files it re-exports from
// `src/shared/api-types/`), so each shape has ONE declaration both workspaces
// import. This check keeps it that way.
//
// WHAT THIS CHECKS
//
// A type the frontend declares (interface, type alias or enum, exported or
// not, in any non-test file under frontend/src/) must not share its name with
// a type the backend declares:
//
//   - any declaration in src/shared/ (it is there to be imported, not copied);
//   - an EXPORTED declaration anywhere else in src/ (an unexported one is a
//     module's private helper — `Entry`, `CacheEntry` — and a same-named
//     frontend local is a coincidence, not a mirror).
//
// A same name is how a hand mirror is usually written (the old copies were annotated
// "Mirrors src/services/X.ts's Y 1:1"), so it is what this check looks for.
// The fix is to import the shared declaration — move the backend's into
// src/shared/ first if it is not there yet — or, when the two really are
// different things that only happen to share a name, to rename one of them.
//
// What it does NOT catch: a copy under a different name (a frontend
// `PlacementPreview` that mirrors the backend's `PlacementDecision`). Those
// are still annotated "Mirrors src/..." where they exist; matching shapes
// rather than names would flag every pair of small look-alike unions.
//
// THE ALLOWLIST
//
// `scripts/shared-type-twins.allowlist.json` maps a name to the reason it may
// stay duplicated. It is empty: every twin found when this check landed was
// either moved or renamed. An entry that no longer matches a duplicate fails
// the check too, so the list can only shrink.
//
// USAGE
//
//   node scripts/check-shared-type-twins.mjs [root] [--allowlist <path>]

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectSourceFiles } from "./lib/audit-loc-core.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = { root: path.resolve(SCRIPT_DIR, ".."), allowlist: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allowlist") {
      const value = argv[++i];
      if (!value) {
        console.error("usage: check-shared-type-twins.mjs [root] [--allowlist <path>]");
        process.exit(2);
      }
      options.allowlist = path.resolve(value);
    } else {
      options.root = path.resolve(arg);
    }
  }
  options.allowlist ??= path.join(options.root, "scripts/shared-type-twins.allowlist.json");
  return options;
}

/**
 * Top-level type declarations of one file.
 * @returns {{name: string, exported: boolean, line: number}[]}
 */
function typeDeclarations(absPath) {
  const text = readFileSync(absPath, "utf8");
  const kind = absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  for (const statement of sf.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isEnumDeclaration(statement)
    ) {
      continue;
    }
    out.push({
      name: statement.name.text,
      exported: (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
      line: sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1,
    });
  }
  return out;
}

const isTestFile = (rel) => /\.test\.tsx?$/.test(rel) || rel.startsWith("frontend/src/test/");

function readAllowlist(file) {
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(`The allowlist is not valid JSON: ${file}`);
    process.exit(1);
  }
  const allowed = parsed?.allowed ?? {};
  if (typeof allowed !== "object" || allowed === null || Array.isArray(allowed)) {
    console.error(`The allowlist's "allowed" must be an object of name -> reason: ${file}`);
    process.exit(1);
  }
  return allowed;
}

const options = parseArgs(process.argv.slice(2));
const { root } = options;

/** name -> backend locations */
const backend = new Map();
for (const rel of collectSourceFiles(root, ["src"])) {
  if (!/\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) continue;
  const shared = rel.startsWith("src/shared/");
  for (const decl of typeDeclarations(path.join(root, rel))) {
    if (!shared && !decl.exported) continue;
    if (!backend.has(decl.name)) backend.set(decl.name, []);
    backend.get(decl.name).push(`${rel}:${decl.line}`);
  }
}

/** name -> [{frontend location, backend locations}] */
const twins = new Map();
for (const rel of collectSourceFiles(root, ["frontend/src"])) {
  if (!/\.tsx?$/.test(rel) || rel.endsWith(".d.ts") || isTestFile(rel)) continue;
  for (const decl of typeDeclarations(path.join(root, rel))) {
    const theirs = backend.get(decl.name);
    if (!theirs) continue;
    if (!twins.has(decl.name)) twins.set(decl.name, []);
    twins.get(decl.name).push({ at: `${rel}:${decl.line}`, backend: theirs });
  }
}

const allowed = readAllowlist(options.allowlist);
const failures = [...twins.keys()].filter((name) => !Object.hasOwn(allowed, name)).sort();
const stale = Object.keys(allowed)
  .filter((name) => !twins.has(name))
  .sort();

if (failures.length > 0) {
  console.error(
    "These frontend types duplicate a backend type by name. Import the shared\n" +
      "declaration from src/shared/types.ts instead (move the backend's there\n" +
      "first if it is not shared yet); if the two are genuinely different\n" +
      "shapes that only share a name, rename one of them. See this script's\n" +
      "header for why.\n",
  );
  for (const name of failures) {
    for (const twin of twins.get(name)) {
      console.error(`  ${name}  ${twin.at}  (backend: ${twin.backend.join(", ")})`);
    }
  }
}
if (stale.length > 0) {
  console.error(
    `\n${path.relative(root, options.allowlist)} lists names that no longer have a twin; ` +
      "remove them:\n",
  );
  for (const name of stale) console.error(`  ${name}`);
}
if (failures.length > 0 || stale.length > 0) process.exit(1);

console.log(`check-shared-type-twins: no frontend type duplicates a backend type by name.`);
