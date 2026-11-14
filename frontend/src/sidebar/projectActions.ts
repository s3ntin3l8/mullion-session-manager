import { useDashboardStore } from "../store/index.js";
import { staleLockMessage } from "../git/gitReasons.js";
import { LOCAL_HOST_ID } from "../api/index.js";
import type { GitStatus, Project, Session } from "../api/index.js";

// A project's Git pull and Delete (its Edit dialog is ProjectEditModal.tsx), as the sidebar's project header menu
// runs them — shared with the session launcher's Where row (#3048), so the
// two surfaces cannot drift apart.

// Issue #431-adjacent — short, user-facing copy for `git pull` refusal
// reasons. Mirrors the message shape SourceControlSection.tsx already uses
// for the same backend response, but trimmed to the one-line slot the
// kebab-error affordance has. Kept inline here rather than promoted to a
// shared helper because the two surfaces have different copy needs and a
// premature consolidation would just drag them both around.
export function formatPullReasonMessage(reason: string | undefined, detail?: string): string {
  switch (reason) {
    case "not-a-repo":
      return "Not a git repository.";
    case "unborn-head":
      return "Cannot pull in an unborn branch.";
    case "detached-head":
      return "Cannot pull in a detached HEAD state.";
    case "no-upstream":
      return "No upstream tracking branch configured.";
    case "dirty-tree":
      return "Working tree has uncommitted changes — commit or stash them first.";
    case "not-fast-forward":
      return "Local branch has diverged from origin — pull cannot fast-forward.";
    case "already-up-to-date":
      return "Already up to date with tracking branch.";
    case "pull-failed":
      return detail ? `Pull failed: ${detail}` : "The pull operation failed.";
    // Issue #1896 — a git operation (a clone repair) holds the clone. Not a
    // failure: the pull was refused, and trying again in a moment works. The
    // default branch would say "Pull failed: …", which is the wrong story.
    case "busy":
      return "A git operation is already running for this repository — try again in a moment.";
    case "stale-lock":
      return staleLockMessage(detail);
    default:
      return detail ? `Pull failed: ${detail}` : "Pull failed — try again.";
  }
}

// Whether Git pull can do anything, and the reason shown when it cannot:
// enabled only when the branch is behind its upstream (the same gating as
// SourceControlSection's Pull button).
//
// gitStatuses[id] === null collapses three distinct states
// (SourceControlSection.tsx): durably not a repo, never fetched yet, and —
// for a remote-hosted project only — the agent host being unreachable. A
// local project's host is this process itself, so "not a repo" is the honest
// read there; a remote-hosted project's null is genuinely ambiguous, so its
// label says so (Hermes review, PR #1366). It keys on
// `project.hostId !== LOCAL_HOST_ID`, not on a `hosts` lookup, which is
// undefined until the hosts list has loaded.
export function gitPullState(
  project: Project,
  gitStatus: GitStatus | null | undefined,
): { disabled: boolean; title: string } {
  return {
    disabled: !gitStatus || gitStatus.behind === 0,
    title: !gitStatus
      ? project.hostId !== LOCAL_HOST_ID
        ? "Not a git repository, or the host is unreachable."
        : "Not a git repository"
      : gitStatus.behind === 0
        ? "Already up to date with tracking branch"
        : `Pull ${gitStatus.behind} commit${gitStatus.behind === 1 ? "" : "s"} from tracking branch`,
  };
}

// Runs `git pull` for the project; resolves to the message to show, or null
// when it pulled.
export async function pullProject(projectId: number): Promise<string | null> {
  try {
    const result = await useDashboardStore.getState().pullProjectGit(projectId);
    if (!result.pulled) {
      // No `&& result.reason` guard — formatPullReasonMessage's default
      // branch covers `{pulled: false}` without a reason, so a missing-reason
      // response never falls through silently.
      return formatPullReasonMessage(result.reason, result.detail);
    }
    // Other pull surfaces invalidate refs too (Hermes review, PR #1366):
    // without this, branch labels and diff stats stay stale until their own
    // poll tick lands.
    await Promise.all([
      useDashboardStore.getState().refreshGitStatuses(),
      useDashboardStore.getState().refreshGitRefs([projectId]),
    ]);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Pull failed — try again.";
  }
}

// Deletes the project, then reports each of its sessions as ended (so their
// open panes close). Resolves to the message to show, or null when deleted.
export async function deleteProjectAndEndSessions(
  projectId: number,
  sessions: Session[],
  onSessionEnded: (session: Session) => void,
): Promise<string | null> {
  try {
    await useDashboardStore.getState().deleteProject(projectId);
    sessions.forEach(onSessionEnded);
    return null;
  } catch (err: unknown) {
    console.debug("[Sidebar] deleteProject failed", err);
    return err instanceof Error ? err.message : "Failed to delete project — try again.";
  }
}
