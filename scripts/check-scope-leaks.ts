#!/usr/bin/env -S npx tsx
// Issue #1137's host-hygiene follow-up: a leaked `crs-session-*` systemd
// --user scope (a crashed test run, a stale scratch dev instance) squats on
// its unit name indefinitely — `--collect` only reaps a scope once its
// whole process tree exits, and a `bash`/`sleep`/agent process left running
// inside one never does on its own. A later, unrelated Mullion instance
// whose own fresh session reuses that same low id then fails to bootstrap
// with nothing but a cryptic exit code (see pty-manager.ts's
// bootstrapMaster() and session-process.ts's describeScope(), the
// diagnostic this same issue added for that failure). This script finds
// such leaks BEFORE they collide with anything.
//
// A `.ts` file run via `tsx` (precedent: generate-ssh-agent-filter-
// vectors.ts) rather than `.mjs` like this directory's other scripts — it
// needs the real, typed parseScopeUnitsListing/extractDtachSocketPath
// helpers from src/services/session-process.ts, and (like that script)
// this is build/dev tooling, not something that ships inside the SEA, so
// the `.mjs` CLI tree's "zero-dependency, node: builtins only" constraint
// doesn't apply here.
//
// Issue #1140 (PR 2) — unaffected by the per-instance unit rename
// (`crs-session-<id>` -> `crs-session-<instanceId>-<id>`): this script
// infers "foreign"/leaked only from the dtach socket path (missing on
// disk, or under the OS tmpdir), never from the unit name, and the
// `crs-session-*.scope` glob below still matches both shapes.
//
// Deliberately NOT wired into `make test`/the pre-push hook: this repo's
// own `SESSIONS_DIR` is a real, persistent path on a developer's machine
// with real, legitimate `crs-session-*` scopes running (dev sessions,
// other Mullion instances) — an assert-clean gate here would flag every one
// of them the moment it runs from a different checkout/cwd than whatever
// instance is actually live, and block every push. This stays a standalone,
// human-invoked check (`npm run check:scope-leaks` / `make check-scope-leaks`).
// The test-time guard against THIS issue's actual regression (this repo's
// own test suite leaking a scope) is the file-local `afterAll` in
// test/services/pty-manager-file-change-ignore.test.ts instead.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import {
  parseScopeUnitsListing,
  extractDtachSocketPath,
  isSystemctlUserAvailable,
} from "../src/services/session-process.js";

const SCOPE_PATTERN = "crs-session-*.scope";

if (!isSystemctlUserAvailable()) {
  console.log(
    "OK — `systemctl --user` isn't available here (e.g. a CI runner with no user systemd " +
      "session, or a plain container with the binary but no bus). Nothing to check.",
  );
  process.exit(0);
}

// Defense-in-depth alongside the isSystemctlUserAvailable() gate above
// (Hermes review, PR #1142) — a bus that answered `show-environment` a
// moment ago disappearing before this call is unlikely but not impossible
// (a logind/systemd-user-session teardown racing this script), and this is
// a diagnostic tool, not a correctness-critical gate: it should report and
// exit cleanly on any such failure rather than crash with an uncaught
// exception.
let listing: string;
try {
  listing = execFileSync(
    "systemctl",
    ["--user", "list-units", "--type=scope", "--all", "--no-legend", "--plain", SCOPE_PATTERN],
    { encoding: "utf8" },
  );
} catch (err) {
  console.log(
    `OK — could not list ${SCOPE_PATTERN} units (${(err as Error).message}). Nothing to check.`,
  );
  process.exit(0);
}

const rows = parseScopeUnitsListing(listing);

// A scope is suspect under either rule, independent of which Mullion
// install (this checkout's own, or a completely different one on the same
// host) actually owns it — neither rule needs to know that install's
// SESSIONS_DIR, which this script has no reliable way to learn anyway (it
// runs from a repo checkout, not from whatever instance is live):
//
//   1. Its dtach socket no longer exists on disk at all — definitively
//      orphaned (dtach itself never cleans these up; this is exactly what
//      caught issue #1137's own leaked `pty-manager-filechange-test-*`
//      unit).
//   2. Its socket path is under the OS tmp dir — a real install's
//      SESSIONS_DIR is a persistent, checked-in-config path; only a
//      test/scratch instance's own throwaway tmpdir lands there.
//
// A scope whose Description doesn't parse as a dtach invocation at all
// (extractDtachSocketPath returns null — some other app's own
// crs-session-*-shaped unit, or a systemd rendering this hasn't seen) is
// left alone rather than guessed at either way.
const tmpdir = os.tmpdir();
const suspects: Array<{ unit: string; socketPath: string; reason: string }> = [];

for (const { unit, description } of rows) {
  const socketPath = extractDtachSocketPath(description);
  if (!socketPath) continue;
  if (!existsSync(socketPath)) {
    suspects.push({ unit, socketPath, reason: "socket file no longer exists on disk" });
  } else if (socketPath.startsWith(tmpdir)) {
    suspects.push({ unit, socketPath, reason: `socket lives under the OS tmp dir (${tmpdir})` });
  }
}

if (suspects.length === 0) {
  console.log(`OK — no suspect ${SCOPE_PATTERN} units found (${rows.length} checked).`);
  process.exit(0);
}

console.log(`Found ${suspects.length} suspect leaked scope(s):\n`);
for (const { unit, socketPath, reason } of suspects) {
  console.log(`  ${unit} — ${reason} (${socketPath})`);
}
console.log(
  "\nIf these aren't sessions you still need, stop them with:\n" +
    `  systemctl --user stop ${suspects.map((s) => s.unit).join(" ")}`,
);
process.exit(1);
