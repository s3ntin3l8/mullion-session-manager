// Review dispatch gating: the CI / mergeability lookup the dispatch passes
// (`processPendingReviewSpawns`, `processHermesDispatch`) wait on, and what
// they do with a PR that conflicts with its base (#3339). Split out of
// task-reconciler.ts, which `autoReturnTask` keeps: it is passed in.
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { projects } from "../db/schema.js";
import { tasks } from "../db/schema.js";
import type { GitHubRepoRef } from "./git-remote.js";
import { resolveRepoRef } from "./host-git.js";
import { resolveGitHubToken } from "./github-integration.js";
import { getPullRequestByNumber } from "./github-write.js";
import { computeCiStatus, fetchRunsForHeadChecked } from "./github.js";
import type { PrCheckRuns } from "./pr-check-runs.js";
import { resolveSessionsDirWithFallback, resolveBackend } from "./session-backend.js";
import { resolveTaskWorkerHost } from "./session-live-info.js";
import { commandSupportsSeed } from "./task-agent-resolve.js";
import { deriveTaskBranchName } from "./git-worktree.js";
import {
  MAX_REBASE_ATTEMPTS,
  attemptAutoRebase,
  settleRapidRebaseExit,
} from "./task-auto-rebase.js";
import { CLEARED_MERGE_ERROR, recordMergeError } from "./task-merge-human.js";
import { resolveTaskIssueContextSafe } from "./task-issue-context.js";
import { resolveWorkerDelegation } from "./task-delegation.js";
import type { resolveTaskMasterConfig } from "./task-config.js";
import { buildMergeConflictPrompt, taskCommitTitlePath } from "./task-prompt.js";
import type { ReviewCiInfo } from "./task-prompt.js";

/** `autoReturnTask` (task-reconciler.ts), passed in to avoid an import cycle. */
type AutoReturn = (
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  opts: { reason: "conflict"; seedPrompt: string },
) => Promise<{ ok: boolean }>;

/** `resolveReviewCi`'s verdict for a PR that conflicts with its base (#3339). */
type ReviewConflict = { conflict: { baseRef: string } };

/**
 * Shared primitive behind both `resolveReviewCi` below (which layers a
 * wait-then-give-up deadline on top, for gating a review-agent spawn) and
 * the auto-approve gate's own CI check (`processAutoApprovals`, which never
 * gives up — see that function's own doc comment on why). Reads the task's
 * PR and its Actions runs for the current head commit; returns `null` for
 * every "nothing to check yet" case (no PR, no resolvable repo/token) with
 * no logging, since that's an ordinary, expected state for plenty of tasks,
 * not a failure. Can still throw on a real lookup failure (a thrown
 * `getPullRequestByNumber` call) — callers decide their own retry/deadline
 * posture around that. The Actions-runs lookup itself never throws: a failed
 * one comes back as `runsAnswered: false` with `status: null`, which reads the
 * same as "no Actions runs" unless the caller checks the flag.
 */
