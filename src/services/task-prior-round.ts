import type { FastifyInstance } from "fastify";
import type { projects, tasks } from "../db/schema.js";
import { resolveRepoRef } from "./host-git.js";
import { resolveGitHubToken } from "./github-integration.js";
import { getPullRequestByNumber } from "./github-write.js";

/**
 * What the previous review round found, for a FOLLOW-UP review's delta
 * prompt — the last `## Round N` block of `tasks.reviewFindings`, plus the
 * head SHA that review covered. `undefined` for a first review, and after an
 * inconclusive one (there was nothing to follow up on).
 *
 * Also `undefined` when the head has not moved since that review AND no worker
 * round has run since its verdict — which is what a human's "Re-review" is. A
 * follow-up prompt tells the reviewer that a finding which is not fixed keeps
 * its severity, so on unchanged code it would just re-derive the verdict the
 * human asked to have looked at again. The worker-round condition keeps the
 * auto-return loop's own follow-ups (a round that pushed nothing) as deltas, so
 * its stall detection still sees the previous round's dispositions.
 * `headSha` is the head being reviewed now, when the caller knows it.
 */
export function priorRoundFor(
  task: typeof tasks.$inferSelect,
  headSha?: string | null,
): { reviewedSha: string | null; findings: string; approved?: boolean } | undefined {
  if (!task.reviewFindings) return undefined;
  if (
    task.lastReviewVerdict !== "changes-requested" &&
    task.lastReviewVerdict !== "approved-with-suggestions"
  ) {
    return undefined;
  }
  const workerReturnedSinceVerdict =
    task.claimedAt !== null &&
    task.lastReviewVerdictAt !== null &&
    task.claimedAt.getTime() > task.lastReviewVerdictAt.getTime();
  if (!workerReturnedSinceVerdict && headSha && task.lastReviewedHeadSha === headSha) {
    return undefined;
  }
  const blocks = task.reviewFindings.split(/\n\n(?=## Round )/);
  const last = blocks[blocks.length - 1];
  return last
    ? {
        reviewedSha: task.lastReviewedHeadSha,
        findings: last,
        approved: task.lastReviewVerdict === "approved-with-suggestions",
      }
    : undefined;
}

/**
 * The head a review being spawned now will cover: the one the caller's CI read
 * already found, else the task's PR head from GitHub. Best-effort — `null` when
 * there is no PR, no token, or GitHub does not answer, in which case
 * `priorRoundFor` keeps the follow-up behaviour (an unknown head never drops the
 * previous round's dispositions).
 */
export async function resolveReviewHeadSha(
  app: FastifyInstance,
  task: Pick<typeof tasks.$inferSelect, "prNumber">,
  project: typeof projects.$inferSelect,
  known?: string | null,
): Promise<string | null> {
  if (known) return known;
  if (task.prNumber === null) return null;
  try {
    const repoRef = await resolveRepoRef(app, project);
    const token = repoRef ? await resolveGitHubToken(app, repoRef, "read") : null;
    if (!repoRef || !token) return null;
    return (await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber))
      .headSha;
  } catch (err) {
    app.log.warn({ err }, "task review: could not read the PR head — spawning without it");
    return null;
  }
}
