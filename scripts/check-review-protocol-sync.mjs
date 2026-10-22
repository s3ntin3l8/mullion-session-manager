#!/usr/bin/env node
// Keeps the review protocol's wording consistent across the surfaces that
// state it.
//
// The rule about asking for a review (one per pull request, wait for it, do
// not re-trigger) is stated in several places, because an agent reads a
// different one depending on where it is standing: the MCP tool description
// (read when it is about to ask), the CLI's output (read right after it
// asked), the agent guide (read when it looks for how), and this repo's
// AGENTS.md (read by the agent CLIs natively). When those drift apart, the
// stale one wins — the agent follows the rule it happens to be reading, and
// the queue grows again.
//
// The canonical wording lives in ONE place — src/cli/review-protocol.mjs,
// imported by both clients — and this check asserts that every surface that
// restates it says the same THING. It compares the clauses that carry the
// rule, not the whole sentence: the surfaces are prose, and a check that
// demanded byte-identical text would be rewritten by the next person who
// touched a paragraph.
//
// Like check-scaffold-region-sync (the AGENTS.md region guard), this is a
// hard failure in `npm run lint` and a pre-commit hook: a drift that is not
// caught here is caught by a queue of duplicate reviews.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Overridable so a test can point the check at a fixture directory instead
// of the real repo — the same posture check-scaffold-region-sync uses (its
// SCAFFOLD_REGION_SYNC_ROOT). Every real invocation (the pre-commit hook,
// `npm run lint`) leaves it unset and gets the real repo root.
const root =
  process.env.REVIEW_PROTOCOL_SYNC_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The clauses every surface must carry, and where they must appear. Each
 * clause is checked case-insensitively.
 *
 * - "one review per pull request" — the invariant itself.
 * - "10-30 minutes" — how long a review takes, so the agent knows whether
 *   "still running" means "wait" or "something is wrong".
 * - "review_status" — where to look instead of asking again.
 */
const CLAUSES = ["one review per pull request", "10-30 minutes", "review_status"];

/**
 * The files that RESTATE the rule in prose, with the label used in the
 * failure message. The two clients are not here: they import the canonical
 * wording (checked below), which is the better way to carry it.
 */
const SURFACES = [
  { label: "AGENTS.md", file: "AGENTS.md" },
  { label: "docs/agent-guide.md", file: "docs/agent-guide.md" },
  { label: "docs/cli.md", file: "docs/cli.md" },
];

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

let failed = false;

for (const surface of SURFACES) {
  let text;
  try {
    text = read(surface.file);
  } catch {
    console.error(
      `${surface.label}: ${surface.file} is missing — cannot check the review protocol.`,
    );
    failed = true;
    continue;
  }
  const haystack = text.toLowerCase();
  const missing = CLAUSES.filter((clause) => !haystack.includes(clause.toLowerCase()));
  if (missing.length > 0) {
    console.error(
      `${surface.label} (${surface.file}) does not carry the review protocol: missing ` +
        `${missing.map((c) => `"${c}"`).join(", ")}. The rule is stated in ` +
        `src/cli/review-protocol.mjs (REVIEW_PROTOCOL_NOTE); restate it here, or ` +
        `import it from there.`,
    );
    failed = true;
  }
}

// The canonical wording itself: the two clients must import it rather than
// keep their own copy, or the "one source" is only true on paper.
const protocol = read("src/cli/review-protocol.mjs");
for (const [label, file] of [
  ["src/mcp/tools.mjs", "src/mcp/tools.mjs"],
  ["src/cli/core.mjs", "src/cli/core.mjs"],
  ["src/mcp/client.mjs", "src/mcp/client.mjs"],
  // The install-wide conventions text the wizard generates and the scaffold
  // writes into every project's AGENTS.md: it builds its review fragment
  // from the note rather than restating it.
  ["src/services/workflow-conventions.ts", "src/services/workflow-conventions.ts"],
]) {
  if (!read(file).includes("review-protocol.mjs")) {
    console.error(
      `${label} does not import src/cli/review-protocol.mjs — the review protocol's wording has two sources.`,
    );
    failed = true;
  }
}
// Importing the note is not enough: the conventions fragment has to USE it.
// Comments stripped, the name must appear beyond the import itself.
const conventionsCode = read("src/services/workflow-conventions.ts")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
if ((conventionsCode.match(/REVIEW_PROTOCOL_NOTE/g) ?? []).length < 2) {
  console.error(
    "src/services/workflow-conventions.ts imports REVIEW_PROTOCOL_NOTE but never uses it — the generated conventions would lose the review protocol.",
  );
  failed = true;
}
if (!protocol.includes("REVIEW_PROTOCOL_NOTE")) {
  console.error("src/cli/review-protocol.mjs does not define REVIEW_PROTOCOL_NOTE.");
  failed = true;
}
// The note the clients import must itself carry the rule, or importing it
// spreads a rule that says nothing.
const note = protocol.slice(protocol.indexOf("REVIEW_PROTOCOL_NOTE"));
const missingNote = CLAUSES.filter((c) => !note.toLowerCase().includes(c.toLowerCase()));
if (missingNote.length > 0) {
  console.error(
    `src/cli/review-protocol.mjs's REVIEW_PROTOCOL_NOTE does not carry ` +
      `${missingNote.map((c) => `"${c}"`).join(", ")}.`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}
console.log(`review protocol: ${SURFACES.length} surfaces carry the rule.`);
