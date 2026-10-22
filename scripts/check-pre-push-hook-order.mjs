#!/usr/bin/env node
// Asserts that the pre-push hook wiring in .pre-commit-config.yaml still
// matches what the patch-coverage gate assumes.
//
// Two invariants, both of which fail SILENTLY if they drift:
//
// 1. The `patch-coverage` hook must be the LAST hook in the file. It
//    consumes the coverage/coverage-final.json (backend) and
//    frontend/coverage/coverage-final.json (frontend) that the two test
//    hooks write, and pre-commit runs hooks in FILE ORDER — so a hook
//    added after it would run first and read a stale (or absent) report,
//    and the patch check would silently measure the wrong thing.
//
// 2. The two test hooks must run `test:coverage`, not `test`. With plain
//    `test` no coverage report is produced, so the patch check re-runs
//    the entire suite a second time to regenerate it.
//
// The hook's own comment in .pre-commit-config.yaml states the ordering
// constraint; this script is what makes it enforced rather than merely
// documented.
//
// Parsed with a line scan rather than a YAML library: the repo has no YAML
// parser dependency, and the file's shape — a flat list of `- id:` entries
// with `key: value` fields — is stable enough for this.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Overridable so tests can point this at a fixture file instead of the
// real one — see test/scripts/check-pre-push-hook-order.test.ts.
const root =
  process.env.PRE_PUSH_HOOK_ORDER_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG = path.join(root, ".pre-commit-config.yaml");

const PATCH_HOOK_ID = "patch-coverage";
const TEST_HOOK_IDS = ["npm-test", "npm-test-frontend"];

/**
 * Parse the hook entries out of a .pre-commit-config.yaml.
 * Returns [{ id, fields: { key: value } }] in file order.
 */
export function parseHookEntries(text) {
  const entries = [];
  let current = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const idMatch = line.match(/^\s*-\s+id:\s*(\S+)\s*$/);
    if (idMatch) {
      current = { id: idMatch[1], fields: {} };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    // A field line is `key: value` at a deeper indent than the `- id:`.
    const fieldMatch = line.match(/^\s+([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (fieldMatch) {
      current.fields[fieldMatch[1]] = fieldMatch[2].replace(/^["']|["']$/g, "");
    }
  }
  return entries;
}

/**
 * Check the invariants. Returns an array of problem strings — empty means
 * the wiring is intact.
 */
export function checkHookOrder(text) {
  const problems = [];
  const entries = parseHookEntries(text);
  const ids = entries.map((e) => e.id);

  const patchIndex = ids.indexOf(PATCH_HOOK_ID);
  if (patchIndex === -1) {
    problems.push(`No '${PATCH_HOOK_ID}' hook found in .pre-commit-config.yaml.`);
    return problems;
  }

  if (patchIndex !== ids.length - 1) {
    const following = ids.slice(patchIndex + 1);
    problems.push(
      `The '${PATCH_HOOK_ID}' hook must be the LAST hook in .pre-commit-config.yaml ` +
        `(pre-commit runs hooks in file order, and this one consumes the coverage ` +
        `report the test hooks write). It is followed by: ${following.join(", ")}.`,
    );
  }

  const patch = entries[patchIndex];
  if (patch.fields.stages !== "[pre-push]") {
    problems.push(
      `The '${PATCH_HOOK_ID}' hook must run at the pre-push stage (found stages: ${patch.fields.stages ?? "none"}).`,
    );
  }
  if (patch.fields["always_run"] !== "true") {
    problems.push(
      `The '${PATCH_HOOK_ID}' hook must set 'always_run: true' — it is the gate, and a ` +
        `path-scoped trigger would let a push that touches no source file skip it.`,
    );
  }

  for (const testId of TEST_HOOK_IDS) {
    const entry = entries.find((e) => e.id === testId);
    if (!entry) {
      problems.push(`No '${testId}' hook found in .pre-commit-config.yaml.`);
      continue;
    }
    // The command may be `npm run test:coverage` or
    // `npm --prefix frontend run test:coverage` — either way it must be the
    // coverage variant, not plain `test`.
    const command = entry.fields.entry ?? "";
    if (!/\btest:coverage\b/.test(command)) {
      problems.push(
        `The '${testId}' hook must run the coverage variant of the test script ` +
          `(found: ${command || "none"}). Plain 'test' produces no coverage report, so ` +
          `the '${PATCH_HOOK_ID}' hook would re-run the whole suite to regenerate it.`,
      );
    }
  }

  return problems;
}

export function main() {
  let text;
  try {
    text = readFileSync(CONFIG, "utf8");
  } catch {
    console.error(`ERROR: could not read ${CONFIG}.`);
    return 1;
  }
  const problems = checkHookOrder(text);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`ERROR: ${problem}`);
    return 1;
  }
  console.log("OK — the pre-push patch-coverage hook wiring is intact.");
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  process.exit(main());
}
