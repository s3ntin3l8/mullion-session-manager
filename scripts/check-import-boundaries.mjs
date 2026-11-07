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

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectSourceFiles, SKIP_DIRS } from "./lib/audit-loc-core.mjs";

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
 *
 * WHICH DIRECTIONS ARE ALLOWED, spelled out (the diagram above does not
 * show them all, and the rule set is the part that matters):
 *
 *   routes  -> services -> db          the intended direction
 *   routes  -> plugins                 allowed (plugins are above routes)
 *   plugins -> services, db            allowed
 *   services -> routes                 FORBIDDEN — reaching up to a route
 *   services -> plugins                FORBIDDEN — reaching up to a plugin
 *   plugins  -> routes                 FORBIDDEN — reaching down to a route
 *   db       -> anything above it      FORBIDDEN — the database reaching back
 *
 * The frontend's own `api/` directory is the API CLIENT, not the route
 * layer, so it is not part of this model.
 */
const LAYERS = [
  { prefix: "src/services/", name: "services" },
  { prefix: "src/routes/", name: "routes" },
  { prefix: "src/plugins/", name: "plugins" },
  { prefix: "src/db/", name: "db" },
];

// The edges that invert the layering. WHICH DIRECTIONS ARE ALLOWED, AND
// WHICH ARE NOT, is spelled out once — in the LAYERS docblock above. This
// list is the same rule in code; it does not repeat the table, so the two
// cannot drift.
const FORBIDDEN_EDGES = new Set([
  "services>routes",
  "services>plugins",
  "plugins>routes",
  "db>services",
  "db>routes",
  "db>plugins",
]);

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
  // A BARE specifier ("some-package/thing") is not resolved here: it names a
  // package, not a file in this repository, so it can be neither a layering
  // inversion nor a cycle between two of this repository's modules. The
  // assumption that makes that true is that the repository has NO path
  // aliases — no tsconfig `paths`, no package.json `imports`, no Vite
  // `resolve.alias` — because an alias would name a file IN this repository
  // under a bare specifier, and the checker would silently take neither the
  // cycle nor the inversion rule for it. assertNoPathAliases() below fails
  // the lint if an alias ever appears, so the assumption cannot rot
  // unnoticed.
  if (!spec.startsWith(".")) return null;
  const base = path.posix.join(path.posix.dirname(fromRelPath), spec);
  const candidates = [
    // The specifier carries the ".js" extension even when the file is
    // TypeScript (Node16 resolution, AGENTS.md's ESM rule), so the
    // extension is swapped back before the lookup.
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base.replace(/\.jsx$/, ".tsx"),
    // The specifier as written (a real .js/.mjs/.cjs file).
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

/**
 * Every tsconfig in the tree, at any depth.
 *
 * The walk skips the same directories the rest of the repo's file collection
 * skips (node_modules, dist, build, coverage, .wt, .mullion-worktrees,
 * .claude) — a nested checkout or an install directory is not part of this
 * repository's source tree.
 *
 * @param {string} root
 * @returns {string[]} repo-relative POSIX paths
 */
function findTsconfigs(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && /^tsconfig.*\.json$/.test(entry.name)) {
        found.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Fail if the repository grows a path alias.
 *
 * The checker resolves RELATIVE specifiers only. An alias (a tsconfig
 * `paths` entry, a package.json `imports` map, a Vite `resolve.alias`)
 * names a file inside this repository under a bare specifier, and the
 * checker would take neither the cycle nor the inversion rule for it —
 * silently. There are none today; this makes that a build failure rather
 * than a silent blind spot.
 *
 * @param {string} root
 * @returns {string[]} the aliases found, empty when there are none
 */
function findPathAliases(root) {
  /** @type {string[]} the aliases found */
  const found = [];
  /** @type {string[]} the tsconfigs this guard could not read */
  const unreadable = [];
  // EVERY tsconfig in the repository, not a hand-written list: a list
  // would silently skip whichever one a `paths` map is added to next (this
  // repo has six), and the whole point of the guard is that the blind spot
  // cannot open unnoticed.
  const tsconfigCandidates = findTsconfigs(root);
  for (const rel of tsconfigCandidates) {
    const abs = path.join(root, rel);
    // TypeScript's own config reader: this repo's tsconfig files carry
    // comments and trailing commas, and a regex stripper cannot be trusted
    // with them. A parse FAILURE is reported rather than swallowed — a
    // tsconfig this guard cannot read is a tsconfig it cannot vouch for.
    const parsed = ts.readConfigFile(abs, ts.sys.readFile);
    if (parsed.error) {
      unreadable.push(
        `${rel}: could not be parsed (${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")})`,
      );
      continue;
    }
    const paths = parsed.config?.compilerOptions?.paths;
    if (paths && Object.keys(paths).length > 0) found.push(`${rel}: compilerOptions.paths`);
  }
  for (const rel of ["package.json", "frontend/package.json"]) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    try {
      const parsed = JSON.parse(readFileSync(abs, "utf8"));
      if (parsed?.imports && Object.keys(parsed.imports).length > 0) found.push(`${rel}: imports`);
    } catch {
      // Not JSON — nothing to check.
    }
  }
  const viteConfig = path.join(root, "frontend/vite.config.ts");
  if (existsSync(viteConfig) && /\balias\s*:/.test(readFileSync(viteConfig, "utf8"))) {
    found.push("frontend/vite.config.ts: resolve.alias");
  }
  return { aliases: found, unreadable };
}

const options = parseArgs(process.argv.slice(2));

const { aliases: pathAliases, unreadable: unreadableTsconfigs } = findPathAliases(options.root);
if (unreadableTsconfigs.length > 0) {
  console.error(
    "This repository has a tsconfig the import-boundary checker cannot READ.\n" +
      "That is not the same problem as a path alias: an unreadable tsconfig is\n" +
      "one this guard cannot vouch for, and a `paths` map hiding inside it would\n" +
      "name a file in this repository under a bare specifier — invisible to both\n" +
      "the cycle rule and the layering rule. Fix the tsconfig, or teach this\n" +
      "checker to read it. Found:",
  );
  for (const entry of unreadableTsconfigs) console.error(`  ${entry}`);
  process.exit(1);
}
if (pathAliases.length > 0) {
  console.error(
    "This repository has path aliases, and the import-boundary checker does\n" +
      "not resolve them — a bare specifier that names a file in this\n" +
      "repository would be invisible to both the cycle rule and the layering\n" +
      "rule. Resolve the alias here first, or teach this checker to resolve\n" +
      "it. Found:",
  );
  for (const alias of pathAliases) console.error(`  ${alias}`);
  process.exit(1);
}

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
  // A Set, not an array: `edges` holds one entry per import STATEMENT, so a
  // module imported twice would push the same edge twice and the baseline
  // would list it twice.
  const groupEdges = new Set();
  for (const edge of edges) {
    if (!members.has(edge.from) || !members.has(edge.to)) continue;
    const key = `${edge.from} -> ${edge.to}`;
    cycleEdges.add(key);
    groupEdges.add(key);
  }
  cycleFiles.set([...groupEdges].sort().join("\n"), component);
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
      "The import-boundary baseline — issue #2413 / #2414. Every import cycle and every layering inversion the tree has today is listed here with a note saying why it is still allowed. The guard (scripts/check-import-boundaries.mjs) fails on a violation that is NOT listed, and on a listed entry that no longer describes a real violation: the baseline only turns down. Regenerate with `node scripts/check-import-boundaries.mjs --update` and read the diff — and note that `--update` writes a NEW entry with an empty note, which the check then rejects: `--update` can record that a violation exists, but only a human can say why it is allowed, so fill the note in before the check will pass.",
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
  const withoutNote = [
    ...updated.cycles.filter((group) => !group.note || group.note.trim() === ""),
    ...updated.inversions.filter((entry) => !entry.note || entry.note.trim() === ""),
  ];
  if (withoutNote.length > 0) {
    console.log(
      `${withoutNote.length} NEW entry/entries have no note yet, and the check rejects a\n` +
        "note-less entry: fill in why each new cycle or inversion is allowed before the\n" +
        "check will pass.",
    );
  }
  process.exit(0);
}

