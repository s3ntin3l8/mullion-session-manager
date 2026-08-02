// Task -> PR promotion (Phase 6 Task Master, 6.7/#220) — the approve-flow
// half: push the task's worktree branch and open a PR against the repo's
// current default branch. Deliberately does the push + PR-create BEFORE
// any local status write (routes/tasks.ts's approve handler only flips
// the task to "done" once this returns ok:true) — a failure here must
// leave the task in "reviewing", safely retryable, never half-promoted
// (a task with a pushed branch but no recorded PR, or vice versa).
//
// #485 — a failure reaching or authenticating with GitHub here
// (no-token/no-repo/push-failed/pr-create-failed — NOT the purely local
// dirty-tree/no-worktree/remote-not-supported checks, nor the
// pr-create-failed sub-case where resolveDefaultBaseRef itself can't
// determine a default branch, also purely local — see that check's own
// comment, Hermes review PR #495 second pass) also records
// tasks.githubSyncError, via the same helper task-github-sync.ts's own
// catch blocks use. Previously this path's only visible trace of a
// failure was routes/tasks.ts's synchronous HTTP error response — real in
// the moment, but gone the instant the browser tab closes or remounts.
import type { FastifyInstance } from "fastify";
import type { tasks, projects } from "../db/schema.js";
import { getGitStatus } from "./git-status.js";
import { resolveGitHubToken } from "./github-integration.js";
import { resolveRepoRef } from "./github-webhook.js";
import { createPullRequest, findPullRequestByHead, GitHubWriteScopeError } from "./github-write.js";
import { GitHubApiError } from "./github.js";
import { resolveDefaultBaseRef } from "./git-refs.js";
import { pushBranch } from "./git-push.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { recordGithubSyncError, clearGithubSyncError } from "./task-github-sync.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

export type PromoteOutcome =
  | { ok: true; prUrl: string }
  | {
      ok: false;
      reason:
        | "no-worktree"
        | "dirty-tree"
        | "no-token"
        | "no-repo"
        | "push-failed"
        | "pr-create-failed"
        | "remote-not-supported";
      detail?: string;
    };

/**
 * Known, accepted gap (6.8/#283): `getGitStatus`, `pushBranch`, and
 * `resolveDefaultBaseRef` below all run local git shell-outs directly
 * against `project.cwd` — none of them route through `resolveBackend`, so
 * none of them can reach a remote-hosted project's filesystem. 6.8 lifted
 * the claim-time and worktree-lifecycle restrictions on remote-hosted
 * tasks (task-claim.ts, git-worktree.ts's SessionBackend proxy), but
 * promotion-to-PR still can't run for one — refused cleanly below rather
 * than silently misreading "can't reach the filesystem" as "not a repo" /
 * "nothing to push." Proxying status/push/base-ref resolution the way
 * worktree create/remove/prune already are is a larger, separate PR.
 */
function isPromotionSupported(project: ProjectRow): boolean {
  return project.hostId === LOCAL_HOST_ID;
}

/**
 * #486 — if a previous approve attempt already pushed AND created a PR but
 * failed before this function's caller recorded `prUrl` (e.g. the process
 * crashed between the two), a retry's createPullRequest call gets GitHub's
 * 422 "A pull request already exists for <owner>:<branch>". Rather than
 * surface that as a generic pr-create-failed, the catch block below
 * specifically detects a 422 and looks the existing PR up
 * (findPullRequestByHead) — this narrow crash-window case is the only
 * caller of that lookup, so it isn't spent on every ordinary approve, only
 * on this one retry path.
 */
