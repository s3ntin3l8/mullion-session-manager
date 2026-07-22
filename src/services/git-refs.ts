import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Branch + worktree enumeration for the GitPanel (issue #162's "worktree
// awareness" half): the repo's first `git branch`/`git worktree list`-style
// calls — everything else that reads git state (git-status.ts, git-branch.ts,
// git-worktree.ts) resolves only the *current* branch of the project root.
// Same conventions as those siblings: `spawn` with an argv array (never a
// shell string), stdout captured on `'close'` (not `'exit'` — see
// git-status.ts's own comment on that race), best-effort and never throws —
// a missing/non-repo cwd or a failed `git` call is just "nothing to show"
// (null), not an error. Deliberately fetched on demand (GitPanel open) rather
// than on the sidebar's 4s live-refresh tick — branch/worktree lists change
// far less often than working-tree status and cost more to enumerate.
//
// This file keeps its own copy of the absolute-path + no-".."-segment guard
// and `.git`-existence check rather than importing git-status.ts's — every
// file in this group (git-status.ts, git-branch.ts, git-worktree.ts) already
// duplicates that guard rather than sharing it, so this follows the
// established pattern instead of introducing a new cross-file dependency.

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
}

export interface GitWorktreeInfo {
  path: string;
  /** `null` for a worktree checked out at a detached HEAD (or a bare repo
   * entry) — not every worktree has a branch. */
  branch: string | null;
  /** The repo's original working directory — always first in `git worktree
   * list`'s own output, never removable via `git worktree remove`. */
  isMain: boolean;
}

const GIT_TIMEOUT_MS = 10_000;

// git honors GIT_DIR/GIT_WORK_TREE (and friends) *before* it ever looks at
// `-C <cwd>` — if this process inherited one of these (e.g. from a git hook
// that spawned it without clearing its own hook-scoped environment; observed
// happening to `npm test` under pre-commit's pre-push stage), every call
// below would silently target whatever repo GIT_DIR points at instead of the
// caller's actual `cwd`, regardless of the explicit `-C` flag. Stripping them
// here is what makes `-C cwd` actually authoritative.
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_CEILING_DIRECTORIES;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_PREFIX;
  return env;
}

function isSafeAbsolutePath(cwd: string): boolean {
  return path.isAbsolute(cwd) && !path.normalize(cwd).split(path.sep).includes("..");
}

/** Runs `git -C <cwd> <args>`, capturing stdout on `'close'`. Resolves `null`
 * on any non-zero exit, spawn error, or timeout. */
function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawnChild("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, GIT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? stdout : null));
  });
}

/**
 * Lists local branches (`git for-each-ref refs/heads`), marking whichever one
 * HEAD points at. Returns `null` when `cwd` isn't a git repo or `git` itself
 * fails; never throws. Never caches — same "don't amplify a transient
 * failure" lesson as git-status.ts (#160): a caller polling this on an
 * explicit refresh should see a fresh failure resolve on its own next time,
 * not a stale cached null.
 */
export async function listBranches(cwd: string): Promise<GitBranchInfo[] | null> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) return null;

  const output = await runGit(cwd, [
    "for-each-ref",
    "--format=%(HEAD)%09%(refname:short)",
    "refs/heads",
  ]);
  if (output === null) return null;

  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [head, name] = line.split("\t");
      return { name: name ?? "", isCurrent: head === "*" };
    })
    .filter((branch) => branch.name.length > 0);
}

/** Parses `git worktree list --porcelain`'s blank-line-separated blocks. The
 * main worktree (the repo's original checkout, where `.git` is a real
 * directory rather than a redirect file) is always listed first. */
function parseWorktreePorcelain(output: string): GitWorktreeInfo[] {
  return output
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block, index) => {
      let worktreePath = "";
      let branch: string | null = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.slice("worktree ".length).trim();
        } else if (line.startsWith("branch ")) {
          const ref = line.slice("branch ".length).trim();
          branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
        }
        // A "detached" or "bare" line (no "branch" line at all) leaves
        // `branch` at its `null` default — both are "no branch" cases here.
      }
      return { path: worktreePath, branch, isMain: index === 0 };
    })
    .filter((worktree) => worktree.path.length > 0);
}

/**
 * Lists all worktrees for the repo at `cwd` (`git worktree list --porcelain`)
 * — the repo's main checkout plus any linked worktrees, whoever created them
 * (Tessera, a coding agent's own worktree management, or a manual `git
 * worktree add`). Returns `null` when `cwd` isn't a git repo or `git` itself
 * fails; never throws.
 */
export async function listWorktrees(cwd: string): Promise<GitWorktreeInfo[] | null> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) return null;

  const output = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (output === null) return null;

  return parseWorktreePorcelain(output);
}
