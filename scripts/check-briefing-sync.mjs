#!/usr/bin/env node
// Guards against the per-agent instruction files silently drifting apart.
// AGENTS.md and GEMINI.md each carry a copy of the same "tier 1" briefing —
// the non-negotiable rules (worktree usage, branch/PR rules, the pre-push
// gate, the review loop) that every agent CLI needs in its own native
// instruction file, not just via Mullion's SessionStart injection (see
// docs/agent-guide.md). Editing one copy without the other is the exact
// failure this repo is trying to eliminate on the *content* side (agents
// reading different, stale rules depending on which CLI they are) — so this
// check fails loud on any mismatch between the two
// `<!-- mullion:briefing:start/end -->` regions.
//
// CLAUDE.md deliberately does NOT carry a third full copy — it already runs
// long with architecture depth, and a third copy is a third place to forget
// to update. It instead carries a short pointer at the top to AGENTS.md, so
// it is not in FILES below and is not expected to have a marked region.
//
// Deliberately an explicit file list, not a glob: docs/agent-guide.md is
// planned to carry its own delimited region (`<!-- mullion:tier1:start/end
// -->`) for a different purpose (Mullion's own env-var/scope summary, not
// the project's workflow rules) once the platform-side briefing channel
// lands. A glob over "any file with mullion: markers" would either wrongly
// demand the guide match this block, or silently swallow it depending on
// iteration order — see the plan doc this script was written against.
//
// AGENTS.override.md (issue #716): per src/services/agent-rules.ts's
// per-agent precedence table, Codex reads this file *instead of* AGENTS.md
// whenever it exists at project scope — and Mullion's Agent Rules Editor can
// create it. If it exists, it is checked here too: its briefing region must
// be byte-identical to AGENTS.md's inside the markers (content outside the
// markers is free to diverge — override files are meant to diverge in
// general, just not on this one block). This is the invariant that keeps
// src/services/project-briefing.ts's SessionStart injection (which reads
// AGENTS.md/CLAUDE.md/.agents/briefing.md — never the override) in sync with
// what Codex reads natively; without it, an override silently cuts Codex off
// from every tier-1 rule with nothing in the diff looking wrong. Only the
// project-scope override is covered — a repo-local check can't and shouldn't
// police $CODEX_HOME/AGENTS.override.md in a user's home directory.
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

const FILES = ["AGENTS.md", "GEMINI.md"];
const OVERRIDE_FILE = "AGENTS.override.md";
if (existsSync(path.join(root, OVERRIDE_FILE))) {
  FILES.push(OVERRIDE_FILE);
}

const MISSING_REGION_HINTS = {
  [OVERRIDE_FILE]:
    `${OVERRIDE_FILE} shadows AGENTS.md for Codex (see ` +
    "src/services/agent-rules.ts's precedence table) — it must carry its " +
    "own copy of the marked region, or Codex silently stops receiving the " +
    "tier-1 briefing entirely. Paste the region in, or delete this file if " +
    "the override isn't needed.",
};
const DEFAULT_MISSING_REGION_HINT =
  "If this is deliberate (the file now just points at another one), " +
  "remove it from FILES in this script; otherwise the briefing silently " +
  "stopped reaching whatever agent reads this file natively.";

function extractRegion(relPath) {
  const src = readFileSync(path.join(root, relPath), "utf8");
  const startIdx = src.indexOf(START);
  const endIdx = src.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return null;
  }
  return src.slice(startIdx + START.length, endIdx).trim();
}

const regions = new Map();
for (const file of FILES) {
  const region = extractRegion(file);
  if (region === null) {
    const hint = MISSING_REGION_HINTS[file] ?? DEFAULT_MISSING_REGION_HINT;
    console.log(`${file} has no ${START} ... ${END} region. ${hint}`);
    process.exit(1);
  }
  regions.set(file, region);
}

const [first, ...rest] = FILES;
const firstRegion = regions.get(first);
let ok = true;
for (const file of rest) {
  if (regions.get(file) !== firstRegion) {
    ok = false;
    console.log(`${file}'s briefing region does not match ${first}'s. Sync them and retry.`);
  }
}

if (!ok) process.exit(1);
console.log(`OK — ${FILES.join(", ")} carry identical briefing regions.`);
