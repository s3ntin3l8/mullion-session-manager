import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Cheap, always-on branch-name lookup (issue #96) — a pure `.git/HEAD` read,
// no `git` CLI shell-out, same "read-only, never throw, missing file is the
// normal case" philosophy as git-remote.ts (this is the second file in the
// repo that reads .git/* directly rather than shelling out). Deliberately
// separate from git-status.ts's fuller `git status` call: this is cheap
// enough to run on every GET /api/projects — the endpoint already polled by
// the live-refresh loop — while the richer dirty/ahead-behind/file-list view
// (git-status.ts) is reserved for the GitPanel and gated behind its own
// cache.

/**
 * Reads `<cwd>/.git/HEAD` and returns the current branch name, a short
 * detached-HEAD SHA, or `null` when there's no readable branch (not a git
 * repo, unreadable HEAD, or a HEAD content this doesn't recognize). Never
 * throws — matches parseGitRemote's "missing/malformed is exactly 'no repo
 * here'" posture (git-remote.ts).
 *
 * Deliberately does NOT follow a `git worktree` checkout's `.git` *file*
 * (a `gitdir: <path>` redirect to the main repo's `.git/worktrees/<name>`)
 * to its real HEAD — `path.join(cwd, ".git", "HEAD")` simply won't exist for
 * one (`.git` is a file, not a directory there), so this returns null, the
 * same "no branch info" result as a plain non-repo directory. Earlier this
 * did follow that redirect (parsing the file's own content for a second
 * path), which CodeQL correctly flagged as a real path-traversal gap: unlike
 * `cwd` itself (constrained by the caller's PROJECTS_ROOTS/resolveWithinRoots
 * check), a `gitdir:` value is untrusted file *content* with no such
 * boundary, so it could point anywhere on disk. Issue #100's worktree
 * sessions will resolve their own branch correctly some other way — most
 * likely by having git-worktree.ts record the worktree's own path in the DB
 * (session.worktreePath) rather than this function ever needing to trust an
 * arbitrary `.git` file's redirect target.
 */
export function readGitBranch(cwd: string): string | null {
  // Same guard as parseGitRemote (git-remote.ts:57-70) — `cwd` here is
  // always meant to be an already-resolved absolute directory (a project's
  // own `cwd` column, or an agent-side value already passed through
  // resolveWithinRoots), so a relative one is rejected outright rather than
  // resolved against this process's own cwd.
  if (!path.isAbsolute(cwd) || path.normalize(cwd).split(path.sep).includes("..")) {
    return null;
  }
  const headPath = path.join(cwd, ".git", "HEAD");
  if (!existsSync(headPath)) return null;

  let content: string;
  try {
    content = readFileSync(headPath, "utf8").trim();
  } catch {
    return null;
  }

  const refMatch = content.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (refMatch) return refMatch[1];

  // Detached HEAD — `HEAD` holds the checked-out commit's full SHA directly
  // rather than a `ref: ...` line. Short-form (7 chars), matching what
  // `git status`/a terminal prompt would typically show.
  if (/^[0-9a-f]{40}$/i.test(content)) return content.slice(0, 7);

  return null;
}
