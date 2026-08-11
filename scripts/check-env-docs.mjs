#!/usr/bin/env node
// Guards against the drift this repo's docs audit found: an env var can be
// added to src/plugins/env.ts's schema without ever reaching .env.example
// or docs/configuration.md (see PREVIEW_RATE_LIMIT_MAX, which was in the
// schema and nowhere else). Asserts the three sources name exactly the same
// set of MULLION_*/other schema-shaped keys.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function schemaKeys() {
  const src = readFileSync(path.join(root, "src/plugins/env.ts"), "utf8");
  const keys = new Set([...src.matchAll(/^ {4}([A-Z][A-Z0-9_]+): \{/gm)].map((m) => m[1]));
  // The regex above assumes a specific indent/brace style. If env.ts is ever
  // reformatted (2-space indent, tabs, a value not opening `{` on the same
  // line, ...) it could silently match fewer keys than actually exist — a
  // false green, since a smaller schema set just makes the other two files
  // look "complete" by comparison. Fail loud instead of passing quietly:
  // the schema has never had fewer than 40 keys since this check was added.
  if (keys.size < 40) {
    throw new Error(
      `Only found ${keys.size} keys in src/plugins/env.ts — expected 40+. ` +
        "Either the schema shrank a lot, or this script's regex no longer matches " +
        "its formatting (check the indent/brace style around a `properties` entry).",
    );
  }
  return keys;
}

function envExampleKeys(schema) {
  const src = readFileSync(path.join(root, ".env.example"), "utf8");
  // Presence of each real schema key is checked directly, keyed off the
  // schema itself (not a free-form scan) — several agent-only vars are
  // shipped commented out (`# KEY=`, inert on a primary) rather than
  // uncommented with an empty value, and a free-form "# WORD=..." regex
  // risks a false positive on ordinary prose that happens to look like an
  // assignment. Anchoring on known schema keys makes the "missing from
  // .env.example" direction — the one that actually matters for silently
  // missing a real var — immune to that.
  const present = new Set([...schema].filter((key) => new RegExp(`^#? ?${key}=`, "m").test(src)));
  // The reverse direction (an entry in .env.example that isn't a real
  // schema key at all) still needs a free-form scan; a false positive here
  // only produces a spurious "stale" report to double-check by hand, never
  // a silent pass, so the looser pattern is an acceptable tradeoff.
  const all = new Set([...src.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  return { present, all };
}

function configDocKeys() {
  const src = readFileSync(path.join(root, "docs/configuration.md"), "utf8");
  // Only the schema-backed tables, not the "Per-session (injected at spawn)"
  // table at the bottom — those are deliberately not @fastify/env keys.
  const beforeSpawn = src.split("## Per-session")[0];
  return new Set([...beforeSpawn.matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm)].map((m) => m[1]));
}

const schema = schemaKeys();
const example = envExampleKeys(schema);
const doc = configDocKeys();

let ok = true;
function report(label, missing) {
  if (missing.size === 0) return;
  ok = false;
  console.log(`\n${label} (${missing.size}):`);
  for (const k of [...missing].sort()) console.log(`  ${k}`);
}

report(
  "In src/plugins/env.ts but missing from .env.example",
  new Set([...schema].filter((k) => !example.present.has(k))),
);
report(
  "In .env.example but not in src/plugins/env.ts (stale)",
  new Set([...example.all].filter((k) => !schema.has(k))),
);
report(
  "In src/plugins/env.ts but missing from docs/configuration.md",
  new Set([...schema].filter((k) => !doc.has(k))),
);
report(
  "In docs/configuration.md but not in src/plugins/env.ts (stale)",
  new Set([...doc].filter((k) => !schema.has(k))),
);

if (ok) {
  console.log(
    `OK — ${schema.size} schema keys, all present in .env.example and docs/configuration.md`,
  );
  process.exit(0);
}
process.exit(1);
