// The Hermes review's hold while a task's branch holds commits its pull request
// does not (#3382). A Hermes run reviews a clone of the PR's head, so reviewing
// before those commits are pushed reads the previous round as "no progress".
import type { FastifyInstance } from "fastify";
import type { tasks } from "../db/schema.js";
import { recordGithubSyncError } from "./task-github-sync.js";
import { worktreeAheadOfPr } from "./task-worktree-ahead.js";

type TaskRow = typeof tasks.$inferSelect;

// Pushes tried for one branch tip before a hold on it is given up. A push that
// can never succeed (a dirty tree left by the worker's last turn, a host that
// cannot push) must not park a task in `reviewing`: after this many the review
// goes ahead on the PR head, as it did before the hold existed. The workflow
// approval gate is exempt, since a human is the only thing that can clear it.
export const UNPUSHED_HEAD_MAX_PUSHES = 3;
const MAX_ENTRIES = 500;
// Per task, process-local like the other retry ledgers: a restart just restarts the count.
const state = new Map<number, { tip: string; pushes: number; gated: boolean }>();

/** FIFO-bounded insert: past `max`, the oldest key makes room for a new one. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (!map.has(key) && map.size >= max) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

export interface UnpushedHoldDeps {
  /** The draft-PR retry ledger: a push is only retried when it allows. */
  backoff: {
    shouldAttempt(taskId: number, now: number): boolean;
    record(taskId: number, now: number): void;
  };
  /** Retries the push; resolves to the refusal reason, or null when it went through. */
  push: () => Promise<string | null>;
}

/**
 * True while the task's branch is strictly ahead of its pull request, so a
 * remote review would read the old head. Each call that finds this also
 * retries the push on the draft-PR backoff, so an approval or a fixed
 * credential is picked up without waiting for the task to leave `reviewing`. A
 * branch that is behind or diverged from the PR, or whose tip cannot be read,
 * never holds: the push is a force-with-lease and must not run in those cases.
 */
export async function holdForUnpushedHead(
  app: FastifyInstance,
  task: TaskRow,
  prHeadSha: string,
  now: number,
  deps: UnpushedHoldDeps,
): Promise<boolean> {
  const { ahead, tip } = await worktreeAheadOfPr(app, task, prHeadSha);
  if (!ahead || tip === null) {
    state.delete(task.id);
    return false;
  }
  let held = state.get(task.id);
  if (held?.tip !== tip) {
    held = { tip, pushes: 0, gated: false };
    setBounded(state, task.id, held, MAX_ENTRIES);
    app.log.info(
      { taskId: task.id, tip, prHeadSha },
      "task reconcile: holding the review — the worktree is ahead of the pull request",
    );
  }
  if (!held.gated && held.pushes >= UNPUSHED_HEAD_MAX_PUSHES) {
    app.log.warn(
      { taskId: task.id, tip, prHeadSha, pushes: held.pushes },
      "task reconcile: the worktree's commits could not be pushed — reviewing the pull request's head as it is",
    );
    // A dirty-tree refusal records no sync error of its own, so say it here: the
    // card would otherwise read "reviewing" with nothing showing the PR is stale.
    recordGithubSyncError(
      app,
      task.id,
      `The branch's latest commits could not be pushed after ${held.pushes} attempts, so the review ran on the pull request's earlier head. Clean the worktree or fix the push, then re-review.`,
    );
    return false;
  }
  if (deps.backoff.shouldAttempt(task.id, now)) {
    deps.backoff.record(task.id, now);
    const failure = await deps.push();
    held.gated = failure === "workflow-approval-required";
    if (!held.gated) held.pushes++;
  }
  return true;
}
