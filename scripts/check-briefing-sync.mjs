#!/usr/bin/env node
// Historically this compared AGENTS.md/GEMINI.md/AGENTS.override.md's
// briefing regions for byte-identical content (issue #716) — that
// precedence model was retired by issue #942: AGENTS.md is now the single
// source of truth, GEMINI.md is a one-line pointer to it, and the scaffold
// (src/services/mullion-scaffold.ts) no longer offers AGENTS.override.md at
// all. What both files can still do is silently shadow AGENTS.md if someone
// pastes a copy of the tier-1 region back into them — Codex reads
// AGENTS.override.md *instead of* AGENTS.md when it exists
// (src/services/agent-rules.ts's precedence table), and a content-bearing
// GEMINI.md just invites the two to drift again the way #716 fixed once
// already. This check fails loud the moment either file re-acquires its own
// `<!-- mullion:briefing:start/end -->` region, rather than comparing region
// contents (the pre-#942 job this script used to do) — presence alone is
// the problem now. Deliberately does NOT check that AGENTS.md itself still
// has a region at all (the old script did): the region there is now purely
// a scaffold upsert boundary (mullion-scaffold.ts's computeScaffold), not
// something anything reads back — a project that hand-writes AGENTS.md
// without markers, or removes them, is not a regression this check needs
// to catch.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Overridable so tests can point this at a fixture directory instead of the
// real repo — see test/scripts/check-briefing-sync.test.ts. Every real
// invocation (the pre-commit hook, `npm run lint`) leaves this unset and
// gets the real repo root.
const root =
  process.env.BRIEFING_SYNC_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const START = "<!-- mullion:briefing:start -->";
const END = "<!-- mullion:briefing:end -->";
const GUARDED_FILES = ["GEMINI.md", "AGENTS.override.md"];

function hasRegion(relPath) {
  const filePath = path.join(root, relPath);
  if (!existsSync(filePath)) return false;
  const src = readFileSync(filePath, "utf8");
  const startIdx = src.indexOf(START);
  const endIdx = src.indexOf(END, startIdx + START.length);
  return startIdx !== -1 && endIdx !== -1;
}

let failed = false;
for (const file of GUARDED_FILES) {
  if (hasRegion(file)) {
    console.log(
      `${file} carries its own ${START} ... ${END} region — AGENTS.md is the single source of ` +
        `truth for the briefing now. Remove the region and replace ${file} with a one-line ` +
        "pointer to AGENTS.md instead.",
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log("OK — no content-bearing briefing mirror or override found.");
