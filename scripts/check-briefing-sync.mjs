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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FILES = ["AGENTS.md", "GEMINI.md"];
const START = "<!-- mullion:briefing:start -->";
const END = "<!-- mullion:briefing:end -->";

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
    console.log(
      `${file} has no ${START} ... ${END} region. If this is deliberate ` +
        "(the file now just points at another one), remove it from FILES " +
        "in this script; otherwise the briefing silently stopped reaching " +
        "whatever agent reads this file natively.",
    );
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