// A baselined entry must say WHY it is allowed. Without that, `--update` is
// a one-command way to launder a brand-new cycle or inversion into the
// baseline: the cycle fails, you run `--update`, and the new entry lands
// with an empty note that nobody ever reads. The note is the point.
const blankNotes = [];
for (const group of baselineCycles) {
  if (!group.note || group.note.trim() === "") {
    blankNotes.push(`cycle edge ${(group.edges ?? [])[0] ?? "(no edges)"}`);
  }
}
for (const entry of baselineInversions) {
  if (!entry.note || entry.note.trim() === "") {
    blankNotes.push(`inversion ${entry.from} -> ${entry.to}`);
  }
}

const report = {
  cycleGroups: cycleComponents.length,
  cycleEdges: cycleEdges.size,
  inversions: inversionPairs.size,
  newCycleEdges,
  staleCycleEdges,
  newInversions,
  staleInversions,
  blankNotes,
};

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
}

const failed =
  newCycleEdges.length > 0 ||
  staleCycleEdges.length > 0 ||
  newInversions.length > 0 ||
  staleInversions.length > 0 ||
  blankNotes.length > 0;

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
if (blankNotes.length > 0) {
  console.error(
    "\nBASELINE ENTRY WITHOUT A REASON — the baseline says what is allowed, not just what exists:",
  );
  for (const entry of blankNotes) console.error(`  ${entry}`);
  console.error(
    "  Every entry needs a note saying why it is allowed. An empty one means\n" +
      "  `--update` laundered a new violation into the baseline.",
  );
}
process.exit(1);
