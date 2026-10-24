#!/usr/bin/env node
// Issue #1804 — node-pty's PREBUILT `spawn-helper` ships WITHOUT the
// executable bit, so on macOS every session spawn fails with a bare
// "posix_spawnp failed." (node-pty execs the helper with posix_spawnp; the
// helper is mode 644 in the npm tarball, so the exec fails with EACCES).
//
// Why only macOS: node-pty 1.1.0 ships prebuilts for darwin and win32 only.
// On Linux it compiles from source, and the compiled helper is executable —
// which is why the whole suite is green on Linux CI and the product is
// completely broken on a Mac.
//
// Why a postinstall: the production install path is `npm ci --omit=dev` in the
// install root (deploy/install.sh, scripts/self-update.sh), and npm runs the
// ROOT package's own lifecycle scripts on every install — so this runs for the
// dev checkout AND for every deployed release.
//
// Idempotent and safe: a no-op when node-pty has no prebuilds (the Linux
// case), and a no-op when the helper is already executable.
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The package root is this script's own parent directory — NOT the cwd. npm
// runs lifecycle scripts with cwd = the package root, but resolving from the
// script's own location also makes the script work when it is invoked by
// hand, and the optional argument is what the test drives.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(scriptDir, ".."));

const prebuildsDir = path.join(root, "node_modules", "node-pty", "prebuilds");

// No prebuilds at all: node-pty was built from source (the Linux case), or
// node-pty is not installed. Both are normal, not errors.
if (!existsSync(prebuildsDir)) {
  process.exit(0);
}

const fixed = [];
for (const entry of readdirSync(prebuildsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const helper = path.join(prebuildsDir, entry.name, "spawn-helper");
  if (!existsSync(helper)) continue;
  // Only `spawn-helper` is exec'd; `pty.node` is dlopen'd and needs no
  // executable bit.
  const mode = statSync(helper).mode & 0o777;
  if ((mode & 0o111) === 0o111) continue;
  chmodSync(helper, 0o755);
  fixed.push(path.join(entry.name, "spawn-helper"));
}

if (fixed.length > 0) {
  console.log(
    `fix-node-pty-helper: made ${fixed.length} spawn-helper executable (${fixed.join(", ")})`,
  );
}
