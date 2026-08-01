// Task -> PR promotion (Phase 6 Task Master, 6.7/#220) — the approve-flow
// half: push the task's worktree branch and open a PR against the repo's
// current default branch. Deliberately does the push + PR-create BEFORE
// any local status write (routes/tasks.ts's approve handler only flips
// the task to "done" once this returns ok:true) — a failure here must
// leave the task in "reviewing", safely retryable, never half-promoted
// (a task with a pushed branch but no recorded PR, or vice versa).
import type { FastifyInstance } from "fastify";
import type { tasks, projects } from "../db/schema.js";
import { getGitStatus } from "./git-status.js";
import { getToken } from "./github-integration.js";
import { resolveRepoRef } from "./github-webhook.js";
import { createPullRequest, GitHubWriteScopeError } from "./github-write.js";
import { resolveDefaultBaseRef } from "./git-refs.js";
import { pushBranch } from "./git-push.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

export type PromoteOutcome =
  | { ok: true; prUrl: string }
  | {
      ok: false;
      reason:
        "no-worktree" | "dirty-tree" | "no-token" | "no-repo" | "push-failed" | "pr-create-failed";
      detail?: string;
    };

/**
 * Known, accepted gap: if a previous approve attempt already pushed AND
 * created a PR but failed before this function's caller recorded `prUrl`
 * (e.g. the process crashed between the two), a retry's createPullRequest
 * call gets GitHub's 422 "A pull request already exists for
 * <owner>:<branch>" — surfaced here as a generic pr-create-failed rather
 * than being detected and resolved to the existing PR's URL. Resolving it
 * would need an extra "list PRs by head branch" lookup on every approve,
 * for a narrow crash-window case; left as a clear, actionable error
 * (GitHub's own message names the exact PR) rather than silently retried
 * automatically.
 */
export async function promoteTaskToPR(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
): Promise<PromoteOutcome> {
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

  const token = getToken(app);
  if (!token) {
    return { ok: false, reason: "no-token", detail: "No GitHub token connected" };
  }
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) {
    return { ok: false, reason: "no-repo", detail: "Could not resolve the project's GitHub repo" };
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
    return {
      ok: false,
      reason: "pr-create-failed",
      detail: "Could not determine the repository's default branch",
    };
  }

  const pushResult = await pushBranch(task.worktreePath, task.branchName, token);
  if (!pushResult.ok) {
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
    return { ok: true, prUrl: pr.htmlUrl };
  } catch (err) {
    const detail =
      err instanceof GitHubWriteScopeError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, reason: "pr-create-failed", detail };
  }
}
