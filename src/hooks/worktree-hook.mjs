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
import { fileURLToPath } from "node:url";

const WT_DIR = ".wt";

// Standalone copies of git-env.ts's GIT_NO_AUTO_GC and gitEnv(): this file is
// copied into dist/hooks verbatim and cannot import the TypeScript module.
// test/git-env-guard.test.ts checks GIT_NO_AUTO_GC against the others.
const GIT_NO_AUTO_GC = ["-c", "gc.auto=0"];
const GIT_ENV_KEYS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
];

function gitEnv() {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS_TO_STRIP) delete env[key];
  env.LC_ALL = "C";
  return env;
}

function git(cwd, args, { quiet = false } = {}) {
  return execFileSync("git", [...GIT_NO_AUTO_GC, ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
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
      // A symlink would copy whatever it points at, outside the repo.
      if (fs.lstatSync(from).isSymbolicLink()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true, dereference: false });
    } catch {
      // Missing or unreadable entry: a worktree without it still works.
    }
  }
}

/** Whether `dir` is a registered worktree of the repo at `root`. */
function isRegisteredWorktree(root, dir) {
  const listed = git(root, ["worktree", "list", "--porcelain"], { quiet: true });
  return listed
    .split("\n")
    .some((line) => line.startsWith("worktree ") && path.resolve(line.slice(9)) === dir);
}

function branchExists(root, branch) {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function headBranch(dir) {
  try {
    return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true });
  } catch {
    return "";
  }
}

/** A registered worktree is reusable only when it is the name this hook
 * created (`worktree-<slug>`) and idle (clean). Anything else is another
 * checkout sharing the directory — two subagents must not edit one tree. */
function canReuseWorktree(dest, branch) {
  if (headBranch(dest) !== branch) return false;
  try {
    return git(dest, ["status", "--porcelain"], { quiet: true }) === "";
  } catch {
    return false;
  }
}

export function createWorktree({ cwd, name }) {
  const root = mainCheckoutRoot(cwd);
  const base = slugify(name);
  // Claude reuses a subagent name across sessions, and removeWorktree keeps a
  // branch that holds unmerged commits: suffix instead of failing on the old
  // branch (or resetting it, which would orphan those commits) or adopting a
  // directory that is not a worktree (git there answers for the main checkout).
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const dest = path.join(root, WT_DIR, slug);
    const branch = `worktree-${slug}`;
    if (fs.existsSync(dest)) {
      if (isRegisteredWorktree(root, dest)) {
        if (canReuseWorktree(dest, branch)) return dest;
      } else {
        let entries;
        try {
          entries = fs.readdirSync(dest);
        } catch {
          entries = null;
        }
        if (entries && entries.length === 0) {
          // An empty squat permanently consumed the name: cleanup only walks
          // registered worktrees. Remove it and use the slot.
          fs.rmdirSync(dest);
        } else {
          process.stderr.write(
            `worktree-hook: ${dest} is not a worktree; leaving it and picking another name\n`,
          );
          continue;
        }
      }
      if (fs.existsSync(dest)) continue;
    }
    if (branchExists(root, branch)) continue;
    try {
      git(root, ["fetch", "origin"], { quiet: true });
    } catch {
      // Offline or no origin: branch from whatever we have.
    }
    git(root, ["worktree", "add", dest, "-b", branch, defaultBaseRef(root)]);
    copyWorktreeInclude(root, dest);
    return dest;
  }
  throw new Error(`no free worktree name for ${base} under ${WT_DIR}/`);
}

export function removeWorktree({ worktree_path: worktreePath }) {
  const resolved = path.resolve(worktreePath);
  const root = mainCheckoutRoot(resolved);
  // Only ever remove what createWorktree made.
  if (!resolved.startsWith(path.join(root, WT_DIR) + path.sep)) return;
  // Leave anything with uncommitted or untracked work alone: no --force, so
  // git refuses a dirty tree itself. Same rule as git-worktree.ts's
  // removeListedWorktree.
  if (git(resolved, ["status", "--porcelain"], { quiet: true }) !== "") return;
  const branch = git(resolved, ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true });
  git(root, ["worktree", "remove", resolved]);
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

// Realpath both sides: in production the script is reached through the
// `current` symlink, while import.meta.url is the resolved release path.
function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
