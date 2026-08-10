// Task -> PR promotion (Phase 6 Task Master, 6.7/#220) — push the task's
// worktree branch and open a PR against the repo's current default branch.
//
// A PR is now opened as a DRAFT as soon as a task reaches "reviewing"
// (openDraftPRForTask, called best-effort from task-reconciler.ts), not
// only at approve — draft, because CI (ci-cd.yml/codeql.yml both trigger
// on plain `pull_request:`, drafts included) and a human/review-agent can
// then see real signal on the diff before a human commits to approving it.
// hermes.yml's own `pull_request.draft == false` gate means Hermes never
// reviews the draft, only once approve flips it ready — the two reviewers
// sequence by construction, no coordination needed here.
//
// Approve (promoteTaskToPR) now has two paths: the common one marks an
// already-open draft ready-for-review; the fallback recreates the old
// direct-create behavior for a task that reached "reviewing" before this
// shipped (or whose draft-open attempt never succeeded — best-effort, see
// task-reconciler.ts). Both paths — and a second "-> reviewing" after an
// auto-returned review round (see task-reconciler.ts's review-feedback
// loop) — push first: the draft, once opened, is not automatically kept in
// sync with new commits, and a stale approve or a stale second review would
// otherwise look at old code.
//
// Deliberately does the push + PR-create/mark-ready BEFORE any local status
// write (routes/tasks.ts's approve handler only flips the task to "done"
// once promoteTaskToPR returns ok:true) — a failure here must leave the
// task in "reviewing", safely retryable, never half-promoted.
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
// openDraftPRForTask follows the identical posture (it shares
// preparePromotion with promoteTaskToPR below) — its own caller
// (task-reconciler.ts) never separately records a sync error itself, since
// this module already does for every reason that deserves one.
import type { FastifyInstance } from "fastify";
import type { tasks, projects } from "../db/schema.js";
import { getGitStatus } from "./git-status.js";
import { resolveGitHubToken } from "./github-integration.js";
import { resolveRepoRef } from "./github-webhook.js";
import type { GitHubRepoRef } from "./git-remote.js";
import {
  createPullRequest,
  findPullRequestByHead,
  getPullRequestByNumber,
  markPullRequestReadyForReview,
  closePullRequest,
  GitHubWriteScopeError,
} from "./github-write.js";
import { GitHubApiError } from "./github.js";
import { resolveDefaultBaseRef } from "./git-refs.js";
import { pushBranch } from "./git-push.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { recordGithubSyncError, clearGithubSyncError } from "./task-github-sync.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

export type PromoteOutcome =
  | { ok: true; prUrl: string; prNumber: number }
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

type PromoteFailure = PromoteOutcome & { ok: false };

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
 * Shared preamble for every path that advances a PR-bearing task: the
 * worktree/dirty-tree gate and GitHub repo/token resolution. Deliberately
 * does NOT push — callers on the "no PR yet" branch need to resolve the
 * base ref FIRST and fail cleanly with nothing pushed if that's
 * undeterminable (Hermes review, PR #475's original ordering, preserved
 * here); the mark-ready branch (a draft already exists) has no base-ref
 * dependency at all and would otherwise pay for a needless local git call.
 * Each caller pushes itself, after whatever pre-push check it needs — see
 * pushForPromotion below, which every caller uses for that push so the
 * idempotency/error-recording behavior stays in one place.
 *
 * Returns the resolved repo ref + token on success so callers don't
 * re-resolve them for their own push/create/mark-ready calls.
 */
async function preparePromotion(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
): Promise<
  { ok: true; repoRef: GitHubRepoRef; token: string } | { ok: false; outcome: PromoteFailure }
