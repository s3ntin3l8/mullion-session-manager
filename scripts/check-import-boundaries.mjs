#!/usr/bin/env node
// Issue #2413 / #2414 — the import-boundary guardrail.
//
// WHY THIS EXISTS
//
// Two rules about how this codebase's modules may depend on each other. Both
// were true only by accident until now, and neither was enforced anywhere:
// the layering was a diagram in docs/architecture.md, and the absence of
// import cycles was a property everyone agreed to preserve by hand.
//
//   1. THE LAYERING. The intended dependency direction is
//
//        routes  ->  services  ->  db
//        plugins  (above both)
//
//      A service that imports a route, or a plugin that imports a route,
//      inverts it: the module that decides something ends up depending on
//      the module that publishes it. That is not a style preference. It
//      makes a route file the only place a helper can live, it puts route
//      registration (and everything it pulls in) in the import path of
//      whatever needed the helper, and it is how the two dozen services
//      that already import "just one function" from "just one route file"
//      happened in the first place.
//
//   2. NO IMPORT CYCLES. A cycle is legal in ESM, but it makes module
//      initialization order load-bearing: whichever module the runtime
//      happens to enter first decides which half of a cycle sees the
//      other's top-level code already run. The bundle managers in
//      src/services/hook-adapters/ are the sharpest example — they read
//      and write the filesystem at import time, so the order they load in
//      is the order their side effects happen in.
//
// WHAT THIS CHECKS
//
// Two violations, both measured over the same production source set
// (src/ and frontend/src/ — the same roots, and the same worktree
// exclusions, as scripts/audit-loc.mjs and scripts/check-max-file-lines.mjs
// use; see scripts/lib/audit-loc-core.mjs, which this script imports
// rather than re-declaring):
//
//   - a LAYERING INVERSION: an edge from a service to a route or a
//     plugin, or from a plugin to a route.
//   - an IMPORT CYCLE: a set of modules that import each other, however
//     many files it spans.
//
// The cycle check runs over the WHOLE module graph — value imports, type
// imports and dynamic imports alike. A cycle made only of `import type`
// edges is still a cycle in the module graph TypeScript and the bundler
// see, and it is exactly the shape the frontend's right-sidebar barrel
// has (views.ts imports its members for the registry; the members import
// their types back from views.ts).
//
// THE BASELINE IS A RATCHET, NOT A THRESHOLD
//
// The tree has real violations of both rules today — they are recorded in
// scripts/import-boundaries.baseline.json, each with a note saying why it
// is still allowed. A flat rule would fail on every existing cycle the
// day it landed, so instead:
//
//   - a violation that is NOT in the baseline fails;
//   - a baseline entry that no longer describes a real violation fails
//     too, because the ratchet only turns DOWN: when a cycle is broken,
//     its edges leave the baseline in the same commit that broke them.
//
// That second half is the point. Without it the baseline would grow
// silently until it was a list of "grandfathered" cycles nobody read, and
// the guard would stop meaning anything.
//
// USAGE
//
//   node scripts/check-import-boundaries.mjs [--root <dir>] [--json]
//   node scripts/check-import-boundaries.mjs --update
//
// --update rewrites the baseline from the current tree, keeping the note
// of every entry that still exists. It is how the baseline is born and
// how it shrinks; the diff it produces is meant to be read.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectSourceFiles } from "./lib/audit-loc-core.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "scripts/import-boundaries.baseline.json";

/** The production roots this check reads: the backend and the React workspace. */
const SOURCE_ROOTS = ["src", "frontend/src"];

/**
 * The backend's layers, and the edges that invert them.
 *
 * "services > routes" — a service reaches up into the module that publishes
 * the route. "services > plugins" — a service reaches up into a plugin.
 * "plugins > routes" — a plugin reaches down into a route.
 *
 * The frontend is not layered this way (it is one workspace of components
 * and an API client), so it contributes no inversions — but it does
 * contribute cycles, which is why it is in SOURCE_ROOTS at all.
 */
const LAYERS = [
  { prefix: "src/services/", name: "services" },
  { prefix: "src/routes/", name: "routes" },
  { prefix: "src/plugins/", name: "plugins" },
];

