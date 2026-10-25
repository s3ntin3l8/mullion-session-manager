#!/usr/bin/env node
// Makes a clone safe for concurrent agents.
//
// Issue #1836 — a background `git gc` in a clone that several agents push to
// concurrently can delete a loose object that a concurrent write is creating.
// The repack sequence is pack-then-unlink: an object written *after* the pack
// was built but *before* the unlink is removed without being in the pack. The
// damage surfaces far from the cause — a commit that cannot complete, naming
// a *missing* object rather than a corrupt one.
//
// `git fetch` runs `git gc --auto`, and this repo fetches a lot: the `wt` make
// target, and four runtime services (`git-fetch.ts`, `git-pull.ts`,
// `git-push.ts`, `git-refs.ts`). So the repo's own tooling can start the
// background gc that then races a concurrent commit in another worktree.
//
// The fix is `gc.auto 0` on the clone. It is per-clone config, and the clone
// is shared by all of its worktrees (they share one git dir), so one write
// covers every worktree.
//
// Reversible: `git config --unset gc.auto`. The cost is that loose objects
// accumulate until someone runs `git gc` deliberately, when no agent is
// pushing.
//
// Usage:
//   node scripts/git-safe-clone.mjs
//
// Exits 0 when the clone is safe (already was, or now is), non-zero on
// failure.

import { execFileSync } from "node:child_process";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.mjs";

/** Runs git, returning stdout, or null when git exits non-zero. */
function gitTry(args, opts = {}) {
  try {
    return execFileSync("git", [...GIT_NO_AUTO_GC, ...args], {
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

function main() {
  const commonDir = gitTry(["rev-parse", "--git-common-dir"]);
  if (!commonDir) {
    console.error(
      "git-safe-clone: not inside a git checkout — 'git rev-parse --git-common-dir' failed.",
    );
    return 1;
  }

  // The LOCAL config is what this script owns: it is the clone's own config,
  // shared by every worktree of the clone (a linked worktree only gets its own
  // config with an explicit `--worktree`). A global `gc.auto` would cover this
  // machine, not this clone.
  const before = gitTry(["config", "--local", "--get", "gc.auto"]);

  if (before === "0") {
    console.log(`git-safe-clone: gc.auto is already 0 — the clone is safe.`);
    console.log(`git-safe-clone:   config: ${commonDir}/config`);
    return 0;
  }

  try {
    execFileSync("git", [...GIT_NO_AUTO_GC, "config", "--local", "gc.auto", "0"], {
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    console.error(`git-safe-clone: could not set gc.auto: ${err.message}`);
    return 1;
  }

  console.log(
    `git-safe-clone: set gc.auto = 0${before === null ? "" : ` (was ${before})`} in ${commonDir}/config.`,
  );
  console.log("git-safe-clone: run 'git gc' deliberately, when no agent is pushing.");
  return 0;
}

process.exit(main());