export async function fetchCurrentCiStatus(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<{
  headSha: string;
  status: ReturnType<typeof computeCiStatus>;
  runs: ReviewCiInfo["runs"];
  // #755 — the PR's own repo/base branch, for the red-CI-return gate.
  // Returned here (rather than re-resolved by that gate) since this function already has both in scope from the
  // `getPullRequestByNumber` call below — one fewer redundant GitHub call.
  repoRef: GitHubRepoRef;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string;
  // Set by the red-CI return once it has read this head's check runs, so the
  // approval gate does not read the same list again this tick.
  checkRuns?: PrCheckRuns;
  // False when the Actions-runs lookup itself failed (a non-2xx or a network
  // error): `status` is then `null`, which reads the same as "no Actions runs".
  // Only the red-CI gate's `unstable` arm needs to tell the two apart.
  runsAnswered: boolean;
  // #2103 — the PR's own lifecycle state, already in the payload: a closed or
  // merged PR is the end of a reviewing task, not something to keep polling.
  prState: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
} | null> {
  if (task.prNumber === null) return null;
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return null;
  // "read" scope (#489's least-privilege split) — this only ever reads the
  // PR and its Actions runs, never writes.
  const token = await resolveGitHubToken(app, repoRef, "read");
  if (!token) return null;
  const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
  const { ok: runsAnswered, runs } = await fetchRunsForHeadChecked(
    token,
    repoRef.owner,
    repoRef.repo,
    pr.headSha,
  );
  const status = computeCiStatus(runs);
  const runSummaries = runs.map((r) => ({
    name: r.name,
    conclusion: r.conclusion,
    htmlUrl: r.htmlUrl,
  }));
  return {
    headSha: pr.headSha,
    status,
    runs: runSummaries,
    repoRef,
    baseRef: pr.baseRef,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeableState,
    runsAnswered,
    prState: pr.state,
    merged: pr.merged,
    mergedAt: pr.mergedAt,
  };
}

/**
 * Resolves the CI signal for a task's PR head commit, or reports that the
 * caller should wait and re-check next tick. Never throws — a resolution
 * failure (no repo, no token, the PR/runs lookup itself throwing) waits up
 * to the same deadline as `in_progress`/`null` below, then degrades to
 * `undefined` (spawn with no CI context at all, the pre-#738-followup
 * behavior) past it, rather than blocking the spawn forever. The reviewer
 * must never be the thing a task gets stuck on.
 *
 * `undefined` also covers the case with nothing to check in the first
 * place: an issue-only task, or one whose draft PR hasn't opened yet.
 *
 * `null` (Hermes review, #742) waits too, same as `"in_progress"` — not
 * "proceed." `openDraftPRForTask` and this pass's own call both run inside
 * the SAME reconcile tick as the `→ reviewing` transition (`maybeOpenDraftPR`
 * above, then `processPendingReviewSpawns` at the very end of
 * `reconcileTasks`), so the very first lookup here almost always lands
 * within a second or two of the push that created the head commit —
 * GitHub's Actions runs for a just-pushed commit routinely aren't registered
 * yet, so the runs lookup answers `[]` and `computeCiStatus` returns
 * `null` indistinguishably from "this repo genuinely has no CI" (a lookup that
 * did not answer at all also gives `null`, but carries `runsAnswered: false`,
 * which only changes the wording of the note below). Treating
 * `null` as "proceed" on that very first check reproduces the #213782
 * incident this whole change exists to fix: the reviewer spawns before a
 * real check has even registered, let alone failed. Waiting on `null` the
 * same as `in_progress` costs nothing for a no-CI repo — it just spawns at
 * the deadline instead of instantly — and is what actually closes the gap
 * for the common case of a CI-having repo whose runs simply haven't shown
 * up yet.
 */
export async function resolveReviewCi(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  waitMinutes: number,
  now: number,
): Promise<"wait" | ReviewConflict | ReviewCiInfo | undefined> {
  if (task.prNumber === null) return undefined;

  try {
    const current = await fetchCurrentCiStatus(app, task, project);
    if (!current) return undefined;
    const { headSha, status, runs: runSummaries, runsAnswered } = current;

    // A PR that conflicts with its base never gets a `pull_request` workflow
    // run, so there is no CI to wait for and a review of its stale head is
    // wasted: the caller hands it to the rebase flow instead (#3339).
    if (current.mergeableState === "dirty") return { conflict: { baseRef: current.baseRef } };
    // GitHub is still computing mergeability (right after a push): wait one
    // more tick, bounded by the same deadline as the CI wait, then proceed as
    // before. Checked before the CI verdict so a terminal-CI PR waits too.
    if (
      (current.mergeable === null || current.mergeableState === "unknown") &&
      now - (task.reviewingAt?.getTime() ?? now) < waitMinutes * 60_000
    ) {
      return "wait";
    }

    if (status !== "in_progress" && status !== null) {
      return { headSha, status, runs: runSummaries };
    }

    // `waitMinutes === 0` disables waiting entirely — `now - reviewingAt`
    // is always `>= 0`, so this deadline is already "past" on the very
    // first check, same effect as never having entered this branch at all.
    // `reviewingAt` is set in the very same DB write that put this task in
    // "reviewing" (both `→ reviewing` transition sites), so it's never
    // actually null here — the `?? now` is defensive, not load-bearing.
    const reviewingAtMs = task.reviewingAt?.getTime() ?? now;
    const pastDeadline = now - reviewingAtMs >= waitMinutes * 60_000;
    if (!pastDeadline) return "wait";
    return {
      headSha,
      status,
      runs: runSummaries,
      // `status: null` is "no runs" only when GitHub actually answered; a failed
      // lookup must not tell the reviewer there is no CI (`runsAnswered`).
      note:
        status === null
          ? runsAnswered
            ? `no CI checks found after the ${waitMinutes}-minute wait`
            : `CI status could not be read after the ${waitMinutes}-minute wait (the Actions lookup failed)`
          : `still running after the ${waitMinutes}-minute wait`,
    };
  } catch (err) {
    // Same reasoning as the `null`-status branch above (Hermes review, PR
    // #742, second pass) — a thrown lookup (a transient network blip, or
    // GitHub not yet consistent on the brand-new PR) in the exact
    // just-pushed window is indistinguishable from "will succeed on the
    // next tick," and spawning without CI on the very first failure would
    // reintroduce the same #213782 gap this whole change exists to close.
    // Wait up to the same deadline; past it (a persistently broken
    // repo/token, not a blip), fall through to "spawn without CI" exactly
    // as before — this lookup must never be the reason a task wedges in
    // "reviewing" forever.
    const reviewingAtMs = task.reviewingAt?.getTime() ?? now;
    const pastDeadline = now - reviewingAtMs >= waitMinutes * 60_000;
    if (!pastDeadline) {
      app.log.warn(
        { err, taskId: task.id, prNumber: task.prNumber },
        "task reconcile: CI lookup for review spawn failed — waiting to retry",
      );
      return "wait";
    }
    app.log.warn(
      { err, taskId: task.id, prNumber: task.prNumber },
      "task reconcile: CI lookup for review spawn still failing past the wait deadline — spawning without it",
    );
    return undefined;
  }
}

/**
 * A PR that conflicts with its base gets no review (#3339). The dispatch loops
 * call this in place of the spawn/run: the task goes to the auto-rebase flow
 * (`attemptAutoRebase`, which owns the attempt counter, `rebaseStartedAt`
 * hold-back and rapid-exit backoff the loops already honour before they get
 * here), and once that cannot run or has given up (`declined`), back to its worker. Every
 * tick either spawns/awaits a rebase attempt (capped by MAX_REBASE_ATTEMPTS),
 * returns the task (once, see `returnConflictingPrToWorker`) or parks it for a
 * human, so the loop cannot spin.
 */
export async function holdConflictingReview(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  baseRef: string,
  resolvedTaskMaster: ReturnType<typeof resolveTaskMasterConfig>,
  autoReturn: AutoReturn,
): Promise<void> {
  // Parked for a human by an earlier tick (a worker that could not be stopped,
  // a return that failed): retrying would repeat the same failure every tick.
  if (isParkedForHuman(task)) return;
  // A park lifted by a reject or re-arm leaves its "will not retry" note behind;
  // this tick is a retry, so drop the note (a fresh park rewrites it).
  if (task.mergeError?.endsWith(PARKED_SUFFIX)) clearConflictHold(app, task);
  // Judge a finished attempt first: a rapid exit is refunded, which can take
  // the task back under the cap.
  await settleRapidRebaseExit(app, task, project);
  if (project.autoApprove && task.rebaseAttempts < MAX_REBASE_ATTEMPTS) {
    const outcome = await attemptAutoRebase(app, task, project, baseRef, { alreadySettled: true });
    if (outcome === "blocked") {
      parkConflict(
        app,
        task,
        `Conflicts with ${baseRef} — a session that has to stop before the rebase could not be stopped, needs manual resolution`,
      );
      return;
    }
    // A rebase that cannot run (no worktree, no seed-capable agent, a failed
    // spawn) would otherwise leave the task in `reviewing` every tick with no
    // attempt counted: send it back to its worker instead.
    if (outcome !== "declined") return;
  }
  await returnConflictingPrToWorker(app, task, project, baseRef, resolvedTaskMaster, autoReturn);
}

// Suffix of a conflict hold this gate parked for good (see `parkConflict`).
const PARKED_SUFFIX = " (Mullion will not retry automatically)";

function parkConflict(app: FastifyInstance, task: typeof tasks.$inferSelect, message: string) {
  recordMergeError(app, task.id, `${message}${PARKED_SUFFIX}`, "rebase-exhausted");
}

function isParkedForHuman(task: typeof tasks.$inferSelect): boolean {
  // The suffix is the once-only marker: `recordMergeError` keeps an existing
  // review-loop `needsHumanReason` (cap, no-progress, ...), so the reason
  // cannot say *that this gate* parked the task. But a park always leaves a
  // non-null reason, and a human reject or a re-arm clears it without touching
  // `mergeError`: a null reason means the park was lifted, so the stale marker
  // must not keep the gate silent.
  return !!task.mergeError?.endsWith(PARKED_SUFFIX) && task.needsHumanReason !== null;
}

/**
 * Sends a conflicting PR back to its worker with a prompt to merge the base and
 * resolve the conflicts (the `conflict` auto-return: spends no review round,
 * is not an inconclusive re-arm). Done at most once in a row: a worker that was
 * already sent back for a conflict and left it conflicting (or lost the race to
 * the base again) goes to a human, since this return deliberately spends no
 * round and so has no cap of its own.
 */
async function returnConflictingPrToWorker(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  baseRef: string,
  resolvedTaskMaster: ReturnType<typeof resolveTaskMasterConfig>,
  autoReturn: AutoReturn,
): Promise<void> {
  if (task.lastAutoReturnReason === "conflict") {
    parkConflict(
      app,
      task,
      `Conflicts with ${baseRef} — the worker was already sent back once to resolve it and the PR still conflicts, needs manual resolution`,
    );
    return;
  }
  if (!task.worktreePath || !task.agentCommand) {
    parkConflict(
      app,
      task,
      `Conflicts with ${baseRef} — no worker to send it back to, needs manual resolution`,
    );
    return;
  }
  if (!commandSupportsSeed(task.agentCommand)) {
    // The worker would spawn with no conflict prompt and burn its budget.
    parkConflict(
      app,
      task,
      `Conflicts with ${baseRef} — the worker's agent cannot take a seed prompt, needs manual resolution`,
    );
    return;
  }
  const workerHostId = resolveTaskWorkerHost(app, task);
  const sessionsDir = await resolveSessionsDirWithFallback(app, resolveBackend(app, workerHostId), {
    taskId: task.id,
    hostId: workerHostId,
  });
  const issueContext = await resolveTaskIssueContextSafe(app, task, project);
  const reason = project.autoApprove
    ? `Mullion's automatic rebase could not resolve it (${task.rebaseAttempts} of ${MAX_REBASE_ATTEMPTS} attempt(s) used).`
    : "Automatic rebase is off for this project.";
  const returned = await autoReturn(app, task, project, {
    reason: "conflict",
    seedPrompt: buildMergeConflictPrompt({
      task: {
        ...task,
        comments: issueContext?.comments,
        parent: issueContext?.parent,
        siblings: issueContext?.siblings,
      },
      branchName: task.branchName ?? deriveTaskBranchName(task),
      worktreePath: task.worktreePath,
      budgetMinutes: resolvedTaskMaster.budgetMinutes,
      commitTitlePath: project.conventionalCommitTitles
        ? taskCommitTitlePath(sessionsDir, task.id)
        : undefined,
      agentCommand: task.agentCommand,
      delegation: resolveWorkerDelegation(app, task.agentCommand, task),
      baseRef,
      reason,
    }),
  });
  if (returned.ok) {
    app.log.info(
      { taskId: task.id, prNumber: task.prNumber },
      "task reconcile: conflicting PR sent back to its worker before review dispatch",
    );
  } else {
    // The return rolled back (e.g. the reseed could not spawn): park after one
    // try rather than repeating it every tick.
    parkConflict(
      app,
      task,
      `Conflicts with ${baseRef} — sending it back to the worker failed, needs manual resolution`,
    );
  }
}

/** Drops the conflict note the rebase flow left once the PR reads mergeable. */
export function clearConflictHold(app: FastifyInstance, task: typeof tasks.$inferSelect): void {
  if (!task.mergeError?.startsWith("Conflicts with")) return;
  app.db.update(tasks).set(CLEARED_MERGE_ERROR).where(eq(tasks.id, task.id)).run();
  task.mergeError = null;
}