const FORBIDDEN_EDGES = new Set(["services>routes", "services>plugins", "plugins>routes"]);

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = { root: REPO_ROOT, update: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      options.root = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--update") {
      options.update = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (!arg.startsWith("-")) {
      options.root = path.resolve(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * The layer a backend module belongs to, or null when it belongs to none
 * (the frontend, the shared/ directory, db/ itself).
 *
 * @param {string} relPath
 * @returns {string | null}
 */
function layerOf(relPath) {
  for (const layer of LAYERS) {
    if (relPath.startsWith(layer.prefix)) return layer.name;
  }
  return null;
}

/**
 * Every import a file makes, with the kind of import it is.
 *
 * The TypeScript parser is used rather than a regular expression because
 * the difference between "an import" and "the text of an import inside a
 * comment or a string" is the difference between a check that can be
 * trusted and one that reports whatever it half-remembers.
 *
 * @param {string} absPath
 * @param {string} relPath
 * @returns {{ spec: string, kind: "value" | "type" | "dynamic" }[]}
 */
function readImports(absPath, relPath) {
  const text = readFileSync(absPath, "utf8");
  const scriptKind = relPath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : relPath.endsWith(".ts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const source = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, scriptKind);
  /** @type {{ spec: string, kind: "value" | "type" | "dynamic" }[]} */
  const found = [];

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        const kind = node.importClause?.isTypeOnly ? "type" : "value";
        found.push({ spec: specifier.text, kind });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push({ spec: node.moduleSpecifier.text, kind: node.isTypeOnly ? "type" : "value" });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ spec: node.arguments[0].text, kind: "dynamic" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Resolve a relative specifier to the file it names.
 *
 * The specifier carries the ".js" extension even when the file is TypeScript
 * (Node16 resolution, AGENTS.md's ESM rule), so the extension is swapped
 * back before the lookup. A directory import ("./foo.js" meaning
 * "./foo/index.ts") resolves through the index candidates.
 *
 * @param {string} fromRelPath
 * @param {string} spec
 * @param {Set<string>} knownFiles
 * @returns {string | null}
 */
function resolveSpecifier(fromRelPath, spec, knownFiles) {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.join(path.posix.dirname(fromRelPath), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base.replace(/\.mjs$/, ".mjs"),
    base.replace(/\.js$/, ".js"),
    base.replace(/\.jsx$/, ".jsx"),
    base,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Tarjan's strongly connected components over the import graph.
 *
 * A component with more than one file is a cycle: every member can reach
 * every other, so the group loads in an order that decides what each
 * module's top-level code sees.
 *
 * @param {Map<string, Set<string>>} adjacency
 * @returns {string[][]}
 */
function findCycles(adjacency) {
  /** @type {Map<string, number>} */
  const index = new Map();
  /** @type {Map<string, number>} */
  const low = new Map();
  /** @type {Set<string>} */
  const onStack = new Set();
  /** @type {string[]} */
  const stack = [];
  /** @type {string[][]} */
  const components = [];
  let counter = 0;

  const strongConnect = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        strongConnect(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };

  for (const node of adjacency.keys()) {
    if (!index.has(node)) strongConnect(node);
  }
  return components;
}

const options = parseArgs(process.argv.slice(2));

const files = collectSourceFiles(options.root, SOURCE_ROOTS);
const knownFiles = new Set(files);

/** @type {{ from: string, to: string, kind: string }[]} */
const edges = [];
for (const relPath of files) {
  for (const entry of readImports(path.join(options.root, relPath), relPath)) {
    const target = resolveSpecifier(relPath, entry.spec, knownFiles);
    if (target) edges.push({ from: relPath, to: target, kind: entry.kind });
  }
}

// The import graph: who imports whom.
const adjacency = new Map();
for (const edge of edges) {
  if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
  adjacency.get(edge.from).add(edge.to);
}

// The cycle groups, and the edges that participate in one. An edge is in a
// cycle exactly when both of its ends are in the same component.
const cycleComponents = findCycles(adjacency);
const cycleEdges = new Set();
/** @type {Map<string, string[]>} */
const cycleFiles = new Map();
for (const component of cycleComponents) {
  const members = new Set(component);
  const groupEdges = [];
  for (const edge of edges) {
    if (!members.has(edge.from) || !members.has(edge.to)) continue;
    const key = `${edge.from} -> ${edge.to}`;
    cycleEdges.add(key);
    groupEdges.push(key);
  }
  cycleFiles.set(groupEdges.sort().join("\n"), component);
}

// The layering inversions, counted per (from, to) pair — a type-only import
// inverts the layering just as much as a value import does; the pair is the
// unit that gets a baseline entry.
const inversionPairs = new Map();
for (const edge of edges) {
  const from = layerOf(edge.from);
  const to = layerOf(edge.to);
  if (!from || !to) continue;
  if (!FORBIDDEN_EDGES.has(`${from}>${to}`)) continue;
  const key = `${edge.from} -> ${edge.to}`;
  if (!inversionPairs.has(key)) inversionPairs.set(key, { from: edge.from, to: edge.to });
}

// --- The baseline ------------------------------------------------------

const baselinePath = path.join(options.root, BASELINE_PATH);
/** @type {{ cycles?: { note?: string, edges?: string[] }[], inversions?: { from: string, to: string, note?: string }[] }} */
let baseline = { cycles: [], inversions: [] };
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch {
  if (!options.update) {
    console.error(`Cannot read the baseline at ${BASELINE_PATH}.`);
    process.exit(1);
  }
}
const baselineCycles = baseline.cycles ?? [];
const baselineInversions = baseline.inversions ?? [];

/** @type {Map<string, string>} */
const baselineCycleNotes = new Map();
for (const group of baselineCycles) {
  for (const edge of group.edges ?? []) {
    if (group.note) baselineCycleNotes.set(edge, group.note);
  }
}
const baselineCycleEdgeSet = new Set(baselineCycles.flatMap((group) => group.edges ?? []));
const baselineInversionKeys = new Set(
  baselineInversions.map((entry) => `${entry.from} -> ${entry.to}`),
);
const baselineInversionNotes = new Map(
  baselineInversions.map((entry) => [`${entry.from} -> ${entry.to}`, entry.note ?? ""]),
);

// --- The verdict -------------------------------------------------------

/** New cycle edges: an edge that participates in a cycle nobody baselined. */
const newCycleEdges = [...cycleEdges].filter((edge) => !baselineCycleEdgeSet.has(edge)).sort();
/** Stale cycle edges: a baselined edge that no longer participates in a cycle. */
const staleCycleEdges = [...baselineCycleEdgeSet].filter((edge) => !cycleEdges.has(edge)).sort();
/** New inversions: a layering inversion nobody baselined. */
const newInversions = [...inversionPairs.keys()]
  .filter((edge) => !baselineInversionKeys.has(edge))
  .sort();
/** Stale inversions: a baselined inversion that is no longer there. */
const staleInversions = [...baselineInversionKeys]
  .filter((edge) => !inversionPairs.has(edge))
  .sort();

if (options.update) {
  const notesByEdge = new Map(baselineCycleNotes);
  const updated = {
    $comment:
      "The import-boundary baseline — issue #2413 / #2414. Every import cycle and every layering inversion the tree has today is listed here with a note saying why it is still allowed. The guard (scripts/check-import-boundaries.mjs) fails on a violation that is NOT listed, and on a listed entry that no longer describes a real violation: the baseline only turns down. Regenerate with `node scripts/check-import-boundaries.mjs --update` and read the diff.",
    cycles: [...cycleFiles.entries()]
      .map(([key, filesInCycle]) => ({
        note: notesByEdge.get(key.split("\n")[0]) ?? "",
        edges: key.split("\n"),
        files: filesInCycle,
      }))
      .sort((a, b) => a.edges[0].localeCompare(b.edges[0])),
    inversions: [...inversionPairs.values()]
      .map((entry) => ({
        from: entry.from,
        to: entry.to,
        note: baselineInversionNotes.get(`${entry.from} -> ${entry.to}`) ?? "",
      }))
      .sort((a, b) => `${a.from} -> ${a.to}`.localeCompare(`${b.from} -> ${b.to}`)),
  };
  writeFileSync(baselinePath, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(
    `Updated ${BASELINE_PATH}: ${updated.cycles.length} cycle group(s), ${updated.inversions.length} inversion(s).`,
  );
  process.exit(0);
}

const report = {
  cycleGroups: cycleComponents.length,
  cycleEdges: cycleEdges.size,
  inversions: inversionPairs.size,
  newCycleEdges,
  staleCycleEdges,
  newInversions,
  staleInversions,
};

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
}

const failed =
  newCycleEdges.length > 0 ||
  staleCycleEdges.length > 0 ||
  newInversions.length > 0 ||
  staleInversions.length > 0;

if (!failed) {
  if (!options.json) {
    console.log(
      `OK — no new import cycles (${cycleComponents.length} baselined group(s), ${cycleEdges.size} edge(s)) and no new layering inversions (${inversionPairs.size} baselined).`,
    );
  }
  process.exit(0);
}

console.error("The import boundaries moved. Each item below needs a decision:");
if (newCycleEdges.length > 0) {
  console.error("\nNEW IMPORT CYCLE — an edge that closes a cycle nobody baselined:");
  for (const edge of newCycleEdges) console.error(`  ${edge}`);
  console.error(
    "  Break the cycle (move the shared piece down into a module both sides can\n" +
      "  import), or — if it is deliberate — add it to the baseline with a note\n" +
      "  saying why, in the same commit.",
  );
}
if (staleCycleEdges.length > 0) {
  console.error("\nSTALE BASELINE ENTRY — a baselined cycle edge that no longer closes a cycle:");
  for (const edge of staleCycleEdges) console.error(`  ${edge}`);
  console.error("  Remove these from scripts/import-boundaries.baseline.json.");
}
if (newInversions.length > 0) {
  console.error("\nNEW LAYERING INVERSION — a service or plugin now depends on a layer below it:");
  for (const edge of newInversions) console.error(`  ${edge}`);
  console.error(
    "  Move the borrowed piece down (a helper that lives in a route belongs in a\n" +
      "  service), or — if the dependency is deliberate — add it to the baseline\n" +
      "  with a note saying why, in the same commit.",
  );
}
if (staleInversions.length > 0) {
  console.error("\nSTALE BASELINE ENTRY — a baselined inversion that is no longer there:");
  for (const edge of staleInversions) console.error(`  ${edge}`);
  console.error("  Remove these from scripts/import-boundaries.baseline.json.");
}
process.exit(1);
