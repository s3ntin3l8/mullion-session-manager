import type { GitBranchMergeState, GitBranchOpReason, GitPullReason } from "../api/types.js";

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
  "still-running",
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

/**
 * The delete-branch button's tooltip, which is also what the armed state
 * shows on the second click. Deleting is a two-click force delete, so this is
 * where the user is told what they are about to lose: a branch not known to be
 * merged may hold commits that exist nowhere else, and a branch a resumable
 * task still references loses that task's Retry.
 */
export function deleteBranchTitle(
  mergeState: GitBranchMergeState | null | undefined,
  taskId: number | null | undefined,
): string {
  // `upstream-gone` counts as merged because mergeChip files it with the merged
  // states; a force-pushed-then-deleted remote can still hide local-only work.
  const known =
    mergeState === "ancestor" || mergeState === "pr-merged" || mergeState === "upstream-gone";
  const base = known ? "Delete branch" : "Delete branch — it may have unmerged commits";
  return taskId == null ? base : `${base} (owned by task #${taskId}; its Retry will break)`;
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
    case "still-running":
      return detail === "alive"
        ? "The session has ended but its process is still running in this worktree."
        : "Mullion can't confirm the session's process has exited.";
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
      // A refusal with no reason at all: the pull did not run and nothing
      // says why. The same words the sidebar uses for the same case.
      return detail ? `Pull failed: ${detail}` : "Pull failed — try again.";
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

/**
 * A refused checkout / branch create / rebase (issue #1672). Exhaustive by
 * type like pullReasonMessage above, with the same forward-compatible default.
 * `conflicts` lists the files the aborted rebase stopped on.
 */
export function branchOpReasonMessage(
  reason: GitBranchOpReason | undefined,
  detail?: string,
  conflicts?: readonly string[],
): string {
  switch (reason) {
    case undefined:
    case "failed":
      return detail ? `Failed: ${detail}` : "The operation failed — try again.";
    case "not-a-repo":
    case "invalid-name":
    case "no-such-branch":
    case "checked-out":
      return reasonMessage(reason, detail);
    case "no-such-ref":
      return `No such branch or ref${detail ? `: ${detail}` : ""}.`;
    case "already-exists":
      return "A branch with that name already exists.";
    case "already-current":
      return "Already on this branch.";
    case "unborn-head":
      return "The current branch has no commits.";
    case "detached-head":
      return "The checkout is on a detached HEAD — check out a branch first.";
    case "dirty-tree":
      return "The checkout has uncommitted changes — commit or stash them first.";
    case "operation-in-progress":
      return "A merge or rebase is stopped mid-way in the checkout — finish or abort it first.";
    case "no-base":
      return "Nothing to rebase onto: no upstream and no origin default branch.";
    case "already-up-to-date":
      return `Already up to date${detail ? ` with ${detail}` : ""}.`;
    case "conflicts": {
      const files = conflicts ?? [];
      const shown = files.slice(0, 5).join(", ");
      const more = files.length > 5 ? ` and ${files.length - 5} more` : "";
      return `Rebase${detail ? ` onto ${detail}` : ""} conflicts${
        shown ? ` in ${shown}${more}` : ""
      } — aborted, nothing changed.`;
    }
    case "sessions-active":
      return `${reasonMessage(reason, detail)} It works in this checkout — stop it first.`;
    case "busy":
      return "A git operation is already running for this repository — try again in a moment.";
    default: {
      assertNever(reason);
      return detail ? `Failed: ${detail}` : "The operation failed — try again.";
    }
  }
}

/** Compile-time exhaustiveness: passing anything but `never` is an error. */
function assertNever(_value: never): void {}
