// "Has the worker moved HEAD past baseSha?" — told apart from "we could not
// find out".
//
// #2416 (audit finding F20). The version this replaces lived inline in
// task-reconciler.ts and answered a BOOLEAN, so it had to answer "false" for
// two different things: "there are no commits" and "the worktree could not be
// read". The two callers then used that one boolean with opposite polarity —
// a budget failure in one, a grace window in the other — so a lookup that
// never happened was indistinguishable from a resolved answer, and a failed
// lookup was silently reported as "no commits".
//
// The third state was the missing piece: "unknown" says the question could
// not be answered, without pretending it was. It is produced ONLY by a lookup
// that genuinely failed — a remote host that could not be reached, or a
// lookup that threw — and it is logged, because a state nobody sees is the
// state that keeps lying.
//
// This module decides what it KNOWS; the callers decide what it MEANS. It
// never fails a task and never keeps one alive: that is the caller's policy,
// and the two callers here want opposite policies. Keeping the policy out of
// here is what stops the next reader from wiring one gate into the other.
//
// The fail-safe posture is unchanged from the version this replaces — "failing
// the task is worse than keeping it alive" — and so is every outcome it
// produces. What changes is that the unreachable case is now said out loud
// instead of being folded into "no commits".

import type { FastifyInstance } from "fastify";
import type { tasks } from "../db/schema.js";
import { resolveHostGitStatus } from "./host-git.js";

/**
 * The three states of "has the worker moved HEAD past baseSha".
 *
 * - `ahead` — the worktree's HEAD is past `baseSha`: the worker committed.
 * - `none` — resolved, and it did not: the worktree has no commits past the
 *   base (or has no repo, or no commit at all).
 * - `unknown` — NOT resolved: the worktree could not be read. `detail` says
 *   why. This is the state the old boolean could not express.
 */
export type CommitsPastBase =
  { state: "ahead" } | { state: "none" } | { state: "unknown"; detail: string };

/** Once per task per hour — see `unknownVerdict`. */
const UNKNOWN_WARN_INTERVAL_MS = 60 * 60_000;
/** The throttle map is in-memory only; this bounds it. */
const MAX_UNKNOWN_WARN_ENTRIES = 500;
const unknownWarnedAt = new Map<number, number>();

/**
 * Whether the task's worktree has commits past the task's base SHA.
 *
 * `hostId` is the host that HOLDS the worktree, which after placement is the
 * worker's own host and not necessarily the project's (issue #1724).
 * Resolving the worktree against the project's host would ask the wrong
 * machine about a directory it does not have — always "no commits", so the
 * salvage never fires and a placed worker with commits stays in grace.
 *
 * @param app the Fastify instance (for the warning log)
 * @param task the task whose worktree is being asked about
 * @param hostId the host that holds the worktree
 * @returns the three-state verdict; `unknown` is logged, never silent
 */
export async function resolveCommitsPastBase(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  hostId: string,
): Promise<CommitsPastBase> {
  // Nothing to compare against — the task never got a base SHA or a
  // worktree. That is a resolved answer, not an unreadable one.
  if (!task.baseSha || !task.worktreePath) return { state: "none" };

  let statusResult: Awaited<ReturnType<typeof resolveHostGitStatus>>;
  try {
    statusResult = await resolveHostGitStatus(app, hostId, task.worktreePath);
  } catch (err) {
    return unknownVerdict(app, task, hostId, err instanceof Error ? err.message : String(err));
  }

  // The host could not be asked (or does not know this route). Resolved
  // NOTHING — this is the case the old boolean answered as "no commits".
  if (!statusResult.ok) {
    const detail =
      statusResult.reason === "unreachable" ? statusResult.detail : statusResult.reason;
    return unknownVerdict(app, task, hostId, detail);
  }

  const { isRepo, status } = statusResult.value;
  // Not a repo, or git had no status to report: a resolved "there is no
  // commit here", not an unreadable worktree.
  if (!isRepo || status === null) return { state: "none" };
  const { hash } = status;
  if (hash === null) return { state: "none" };

  // HEAD is at (or behind) the base SHA → no commits past it.
  return task.baseSha.startsWith(hash) ? { state: "none" } : { state: "ahead" };
}

/**
 * The "we could not find out" verdict, logged so it is never silent.
 *
 * The log carries what an operator needs to act on it: which task, in which
 * project, on which host, at which worktree — and why the lookup failed.
 *
 * Throttled to once per task per hour, the way the sibling lookup's warning
 * is (`warnUnstableRunsUnreadable` in task-reconciler.ts): the reconcile tick
 * is 30s by default and a task can sit in a rate-limit grace window for
 * hours, so an unthrottled warning here would be one line per tick for the
 * whole outage.
 */
function unknownVerdict(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  hostId: string,
  detail: string,
): CommitsPastBase {
  const now = Date.now();
  const last = unknownWarnedAt.get(task.id);
  if (last === undefined && unknownWarnedAt.size >= MAX_UNKNOWN_WARN_ENTRIES) {
    const oldest = unknownWarnedAt.keys().next().value;
    if (oldest !== undefined) unknownWarnedAt.delete(oldest);
  }
  if (last === undefined || now - last >= UNKNOWN_WARN_INTERVAL_MS) {
    unknownWarnedAt.set(task.id, now);
    app.log.warn(
      {
        taskId: task.id,
        projectId: task.projectId,
        hostId,
        worktreePath: task.worktreePath,
        detail,
      },
      "task reconcile: could not read the worktree's git status — the commits are unknown, not 'no commits'",
    );
  }
  return { state: "unknown", detail };
}

/** Test-only reset — the throttle map is module-level and would otherwise
 * leak state between test cases. */
export function resetUnknownVerdictWarningsForTests(): void {
  unknownWarnedAt.clear();
}
