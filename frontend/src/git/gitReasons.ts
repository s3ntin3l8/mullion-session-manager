// Reasons a delete or remove refusal can be overridden via force: true.
export const FORCEABLE_REASONS = new Set([
  "unmerged",
  "task-branch",
  "dirty",
  "conflicts",
  "sessions-active",
]);

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
    case "dirty-tree":
      return "Working tree has uncommitted changes or conflicts.";
    case "detached-head":
      return "Cannot pull in a detached HEAD state.";
    case "unborn-head":
      return "The current branch has no commits.";
    case "no-upstream":
      return "No upstream tracking branch configured.";
    case "not-fast-forward":
      return "Branch has diverged from upstream (cannot fast-forward).";
    case "already-up-to-date":
      return "Already up to date.";
    case "pull-failed":
      return detail ? `Pull failed: ${detail}` : "The pull operation failed.";
    default:
      return "Action failed.";
  }
}