> {
  if (!isPromotionSupported(project)) {
    return {
      ok: false,
      outcome: {
        ok: false,
        reason: "remote-not-supported",
        detail:
          "Promoting a remote-hosted task to a PR isn't supported yet — approve/reject still work locally against the task's worktree on its own host, but PR creation needs local git status/push, which don't yet proxy to remote hosts",
      },
    };
  }
  if (!task.worktreePath || !task.branchName) {
    return {
      ok: false,
      outcome: {
        ok: false,
        reason: "no-worktree",
        detail: "Task has no recorded worktree/branch to promote",
      },
    };
  }

  // forceFresh (Hermes review, PR #475): the default 5s-cached read could
  // serve "clean" from before the agent's last commit — pushing on a stale
  // read would silently exclude work the human never got to see excluded,
  // exactly what this gate exists to prevent.
  const status = await getGitStatus(task.worktreePath, { forceFresh: true });
  if (!status) {
    return {
      ok: false,
      outcome: {
        ok: false,
        reason: "no-worktree",
        detail: `Could not read git status for ${task.worktreePath}`,
      },
    };
  }
  // The human should see uncommitted work, not have it silently excluded
  // from the PR — refuse rather than pushing a partial branch. A caller on
  // the automatic "-> reviewing" path (openDraftPRForTask, best-effort)
  // treats this as "skip the PR for now," not a blocked transition; approve
  // surfaces it as a 409, same as always.
  if (!status.isClean || status.hasConflicts) {
    return {
      ok: false,
      outcome: {
        ok: false,
        reason: "dirty-tree",
        detail: status.hasConflicts
          ? "Worktree has unresolved merge conflicts"
          : "Worktree has uncommitted changes — commit or discard them before approving",
      },
    };
  }

  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) {
    recordGithubSyncError(app, task.id, "Could not resolve the project's GitHub repo");
    return {
      ok: false,
      outcome: {
        ok: false,
        reason: "no-repo",
        detail: "Could not resolve the project's GitHub repo",
      },
    };
  }
  // #489 — repo-scoped (App installation token when configured, falling
  // back to the shared PAT/OAuth token) rather than the plain getToken this
  // used before.
  const token = await resolveGitHubToken(app, repoRef);
  if (!token) {
    recordGithubSyncError(app, task.id, "No GitHub token connected");
    return {
      ok: false,
      outcome: { ok: false, reason: "no-token", detail: "No GitHub token connected" },
    };
  }

  return { ok: true, repoRef, token };
}

/** `resolveDefaultBaseRef` returns e.g. "origin/main" (or bare "HEAD" when
 * it couldn't determine one) — the PR API wants a bare branch name. Only
 * the create sub-path calls this, and only BEFORE pushing (see
 * preparePromotion's own doc comment on why). */
async function resolveBaseBranch(project: ProjectRow): Promise<string | null> {
  const baseRefRaw = await resolveDefaultBaseRef(project.cwd);
  const base = baseRefRaw.startsWith("origin/") ? baseRefRaw.slice("origin/".length) : baseRefRaw;
  return base === "HEAD" ? null : base;
}

/** The push every caller below shares, once preparePromotion (and, on the
 * create sub-path, resolveBaseBranch) has already succeeded. `pushBranch`
 * is idempotent (a plain `git push -u origin <branch>`, no `--force` — see
 * git-push.ts's own doc comment: "Everything up-to-date" exits 0 same as a
 * real push), so calling this on a re-entry (a second "-> reviewing" after
 * an auto-returned review round, or approve running after a draft is
 * already open) correctly delivers whatever new commits exist without
 * needing its own "has this already run" check. */
async function pushForPromotion(
  app: FastifyInstance,
  task: TaskRow,
  token: string,
): Promise<PromoteFailure | null> {
  const pushResult = await pushBranch(task.worktreePath!, task.branchName!, token);
  if (pushResult.ok) return null;
  recordGithubSyncError(app, task.id, pushResult.detail ?? "Failed to push the task's branch");
  return { ok: false, reason: "push-failed", detail: pushResult.detail };
}

/**
 * #486 — if a previous create attempt already pushed AND created a PR but
 * failed before the caller recorded `prNumber`/`prUrl` (e.g. the process
 * crashed in between), a retry's `createPullRequest` call gets GitHub's 422
 * "A pull request already exists for <owner>:<branch>". Rather than surface
 * that as a generic pr-create-failed, this resolves the existing PR via
 * `findPullRequestByHead` instead.
 */
