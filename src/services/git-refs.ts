import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitEnv } from "./git-env.js";

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

/**
 * Lists remote-tracking branches (`git for-each-ref refs/remotes`), for the
 * base-ref picker issue #271's promote/launcher-toggle flows offer (the
 * roadmap's "not one hardcoded rule" note — a human present may want to
 * branch off a remote branch, not just a local one). Kept separate from
 * `listBranches` rather than folding into it: the GitPanel's own "Branches"
 * section already renders `listBranches`' result unchanged, and merging
 * remotes into that shape would silently change what it displays. Strips
 * the symbolic `origin/HEAD` entry (`for-each-ref` includes it, but it's
 * not a real ref a worktree can branch from). Returns `null` when `cwd`
 * isn't a git repo or `git` itself fails; never throws.
 */
export async function listRemoteBranches(cwd: string): Promise<string[] | null> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) return null;

  const output = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]);
  if (output === null) return null;

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/HEAD"));
}

/**
 * Resolves the ref a Task Master claim (issue #216) should branch its
 * worktree from, when there's no human present to pick one via the
 * interactive base-ref picker (issue #271's `listRemoteBranches`) — the
 * roadmap's "branch from origin/<default> for the autonomous case" rule.
 * Best-effort `git fetch origin` first so `origin/HEAD`/`origin/main` are
 * current before resolving (origin/HEAD is only written at clone time, so a
 * long-lived checkout's copy can otherwise be stale or entirely absent).
 * Falls back through `origin/main` -> `origin/master` -> `HEAD` if the
 * symbolic ref can't be resolved. Never throws; always returns a usable ref
 * string (worst case `"HEAD"`, which `git worktree add -b <branch> <path>
 * HEAD` always accepts for a repo with at least one commit).
 */
export async function resolveDefaultBaseRef(cwd: string): Promise<string> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) return "HEAD";

  // Best-effort freshness — a stale/missing origin/HEAD or origin/main is
  // exactly the failure mode this guards against; a fetch failure (offline,
  // no remote) just means the candidates below resolve against whatever the
  // repo already has locally.
  await runGit(cwd, ["fetch", "origin", "--quiet"]);

  const symbolic = await runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const remotePrefix = "refs/remotes/";
  if (symbolic) {
    const trimmed = symbolic.trim();
    if (trimmed.startsWith(remotePrefix)) return trimmed.slice(remotePrefix.length);
  }

  for (const candidate of ["origin/main", "origin/master"]) {
    const verified = await runGit(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${candidate}^{commit}`,
    ]);
    if (verified !== null) return candidate;
  }

  return "HEAD";
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
 * (Mullion, a coding agent's own worktree management, or a manual `git
 * worktree add`). Returns `null` when `cwd` isn't a git repo or `git` itself
 * fails; never throws.
 */
export async function listWorktrees(cwd: string): Promise<GitWorktreeInfo[] | null> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) return null;

  const output = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (output === null) return null;

  return parseWorktreePorcelain(output);
}
