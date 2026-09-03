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
import { resolveGitHubToken } from "./github-integration.js";
import type { GitHubRepoRef } from "./git-remote.js";
import {
  createPullRequest,
  findPullRequestByHead,
  getPullRequestByNumber,
  markPullRequestReadyForReview,
  closePullRequest,
  updatePullRequestTitle,
  GitHubWriteScopeError,
} from "./github-write.js";
import { GitHubApiError } from "./github.js";
import {
  resolveHostGitStatus,
  resolveHostBaseRef,
  pushHostBranch,
  resolveRepoRef,
} from "./host-git.js";
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

  // #484 — routed through host-git.ts so this reaches a remote-hosted
  // project's own filesystem the same way worktree create/remove/prune
  // already do, always via the same forceFresh read the local path always
  // used (Hermes review, PR #475): the default 5s-cached read could serve
  // "clean" from before the agent's last commit — pushing on a stale read
  // would silently exclude work the human never got to see excluded,
  // exactly what this gate exists to prevent.
  //
  // Two distinct failure reasons, deliberately not collapsed into one:
  // "unsupported" (an agent build predating #484's proxy routes) is a
  // durable, version-skew refusal — the only remaining meaning of
  // `remote-not-supported` now that promotion itself works for any
  // sufficiently-new remote host. "unreachable" (a network blip, a host
  // that's down) is exactly as retryable as any other transient git-status
  // failure, so it's folded into the same "no-worktree" reason the local
  // `status === null` branch below already uses, not surfaced as a
  // permanent-sounding remote-not-supported.
  const statusResult = await resolveHostGitStatus(app, project.hostId, task.worktreePath);
  if (!statusResult.ok) {
    if (statusResult.reason === "unsupported") {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: "remote-not-supported",
          detail:
            "This host's agent build doesn't support promoting a task to a PR yet — update it and retry",
        },
      };
    }
    return {
      ok: false,
      outcome: {
        ok: false,
        reason: "no-worktree",
        detail: `Could not reach the task's host: ${statusResult.detail}`,
      },
    };
  }
  const { isRepo, status } = statusResult.value;
  if (!isRepo) {
    return {
      ok: false,
      outcome: {
        ok: false,
        reason: "no-worktree",
        detail: `Could not read git status for ${task.worktreePath}`,
      },
    };
  }
  if (!status) {
    return {
      ok: false,
      outcome: {
        ok: false,
        reason: "no-worktree",
        detail: `Could not read git status for ${task.worktreePath} (transient failure — retry)`,
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

/** Resolves the base branch on whichever host owns `project.cwd`
 * (`resolveHostBaseRef` returns e.g. "origin/main", or bare "HEAD" when it
 * couldn't determine one — the PR API wants a bare branch name). Only the
 * create sub-path calls this, and only BEFORE pushing (see
 * preparePromotion's own doc comment on why). A transport failure
 * (unreachable/unsupported host) collapses into the same `null` an
 * undeterminable local base ref already produces — both callers already
 * treat `null` as "nothing to push yet, fail cleanly," the correct posture
 * either way. */
async function resolveBaseBranch(
  app: FastifyInstance,
  project: ProjectRow,
): Promise<string | null> {
  const result = await resolveHostBaseRef(app, project.hostId, project.cwd);
  if (!result.ok) return null;
  const { baseRef: baseRefRaw } = result.value;
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
 * needing its own "has this already run" check. #484 — routed through
 * host-git.ts so this reaches a remote-hosted project's own filesystem;
 * both a git-level push failure and a transport failure (unreachable/
 * unsupported host) surface as the same retryable "push-failed" reason. */
async function pushForPromotion(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
  token: string,
): Promise<PromoteFailure | null> {
  const pushResult = await pushHostBranch(
    app,
    project.hostId,
    task.worktreePath!,
    task.branchName!,
    token,
  );
  if (!pushResult.ok) {
    const detail =
      pushResult.reason === "unsupported"
        ? "This host's agent build doesn't support pushing a task's branch yet — update it and retry"
        : `Could not reach the task's host: ${pushResult.detail}`;
    recordGithubSyncError(app, task.id, detail);
    return { ok: false, reason: "push-failed", detail };
  }
  const { value } = pushResult;
  if (value.ok) return null;
  recordGithubSyncError(app, task.id, value.detail ?? "Failed to push the task's branch");
  return { ok: false, reason: "push-failed", detail: value.detail };
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
      // #761 — the agent-supplied Conventional Commits title, ingested and
      // validated by task-reconciler.ts at the "-> reviewing" transition.
      // Falls back to the raw task title when absent (feature off, or a
      // malformed/unreadable write) — never blocks promotion on this.
      title: task.prTitle ?? task.title,
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
        // Hermes review, PR #574 — this 422 can now resolve to the
        // reconciler's own DRAFT: openDraftPRForTask (best-effort, at
        // "-> reviewing") and this fallback create race for the same head
        // branch, so a caller that wanted `draft: false` (approve) can land
        // here holding a still-draft PR. Returning ok:true as-is would flip
        // the task straight to "done" with the PR never marked ready —
        // hermes.yml's own `draft == false` gate means it's never reviewed.
        if (!draft && existing.draft) {
          try {
            await markPullRequestReadyForReview(token, existing.nodeId);
          } catch (markErr) {
            const detail =
              markErr instanceof GitHubWriteScopeError
                ? markErr.message
                : markErr instanceof Error
                  ? markErr.message
                  : String(markErr);
            recordGithubSyncError(app, task.id, detail);
            return { ok: false, reason: "pr-create-failed", detail };
          }
        }
        // #782 — same compare-then-PATCH as promoteTaskToPR's already-open
        // branch: this 422-adopt path picks up whatever title the PR was
        // opened with (a human's out-of-band PR, or openDraftPRForTask's own
        // earlier create for the same head branch), which can differ from
        // task.prTitle. Without this, approve's own createOrRecoverPR call
        // (the only caller that can reach this branch with prNumber still
        // null going in) would adopt a stale title with nothing left to
        // correct it before attemptMerge reads pr.title for the squash-merge
        // commit message.
        if (task.prTitle !== null && task.prTitle !== existing.title) {
          try {
            await updatePullRequestTitle(
              token,
              repoRef.owner,
              repoRef.repo,
              existing.number,
              task.prTitle,
            );
          } catch (err) {
            app.log.warn(
              { err, taskId: task.id, prNumber: existing.number },
              "task promote: failed to re-sync the PR title — leaving the live GitHub title as-is",
            );
          }
        }
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
 * Opens (or, on re-entry, just pushes new commits to and re-syncs the
 * title of) a draft PR for a task entering "reviewing" — called
 * best-effort from task-reconciler.ts, never blocking the transition that
 * already committed. `task.prNumber !== null` means a draft already exists
 * (this is a second "-> reviewing" after an auto-returned review round):
 * nothing left to create, just push whatever new commits exist (`#782`
 * also re-syncs the title, since a later round can rewrite it).
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
    const pushFailure = await pushForPromotion(app, task, project, token);
    if (pushFailure) return pushFailure;
    // #782 — this branch makes NO other GitHub call today (it returns
    // task.prUrl/prNumber straight from the DB row), so a bare PATCH here
    // is the cheapest way to keep the title re-synced on this path too: a
    // GET-then-compare would double the call count for a branch whose
    // whole point is "nothing left to create, just push." The PATCH is
    // idempotent (same value in, same value out) when the title hasn't
    // changed, so there's no correctness cost to skipping the comparison
    // `promoteTaskToPR`'s branch above does (it has `pr.title` in hand
    // already; this branch would need a whole extra fetch to get one).
    if (task.prTitle !== null) {
      try {
        await updatePullRequestTitle(
          token,
          repoRef.owner,
          repoRef.repo,
          task.prNumber,
          task.prTitle,
        );
      } catch (err) {
        app.log.warn(
          { err, taskId: task.id, prNumber: task.prNumber },
          "task promote: failed to re-sync the PR title — leaving the live GitHub title as-is",
        );
      }
    }
    clearGithubSyncError(app, task.id);
    // #972 — task.prUrl can still be null here on a row that predates
    // retryTask clearing prUrl/prNumber together (a retry that cleared only
    // prUrl left this exact inconsistent pair). Asserting it non-null would
    // hand `null` to a caller (maybeOpenDraftPR) that writes it straight
    // back into tasks.prUrl, re-affirming the bad state forever. Fetch the
    // live URL instead of trusting the DB row when it's missing.
    if (task.prUrl !== null) {
      return { ok: true, prUrl: task.prUrl, prNumber: task.prNumber };
    }
    try {
      const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
      return { ok: true, prUrl: pr.htmlUrl, prNumber: task.prNumber };
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

  // Base resolved BEFORE pushing (Hermes review, PR #475's original
  // ordering, preserved through this file's refactor into
  // preparePromotion/pushForPromotion): an undeterminable default branch
  // fails cleanly with nothing pushed, rather than leaving a
  // pushed-but-PR-less branch on origin a retry has to reconcile.
  const base = await resolveBaseBranch(app, project);
  if (base === null) {
    // Deliberately does NOT recordGithubSyncError here (Hermes review, PR
    // #495, second pass, carried over from the original promoteTaskToPR):
    // resolveHostBaseRef's local path is a purely local git resolution, not
    // a GitHub write/scope problem — and a remote transport failure here
    // will already have been recorded moments earlier by
    // preparePromotion's own status check, or is about to be by the push
    // right below, so this would just be a duplicate.
    return {
      ok: false,
      reason: "pr-create-failed",
      detail: "Could not determine the repository's default branch",
    };
  }

  const pushFailure = await pushForPromotion(app, task, project, token);
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
    const pushFailure = await pushForPromotion(app, task, project, token);
    if (pushFailure) return pushFailure;
    try {
      const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
      // Hermes review, PR #574 — task.prNumber can point at an already
      // ready-for-review PR (e.g. a prior approve attempt's mark-ready
      // succeeded but crashed before this returned, or a 422-recovery
      // elsewhere resolved to a non-draft). GitHub's GraphQL mutation
      // errors when called on a PR that's already ready, which would fail
      // approve on every retry — skip it once already true.
      if (pr.draft) {
        await markPullRequestReadyForReview(token, pr.nodeId);
      }
      // #782 — a later auto-return round can rewrite tasks.prTitle with a
      // changed Conventional Commits type (e.g. round 1 seeds `docs:`,
      // review feedback in round 2 turns it into real functional work
      // warranting `feat:`), but nothing previously re-synced that to the
      // live GitHub PR — the squash-merge commit message (attemptMerge
      // reads pr.title, not task.prTitle) stayed frozen at whichever round
      // first opened the PR. Already have `pr` in hand here, so compare
      // before writing: zero extra API calls in the common (unchanged)
      // case. Never lets a title-sync failure fail the promotion — same
      // "never gate promotion on the title" posture #761 established.
      if (task.prTitle !== null && task.prTitle !== pr.title) {
        try {
          await updatePullRequestTitle(
            token,
            repoRef.owner,
            repoRef.repo,
            task.prNumber,
            task.prTitle,
          );
        } catch (err) {
          app.log.warn(
            { err, taskId: task.id, prNumber: task.prNumber },
            "task promote: failed to re-sync the PR title — leaving the live GitHub title as-is",
          );
        }
      }
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
  const base = await resolveBaseBranch(app, project);
  if (base === null) {
    return {
      ok: false,
      reason: "pr-create-failed",
      detail: "Could not determine the repository's default branch",
    };
  }

  const pushFailure = await pushForPromotion(app, task, project, token);
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

  // #484 — no host guard: closing a PR is a pure GitHub API write, with no
  // filesystem/git dependency on the task's host at all (unlike every other
  // function in this module) — it never actually needed isPromotionSupported
  // for a technical reason, and a draft PR can exist for a remote-hosted
  // task now that promotion itself does.
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
