// #744 — the release-PR merge decision, extracted out of
// `POST /api/projects/:id/release/merge` (routes/projects.ts) so
// task-reconciler.ts's `processReleaseRequests` sweep (the autorelease-after-
// tasks half of #744) can reuse the exact same GitHub-semantics knowledge
// instead of re-deriving it — the same "shared classifier, `classifyMergeReadiness`
// itself, is already relied on by both a route and a sweep" precedent that
// module's own doc comment names.
//
// Deliberately returns a STATE (`ReleaseMergeResult`), not an action, mirroring
// `merge-readiness.ts`'s own stated posture: the route and the sweep want
// DIFFERENT remedies for the same state. The route refuses "behind" and points
// the human at the Run button; the sweep just records it and backs off
// (task-reconciler.ts's own doc comment on why a release PR never gets an
// auto-rebase or a branch-update attempt applies to both callers equally, so
// that reasoning lives here once rather than twice).
import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tasks } from "../db/schema.js";
import type { GitHubRepoRef } from "./git-remote.js";
import { resolveGitHubToken } from "./github-integration.js";
import {
  findReleasePullRequest,
  getPullRequestByNumber,
  invalidateReleaseCache,
  mergePullRequest,
} from "./github-write.js";
import { classifyMergeReadiness } from "./merge-readiness.js";
import { getDefaultBranch, GitHubApiError } from "./github.js";
import type { ReleaseMergeResult } from "../shared/types.js";

/**
 * Clears the durable `tasks.releaseRequestedAt`/`releaseError` intent for
 * EVERY task on `projectId` that still has one set — called on every
 * `merged: true` outcome below, from whichever caller triggered it (the
 * manual Merge button, routes/projects.ts, or the autorelease sweep,
 * task-reconciler.ts). Broader than "just the tasks THIS caller knew about"
 * on purpose: `mergePullRequest`'s own `sha` guard means a merge only ever
 * succeeds against the exact PR content just read as `mergeableState:
 * "clean"` — which itself means the release branch already contains every
 * commit currently on the default branch (a branch missing a recent push
 * reads "behind", not "clean", and refuses instead — see the "clean" case
 * below). So any task whose OWN PR already merged before this point is
 * necessarily already included in the release that just merged, regardless
 * of which caller's own bookkeeping knew about it. A task that arms
 * `releaseRequestedAt` in the brief async gap between the PR read here and
 * this clear could theoretically get swept up too — a rare, benign
 * mislabel (that task's commit ships in this release either way; only the
 * "which version" bookkeeping is a release early), not a correctness bug.
 */
function clearReleaseIntentForProject(app: FastifyInstance, projectId: number): void {
  app.db
    .update(tasks)
    .set({ releaseRequestedAt: null, releaseError: null })
    .where(and(eq(tasks.projectId, projectId), isNotNull(tasks.releaseRequestedAt)))
    .run();
}

/**
 * Resolves and, if ready, merges the open release-please PR for `repoRef` —
 * gated hard on GitHub's own mergeability verdict via `classifyMergeReadiness`,
 * never a force/override path. Takes no PR number: the PR to merge is always
 * re-resolved via `findReleasePullRequest`, which itself only ever returns a
 * PR whose head branch carries release-please's own `RELEASE_PLEASE_BRANCH_PREFIX`
 * — so this can never be pointed at an arbitrary PR by construction.
 *
 * `token` should be a "read"-scoped token (every call here except the merge
 * itself is a read); a "write"-scoped token is minted internally right before
 * the one call that needs it, same split the route this was extracted from
 * used, and for the same reason — WRITE_PERMISSIONS (github-app.ts) doesn't
 * grant `metadata`, which `getDefaultBranch` needs.
 *
 * `projectId` exists ONLY to clear any outstanding autorelease intent
 * (`clearReleaseIntentForProject` above) on a `merged: true` outcome — this
 * is the ONE place that outcome is decided, so it's also the one place that
 * clears it, regardless of which caller (the manual Merge button or the
 * autorelease sweep) triggered it. Before this, the manual button never
 * cleared `tasks.releaseRequestedAt`/`releaseError` at all — a human
 * manually merging the release PR while a task's autorelease was still
 * pending or backed-off left that task showing a permanently stale "no open
 * release PR" error even though its release had, in fact, shipped.
 *
 * Throws only a non-`GitHubApiError` (a genuine bug); any `GitHubApiError` —
 * including a merge call's ordinary 405 "not mergeable" / 409 head-sha-moved
 * races — is caught and folded into `{merged: false, reason: "merge-failed"}`.
 */