export async function promoteTaskToPR(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
): Promise<PromoteOutcome> {
  if (!isPromotionSupported(project)) {
    return {
      ok: false,
      reason: "remote-not-supported",
      detail:
        "Promoting a remote-hosted task to a PR isn't supported yet — approve/reject still work locally against the task's worktree on its own host, but PR creation needs local git status/push, which don't yet proxy to remote hosts",
    };
  }
  if (!task.worktreePath || !task.branchName) {
    return {
      ok: false,
      reason: "no-worktree",
      detail: "Task has no recorded worktree/branch to promote",
    };
  }

  // forceFresh (Hermes review, PR #475): the default 5s-cached read could
  // serve "clean" from before the agent's last commit — approve pushing on
  // a stale read would silently exclude work the human never got to see
  // excluded, exactly what this gate exists to prevent.
  const status = await getGitStatus(task.worktreePath, { forceFresh: true });
  if (!status) {
    return {
      ok: false,
      reason: "no-worktree",
      detail: `Could not read git status for ${task.worktreePath}`,
    };
  }
  // The human should see uncommitted work, not have it silently excluded
  // from the PR — refuse rather than pushing a partial branch.
  if (!status.isClean || status.hasConflicts) {
    return {
      ok: false,
      reason: "dirty-tree",
      detail: status.hasConflicts
        ? "Worktree has unresolved merge conflicts"
        : "Worktree has uncommitted changes — commit or discard them before approving",
    };
  }

  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) {
    recordGithubSyncError(app, task.id, "Could not resolve the project's GitHub repo");
    return { ok: false, reason: "no-repo", detail: "Could not resolve the project's GitHub repo" };
  }
  // #489 — repo-scoped (App installation token when configured, falling
  // back to the shared PAT/OAuth token) rather than the plain getToken this
  // used before. Reordered after repoRef (needed to resolve the App path)
  // rather than before it, unlike the original getToken-first ordering.
  const token = await resolveGitHubToken(app, repoRef);
  if (!token) {
    recordGithubSyncError(app, task.id, "No GitHub token connected");
    return { ok: false, reason: "no-token", detail: "No GitHub token connected" };
  }

  // Resolved BEFORE pushing (Hermes review, PR #475) — resolveDefaultBaseRef
  // doesn't depend on the push at all, and checking it first means an
  // undeterminable default branch fails cleanly with nothing pushed yet,
  // rather than leaving a pushed-but-PR-less branch on origin that a retry
  // has to reconcile. resolveDefaultBaseRef returns e.g. "origin/main" (or
  // bare "HEAD" when it couldn't determine one) — the PR API wants a bare
  // branch name.
  const baseRefRaw = await resolveDefaultBaseRef(project.cwd);
  const base = baseRefRaw.startsWith("origin/") ? baseRefRaw.slice("origin/".length) : baseRefRaw;
  if (base === "HEAD") {
    // Deliberately does NOT recordGithubSyncError here (Hermes review, PR
    // #495, second pass): resolveDefaultBaseRef is a purely local git
    // resolution (project.cwd's own remote-tracking refs), not a GitHub
    // write/scope problem — recording it in a field whose banner reads
    // "GitHub sync: …" would misdirect a user toward re-checking their
    // token when the actual fix is local (e.g. the repo has no remote
    // tracking branch at all).
    return {
      ok: false,
      reason: "pr-create-failed",
      detail: "Could not determine the repository's default branch",
    };
  }

  const pushResult = await pushBranch(task.worktreePath, task.branchName, token);
  if (!pushResult.ok) {
    recordGithubSyncError(app, task.id, pushResult.detail ?? "Failed to push the task's branch");
    return { ok: false, reason: "push-failed", detail: pushResult.detail };
  }

  const closesLine = task.issueNumber !== null ? `\n\nCloses #${task.issueNumber}` : "";
  const body = `${task.body ?? ""}${closesLine}\n\n---\nOpened by Mullion Task Master.`;

  try {
    const pr = await createPullRequest(token, repoRef.owner, repoRef.repo, {
      title: task.title,
      head: task.branchName,
      base,
      body,
    });
    clearGithubSyncError(app, task.id);
    return { ok: true, prUrl: pr.htmlUrl };
  } catch (err) {
    // #486 — a 422 here almost always means a prior attempt's push+create
    // already succeeded and this is a retry after a crash between that and
    // the caller recording prUrl. Resolve to the existing PR instead of
    // failing again. Not a GitHubWriteScopeError (that's only 403/404 on a
    // write, see github-write.ts) — a plain GitHubApiError with
    // statusCode 422.
    if (err instanceof GitHubApiError && err.statusCode === 422) {
      const existing = await findPullRequestByHead(
        token,
        repoRef.owner,
        repoRef.repo,
        `${repoRef.owner}:${task.branchName}`,
      ).catch(() => null);
      if (existing) {
        clearGithubSyncError(app, task.id);
        return { ok: true, prUrl: existing.htmlUrl };
      }
    }
    const detail =
      err instanceof GitHubWriteScopeError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    recordGithubSyncError(app, task.id, detail);
    return { ok: false, reason: "pr-create-failed", detail };
  }
}
