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
  return new Set([...src.matchAll(/^ {4}([A-Z][A-Z0-9_]+): \{/gm)].map((m) => m[1]));
}

function envExampleKeys() {
  const src = readFileSync(path.join(root, ".env.example"), "utf8");
  // Allow a leading "# " — several agent-only vars are shipped commented
  // out (inert on a primary) rather than uncommented with an empty value.
  return new Set([...src.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
}

function configDocKeys() {
  const src = readFileSync(path.join(root, "docs/configuration.md"), "utf8");
  // Only the schema-backed tables, not the "Per-session (injected at spawn)"
  // table at the bottom — those are deliberately not @fastify/env keys.
  const beforeSpawn = src.split("## Per-session")[0];
  return new Set([...beforeSpawn.matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm)].map((m) => m[1]));
}

const schema = schemaKeys();
const example = envExampleKeys();
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
  new Set([...schema].filter((k) => !example.has(k))),
);
report(
  "In .env.example but not in src/plugins/env.ts (stale)",
  new Set([...example].filter((k) => !schema.has(k))),
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
