#!/usr/bin/env node
// Claude Code WorktreeCreate / WorktreeRemove hook. Registered by
// hook-adapters/claude-code.ts only for sessions whose workflow conventions
// say worktrees live under `.wt/`: Claude Code's own worktrees (subagent
// `isolation: "worktree"`, EnterWorktree, `--worktree`) otherwise land in
// `.claude/worktrees/`, which no setting can change.
//
//   node <this file> create    stdin {cwd, name}      -> last stdout line: path
//   node <this file> remove    stdin {worktree_path}
//
// Plain JavaScript for the same dev/prod reason as forwarder.mjs. Everything
// but the final path goes to stderr; a non-zero exit makes Claude Code fail
// the creation, which is the right outcome when git itself failed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WT_DIR = ".wt";

function git(cwd, args, { quiet = false } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  }).trim();
}

/** The main checkout's root, even when `cwd` is inside another worktree. */
export function mainCheckoutRoot(cwd) {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return path.dirname(common);
}

export function slugify(name) {
  const slug = String(name)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  return slug || `agent-${Date.now()}`;
}

function defaultBaseRef(root) {
  try {
    return git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { quiet: true });
  } catch {
    return "HEAD";
  }
}

/** Copy the gitignored files `.worktreeinclude` lists (Claude Code skips this
 * once a create hook exists). One path per line; `#` comments and blank lines
 * ignored; anything escaping the repo root is dropped. */
function copyWorktreeInclude(root, dest) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(root, ".worktreeinclude"), "utf8").split("\n");
  } catch {
    return;
  }
  for (const raw of lines) {
    const rel = raw.trim();
    if (!rel || rel.startsWith("#")) continue;
    const from = path.resolve(root, rel);
    const to = path.resolve(dest, rel);
    if (!from.startsWith(root + path.sep) || !to.startsWith(dest + path.sep)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    } catch {
      // Missing or unreadable entry: a worktree without it still works.
    }
  }
}

export function createWorktree({ cwd, name }) {
  const root = mainCheckoutRoot(cwd);
  const slug = slugify(name);
  const dest = path.join(root, WT_DIR, slug);
  if (fs.existsSync(dest)) return dest;
  try {
    git(root, ["fetch", "origin"], { quiet: true });
  } catch {
    // Offline or no origin: branch from whatever we have.
  }
  git(root, ["worktree", "add", dest, "-b", `worktree-${slug}`, defaultBaseRef(root)]);
  copyWorktreeInclude(root, dest);
  return dest;
}

export function removeWorktree({ worktree_path: worktreePath }) {
  const resolved = path.resolve(worktreePath);
  const root = mainCheckoutRoot(resolved);
  // Only ever remove what createWorktree made.
  if (!resolved.startsWith(path.join(root, WT_DIR) + path.sep)) return;
  const branch = git(resolved, ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true });
  git(root, ["worktree", "remove", "--force", resolved]);
  // Keep any branch that still holds commits the default branch doesn't.
  if (!branch.startsWith("worktree-")) return;
  try {
    git(root, ["merge-base", "--is-ancestor", branch, defaultBaseRef(root)], { quiet: true });
    git(root, ["branch", "-D", branch], { quiet: true });
  } catch {
    // Unmerged work stays reachable from its branch.
  }
}

async function main() {
  const mode = process.argv[2];
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || "{}");
  if (mode === "create") {
    process.stdout.write(`${createWorktree(input)}\n`);
  } else if (mode === "remove") {
    removeWorktree(input);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
