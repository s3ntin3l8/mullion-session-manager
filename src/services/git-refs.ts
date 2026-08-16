import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitEnv } from "./git-env.js";
// GitBranchInfo/GitWorktreeInfo now physically live in src/shared/types.ts
// (hand-mirrored 1:1 on the frontend — see frontend/src/api.ts's own
// re-export). Re-exported below so every existing backend importer of this
// module keeps working unchanged.
import type { GitBranchInfo, GitWorktreeInfo } from "../shared/types.js";

export type { GitBranchInfo, GitWorktreeInfo };

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

const GIT_TIMEOUT_MS = 10_000;
// B9 — see git-status.ts's identical constant for the full rationale
// (shared across every runGit-shaped helper in this sibling group).
const KILL_ESCALATION_MS = 2_000;

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

    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);

    // B9 — see git-status.ts's runGitStatus for the full rationale on both
    // the escalation and the listener-detach-in-finish shape below.
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill(); // SIGTERM
      finish(null);
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
    }, GIT_TIMEOUT_MS);

    child.on("error", () => {
      clearKillTimer();
      finish(null);
    });
    child.on("close", (code) => {
      clearKillTimer();
      finish(code === 0 ? stdout : null);
    });
  });
}

/** Parses `%(upstream:track)`'s bracketed form into ahead/behind/gone —
 * shared by `listBranches` below. Verified against a real repo (see
 * git-refs.test.ts): "[ahead 3, behind 1]", "[behind 4]", "[gone]", or
 * empty (up to date or no upstream at all). */
function parseUpstreamTrack(
  track: string,
): Pick<GitBranchInfo, "ahead" | "behind" | "upstreamGone"> {
  if (track === "[gone]") return { upstreamGone: true };
  const result: Pick<GitBranchInfo, "ahead" | "behind" | "upstreamGone"> = {};
  const aheadMatch = track.match(/ahead (\d+)/);
  const behindMatch = track.match(/behind (\d+)/);
  if (aheadMatch) result.ahead = Number(aheadMatch[1]);
  if (behindMatch) result.behind = Number(behindMatch[1]);
  return result;
}

/**
 * Lists local branches (`git for-each-ref refs/heads`), marking whichever one
 * HEAD points at, plus the free upstream/ahead/behind/relative-date
 * enrichment fields (issue #442 — see GitBranchInfo's own doc comment).
 * Still exactly **one** `for-each-ref` spawn regardless of `opts.detail` —
 * `store.ts`'s `refreshGitRefs` calls this for every project on every 15th
 * live-refresh tick (~60s), so cost per project per minute matters (the
 * plan's own framing). Returns `null` when `cwd` isn't a git repo or `git`
 * itself fails; never throws. Never caches — same "don't amplify a
 * transient failure" lesson as git-status.ts (#160): a caller polling this
 * on an explicit refresh should see a fresh failure resolve on its own next
 * time, not a stale cached null.
 *
 * `opts.detail` (issue #442) additionally computes `isMerged` per branch —
 * 1-3 spawns to resolve the default base ref (never `resolveDefaultBaseRef`
 * itself, which runs `git fetch origin` first; a no-fetch fallback chain is
 * shared via `resolveDefaultBaseRefNoFetch` below) plus one `git branch
 * --merged <base>` call. Set only by the GitPanel's explicit fetch
 * (`?detail=1` on the route), never by the unconditional poll above.
 */
export async function listBranches(
  cwd: string,
  opts?: { detail?: boolean },
): Promise<GitBranchInfo[] | null> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) return null;

  const output = await runGit(cwd, [
    "for-each-ref",
    "--format=%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:relative)",
    "refs/heads",
  ]);
  if (output === null) return null;

  const branches: GitBranchInfo[] = output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [head, name, upstream, track, relative] = line.split("\t");
      const info: GitBranchInfo = { name: name ?? "", isCurrent: head === "*" };
      if (upstream) info.upstream = upstream;
      if (track) Object.assign(info, parseUpstreamTrack(track));
      if (relative) info.lastCommitRelative = relative;
      return info;
    })
    .filter((branch) => branch.name.length > 0);

  if (opts?.detail) {
    const base = await resolveDefaultBaseRefNoFetch(cwd);
    // A chain that falls through to HEAD means no remote is configured —
    // suppress isMerged entirely rather than report a misleading "merged
    // into whatever branch you're standing on" (see GitBranchInfo's doc
    // comment).
    if (base !== "HEAD") {
      const merged = await runGit(cwd, ["branch", "--merged", base, "--format=%(refname:short)"]);
      if (merged !== null) {
        const mergedNames = new Set(
          merged
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        );
        for (const branch of branches) branch.isMerged = mergedNames.has(branch.name);
      }
    }
  }

  return branches;
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
/**
 * The fallback chain shared by `resolveDefaultBaseRef` below and
 * `listBranches`' `isMerged` enrichment (issue #442):
 * `symbolic-ref refs/remotes/origin/HEAD` -> `origin/main` -> `origin/master`
 * -> `HEAD`. Deliberately does NOT fetch — see `resolveDefaultBaseRef`'s own
 * doc comment for why a network round-trip on every call would be wrong for
 * `listBranches`' on-panel-open caller. Assumes `cwd` has already been
 * validated (`isSafeAbsolutePath` + `.git` exists) by the caller.
 */
export async function resolveDefaultBaseRefNoFetch(cwd: string): Promise<string> {
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

export async function resolveDefaultBaseRef(cwd: string): Promise<string> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) return "HEAD";

  // Best-effort freshness — a stale/missing origin/HEAD or origin/main is
  // exactly the failure mode this guards against; a fetch failure (offline,
  // no remote) just means the candidates below resolve against whatever the
  // repo already has locally.
  await runGit(cwd, ["fetch", "origin", "--quiet"]);

  return resolveDefaultBaseRefNoFetch(cwd);
}

/**
 * The `/api/projects/:id/git-branches` route's variant for the promote and
 * launcher base-ref pickers (issue #271 follow-up): same no-fetch chain as
 * `resolveDefaultBaseRefNoFetch` (this route is on the sidebar's 60s
 * background poll, so a `git fetch` per call is wrong here too — see that
 * function's own doc comment), but returns `null` instead of the literal
 * `"HEAD"` fallback. `"HEAD"` is a fine worktree-creation argument (git
 * always accepts it) but a bad UI default: it isn't a real ref a human would
 * recognize, and surfacing it would prepend an unfamiliar "HEAD" entry to
 * the base-ref dropdown and preselect it. `null` lets callers fall back to
 * the current branch instead, exactly like a repo with no `origin` at all
 * (there's no meaningful way to distinguish "no remote" from "remote
 * present but nothing resolved" here, and callers don't need to).
 */
export async function resolveDefaultBaseRefForPicker(cwd: string): Promise<string | null> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) return null;
  const resolved = await resolveDefaultBaseRefNoFetch(cwd);
  return resolved === "HEAD" ? null : resolved;
}

/**
 * Resolves `ref` to a commit SHA against `cwd` (`git rev-parse --verify`).
 * Used to pin a symbolic ref (e.g. `resolveDefaultBaseRef`'s
 * `"origin/main"`) to a fixed point in time — the ref itself keeps moving,
 * the SHA doesn't. Returns `null` rather than throwing on any failure
 * (unresolvable ref, non-repo cwd, git error), matching this file's
 * best-effort posture.
 */
export async function resolveCommitSha(cwd: string, ref: string): Promise<string | null> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) return null;
  const sha = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return sha ? sha.trim() : null;
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
