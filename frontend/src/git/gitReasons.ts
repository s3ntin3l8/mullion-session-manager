import type { GitPullReason } from "../api/types.js";

// Issue #442 — reasons a branch-delete/worktree-remove refusal is worth
// offering a Force retry for. Every other reason (invalid-name, no-such-
// branch, not-a-repo, current-branch, checked-out, is-main, not-listed,
// directory-gone, delete-failed, remove-failed) either cannot succeed under
// force or has a dedicated alternative (e.g. Prune stale for directory-gone).
export const FORCEABLE_REASONS = new Set([
  "unmerged",
  "task-branch",
  "dirty",
  "conflicts",
  "sessions-active",
]);

/**
 * Strips `refs/remotes/` and `origin/` from the backend's resolved default
 * branch ref (`origin/main`, `origin/trunk`, etc.) and returns whether
 * `branchName` is the repository's default branch. Falls back to `main` /
 * `master` when `defaultBranch` is absent.
 */
export function isDefaultBranchName(
  branchName: string,
  defaultBranch: string | null | undefined,
): boolean {
  const resolved = defaultBranch?.replace(/^refs\/remotes\//, "").replace(/^origin\//, "");
  return resolved ? branchName === resolved : branchName === "main" || branchName === "master";
}

export function reasonMessage(reason: string | undefined, detail: string | undefined): string {
  switch (reason) {
    case "current-branch":
      return "This is the current branch.";
    case "checked-out":
      return `Checked out in another worktree${detail ? `: ${detail}` : ""}.`;
    case "unmerged":
      return "This branch has commits not merged into the default base.";
    case "task-branch":
      return `Referenced by task ${detail ?? "?"} — Force will break its Retry.`;
    case "no-such-branch":
      return "Branch no longer exists.";
    case "invalid-name":
      return "Invalid branch name.";
    case "not-a-repo":
      return "Not a git repository.";
    case "delete-failed":
    case "remove-failed":
      return `The operation failed.${detail ? ` ${detail}` : ""}`;
    case "not-listed":
      return "This worktree is no longer reported by git.";
    case "is-main":
      return "The main worktree can't be removed.";
    case "dirty":
      return "This worktree has uncommitted changes.";
    case "conflicts":
      return "This worktree has unresolved merge conflicts.";
    case "sessions-active":
      return `Active session${detail?.includes(",") ? "s" : ""}: ${detail ?? "?"}.`;
    case "directory-gone":
      return "This worktree's directory no longer exists — use Prune stale instead.";
    default:
      return "Action failed.";
  }
}

/**
 * The PULL refusal's message.
 *
 * Typed to GitPullReason and EXHAUSTIVE by type: a new member of the union
 * with no case here is a COMPILE error, not a silent fall-through to
 * "Action failed." That guard is not theoretical — issue #1896's "busy" (a
 * refusal, not a failure) reached one renderer's default branch and told the
 * user the pull had FAILED.
 *
 * The default branch is the forward-compatibility path, not the
 * exhaustiveness path: a NEWER backend can send a reason this build has
 * never heard of, and that must still say something sensible.
 */
export function pullReasonMessage(reason: GitPullReason | undefined, detail?: string): string {
  switch (reason) {
    case undefined:
      return "Action failed.";
    case "not-a-repo":
      // Shared with the branch/worktree refusals — one copy of that copy.
      return reasonMessage(reason, detail);
    case "unborn-head":
      return "The current branch has no commits.";
    case "detached-head":
      return "Cannot pull in a detached HEAD state.";
    case "no-upstream":
      return "No upstream tracking branch configured.";
    case "dirty-tree":
      return "Working tree has uncommitted changes or conflicts.";
    case "not-fast-forward":
      return "Branch has diverged from upstream (cannot fast-forward).";
    case "already-up-to-date":
      return "Already up to date.";
    case "pull-failed":
      return detail ? `Pull failed: ${detail}` : "The pull operation failed.";
    case "busy":
      return "A git operation is already running for this repository — try again in a moment.";
    default: {
      // Compile-time exhaustiveness: a new member of GitPullReason with no
      // case above is an error here. At runtime this is where a reason from
      // a newer backend lands.
      assertNever(reason);
      return detail ? `Pull failed: ${detail}` : "Pull failed — try again.";
    }
  }
}

/** Compile-time exhaustiveness: passing anything but `never` is an error. */
function assertNever(_value: never): void {}
