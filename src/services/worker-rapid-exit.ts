// "This worker's agent died at once": a Task Master worker session that ended
// within RAPID_EXIT_MS of being spawned without moving the PR head. An agent
// CLI that exits in seconds (agy on an exhausted quota, #1363) is recorded as
// a normal completion, so the auto-rebase and suggestions-round paths would
// spend an attempt / complete a round on work that never started. This module
// is the one predicate both consumers share; what each does with the answer
// stays with the consumer.
import type { FastifyInstance } from "fastify";
import type { projects, tasks } from "../db/schema.js";
import { resolveRepoRef } from "./host-git.js";
import { resolveGitHubToken } from "./github-integration.js";
import { getPullRequestByNumber } from "./github-write.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

export const RAPID_EXIT_MS = 60_000;
/** How long a rapid-exit worker waits before it is spawned / re-seeded again. */
export const RAPID_EXIT_BACKOFF_MS = 10 * 60_000;
/** Rebase attempts that may be refunded as rapid exits before the normal give-up applies. */
export const MAX_RAPID_REBASE_ABORTS = 3;
/** Rapid exits a suggestions round tolerates: one re-seed, then a human. */
export const MAX_RAPID_SUGGESTION_EXITS = 2;
/** Rebase attempts that may be refunded because main outran a clean rebase, per task. */
export const MAX_REBASE_OUTRUNS = 5;

// Same tolerance the reconciler allows between this process's clock and a
// remote host's, which stamps `workFinishedAt`.
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

/**
 * The PR head SHA, read the way the review-stall detector reads it
 * (`getPullRequestByNumber`). Null when it cannot be read — callers treat
 * that as "unknown", never as "unchanged".
 */
export async function readPrHeadSha(
  app: FastifyInstance,
  task: Pick<TaskRow, "id" | "prNumber">,
  project: ProjectRow,
): Promise<string | null> {
  if (task.prNumber === null) return null;
  try {
    const repoRef = await resolveRepoRef(app, project);
    const token = repoRef ? await resolveGitHubToken(app, repoRef, "read") : null;
    if (!repoRef || !token) return null;
    const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
    return pr.headSha;
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id },
      "task reconcile: could not read the PR head to check for a rapid worker exit — not treating it as one",
    );
    return null;
  }
}

/**
 * The PR head and whether GitHub currently reports it conflict-free. Null when
 * the PR cannot be read; `mergeable` is true only for a settled `mergeable ===
 * true` that is not `dirty`, false for a settled conflict, and null while GitHub
 * is still computing.
 */
export async function readPrHeadAndMergeability(
  app: FastifyInstance,
  task: Pick<TaskRow, "id" | "prNumber">,
  project: ProjectRow,
): Promise<{ headSha: string; mergeable: boolean | null } | null> {
  if (task.prNumber === null) return null;
  try {
    const repoRef = await resolveRepoRef(app, project);
    const token = repoRef ? await resolveGitHubToken(app, repoRef, "read") : null;
    if (!repoRef || !token) return null;
    const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
    // Tri-state: null = GitHub is still computing (`mergeable === null` /
    // `unknown`), which is "ask again", never a verdict.
    const computing = pr.mergeable === null || pr.mergeableState === "unknown";
    return {
      headSha: pr.headSha,
      mergeable: computing ? null : pr.mergeable === true && pr.mergeableState !== "dirty",
    };
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id },
      "task reconcile: could not read the PR's mergeability to check for an outrun rebase — not refunding",
    );
    return null;
  }
}

/**
 * Did the worker end within RAPID_EXIT_MS of `spawnedAt` with the PR head
 * still at `headAtSpawn`? Fails open: any missing input, or a head that
 * cannot be read, answers false (an ordinary completion). Logs one `warn` per
 * rapid exit.
 */
export async function workerExitedRapidly(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
  w: {
    sessionId: number;
    spawnedAt: Date | null;
    workFinishedAt: number | null;
    headAtSpawn: string | null;
  },
): Promise<boolean> {
  if (w.spawnedAt === null || w.workFinishedAt === null || w.headAtSpawn === null) return false;
  const elapsedMs = w.workFinishedAt - w.spawnedAt.getTime();
  if (elapsedMs < -CLOCK_SKEW_TOLERANCE_MS || elapsedMs >= RAPID_EXIT_MS) return false;
  const headNow = await readPrHeadSha(app, task, project);
  if (headNow === null || headNow !== w.headAtSpawn) return false;
  app.log.warn(
    {
      taskId: task.id,
      sessionId: w.sessionId,
      agent: task.agentCommand,
      elapsedSeconds: Math.max(0, Math.round(elapsedMs / 1000)),
    },
    "task reconcile: worker exited within seconds of spawn without moving the PR head — not counting it as a completed attempt",
  );
  return true;
}