export async function resolveReleaseMerge(
  app: FastifyInstance,
  repoRef: GitHubRepoRef,
  token: string,
  projectId: number,
): Promise<ReleaseMergeResult> {
  try {
    const defaultBranch = await getDefaultBranch(token, repoRef.owner, repoRef.repo);
    const summary = await findReleasePullRequest(token, repoRef.owner, repoRef.repo, defaultBranch);
    if (!summary) return { merged: false, reason: "no-release-pr" };

    const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, summary.number);
    const readiness = classifyMergeReadiness(pr);

    switch (readiness) {
      case "already-done": {
        // Unreachable via findReleasePullRequest's own state=open filter
        // today — kept because classifyMergeReadiness is a shared classifier
        // (task-reconciler.ts's attemptMerge reaches this case for real);
        // removing it here would silently break if a future caller resolved
        // release PRs some other way.
        invalidateReleaseCache(repoRef.owner, repoRef.repo);
        clearReleaseIntentForProject(app, projectId);
        return { merged: true };
      }
      case "clean": {
        if (pr.draft) {
          // mergeableState can read "clean" on a draft PR — GitHub only
          // refuses the merge call itself. Checked explicitly so callers get
          // a named reason instead of an opaque "merge-failed" from catching
          // that 405.
          return { merged: false, reason: "draft" };
        }
        const writeToken = await resolveGitHubToken(app, repoRef, "write");
        if (!writeToken) {
          return {
            merged: false,
            reason: "merge-failed",
            detail: "No write-scoped GitHub token available",
          };
        }
        await mergePullRequest(writeToken, repoRef.owner, repoRef.repo, summary.number, {
          sha: pr.headSha,
          commitTitle: pr.title,
        });
        // The PR this cache entry was holding just closed — drop it so the
        // next GET .../release reflects that immediately rather than showing
        // a stale "clean, ready to merge" PR for up to RELEASE_PR_CACHE_TTL_MS.
        invalidateReleaseCache(repoRef.owner, repoRef.repo);
        clearReleaseIntentForProject(app, projectId);
        return { merged: true };
      }
      case "behind":
      case "blocked":
      case "unstable":
      case "dirty":
      case "computing": {
        // "behind" deliberately does NOT call updatePullRequestBranch here,
        // unlike the task-PR merge-on-approve sweep (task-reconciler.ts's
        // attemptMerge): release-please owns and force-pushes this branch on
        // every run, so a merge-base update either gets clobbered mid-flight
        // or races the next run — and worse, the branch's version bump/
        // CHANGELOG were computed from the commits present when release-please
        // last generated it, so a squash-merge after updating the branch
        // would tag a release whose CHANGELOG omits commits already on the
        // base branch. The correct remedy is re-running release-please
        // (which regenerates the branch off the current default branch with
        // the right bump) — callers refuse/back off and point at that
        // instead. Same reasoning rules out an auto-rebase attempt on
        // "dirty": attemptAutoRebase is task-PR-specific and spawns a worker
        // into the task's own worktree, which a release PR doesn't have.
        return { merged: false, reason: readiness };
      }
    }
  } catch (err) {
    // Covers a merge call itself failing — including a 405 ("not mergeable")
    // or 409 (head-SHA moved) racing this same read, both ordinary expected
    // outcomes here, not alarms (mergePullRequest's own doc comment). Logged
    // here rather than at each call site so the route and the sweep don't
    // have to duplicate it.
    if (!(err instanceof GitHubApiError)) throw err;
    app.log.warn({ err, owner: repoRef.owner, repo: repoRef.repo }, "release PR merge failed");
    return { merged: false, reason: "merge-failed", detail: err.message };
  }
}
