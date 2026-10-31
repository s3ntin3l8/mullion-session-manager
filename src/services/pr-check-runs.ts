// A PR's check runs — and whether we could read them.
//
// #2416. `fetchCheckRunsForHead` degrades to `[]` when the lookup fails,
// which is indistinguishable from "this PR has no checks". The unstable-PR
// path read that empty list as "nothing to self-heal", so a red TITLE-LINT
// check was silently never healed (#1035's self-heal never ran) and the
// operator was told only that "a non-required check is failing or still
// running" — with nothing in the log saying the check list could not even be
// read.
//
// This is the same shape as the Workflow Runs path's `runsAnswered` flag
// (the `warnUnstableRunsUnreadable` helper in task-reconciler.ts): the
// lookup says whether GitHub answered, and the CALLER decides what an
// unanswered lookup means. Here the caller holds the PR either way, so the
// only thing an unanswered lookup changes is what the operator is told.
//
// The warning is throttled the same way — once per task per hour — because
// this runs on every sweep tick (60s) and an unstable PR that cannot be read
// stays unreadable for as long as it is stuck.

import type { FastifyInstance } from "fastify";
import type { tasks } from "../db/schema.js";
import { fetchCheckRunsForHead, type CheckRunResult } from "./github.js";
import type { GitHubRepoRef } from "./git-remote.js";

/**
 * The check runs of a PR, and whether GitHub answered the lookup.
 *
 * - `ok: true` — GitHub answered; `runs` is the real list (possibly empty:
 *   a PR with no checks at all).
 * - `ok: false` — GitHub did NOT answer; `runs` is empty and `detail` says
 *   why. "No checks" and "couldn't ask" are different answers.
 */
export type PrCheckRuns = { ok: true; runs: CheckRunResult[] } | { ok: false; detail: string };

/** Once per task per hour — see the header. */
const UNREADABLE_WARN_INTERVAL_MS = 60 * 60_000;
/** The throttle map is in-memory only; this bounds it. */
const MAX_UNREADABLE_WARN_ENTRIES = 500;
const unreadableWarnedAt = new Map<number, number>();

/**
 * Reads a PR's check runs, saying whether GitHub answered.
 *
 * Never throws: a failed lookup comes back as `{ ok: false }` with the reason,
 * so the caller cannot mistake "couldn't ask" for "there is nothing there".
 *
 * @param app the Fastify instance (for the throttled warning)
 * @param task the task whose PR is being read
 * @param token a GitHub token with read scope
 * @param repoRef the PR's repository
 * @param headSha the PR's head commit
 */
export async function readPrCheckRuns(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  token: string,
  repoRef: GitHubRepoRef,
  headSha: string,
): Promise<PrCheckRuns> {
  try {
    const runs = await fetchCheckRunsForHead(token, repoRef.owner, repoRef.repo, headSha);
    return { ok: true, runs };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warnUnreadable(app, task, repoRef, detail);
    return { ok: false, detail };
  }
}

/**
 * Warn that the check list could not be read — at most once per task per
 * hour, because the unstable branch asks again on every sweep tick.
 */
function warnUnreadable(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  repoRef: GitHubRepoRef,
  detail: string,
): void {
  const now = Date.now();
  const last = unreadableWarnedAt.get(task.id);
  if (last !== undefined && now - last < UNREADABLE_WARN_INTERVAL_MS) return;
  if (last === undefined && unreadableWarnedAt.size >= MAX_UNREADABLE_WARN_ENTRIES) {
    const oldest = unreadableWarnedAt.keys().next().value;
    if (oldest !== undefined) unreadableWarnedAt.delete(oldest);
  }
  unreadableWarnedAt.set(task.id, now);
  app.log.warn(
    {
      taskId: task.id,
      projectId: task.projectId,
      owner: repoRef.owner,
      repo: repoRef.repo,
      detail,
    },
    "task reconcile: could not read the PR's check runs — the title-lint self-heal did not run, and the PR stays unstable until the lookup answers",
  );
}

/** Test-only reset — the throttle map is module-level and would otherwise
 * leak state between test cases. */
export function resetPrCheckRunsWarningsForTests(): void {
  unreadableWarnedAt.clear();
}
