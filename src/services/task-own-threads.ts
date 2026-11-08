// Resolves Mullion's own review threads once a clean verdict corroborates them
// (D1). Split out of task-reconciler.ts, which is at its file-size ceiling; the
// doc comment below is the design record.
import type { FastifyInstance } from "fastify";
import type { projects, tasks } from "../db/schema.js";
import { resolveGitHubToken, resolveMullionReviewLogins } from "./github-integration.js";
import { fetchPullRequestReviewThreads, resolveReviewThread } from "./github-write.js";
import { resolveRepoRef } from "./host-git.js";
import { isRetryableGitHubError } from "./task-github-sync.js";

/**
 * D1 — on any repo with `required_conversation_resolution` enabled (this
 * repo's own `main` included), an anchored review finding blocks merge
 * FOREVER once its thread is created: nothing before this called GitHub's
 * thread-resolution mutation at all (`docs/tasks-internals.md`'s own
 * Auto-approve section documented the resulting false-positive "blocked"
 * read, but never closed it). Confirmed live in a dry run (2026-08-27): a real anchored
 * finding, fixed and re-reviewed clean, still left `mergeStateStatus:
 * BLOCKED` with green CI — resolving the stale thread by hand was the only
 * way to unstick it.
 *
 * Deliberately NOT "the worker resolves its own threads" in the literal
 * sense — a worker has no route to a GitHub GraphQL thread node id (the
 * REST review-post response this codebase uses to post findings doesn't
 * return one), and handing it a write-scoped GitHub token just to look one
 * up would be a real capability grant for no real safety gain. Instead,
 * Mullion resolves — but ONLY once its own NEXT independent review round
 * confirms the diff is no longer a "changes-requested" one, i.e. exactly
 * the same corroboration a human reviewer clicking Resolve would be acting
 * on. This function has two call sites, both gated on a "clean" verdict:
 * `processReviewingTasks`, at the moment that verdict is durably ingested,
 * and `attemptMerge`'s D1 self-heal, which re-checks the same
 * `lastReviewVerdict` column on already-`done` rows (see the comment at
 * that call site) — never fires off an "inconclusive"/crashed-reviewer
 * verdict, which is not corroborating evidence of anything.
 *
 * Bounded to `mullionLogins` (`resolveMullionReviewLogins`, same set D0's
 * fix uses) — a human's own review thread is NEVER a candidate here,
 * regardless of verdict. Independent review, round 3: ownership is judged
 * across EVERY comment in the thread, not just the first — a thread that
 * started as Mullion's own finding but later got a human reply pushing
 * back inside it (disagreeing the finding is real, adding context) must
 * stay unresolved too. Auto-resolving on `comments[0]` alone would dismiss
 * that objection right along with the original finding, which is exactly
 * the "don't paper over a human's input" bound this function exists to
 * hold. This is the one bound that actually matters: it's what keeps
 * `required_conversation_resolution` a real gate against a worker (or
 * Mullion itself) papering over a human's finding, while still closing the
 * self-inflicted deadlock this function exists to fix.
 *
 * Best-effort, matching every other GitHub write in this file's own
 * posture: a fetch/mint/resolve failure is logged and skipped, never
 * thrown — the verdict this call follows is already durably recorded by
 * the time this runs, so a failure here costs nothing but a stale thread
 * surviving to the next tick's `attemptMerge`, not a lost transition. Fails
 * closed on `truncated: true` (an incomplete thread enumeration must not
 * be read as "no threads to resolve").
 *
 * Returns the fetched thread result on success (even when nothing ended up
 * resolved) so `attemptMerge`'s own "blocked" diagnostic — the OTHER
 * consumer of this exact same fetch — can reuse it instead of paying for a
 * second GraphQL round trip in the same sweep tick; `null` on any early
 * return (no PR, no token, fetch failure, truncation), signaling "I
 * couldn't get you a usable result, fetch your own."
 */
export async function resolveMullionOwnThreadsIfClean(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<Awaited<ReturnType<typeof fetchPullRequestReviewThreads>> | null> {
  return (await resolveMullionOwnThreadsWithOutcome(app, task, project)).result;
}

type ThreadFetchResult = Awaited<ReturnType<typeof fetchPullRequestReviewThreads>>;

/**
 * `resolveMullionOwnThreadsIfClean`, plus whether a later tick should try
 * again: `retry` is true when a GitHub call failed transiently (a rate limit,
 * a 5xx) — the fetch of the threads, or resolving one of them. The ingest's
 * retry marker (`tasks.reviewPostPending`) keeps the round "not done" on it.
 * Every other early return (no PR, no token, a truncated enumeration, a
 * permanent error) is `retry: false`: another tick would get the same answer,
 * and `attemptMerge`'s own self-heal still covers those.
 */
export async function resolveMullionOwnThreadsWithOutcome(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<{ result: ThreadFetchResult | null; retry: boolean }> {
  if (task.prNumber === null) return { result: null, retry: false };

  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return { result: null, retry: false };
  const token = await resolveGitHubToken(app, repoRef, "write");
  if (!token) return { result: null, retry: false };

  let result: ThreadFetchResult;
  try {
    result = await fetchPullRequestReviewThreads(token, repoRef.owner, repoRef.repo, task.prNumber);
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id },
      "task reconcile: review-thread fetch failed while checking for Mullion's own threads to resolve",
    );
    return { result: null, retry: isRetryableGitHubError(err) };
  }
  if (result.truncated) {
    app.log.warn(
      { taskId: task.id, prNumber: task.prNumber },
      "task reconcile: review threads/comments exceeded the fetch page size — skipping auto-resolve this tick rather than resolving an incomplete set",
    );
    return { result: null, retry: false };
  }

  // Independent review, round 2: cheap pre-filter before the reviewer
  // identity lookup below, same reasoning as attemptReturnPrCommentsToWorker's
  // own ordering (D0) — resolveMullionReviewLogins is a live, uncached
  // GraphQL round trip, and this function is called from a merge-retry
  // backoff loop, not a one-shot verdict ingestion, so paying for it on
  // every tick even when nothing is unresolved would reproduce the exact
  // pattern D0 fixed elsewhere in this file.
  if (!result.threads.some((t) => !t.isResolved)) return { result, retry: false };

  const mullionLogins = await resolveMullionReviewLogins(app, repoRef, result.viewerLogin);
  const ownUnresolved = result.threads.filter(
    (t) =>
      !t.isResolved &&
      t.comments.length > 0 &&
      t.comments.every((c) => mullionLogins.has(c.author ?? "")),
  );
  if (ownUnresolved.length === 0) return { result, retry: false };

  let retry = false;
  for (const thread of ownUnresolved) {
    try {
      await resolveReviewThread(token, thread.id);
    } catch (err) {
      if (isRetryableGitHubError(err)) retry = true;
      app.log.warn(
        { err, taskId: task.id, threadId: thread.id },
        "task reconcile: failed to resolve one of Mullion's own review threads",
      );
    }
  }
  return { result, retry };
}