async function createOrRecoverPR(
  app: FastifyInstance,
  task: TaskRow,
  repoRef: GitHubRepoRef,
  token: string,
  base: string,
  draft: boolean,
): Promise<PromoteOutcome> {
  const closesLine = task.issueNumber !== null ? `\n\nCloses #${task.issueNumber}` : "";
  const body = `${task.body ?? ""}${closesLine}\n\n---\nOpened by Mullion Task Master.`;

  try {
    const pr = await createPullRequest(token, repoRef.owner, repoRef.repo, {
      title: task.title,
      head: task.branchName!,
      base,
      body,
      draft,
    });
    clearGithubSyncError(app, task.id);
    return { ok: true, prUrl: pr.htmlUrl, prNumber: pr.number };
  } catch (err) {
    if (err instanceof GitHubApiError && err.statusCode === 422) {
      const existing = await findPullRequestByHead(
        token,
        repoRef.owner,
        repoRef.repo,
        `${repoRef.owner}:${task.branchName}`,
      ).catch(() => null);
      if (existing) {
        clearGithubSyncError(app, task.id);
        return { ok: true, prUrl: existing.htmlUrl, prNumber: existing.number };
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

/**
 * Opens (or, on re-entry, just pushes new commits to) a draft PR for a task
 * entering "reviewing" — called best-effort from task-reconciler.ts, never
 * blocking the transition that already committed. `task.prNumber !== null`
 * means a draft already exists (this is a second "-> reviewing" after an
 * auto-returned review round): nothing left to create, just push whatever
 * new commits exist.
 */
export async function openDraftPRForTask(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
): Promise<PromoteOutcome> {
  const prepared = await preparePromotion(app, task, project);
  if (!prepared.ok) return prepared.outcome;
  const { repoRef, token } = prepared;

  if (task.prNumber !== null) {
    const pushFailure = await pushForPromotion(app, task, token);
    if (pushFailure) return pushFailure;
    clearGithubSyncError(app, task.id);
    return { ok: true, prUrl: task.prUrl!, prNumber: task.prNumber };
  }

  // Base resolved BEFORE pushing (Hermes review, PR #475's original
  // ordering, preserved through this file's refactor into
  // preparePromotion/pushForPromotion): an undeterminable default branch
  // fails cleanly with nothing pushed, rather than leaving a
  // pushed-but-PR-less branch on origin a retry has to reconcile.
  const base = await resolveBaseBranch(project);
  if (base === null) {
    // Deliberately does NOT recordGithubSyncError here (Hermes review, PR
    // #495, second pass, carried over from the original promoteTaskToPR):
    // resolveDefaultBaseRef is a purely local git resolution, not a GitHub
    // write/scope problem.
    return {
      ok: false,
      reason: "pr-create-failed",
      detail: "Could not determine the repository's default branch",
    };
  }

  const pushFailure = await pushForPromotion(app, task, token);
  if (pushFailure) return pushFailure;

  return createOrRecoverPR(app, task, repoRef, token, base, /* draft */ true);
}

/**
 * Approve's promotion call. If a draft PR is already open
 * (`task.prNumber !== null` — the common path once openDraftPRForTask above
 * runs at every "-> reviewing"), pushes any new commits and marks it ready
 * for review. Otherwise falls back to the original direct-create behavior
 * (non-draft — there's nothing left to wait on at approve time) for a task
 * that reached "reviewing" before this shipped, or whose draft-open attempt
 * never succeeded.
 */
export async function promoteTaskToPR(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
): Promise<PromoteOutcome> {
  const prepared = await preparePromotion(app, task, project);
  if (!prepared.ok) return prepared.outcome;
  const { repoRef, token } = prepared;

  if (task.prNumber !== null) {
    const pushFailure = await pushForPromotion(app, task, token);
    if (pushFailure) return pushFailure;
    try {
      const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
      await markPullRequestReadyForReview(token, pr.nodeId);
      clearGithubSyncError(app, task.id);
      return { ok: true, prUrl: pr.htmlUrl, prNumber: pr.number };
    } catch (err) {
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

  // Same before-the-push ordering as openDraftPRForTask above.
  const base = await resolveBaseBranch(project);
  if (base === null) {
    return {
      ok: false,
      reason: "pr-create-failed",
      detail: "Could not determine the repository's default branch",
    };
  }

  const pushFailure = await pushForPromotion(app, task, token);
  if (pushFailure) return pushFailure;

  return createOrRecoverPR(app, task, repoRef, token, base, /* draft */ false);
}

/**
 * Closes a task's still-open draft PR — called from give-up (the only route
 * that resolves "reviewing" -> "failed"; a budget/session-death failure
 * never reaches "reviewing" in the first place, so it never has a PR to
 * close). Best-effort and fire-and-forget from the caller's point of view,
 * same posture as cleanupTaskWorktree (routes/tasks.ts) it's meant to run
 * alongside: a failure here is a real, no-retry-queue GitHub write gap
 * (docs/tasks.md's GitHub sync section already accepts this for every
 * other write in this module), so it's recorded via recordGithubSyncError
 * rather than silently swallowed — a task already in its terminal "failed"
 * state won't get another chance to sync, but a human looking at the row
 * later should still be able to tell the PR was left open.
 */
export async function closeDraftPRForTask(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
): Promise<void> {
  if (task.prNumber === null) return;
  if (!isPromotionSupported(project)) return;

  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return;
  const token = await resolveGitHubToken(app, repoRef);
  if (!token) return;

  try {
    await closePullRequest(token, repoRef.owner, repoRef.repo, task.prNumber);
    clearGithubSyncError(app, task.id);
  } catch (err) {
    const detail =
      err instanceof GitHubWriteScopeError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    recordGithubSyncError(app, task.id, `Failed to close the draft PR: ${detail}`);
  }
}
