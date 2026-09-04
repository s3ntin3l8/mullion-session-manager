import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, sessions, tasks } from "../db/schema.js";
import type { SessionInfo } from "./pty-manager.js";
// createSessionRecord is pure business logic filed under services/
// (session-lifecycle.ts) precisely so a service can reuse it directly.
import { createSessionRecord, killSession } from "./session-lifecycle.js";
// closeSessionBrowserBindings — the same "confirmed-terminate" side effect
// reseedTaskIfSessionExited's own force path applies (task-reseed.ts); see
// attemptAutoRebase's stale-attempt-termination branch below for why this
// needs it too.
import { closeSessionBrowserBindings } from "./session-browsers.js";
import {
  resolveBackend,
  resolveSessionsDirWithFallback,
  type SessionBackend,
} from "./session-backend.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { defaultDeriveStatusInfo, deriveSessionStatus } from "./session-status.js";
import { getStoredSettings } from "./settings.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import {
  resolveReviewAgentCommand,
  commandSupportsSeed,
  resolveSeedDelivered,
} from "./task-agent-resolve.js";
import { resolveOpenCodeModel, resolveOpenCodeSmallModel } from "./task-model-resolve.js";
import { commandIsOpencode } from "./hook-adapters/index.js";
import {
  syncTaskTransition,
  computeTaskDiffStat,
  postReviewFindingsComment,
} from "./task-github-sync.js";
import { recordTaskTransition } from "./task-state.js";
import {
  buildReviewPrompt,
  buildReviewFeedbackPrompt,
  buildCiFailurePrompt,
  buildRebasePrompt,
  buildPrReviewCommentsPrompt,
  taskReviewFindingsPath,
  taskCommitTitlePath,
  parseReviewFindings,
  parseCommitTitle,
  renderReviewFindingsMarkdown,
  type ReviewCiInfo,
  type PrReviewCommentInfo,
} from "./task-prompt.js";
import { openDraftPRForTask } from "./task-promote.js";
import { approveTask, cleanupTaskWorktree, cleanupTaskSessions } from "./task-approve.js";
import { reseedTaskIfSessionExited } from "./task-reseed.js";
import { resolveHostGitStatus, resolveRepoRef } from "./host-git.js";
import { commitWipChanges, deriveTaskBranchName, deriveWorktreePath } from "./git-worktree.js";
import type { GitHubRepoRef } from "./git-remote.js";
import {
  resolveGitHubToken,
  resolveReviewerToken,
  resolveMullionReviewLogins,
} from "./github-integration.js";
import {
  getPullRequestByNumber,
  mergePullRequest,
  updatePullRequestBranch,
  deleteRemoteBranch,
  fetchPullRequestReviewThreads,
  detectReleaseWorkflow,
  getPullRequestReviewDecision,
  createPullRequestReview,
  resolveReviewThread,
} from "./github-write.js";
import {
  computeCiStatus,
  fetchRunsForHead,
  fetchRequiredStatusContexts,
  fetchCheckRunsForHead,
  getPRsStatus,
} from "./github.js";
import { isGitHubRateLimited, githubRateLimitRemainingMs } from "./github-fetch.js";
import { classifyMergeReadiness } from "./merge-readiness.js";
import { resolveReleaseMerge } from "./release-merge.js";
import type { ReleaseMergeResult } from "../shared/types.js";

/**
 * Review agent decision (this phase's binding design) — when a project or
 * the task's own issue configures one, entering "reviewing" spawns it IN
 * THE WORKER'S OWN WORKTREE (no new worktree — the worker's turn is
 * already over by the time this runs, so there's no concurrent-write
 * race), seeded with a review-focused prompt. Advisory only: its output is
 * surfaced via `tasks.reviewSessionId` for the panel to render as a
 * distinct, clearly-labeled card — it has no path to approve, reject, or
 * otherwise transition the task itself. Best-effort with respect to the
 * reviewing transition that already committed: a spawn failure here is
 * logged and swallowed, never rolled back into the (already-real) status
 * change, matching the "advisory, not required for the loop's
 * correctness" framing.
 *
 * #487 — unlike the worker claim (task-claim.ts), which refuses outright
 * when its resolved agent's adapter can't receive a seed (a correctness bug
 * for unattended work), a review agent is always spawned regardless: it's
 * advisory, and refusing to spawn it at all would remove the one artifact
 * (the empty session) a human could notice something's wrong from. Instead
 * this warns (matching the worker path's log posture) and records
 * `reviewSeedDelivered: false` on the task row, so a seedless review
 * session is visible without grepping logs — see the column's own doc
 * comment in schema.ts.
 *
 * Actually spawning — this function — is called only once
 * `processPendingReviewSpawns` below has already resolved a CI verdict (or
 * decided there's none to wait for) and CAS-claimed the slot. Unlike the
 * old inline version, a failed spawn now clears its own claim
 * (`clearReviewSpawnClaim`) so the next tick retries rather than leaving
 * the task with no reviewer forever — see schema.ts's
 * `reviewSpawnClaimedAt` doc comment.
 */
async function spawnReviewAgentNow(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  skipPermissions: boolean,
  reviewCommand: string,
  ci: ReviewCiInfo | undefined,
  model: string | undefined,
  smallModel: string | undefined,
): Promise<void> {
  if (!task.worktreePath) return;
  // Hoisted out of the `try` (Hermes review, PR #742) — a throw AFTER
  // createSessionRecord succeeds (a DB error on the CAS update below, or
  // resolveSeedDelivered itself throwing) used to fall into the generic
  // `catch`, which only cleared the claim and had no way to reach the
  // session it had just created — left "active" and untracked, it would
  // surface later at the exited-session reconciler as a mystery crash with
  // no task behind it, same failure mode the `changes === 0` branch below
  // exists to prevent for the "task moved on" case.
  let spawnedSessionId: number | undefined;
  try {
    // Delivered as argv, not stashSeed — same fix as task-claim.ts's own
    // worker spawns: SessionStart's `additionalContext` (stashSeed's only
    // consumer) injects context but never submits a turn, which would leave
    // an unattended review agent idling exactly like an unattended worker
    // did before this fix.
    const seedCapable = commandSupportsSeed(reviewCommand);
    // #778 — resolved against the OWNING host's own sessionsDir (falls back
    // to the primary's local path, with a warn, if that lookup fails) so
    // the review agent is told to write somewhere it can actually reach on
    // its own filesystem, not wherever the primary's own hookSocketPath
    // happens to live.
    const backend = resolveBackend(app, project.hostId);
    const sessionsDir = await resolveSessionsDirWithFallback(app, backend, {
      taskId: task.id,
      hostId: project.hostId,
    });
    // task.autoReturnRounds is the round THIS review belongs to: 0 for the
    // first review, 1 for the one spawned after an auto-returned round —
    // see taskReviewFindingsPath's own doc comment for why round-suffixing
    // matters here.
    const findingsPath = taskReviewFindingsPath(sessionsDir, task.id, task.autoReturnRounds);
    // Task Master trial 220921 / PR #743's incident left exactly this file
    // on disk: `processReviewingTasks`'s own unlink-on-ingest ran before the
    // real (late-arriving) findings file existed, so it found nothing to
    // remove, and the file that appeared 21 seconds later was never cleaned
    // up. `autoReturnRounds` doesn't change on a same-round re-review (a
    // rejected task's next review reuses this exact round-suffixed path —
    // see `taskReviewFindingsPath`'s own doc comment on why round-suffixing
    // exists at all), so a leftover from a PRIOR attempt at this round would
    // otherwise be silently re-ingested as THIS attempt's fresh output.
    // Unlinking here, before the agent gets a chance to write anything, is
    // the fix: whatever this fresh spawn's own agent writes is now
    // guaranteed to be the only thing this path can ever contain.
    await unlinkFindingsFileIfPresent(app, backend, task.id, task.autoReturnRounds);
    const prompt = buildReviewPrompt({ task, worktreePath: task.worktreePath, findingsPath, ci });
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command: reviewCommand,
      cwd: task.worktreePath,
      initialPrompt: seedCapable ? prompt : undefined,
      skipPermissions,
      // #9 — named and locked so this session reads as "task #N's review"
      // anywhere it's shown. `nameLocked: true` deliberately overrides this
      // column's own documented default intent (schema.ts) — see
      // task-claim.ts's own worker-spawn comment for the full reasoning.
      name: `Task #${task.id} · review`,
      nameLocked: true,
      model,
      smallModel,
      // Review agents are also unattended (no human in the loop) and run
      // in the same worktree as the worker, so they're just as exposed to
      // the brainstorming-skill failure mode verified in branchdam-mobile
      // tasks #66 / #67. Mark as a Task Master session so the opencode
      // adapter denies the same three skills.
      taskId: task.id,
    });
    if (!result.ok) {
      app.log.warn(
        { taskId: task.id, reviewCommand, reason: result.reason },
        "task reconcile: review agent spawn failed",
      );
      clearReviewSpawnClaim(app, task.id);
      return;
    }
    spawnedSessionId = result.row.id;
    // Same version-skew guard as task-claim.ts's own — see
    // resolveSeedDelivered's doc comment.
    const seedDelivered = resolveSeedDelivered(
      seedCapable,
      project.hostId,
      result.initialPromptApplied,
    );
    if (!seedDelivered) {
      app.log.warn(
        { taskId: task.id, reviewCommand, hostId: project.hostId, seedCapable },
        seedCapable
          ? "task reconcile: sent an initial prompt to a remote host but it wasn't confirmed applied — possible version skew"
          : "task reconcile: review agent's adapter can't receive an initial prompt — spawning with no instructions",
      );
    }
    // CAS on `status = "reviewing"`, not just `id` — the claim slot
    // (`reviewSpawnClaimedAt`) only protects against a second
    // `processPendingReviewSpawns` pass racing this one; it says nothing
    // about Reject/Give-up/Approve, which CAS on `status` alone and don't
    // know this claim exists. `createSessionRecord` above is a real spawn
    // (possibly a network round-trip to a remote host), long enough for one
    // of those routes to land while it's in flight. If the task has moved
    // on, attaching `reviewSessionId` here would leave a live, untracked
    // session pointed at a worktree Approve may already be deleting —
    // discard it instead of recording it.
    const updated = app.db
      .update(tasks)
      .set({ reviewSessionId: result.row.id, reviewSeedDelivered: seedDelivered })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
      .run();
    if (updated.changes === 0) {
      app.log.warn(
        { taskId: task.id, reviewSessionId: result.row.id },
        "task reconcile: task left 'reviewing' while its review agent was spawning — killing the orphaned session",
      );
      // killSession, not a bare backend.terminate — this session was never
      // attached to the task (the write above just refused), so nothing
      // else will ever flip its `sessions` row to "killed." Left "active",
      // the exited-session reconciler would find the now-dead process later
      // and surface it as a crashed session with no task, agent, or
      // worktree behind it — a live "kill" here folds that into the normal
      // human-initiated-kill path instead of inventing a new terminal state
      // for it.
      await killSession(app, result.row.id);
      return;
    }
    app.log.info(
      { taskId: task.id, reviewSessionId: result.row.id, reviewCommand, seedDelivered },
      "task reconcile: review agent spawned",
    );
  } catch (err) {
    app.log.warn({ err, taskId: task.id, reviewCommand }, "task reconcile: review agent threw");
    clearReviewSpawnClaim(app, task.id);
    if (spawnedSessionId !== undefined) {
      await killSession(app, spawnedSessionId).catch((killErr: unknown) => {
        app.log.warn(
          { err: killErr, taskId: task.id, reviewSessionId: spawnedSessionId },
          "task reconcile: failed to kill the orphaned review session after a post-spawn throw",
        );
      });
    }
  }
}

// Guarded on `reviewSessionId IS NULL` — if some other path already landed a
// real session between the failure and this write (shouldn't happen, given
// the CAS claim, but this is a cheap belt-and-suspenders match for the
// discipline every other write in this file already follows), this must not
// clobber it back to an unspawned-looking state.
function clearReviewSpawnClaim(app: FastifyInstance, taskId: number): void {
  app.db
    .update(tasks)
    .set({ reviewSpawnClaimedAt: null })
    .where(and(eq(tasks.id, taskId), isNull(tasks.reviewSessionId)))
    .run();
}

/**
 * Shared primitive behind both `resolveReviewCi` below (which layers a
 * wait-then-give-up deadline on top, for gating a review-agent spawn) and
 * the auto-approve gate's own CI check (`processAutoApprovals`, which never
 * gives up — see that function's own doc comment on why). Reads the task's
 * PR and its Actions runs for the current head commit; returns `null` for
 * every "nothing to check yet" case (no PR, no resolvable repo/token) with
 * no logging, since that's an ordinary, expected state for plenty of tasks,
 * not a failure. Can still throw on a real lookup failure (a thrown
 * `getPullRequestByNumber`/`fetchRunsForHead` call) — callers decide their
 * own retry/deadline posture around that.
 */
async function fetchCurrentCiStatus(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<{
  headSha: string;
  status: ReturnType<typeof computeCiStatus>;
  runs: ReviewCiInfo["runs"];
  // #755 — the PR's own repo/base branch, for the red-CI-return gate's
  // branch-protection lookup. Returned here (rather than re-resolved by
  // that gate) since this function already has both in scope from the
  // `getPullRequestByNumber` call below — one fewer redundant GitHub call.
  repoRef: GitHubRepoRef;
  baseRef: string;
} | null> {
  if (task.prNumber === null) return null;
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return null;
  // "read" scope (#489's least-privilege split) — this only ever reads the
  // PR and its Actions runs, never writes.
  const token = await resolveGitHubToken(app, repoRef, "read");
  if (!token) return null;
  const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
  const runs = await fetchRunsForHead(token, repoRef.owner, repoRef.repo, pr.headSha);
  const status = computeCiStatus(runs);
  const runSummaries = runs.map((r) => ({
    name: r.name,
    conclusion: r.conclusion,
    htmlUrl: r.htmlUrl,
  }));
  return { headSha: pr.headSha, status, runs: runSummaries, repoRef, baseRef: pr.baseRef };
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
 * yet, so `fetchRunsForHead` returns `[]` and `computeCiStatus` returns
 * `null` indistinguishably from "this repo genuinely has no CI." Treating
 * `null` as "proceed" on that very first check reproduces the #213782
 * incident this whole change exists to fix: the reviewer spawns before a
 * real check has even registered, let alone failed. Waiting on `null` the
 * same as `in_progress` costs nothing for a no-CI repo — it just spawns at
 * the deadline instead of instantly — and is what actually closes the gap
 * for the common case of a CI-having repo whose runs simply haven't shown
 * up yet.
 */
async function resolveReviewCi(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  waitMinutes: number,
  now: number,
): Promise<"wait" | ReviewCiInfo | undefined> {
  if (task.prNumber === null) return undefined;

  try {
    const current = await fetchCurrentCiStatus(app, task, project);
    if (!current) return undefined;
    const { headSha, status, runs: runSummaries } = current;

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
      note:
        status === null
          ? `no CI checks found after the ${waitMinutes}-minute wait`
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
 * Spawns the review agent for every "reviewing" task that doesn't have one
 * yet (`reviewSessionId IS NULL`) — a separate pass from the `→ reviewing`
 * transition itself (both call sites below now only clear
 * `reviewSessionId`/`reviewSeedDelivered`/`reviewSpawnClaimedAt`, they no
 * longer spawn inline), so the spawn can hold until CI reports on the PR's
 * head commit instead of firing before the PR even exists — the gap a live
 * run against branchdam (#213782) exposed: the reviewer was spawned 5s
 * before the draft PR was opened, so it could never have seen CI regardless
 * of how long it waited on its own.
 *
 * Runs every tick this task's status/reviewSessionId match, independent of
 * the claimed/in_progress pass below — same reasoning as
 * `processReviewingTasks`/`retryStrandedDraftPRs` above.
 *
 * No first-deploy backfill concern: this selects on `reviewSessionId IS
 * NULL`, and every task that reached "reviewing" under the OLD inline-spawn
 * code already has a non-null `reviewSessionId` from that spawn. The only
 * rows this pass ever sees are ones that entered "reviewing" under this new
 * code (deliberately null) or ones whose original spawn attempt failed
 * under the old code (already stuck with no reviewer today) — never a burst
 * of already-reviewed tasks.
 */
// A claim survives only as long as the in-process work between claiming it
// and either spawning or clearing it (clearReviewSpawnClaim's own catch
// paths) — a process crash/redeploy mid-claim leaves it stuck non-null
// forever with no other code path that ever clears it (unlike
// reviewSessionId, nothing outside this pass's own CAS reads it). 10 minutes
// is generous relative to what's actually in that window (one CI lookup,
// one spawn), so a claim still standing past it is treated as abandoned and
// reclaimed on the next tick rather than the task quietly losing its
// reviewer forever to a redeploy that happened at the wrong instant.
const REVIEW_SPAWN_CLAIM_STALE_MS = 10 * 60_000;

async function processPendingReviewSpawns(app: FastifyInstance): Promise<void> {
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  // Same gate as the "→ reviewing" transition itself (Hermes review, PR
  // #480) used to cover transitively, back when it spawned the reviewer
  // inline: spawning a review-agent session is new autonomous work — a real
  // PTY session, optionally with skip-permissions — not the "already
  // claimed/in_progress" progression `pty.ts`'s ungated-tick comment carves
  // out. Splitting the spawn into this separate pass (#738 follow-up) lost
  // that transitive coverage; restored explicitly here, same posture as
  // `retryStrandedDraftPRs` above. A task left waiting here when disabled
  // still has reject/give-up as an escape hatch (both deliberately ungated,
  // same reasoning as the transition-site comment above) and picks up its
  // reviewer normally on the next tick once re-enabled.
  if (!resolvedTaskMaster.enabled) return;

  const rows = app.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.status, "reviewing"), isNull(tasks.reviewSessionId)))
    .all();
  if (rows.length === 0) return;

  const now = Date.now();

  // Host-grouped and concurrent, same shape as retryStrandedDraftPRs above
  // — a CI lookup or a spawn on one host must not serialize behind a slow
  // or unreachable one. Unlike that pass, no per-task backoff state: every
  // waiting task resolves in at most `reviewCiWaitMinutes` /
  // `reconcileIntervalSeconds` ticks (2 GitHub calls each) — bounded and
  // self-terminating once it spawns, not an unbounded retry a backoff would
  // need to tame. That IS a real, if modest, standing cost at the default
  // 15-minute wait: a repo with no CI configured at all polls for the full
  // window on every task with a PR (null now waits too — see
  // resolveReviewCi's own doc comment), not just one whose CI is genuinely
  // `in_progress`. Acceptable at this tool's scale (a handful of concurrent
  // tasks, well under GitHub's rate limits); revisit with real backoff if
  // that scale assumption ever changes.
  const byHost = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byHost.get(row.project.hostId) ?? [];
    group.push(row);
    byHost.set(row.project.hostId, group);
  }

  await Promise.all(
    [...byHost.values()].map(async (hostRows) => {
      for (const { task, project } of hostRows) {
        if (!task.worktreePath) continue;
        const reviewCommand = resolveReviewAgentCommand(app, {
          taskReviewAgent: task.reviewAgent,
          issueBody: task.body,
          projectDefaultReviewAgent: project.defaultReviewAgent,
        });
        // No reviewer configured for this task — never spawn one, exactly
        // the pre-#738-followup behavior. Cheap check, done before any
        // network call.
        if (reviewCommand === null) continue;

        const reviewModel = commandIsOpencode(reviewCommand)
          ? (resolveOpenCodeModel(app, {
              taskModel: task.model ?? null,
              issueBody: task.body,
              role: "reviewer",
            }) ?? undefined)
          : undefined;
        const reviewSmallModel = commandIsOpencode(reviewCommand)
          ? (resolveOpenCodeSmallModel(app, {
              taskSmallModel: task.smallModel ?? null,
              issueBody: task.body,
            }) ?? undefined)
          : undefined;

        const ci = await resolveReviewCi(
          app,
          task,
          project,
          resolvedTaskMaster.reviewCiWaitMinutes,
          now,
        );
        if (ci === "wait") continue;

        // Claim the slot immediately before the spawn's own I/O (the CI
        // lookup above is read-only — nothing to protect there) — CAS
        // re-checks status/reviewSessionId/reviewSpawnClaimedAt all still
        // match what was read at the top of this pass, so a concurrent
        // reject/give-up/approve that landed while the CI lookup was in
        // flight wins outright instead of racing a spawn into existence
        // for a task that's already moved on. See schema.ts's
        // `reviewSpawnClaimedAt` doc comment. A claim older than
        // REVIEW_SPAWN_CLAIM_STALE_MS is treated as abandoned (a prior
        // attempt's process died mid-claim) and reclaimable, same as a null
        // one — see that constant's own doc comment.
        const claimed = app.db
          .update(tasks)
          .set({ reviewSpawnClaimedAt: new Date(now) })
          .where(
            and(
              eq(tasks.id, task.id),
              eq(tasks.status, "reviewing"),
              isNull(tasks.reviewSessionId),
              or(
                isNull(tasks.reviewSpawnClaimedAt),
                lt(tasks.reviewSpawnClaimedAt, new Date(now - REVIEW_SPAWN_CLAIM_STALE_MS)),
              ),
            ),
          )
          .run();
        if (claimed.changes === 0) continue;

        await spawnReviewAgentNow(
          app,
          task,
          project,
          resolvedTaskMaster.skipPermissions,
          reviewCommand,
          ci,
          reviewModel,
          reviewSmallModel,
        );
      }
    }),
  );
}

// #722's investigation, RC5 — session-status.ts's `derived.status ===
// "finished"` is a LATCH on `lastTurnEndedAt`, not an edge: once set, it
// stays true until the NEXT turn starts (hook-handlers.ts's `turn_start`) or
// a genuine keystroke clears it (pty-manager.ts's `isGenuineUserInput`).
// Reject (`reviewing -> in_progress`, routes/tasks.ts) deliberately leaves a
// still-active session's latch untouched so a human can type feedback into
// it themselves (task-reseed.ts's own `force: false` doc comment) — but
// that means the very next reconcile tick re-derives "finished" from that
// SAME stale latch and flips the task straight back to "reviewing" before
// the human ever gets a chance to type, pushing again and spawning a second
// review agent that clobbers `reviewSessionId`.
//
// Fixed by requiring the finish signal to postdate this specific
// claimed/in_progress spell, anchored on `claimedAt`: it's already reset to
// `now` on every fresh entry into that pool — a new claim, Retry, AND Reject
// (routes/tasks.ts's own reject handler, already documented there as the
// budget-deadline anchor) — so one comparison covers all three without a new
// column. A small tolerance guards against clock skew between this process
// and a remote-hosted project's own host (#484) — both are NTP-synced in
// practice, but a bare `>` would let a few hundred ms of skew wrongly stick
// a task in "in_progress" forever.
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

function turnFinishedSinceClaim(
  info: SessionInfo | null,
  task: { claimedAt: Date | null },
): boolean {
  if (info === null || info.lastTurnEndedAt === null || task.claimedAt === null) return false;
  return info.lastTurnEndedAt >= task.claimedAt.getTime() - CLOCK_SKEW_TOLERANCE_MS;
}

/**
 * #722's fix — decides whether a "-> reviewing" transition (both call sites
 * below) may actually fire. `derived.status === "finished"` alone isn't
 * enough: a `stop_failure` (e.g. a rate-limit) produces the exact same
 * "phase: done" signal as a real completion, and both call sites used to
 * advance to "reviewing" either way — the task 213765 incident this fixes,
 * where the transition fired with 8 modified files, 1 untracked file, and
 * zero commits on the branch.
 *
 * The discriminating signal is deliberately "commits ahead of `baseSha`",
 * NOT dirtiness: a task barely out of its worker's last turn very often has
 * an untracked scratch file (see maybeOpenDraftPR's own doc comment above)
 * even when its real work IS committed — failing on dirtiness alone would
 * turn every such stray file into a hard failure, a far bigger blast radius
 * than the bug this fixes. Only "HEAD is still at baseSha" — genuinely no
 * commits at all — blocks the transition; a dirty-but-committed tree still
 * advances normally, exactly as before, and picks up its draft PR via
 * `maybeOpenDraftPR`/the stranded-task retry sweep once the tree is clean.
 *
 * Fails OPEN (`{ ok: true }`, advances normally) whenever this can't be
 * determined — no `baseSha` recorded (an older task row), the worktree
 * isn't reachable, or the host doesn't support the git-status proxy yet
 * (#484) — this check must never itself be the reason a healthy task gets
 * stuck.
 *
 * LOCAL_HOST_ID only (independent review, PR #726) — `resolveHostGitStatus`
 * itself is fully proxied for a #484-capable remote host, so this gate
 * WOULD fire there too, but `failReviewingGate` below only salvages a WIP
 * commit on the local host (no proxied git-commit route exists yet — see
 * that function's own doc comment). Firing the gate without the salvage
 * would fail the task, terminate its session, and leave the tree dirty —
 * `removeWorktreeIfClean` then refuses (dirty is its one real refusal
 * condition), permanently blocking Retry's `resumeTaskWorktree` at the
 * deterministic path. That's strictly worse than the pre-#722 behavior for
 * a remote-hosted task, which at least reached "reviewing" with a live
 * session and its uncommitted work still in place. Stays fail-open for
 * remote hosts until a remote salvage-commit proxy exists.
 */
async function checkReviewingGate(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  info: SessionInfo | null,
): Promise<{ ok: true } | { ok: false; failureReason: string }> {
  if (project.hostId !== LOCAL_HOST_ID) return { ok: true };
  if (!task.baseSha || !task.worktreePath) return { ok: true };

  const statusResult = await resolveHostGitStatus(app, project.hostId, task.worktreePath);
  if (!statusResult.ok || !statusResult.value.isRepo || statusResult.value.status === null) {
    return { ok: true };
  }
  const { hash } = statusResult.value.status;
  if (hash === null || !task.baseSha.startsWith(hash)) return { ok: true };

  // Best-effort enrichment only — errorState is TTL-backed and often
  // already cleared by the time a human has resumed and re-finished the
  // session, so this is omitted rather than guessed at when stale.
  //
  // Truncated (independent review, PR #726) — errorDetail is unbounded
  // agent-controlled free text (the stop_failure hook payload), and
  // failureReason is posted verbatim to a public GitHub issue comment
  // (task-github-sync.ts). Every other place this kind of detail reaches a
  // human trims it to the same length (session-status.ts's own
  // STATUS_DETAIL_MAX_CHARS) — this path shouldn't be the one exception.
  const ERROR_DETAIL_MAX_CHARS = 48;
  const rawDetail = info?.errorState === "api_error" ? info.errorDetail : null;
  const truncatedDetail =
    rawDetail === null
      ? null
      : rawDetail.length <= ERROR_DETAIL_MAX_CHARS
        ? rawDetail
        : `${rawDetail.slice(0, ERROR_DETAIL_MAX_CHARS)}…`;
  const detail = truncatedDetail !== null ? ` (${truncatedDetail})` : "";
  return {
    ok: false,
    failureReason: `agent ended its turn with no commits on ${task.branchName}${detail}`,
  };
}

/**
 * Executes the #722 "no commits ahead of base" failure found by
 * `checkReviewingGate`: claims the task via the same CAS `.where(status =
 * fromStatus)` every other automatic transition in this file uses, THEN
 * attempts a machine-made salvage commit, then cleans up exactly like the
 * budget-exceeded branch above: terminate the session, sync the failure to
 * GitHub, remove the worktree if (now) clean. This is what makes Retry able
 * to recover the work — before this, a dirty leftover worktree at the
 * deterministic path permanently blocked `resumeTaskWorktree`'s own
 * `git worktree add`.
 *
 * The `LOCAL_HOST_ID` guard on the salvage commit below is redundant in
 * practice — `checkReviewingGate` itself is scoped to local hosts, so this
 * function is never called for a remote-hosted task at all — but kept as
 * defense in depth rather than trusted to that caller alone.
 *
 * CAS BEFORE the salvage commit, not after (Hermes review, PR #726) — a
 * git commit is a real, visible mutation of the branch. Committing first and
 * checking the CAS second meant a task that lost a race with a concurrent
 * transition (e.g. a human Reject landing mid-flight) still got a stray wip
 * commit pushed onto a branch this function no longer owned. Claiming the
 * transition first means the commit only ever happens once this call is the
 * sole owner of what happens to the task next.
 */
async function failReviewingGate(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  session: typeof sessions.$inferSelect,
  project: typeof projects.$inferSelect,
  backend: SessionBackend,
  fromStatus: "claimed" | "in_progress",
  failureReason: string,
  now: Date,
): Promise<void> {
  const updated = app.db
    .update(tasks)
    .set({ status: "failed", failureReason, completedAt: now })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, fromStatus)))
    .run();
  if (updated.changes === 0) return;

  if (project.hostId === LOCAL_HOST_ID && task.worktreePath) {
    const commitResult = await commitWipChanges(task.worktreePath);
    if (commitResult.error) {
      app.log.warn(
        { taskId: task.id, worktreePath: task.worktreePath, error: commitResult.error },
        "task reconcile: WIP salvage commit failed",
      );
    } else if (commitResult.committed) {
      app.log.info({ taskId: task.id }, "task reconcile: committed a WIP salvage commit");
    }
  }

  recordTaskTransition(app, {
    taskId: task.id,
    projectId: project.id,
    from: fromStatus,
    to: "failed",
    via: "reconcile",
    context: { sessionId: session.id, reason: failureReason },
  });
  // killSession, not a bare backend.terminate — this task just left
  // claimed/in_progress for good, and nothing else will ever flip this
  // session's row to "killed." A bare terminate leaves it "active" until
  // the 30s exited-session reconciler notices and marks it "exited" —
  // never "killed", the one status the sidebar and the Unified Board's
  // ad-hoc lane don't already filter out of view.
  await killSession(app, session.id).catch((err) => {
    app.log.warn(
      { err, taskId: task.id, sessionId: session.id },
      "task reconcile: failed to kill session after the no-commits gate failure",
    );
  });
  await syncTaskTransition(
    app,
    { ...task, status: "failed", failureReason, completedAt: now },
    project,
    "failed",
  );
  if (task.worktreePath) {
    await backend.removeWorktreeIfClean(task.worktreePath, project.cwd).catch((err) => {
      app.log.warn(
        { err, taskId: task.id, worktreePath: task.worktreePath },
        "task reconcile: removeWorktreeIfClean threw after the no-commits gate failure",
      );
    });
  }
}

/**
 * Opens (or, on a second "-> reviewing", pushes new commits to) a draft PR
 * for the task — best-effort, mirroring maybeSpawnReviewAgent's own posture
 * exactly: a failure here is logged and swallowed, never rolled back into
 * the reviewing transition that already committed. task-promote.ts's
 * openDraftPRForTask already records tasks.githubSyncError for every
 * failure reason that's an actual sync problem (and deliberately doesn't
 * for the ones that aren't — dirty-tree, no-worktree, an undeterminable
 * base branch, or remote-not-supported), so this only needs to log, not
 * duplicate that bookkeeping.
 */
async function maybeOpenDraftPR(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<void> {
  const result = await openDraftPRForTask(app, task, project);
  if (!result.ok) {
    // dirty-tree/no-worktree/remote-not-supported are ordinary, expected
    // outcomes here (a task barely out of its worker's last turn very
    // often has an untracked scratch file, its host was briefly
    // unreachable, or — #484 — its host's agent build predates the proxy
    // routes promotion needs) — logged at info, not warn, so this doesn't
    // read as an operational alert on every routine skip.
    app.log.info(
      { taskId: task.id, reason: result.reason, detail: result.detail },
      "task reconcile: draft PR not opened",
    );
    return;
  }
  // CAS'd on `status = "reviewing"` (independent review, PR #725) — the
  // retry sweep below awaits a real network call (openDraftPRForTask) per
  // task, which is long enough for a concurrent give-up/approve/reject to
  // resolve the task out from under it. Without this guard, a give-up that
  // lands mid-call flips the task to "failed" and its own
  // closeDraftPRForTask no-ops (prNumber was still null when it ran) — this
  // write would then land anyway, leaving a "failed" task with an open
  // draft PR nothing will ever close.
  const updated = app.db
    .update(tasks)
    .set({ prUrl: result.prUrl, prNumber: result.prNumber })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
    .run();
  if (updated.changes === 0) {
    app.log.info(
      { taskId: task.id, prUrl: result.prUrl },
      "task reconcile: draft PR opened but the task left 'reviewing' before this could record it — leaving the PR as-is for a human to notice",
    );
    return;
  }
  app.log.info({ taskId: task.id, prUrl: result.prUrl }, "task reconcile: draft PR opened");
}

// Stranded draft-PR retry sweep (#722's investigation, task 213765) — a
// "reviewing" task with no PR only ever gets ONE draft-open attempt today,
// made inline at the "-> reviewing" transition (maybeOpenDraftPR above, both
// call sites below). If that attempt fails — the tree was still dirty right
// after the worker's last turn, the host was briefly unreachable, the push
// itself failed transiently — nothing ever retries it: the main sweep below
// only selects "claimed"/"in_progress" rows, and processReviewingTasks is
// joined on the REVIEW session, not the worker, so a "reviewing" task with
// no review agent (task 213765 had none) is invisible to it too. A worker
// that later cleans up its own worktree and ends its turn again, believing
// "Mullion pushes the branch and opens the PR" (task-prompt.ts's own
// framing), has nothing left to trigger that — the transition already fired
// once and never fires again. This sweep is the fix: keep retrying any
// "reviewing" task with no PR until one opens.
//
// Per-task attempt state is process-local (module state, not a DB column) —
// same posture as task-watcher.ts's own parentTitleFetchAttempts: losing
// this on a restart just costs one extra attempt, which is harmless. A DB
// column would need a schema migration for what is, in effect, a rate
// limiter with no durability requirement.
const DRAFT_PR_RETRY_TTL_MS = 5 * 60 * 1000;
// Hermes review, PR #725 — a permanently-stuck reason (remote-not-supported,
// a worktree deleted out from under the task) would otherwise retry every
// 5 minutes forever. Deliberately NOT a give-up cap: a hard cap would mean a
// task that becomes resolvable again after a long time (a host comes back
// after an extended outage, a human finally cleans up a dirty tree) never
// gets picked up again short of a process restart — exactly the "stranded
// forever" failure mode this sweep exists to fix. Doubling the backoff each
// consecutive failed attempt, capped at this ceiling, keeps retrying
// indefinitely while cutting steady-state noise/git-status calls roughly
// 12x for a task that's been stuck a while.
const DRAFT_PR_RETRY_MAX_TTL_MS = 60 * 60 * 1000;
// Global cap for the whole sweep (mirrors task-watcher.ts's own per-tick
// caps, e.g. MAX_DEPENDENCY_CHECKS_PER_SWEEP) — a backstop against a
// pathological install with many simultaneously-stranded "reviewing" tasks
// all hitting the same host's git/GitHub calls in one tick.
const MAX_DRAFT_PR_RETRIES_PER_SWEEP = 20;
// Bounds the attempt-state Map itself; nothing else would. Simple
// oldest-inserted eviction (Map iteration order === insertion order) — this
// map's entries self-expire via the TTL above far faster than 500 distinct
// tasks could realistically accumulate, so eviction policy sophistication
// (see the parentTitleFetchAttempts precedent) isn't worth it here.
const MAX_DRAFT_PR_RETRY_ENTRIES = 500;
const draftPrRetryState = new Map<number, { lastAttemptedAt: number; attempts: number }>();

// `attempts` is stored post-increment (1 after the very first attempt —
// see the `.set()` call below), so the exponent is `attempts - 1`: the
// first wait is exactly DRAFT_PR_RETRY_TTL_MS (2**0), then it doubles from
// there. Independent review, PR #726 — using `attempts` directly here made
// the very first backoff 10 minutes, not the 5 the constant name implies.
function draftPrRetryBackoffMs(attempts: number): number {
  return Math.min(DRAFT_PR_RETRY_TTL_MS * 2 ** (attempts - 1), DRAFT_PR_RETRY_MAX_TTL_MS);
}

// #759 — one entry-point check per sweep, not per task: skip opening the
// pass at all once the install-wide rate-limit budget (github-fetch.ts) is
// known to be in effect, rather than discovering it task-by-task via
// exceptions. githubApiFetch/githubRequest already short-circuit at the
// transport layer regardless (the PRIMARY defense — see that file's own
// doc comment), so this is a belt-and-suspenders "don't even open a pass
// we know will fail immediately" — logged once per sweep, not once per
// task, so a long rate-limit window doesn't spam the log every 30s tick.
function skipSweepIfGitHubRateLimited(app: FastifyInstance, sweepName: string): boolean {
  if (!isGitHubRateLimited()) return false;
  app.log.debug(
    { sweep: sweepName, resumeInMs: githubRateLimitRemainingMs() },
    "task reconcile: skipping sweep — GitHub rate limit is in effect",
  );
  return true;
}

async function retryStrandedDraftPRs(app: FastifyInstance): Promise<void> {
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  // Same gate as the transition itself (Hermes review, PR #480) — a retry
  // is still "real GitHub state," not a passive read.
  if (!resolvedTaskMaster.enabled) return;
  if (skipSweepIfGitHubRateLimited(app, "retryStrandedDraftPRs")) return;

  const rows = app.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.status, "reviewing"), isNull(tasks.prNumber)))
    .all();
  if (rows.length === 0) return;

  // Grouped by host and run concurrently (independent review, PR #725) —
  // same shape as the claimed/in_progress sweep and processReviewingTasks
  // below. Each `maybeOpenDraftPR` call can now legitimately take up to
  // GIT_TIMEOUT_MS (120s, git-push.ts) for a single push; a flat sequential
  // loop over every stranded task regardless of host would let one slow or
  // unreachable host serialize into a multi-minute stall of this sweep,
  // ahead of (and inside the same taskReconcileRunning-guarded tick as) the
  // budget force-fail for unrelated claimed/in_progress tasks on OTHER
  // hosts — the kind of "hard backstop, not a negotiation" that sweep's own
  // doc comment describes.
  const byHost = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byHost.get(row.project.hostId) ?? [];
    group.push(row);
    byHost.set(row.project.hostId, group);
  }

  const now = Date.now();
  // Shared across every host's concurrent loop below on purpose — this is
  // still one sweep-wide cap, not a per-host one. Safe without a lock: JS
  // only interleaves at `await` points, and every check-then-increment
  // below is synchronous, so two host loops can never both pass the check
  // before either increments.
  let attempted = 0;

  await Promise.all(
    [...byHost.values()].map(async (hostRows) => {
      for (const { task, project } of hostRows) {
        if (attempted >= MAX_DRAFT_PR_RETRIES_PER_SWEEP) return;
        // #759 — re-check mid-pass: a rate limit can land on task N of a
        // multi-host, multi-task pass, and the sweep-entry check above only
        // catches a limit already in effect when the tick started.
        if (isGitHubRateLimited()) return;

        const state = draftPrRetryState.get(task.id);
        if (
          state !== undefined &&
          now - state.lastAttemptedAt < draftPrRetryBackoffMs(state.attempts)
        )
          continue;

        attempted++;
        if (
          !draftPrRetryState.has(task.id) &&
          draftPrRetryState.size >= MAX_DRAFT_PR_RETRY_ENTRIES
        ) {
          const oldest = draftPrRetryState.keys().next().value;
          if (oldest !== undefined) draftPrRetryState.delete(oldest);
        }
        draftPrRetryState.set(task.id, {
          lastAttemptedAt: now,
          attempts: (state?.attempts ?? 0) + 1,
        });

        // maybeOpenDraftPR already re-reads the task's current git status
        // and is idempotent/best-effort (it's the exact same call the
        // "-> reviewing" transition makes) — nothing here duplicates that
        // logic. A successful open sets tasks.prNumber, which drops the
        // task out of this sweep's own WHERE clause on the next tick, so
        // there's no need to reset `attempts` back to 0 here on success —
        // it simply never gets read again.
        await maybeOpenDraftPR(app, task, project);
      }
    }),
  );
}

// Merge-on-approve sweep — approving a task on a project with
// projects.mergeOnApprove sets tasks.mergeRequestedAt (routes/tasks.ts's
// approve handler); this sweep is what actually lands the merge. It can't
// happen synchronously inside approve: main's branch protection here is
// `strict: true` (branch must be up to date) plus required checks, and a
// branch that was JUST pushed almost never satisfies either yet. GitHub's
// own native auto-merge doesn't help either — it does not update a behind
// branch under `strict`, and this repo's `allow_auto_merge` is `false`
// regardless — so this sweep does the "record intent, land it once GitHub
// allows" work by hand: read the PR's mergeableState every tick (subject to
// backoff) and act on it.
//
// Per-task attempt state is process-local (module state, not a DB column),
// same posture and same reasoning as draftPrRetryState above — the merge
// *intent* is durable (tasks.mergeRequestedAt), the retry *rate limiter*
// doesn't need to be.
const MERGE_RETRY_TTL_MS = 60 * 1000;
// Tighter ceiling than DRAFT_PR_RETRY_MAX_TTL_MS above — a merge is a cheap
// GitHub API call (no git push involved) and a human is typically watching
// for it to land, unlike a stranded draft-PR retry.
const MERGE_RETRY_MAX_TTL_MS = 30 * 60 * 1000;
const MAX_MERGE_RETRIES_PER_SWEEP = 20;
const MAX_MERGE_RETRY_ENTRIES = 500;
const mergeRetryState = new Map<
  number,
  {
    lastAttemptedAt: number;
    attempts: number;
    // #737 (Hermes review, PR #827) — the head SHA a re-assert APPROVE was
    // last posted for. Without this, a re-assert whose APPROVE succeeds at
    // the GitHub API level but doesn't actually satisfy the branch
    // protection rule (the reviewer App isn't an eligible approver — the
    // CODEOWNERS limitation this feature already documents) never flips
    // `reviewDecision` to `APPROVED`, so the "can't spin" argument's
    // premise fails: every backoff tick would re-post an identical APPROVE
    // on the same commit forever, spam bounded by ticks, not pushes. Only
    // cleared by `clearMergeState`/`resetMergeBackoff`, same lifecycle as
    // the rest of this entry — a human's explicit "Merge now"/"Retry
    // merge" click (which calls `resetMergeBackoff`) deliberately gets a
    // fresh re-assert attempt even on an unchanged head.
    lastReassertedSha?: string;
  }
>();

function mergeRetryBackoffMs(attempts: number): number {
  return Math.min(MERGE_RETRY_TTL_MS * 2 ** (attempts - 1), MERGE_RETRY_MAX_TTL_MS);
}

/**
 * Re-arms a task's merge backoff so the next reconcile tick attempts it
 * immediately instead of waiting out whatever backoff interval it was on.
 * Called by `POST /api/tasks/:id/merge` (a human's "Merge now"/"Retry merge"
 * click) — without this, a click during a long backoff window would appear
 * to do nothing until the window elapsed on its own.
 */
export function resetMergeBackoff(taskId: number): void {
  mergeRetryState.delete(taskId);
}

function clearMergeState(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): void {
  app.db
    .update(tasks)
    .set({ mergeRequestedAt: null, mergeError: null, rebaseStartedAt: null })
    .where(eq(tasks.id, task.id))
    .run();
  // Hermes review, PR #763 — without this, a resolved task's backoff entry
  // lingers in mergeRetryState until MAX_MERGE_RETRY_ENTRIES forces an
  // oldest-insertion eviction, which can evict an ACTIVELY retrying task's
  // entry instead of a resolved one, silently resetting its backoff/attempt
  // count. Deleting here (unlike draftPrRetryState's own "never gets read
  // again" reasoning, which relies on the row dropping out of that sweep's
  // WHERE clause) closes that gap directly.
  mergeRetryState.delete(task.id);
  // #758, fresh-review fix — a task that went through attemptAutoRebase has
  // a REAL worktree/session again (worktreePath/sessionId overwritten from
  // their post-approve null), which nothing else ever cleans up once the
  // conflict resolves and this merges: the task never leaves `done`, so
  // approveTask's own cleanupTaskWorktree/cleanupTaskSessions calls (which
  // only ever fire on a "-> done" transition) never fire again for it. Safe
  // to call unconditionally on the (far more common) task that never
  // auto-rebased too — NOT because worktreePath/sessionId are null there
  // (approveTask never nulls either column; they're stale pointers to
  // already-removed/killed resources), but because both calls are
  // independently idempotent on stale-but-non-null values:
  // removeWorktreeIfClean returns "not-a-repo" on an already-gone
  // directory, and killSession is a safe no-op on an already-"killed"
  // session.
  cleanupTaskWorktree(app, task, project);
  cleanupTaskSessions(app, task);
}

function recordMergeError(app: FastifyInstance, taskId: number, message: string): void {
  app.db.update(tasks).set({ mergeError: message }).where(eq(tasks.id, taskId)).run();
}

// #758 — bounds how many times attemptAutoRebase spawns a worker for the
// SAME task across its whole lifecycle. A separate counter/cap from
// autoReturnRounds/maxAutoReturnRounds on purpose: this task is `done` and
// never transitions (see schema.ts's rebaseAttempts doc comment), so
// autoReturnTask's CAS-on-"reviewing" mechanism doesn't apply — only the
// same shape (bounded, give-up once spent) does. No per-project override, to
// keep this PR's scope to the reconciler; add one later if it turns out to
// matter in practice.
const MAX_REBASE_ATTEMPTS = 2;

// How long a spawned auto-rebase worker gets before its attempt is treated
// as abandoned and eligible for a retry. NOT session-exited detection — see
// schema.ts's rebaseStartedAt doc comment for why session status can't
// answer "is an attempt still in flight" here. Same 30-minute scale as
// REVIEW_FINDINGS_GRACE_MS below: a rebase-and-reverify round is comparable
// in scope to a review-fix round. Exported so task-watcher.ts's boot-time
// orphan sweep can use the SAME window to decide a `done` task's rebase
// worktree is still active — see that file's own use of this constant.
export const REBASE_ATTEMPT_STALE_MS = 30 * 60_000;

/**
 * Spawns a worker to resolve a real merge conflict (`dirty` mergeableState)
 * found on a `done` task's PR — attemptMerge's own `case "dirty"` calls this
 * instead of only recording the error. Never transitions the task's status:
 * it stays `done` throughout (no outgoing edge exists — task-state.ts), so
 * this is a sibling to the merge sweep's retry loop, not a use of
 * autoReturnTask.
 *
 * Gated on `project.autoApprove`, the same "nobody is watching" opt-in
 * `attemptAutoApprove`/`attemptReturnRedCiToWorker` use — spawning an
 * unattended worker against a task nobody asked to be re-touched is exactly
 * the kind of action that opt-in exists to gate.
 */
async function attemptAutoRebase(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  baseRef: string,
): Promise<void> {
  if (!project.autoApprove) {
    recordMergeError(app, task.id, "Conflicts with main — needs manual resolution");
    return;
  }

  const now = Date.now();
  const backend = resolveBackend(app, project.hostId);

  if (task.rebaseStartedAt !== null) {
    const withinWindow = now - task.rebaseStartedAt.getTime() < REBASE_ATTEMPT_STALE_MS;
    if (withinWindow) {
      // Still within its window — wait for it rather than spawning a second
      // worker into the same worktree concurrently. Deliberately checked
      // BEFORE the attempts cap below: if this is the last allowed attempt
      // and it's still in flight, it should be allowed to finish, not be
      // reported as "gave up" while it may yet succeed.
      recordMergeError(app, task.id, "Conflicts with main — an auto-rebase attempt is in progress");
      return;
    }
  }

  // Second review, PR #783 — checked before the stale-attempt termination
  // below, not after: terminating a possibly-still-working session only to
  // then immediately give up and never retry into a fresh one would be a
  // pointless, irreversible kill. A task already at the cap gets no more
  // attempts either way, so there's nothing to protect by keeping a stale
  // attempt's session alive past this point.
  if (task.rebaseAttempts >= MAX_REBASE_ATTEMPTS) {
    recordMergeError(
      app,
      task.id,
      `Conflicts with main — auto-rebase gave up after ${MAX_REBASE_ATTEMPTS} attempt(s), needs manual resolution`,
    );
    return;
  }

  if (task.rebaseStartedAt !== null && task.sessionId !== null) {
    // Reaching here means rebaseStartedAt is past its window (the withinWindow
    // check above already returned otherwise) and a retry is going to happen
    // (the cap check above already returned otherwise) — so the previous
    // attempt is genuinely being superseded, and its session needs
    // terminating before its worktree is touched. "Past the window" is a
    // TIME check, not a liveness check (see REBASE_ATTEMPT_STALE_MS's own
    // doc comment on why session-exit can't answer "still working" here) — a
    // rebase-and-reverify round genuinely can run long on a large repo
    // without being stuck. Force-removing the worktree below while that
    // session is still actually alive would yank the directory out from
    // under a running process, not just leak one. Terminate it first if it's
    // still active, same posture as reseedTaskIfSessionExited's own
    // `force: true` path: confirm the kill succeeded before doing anything
    // destructive to its worktree, and don't proceed at all if the
    // terminate itself fails.
    const [session] = app.db.select().from(sessions).where(eq(sessions.id, task.sessionId)).all();
    if (session?.status === "active") {
      try {
        await backend.terminate(String(task.sessionId));
        app.db
          .update(sessions)
          .set({ status: "killed" })
          .where(eq(sessions.id, task.sessionId))
          .run();
        closeSessionBrowserBindings(app, task.sessionId);
      } catch (err) {
        app.log.warn(
          { err, taskId: task.id, sessionId: task.sessionId },
          "task auto-rebase: a stale attempt's session is still active and could not be terminated, leaving it for a later tick",
        );
        recordMergeError(
          app,
          task.id,
          "Conflicts with main — a previous auto-rebase attempt appears stuck and could not be stopped, needs manual resolution",
        );
        return;
      }
    }
  }

  // task.branchName should always be set by this point (retryTask's own
  // reservation transaction refuses a null branchName before a task can
  // even reach "done"), but fall back the same way task-claim.ts's resume
  // path does rather than crash on an unexpected null.
  const branchName = task.branchName ?? deriveTaskBranchName(task);
  if (!task.agentCommand || !commandSupportsSeed(task.agentCommand)) {
    recordMergeError(
      app,
      task.id,
      "Conflicts with main — no seed-capable agent recorded for this task, needs manual resolution",
    );
    return;
  }

  // Clear any leftover worktree from a prior attempt first. resumeTaskWorktree
  // targets a deterministic path (deriveWorktreePath), so a second attempt at
  // the same path fails outright unless the first attempt's worktree is gone.
  // Unconditional force-remove, not removeWorktreeIfClean: the worker's own
  // preamble tells it to commit and leave the tree clean, so anything left
  // behind on an already-superseded attempt is a contract violation, not
  // work worth the careful preservation removeWorktreeIfClean exists for.
  const stalePath = deriveWorktreePath(project.cwd, branchName);
  await backend.removeWorktree(stalePath, project.cwd).catch((err) => {
    app.log.warn(
      { err, taskId: task.id, stalePath },
      "task auto-rebase: failed to clear a stale worktree before retrying",
    );
  });

  const worktree = await backend.resumeTaskWorktree(project.cwd, branchName);
  if (!worktree) {
    // Branch missing or checked out elsewhere — not retryable by spawning
    // again. Surface for a human rather than looping (mirrors the plan's
    // "returns null -> surface for a human, not a retry").
    recordMergeError(
      app,
      task.id,
      `Conflicts with main — could not recreate the worktree for ${branchName} (branch missing or checked out elsewhere), needs manual resolution`,
    );
    return;
  }

  const taskMasterConfig = resolveTaskMasterConfig(app);
  // #778 — resolved against the OWNING host's own sessionsDir; see
  // spawnReviewAgentNow's own comment above for the full rationale.
  const commitTitlePath = project.conventionalCommitTitles
    ? taskCommitTitlePath(
        await resolveSessionsDirWithFallback(app, backend, {
          taskId: task.id,
          hostId: project.hostId,
        }),
        task.id,
      )
    : undefined;
  const seedCapable = commandSupportsSeed(task.agentCommand);
  const prompt = buildRebasePrompt({
    task,
    branchName: worktree.branch,
    worktreePath: worktree.path,
    budgetMinutes: taskMasterConfig.budgetMinutes,
    auto: true,
    commitTitlePath,
    baseRef,
  });
  const result = await createSessionRecord(app, {
    projectId: project.id,
    command: task.agentCommand,
    cwd: worktree.path,
    initialPrompt: seedCapable ? prompt : undefined,
    skipPermissions: taskMasterConfig.skipPermissions,
    // #9 — a rebase worker is still task #N's worker, just spawned via a
    // different path (attemptAutoRebase, #758) than the claim/retry spawns
    // — same naming/locking, same reasoning (see task-claim.ts's own
    // worker-spawn comment).
    name: `Task #${task.id} · worker`,
    nameLocked: true,
    // Same "this is an unattended Task Master worker" marker as the
    // claim/retry spawns (see task-claim.ts's own worker-spawn comments).
    // The auto-rebase worker is just as exposed to the brainstorming-skill
    // failure mode as any other Task Master worker.
    taskId: task.id,
  });
  if (!result.ok) {
    recordMergeError(
      app,
      task.id,
      `Conflicts with main — failed to spawn an auto-rebase worker (${result.reason}), needs manual resolution`,
    );
    return;
  }
  const seedDelivered = resolveSeedDelivered(
    seedCapable,
    project.hostId,
    result.initialPromptApplied,
  );

  // CAS on status = "done" — the one guard against a concurrent transition
  // (nothing legitimately moves a done task elsewhere today, but this stays
  // consistent with every other write in this file's own paranoia about
  // races rather than assuming that never changes).
  const updated = app.db
    .update(tasks)
    .set({
      sessionId: result.row.id,
      worktreePath: worktree.path,
      branchName: worktree.branch,
      seedDelivered,
      rebaseAttempts: task.rebaseAttempts + 1,
      rebaseStartedAt: new Date(now),
      mergeError: "Conflicts with main — an auto-rebase attempt is in progress",
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "done")))
    .run();
  if (updated.changes === 0) {
    app.log.warn(
      { taskId: task.id, newSessionId: result.row.id },
      "task auto-rebase: lost a race with a concurrent transition — the freshly spawned session is orphaned, left for a human to notice",
    );
    return;
  }

  app.log.info(
    { taskId: task.id, sessionId: result.row.id, attempt: task.rebaseAttempts + 1 },
    "task auto-rebase: spawned a worker to resolve a merge conflict",
  );
}

async function attemptMerge(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<void> {
  if (task.prNumber === null) return; // WHERE below already guarantees this; narrows the type.

  // Resolve repoRef/token from `project` alone, never from
  // `task.worktreePath` — cleanupTaskWorktree already ran at approve
  // (routes/tasks.ts), so the worktree is gone by the time this sweep fires.
  // Same posture as closeDraftPRForTask (task-promote.ts): a pure GitHub API
  // write with no filesystem/git dependency on the task's host at all.
  // Reaching for worktreePath here would fail every merge forever with an
  // unfixable no-repo/no-token — exactly the stranding shape this codebase
  // keeps getting bitten by (see REVIEW_FINDINGS_GRACE_MS's own history).
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return;
  const token = await resolveGitHubToken(app, repoRef);
  if (!token) return;

  try {
    const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
    const readiness = classifyMergeReadiness(pr);

    switch (readiness) {
      case "already-done": {
        // Merged or closed out of band (a human merged it directly on
        // GitHub, or closed it) — idempotent no-op, not an error.
        clearMergeState(app, task, project);
        return;
      }
      case "clean": {
        await mergePullRequest(token, repoRef.owner, repoRef.repo, task.prNumber, {
          sha: pr.headSha,
          commitTitle: pr.title,
        });
        // Best-effort: a failure here must not undo the merge that just
        // succeeded, nor re-arm the sweep to retry a merge that's already
        // done. delete_branch_on_merge is false on this repo, so without
        // this the branch is left behind forever.
        try {
          await deleteRemoteBranch(token, repoRef.owner, repoRef.repo, pr.headRef);
        } catch (err) {
          app.log.warn(
            { err, taskId: task.id, branch: pr.headRef },
            "task reconcile: merged the PR but failed to delete its remote branch",
          );
        }
        // #744 — arm autorelease HERE ONLY, after the merge call above has
        // actually succeeded. Deliberately not inside clearMergeState below:
        // that helper is also reached from case "already-done", which covers
        // a PR CLOSED without merging (classifyMergeReadiness collapses
        // `pr.merged || pr.state === "closed"` into one state) — arming
        // there would tag a release for code that never landed.
        if (project.autoTagRelease) {
          app.db
            .update(tasks)
            .set({ releaseRequestedAt: new Date() })
            .where(eq(tasks.id, task.id))
            .run();
        }
        clearMergeState(app, task, project);
        return;
      }
      case "behind": {
        // Update the branch, then wait for the NEXT tick rather than
        // attempting the merge in this same pass — checks must re-run
        // against the new head first. Can ping-pong if main moves faster
        // than CI resolves; the backoff above bounds how often this repeats.
        await updatePullRequestBranch(
          token,
          repoRef.owner,
          repoRef.repo,
          task.prNumber,
          pr.headSha,
        );
        recordMergeError(app, task.id, "Branch was behind main — requested an update, retrying");
        return;
      }
      case "unstable": {
        // A NON-required check is failing or still running — e.g. this
        // repo's own test-e2e/codecov/patch, deliberately not required (see
        // CLAUDE.md). Merging on "unstable" would silently skip whatever
        // that check was verifying; a human clicking Squash-and-merge at
        // least sees the red X. Back off and retry: a pending non-required
        // check resolves into "clean" on its own, and a genuinely failing
        // one stays "unstable" forever, which is the correct outcome —
        // "Merge now" is the escape hatch for deciding to override it.
        // Counter-risk, stated deliberately: a non-required check that never
        // reports at all leaves this PR never auto-merging.
        recordMergeError(app, task.id, "A non-required check is failing or still running");
        return;
      }
      case "dirty": {
        // A real merge conflict with main. Never resolves on its own —
        // attemptAutoRebase spawns a worker to resolve it (bounded,
        // opt-in via project.autoApprove); falls back to today's plain
        // backoff-and-record-error behavior when that's off, exhausted, or
        // not applicable.
        await attemptAutoRebase(app, task, project, pr.baseRef);
        return;
      }
      case "blocked": {
        // #737 — `mergeable_state: "blocked"` collapses several distinct
        // reasons GitHub won't merge into one state: a required CHECK red
        // or pending, or a required APPROVING REVIEW missing/dismissed.
        // Before this, every "blocked" PR got the same "Required checks
        // are red or still pending" message even when the real cause was a
        // missing review — actively misleading once a repo's branch
        // protection also requires an approval. `reviewDecision` is
        // GitHub's own aggregate verdict across all reviews on the PR
        // (`null` when the repo has no review requirement configured at
        // all, in which case a required CHECK is the only thing "blocked"
        // could mean here).
        const reviewDecision = await getPullRequestReviewDecision(
          token,
          repoRef.owner,
          repoRef.repo,
          task.prNumber,
        ).catch((err) => {
          app.log.warn(
            { err, taskId: task.id, prNumber: task.prNumber },
            "task reconcile: failed to read the PR's review decision — falling back to the generic 'blocked' message",
          );
          return null;
        });

        // #737 — re-assert an approval a later Mullion-initiated push may
        // have dismissed. Deliberately `"REVIEW_REQUIRED"` ONLY, not
        // `"CHANGES_REQUESTED"` too (Hermes review, PR #827): a `done` task
        // only ever got there via the bot's own clean-gate or a human
        // clicking Approve, so a `CHANGES_REQUESTED` decision at THIS point
        // can only be a review posted AFTER that — either a human on
        // GitHub, or a later review-agent round the reviewer identity
        // itself posted. Re-asserting APPROVE over that would silently
        // override an explicit rejection, exactly the "manufacture an
        // approval nobody made" failure mode this mechanism must never
        // become, just with the rejection arriving after approval instead
        // of before it. `REVIEW_REQUIRED` has no such ambiguity — it means
        // "no active review objects, but the required-approval count isn't
        // met," which is what a push-dismissed approval (and nothing else
        // reachable from this arm) produces.
        //
        // `attemptMerge` only ever runs for `status: "done"` tasks
        // (processMergeRequests' own candidate query, above) — reaching
        // "done" already means a human clicked Approve or auto-approve's
        // own `lastReviewVerdict === "clean"` gate fired, so `task.status
        // === "done"` is trivially true on every call here today. Kept as
        // an explicit condition anyway (not just a comment) as a guard
        // against a future refactor calling this function from a context
        // where that's no longer guaranteed.
        //
        // Why this usually can't spin: a successful re-assert flips
        // `reviewDecision` to `"APPROVED"` and the condition below closes
        // immediately. It only reopens when something DISMISSES that
        // approval, which is always a push (`"behind"`'s
        // `updatePullRequestBranch` above, or an auto-rebase worker's
        // commits) — so the number of re-asserts this can ever produce is
        // bounded by the number of pushes to the head branch, not by how
        // many sweep ticks pass while blocked, PROVIDED the re-assert
        // actually counts. Hermes review, PR #827 (round 2): that proviso
        // can fail — the reviewer App's `APPROVE` can succeed at the GitHub
        // API level without satisfying the branch protection rule at all
        // (the App isn't an eligible approver — the CODEOWNERS limitation
        // this feature already documents), in which case `reviewDecision`
        // NEVER flips to `"APPROVED"` and the argument above breaks: every
        // backoff tick would re-post an identical `APPROVE` on the same
        // commit forever, spam bounded by ticks, not pushes. Guarded here
        // by memoizing the head SHA a re-assert was last attempted for
        // (`mergeRetryState`, shared with the rest of this task's merge
        // backoff — same lifecycle, cleared by `clearMergeState`/
        // `resetMergeBackoff`) and only trying again once `pr.headSha`
        // actually changes — restoring "bounded by pushes" as a guarantee
        // rather than an assumption, regardless of whether any given
        // re-assert counts. (A persistent failure to re-assert — e.g. a
        // reviewer App that always 422s — still only retries at
        // `processMergeRequests`' own per-task backoff cadence, same as
        // every other `attemptMerge` call, not on every tick — that part
        // of the throttling was never the issue.)
        const retryState = mergeRetryState.get(task.id);
        if (
          reviewDecision === "REVIEW_REQUIRED" &&
          task.status === "done" &&
          retryState?.lastReassertedSha !== pr.headSha
        ) {
          const reviewerToken = await resolveReviewerToken(app, repoRef);
          if (reviewerToken) {
            try {
              await createPullRequestReview(
                reviewerToken,
                repoRef.owner,
                repoRef.repo,
                task.prNumber,
                {
                  body: "Re-affirming approval: this task's clean review was already approved in Mullion; re-asserting it after a required branch update.",
                  commitId: pr.headSha,
                  event: "APPROVE",
                },
              );
              // Record the SHA regardless of whether this ends up
              // satisfying branch protection — that's precisely the case
              // this memoization exists to stop from retrying forever.
              mergeRetryState.set(task.id, {
                lastAttemptedAt: retryState?.lastAttemptedAt ?? Date.now(),
                attempts: retryState?.attempts ?? 1,
                lastReassertedSha: pr.headSha,
              });
              // Don't record an error — the next sweep tick re-reads
              // GitHub's fresh mergeable_state instead of retrying a merge
              // this tick already knows is still blocked on stale data.
              return;
            } catch (err) {
              app.log.warn(
                { err, taskId: task.id, prNumber: task.prNumber },
                "task reconcile: failed to re-assert the reviewer App's approval",
              );
            }
          }
        }

        // D3 — `reviewDecision` (a repo-wide required-approval verdict) has
        // no opinion on conversation resolution, a SEPARATE, per-thread
        // branch-protection rule (this repo's own `main` has both enabled).
        // Before this, a `blocked` PR with no required-approval rule but an
        // unresolved thread got the same generic "Required checks" message
        // even with CI green — actively wrong, and exactly what made D1's
        // deadlock invisible in the logs. Checked whenever `reviewDecision`
        // ISN'T already a more specific, correct explanation on its own —
        // that's `CHANGES_REQUESTED`/`REVIEW_REQUIRED`, but NOT `APPROVED`:
        // independent review, round 3 — a repo requiring both an approval
        // AND conversation resolution can be `blocked` with the approval
        // requirement already satisfied (`reviewDecision: "APPROVED"`)
        // while a stale conversation is the sole remaining cause; treating
        // `APPROVED` as "already explained" would leave exactly that
        // combination on the old generic message forever.
        //
        // Reading branch protection's own `required_conversation_resolution`
        // flag directly isn't an option here — that endpoint needs the
        // `administration` scope, which neither WRITE_PERMISSIONS nor
        // READ_PERMISSIONS grants (github.ts's own fetchRequiredStatusContexts
        // documents the identical gap for required_status_checks) — so this
        // derives the cause from OBSERVED unresolved threads instead, which
        // is more precise anyway: it answers "is THIS PR actually blocked on
        // a conversation," not "does the branch require one."
        let message =
          reviewDecision === "CHANGES_REQUESTED"
            ? "Changes were requested on the PR"
            : reviewDecision === "REVIEW_REQUIRED"
              ? "Waiting on a required approving review"
              : "Required checks are red or still pending";
        if (reviewDecision === null || reviewDecision === "APPROVED") {
          // Self-heals the D1 deadlock — but ONLY when this row's own last
          // ingested verdict is "clean". Independent review, round 2: an
          // earlier version of this call fired unconditionally on the
          // (false) assumption that a `done` task's verdict can never be
          // "changes-requested." It can: `POST .../approve`
          // (task-approve.ts) and the closed-issue sync path
          // (syncClosedIssueToLocal, task-github-sync.ts) both flip
          // "reviewing" straight to "done" on `canTransition` alone, never
          // consulting `lastReviewVerdict` — a human (or a closed issue)
          // can promote a task whose last review genuinely requested
          // changes. Resolving Mullion's own threads in THAT case would
          // satisfy `required_conversation_resolution` with zero
          // corroboration a finding was ever addressed, defeating the
          // entire point of the gate. Checking the column here is what
          // keeps this call as safe as its sibling in
          // processReviewingTasks, which reads the SAME column at the
          // point of ingestion rather than re-deriving a "must be clean by
          // now" assumption.
          //
          // Reuses the self-heal's own fetch for the diagnostic below
          // (independent review, round 3) rather than fetching twice in
          // the same tick — `null` means either self-heal didn't run
          // (verdict isn't "clean") or it hit its own early-return
          // (fetch failure/truncation), either way falling through to a
          // fresh fetch just for the count.
          const selfHealResult =
            task.lastReviewVerdict === "clean"
              ? await resolveMullionOwnThreadsIfClean(app, task, project)
              : null;
          try {
            const threadsResult =
              selfHealResult ??
              (await fetchPullRequestReviewThreads(
                token,
                repoRef.owner,
                repoRef.repo,
                task.prNumber,
              ));
            if (threadsResult.truncated) {
              message = "Blocked on the PR, but its review threads couldn't be fully enumerated";
            } else {
              const unresolvedCount = threadsResult.threads.filter((t) => !t.isResolved).length;
              if (unresolvedCount > 0) {
                message = `Blocked on ${unresolvedCount} unresolved review conversation${unresolvedCount === 1 ? "" : "s"}`;
              }
            }
          } catch (err) {
            app.log.warn(
              { err, taskId: task.id, prNumber: task.prNumber },
              "task reconcile: failed to check for unresolved review conversations — falling back to the generic 'blocked' message",
            );
          }
        }
        recordMergeError(app, task.id, message);
        return;
      }
      case "computing": {
        // "unknown" (pr.mergeable === null — GitHub is still computing
        // mergeability after a push) or any future state GitHub adds. Wait
        // and retry, no error recorded.
        return;
      }
    }
    // Never give up on any of the above, no matter how long: a conflict
    // becomes resolvable the moment someone rebases, checks can go green on
    // a rerun — a give-up cap would recreate exactly the "stranded forever"
    // failure mode DRAFT_PR_RETRY_MAX_TTL_MS's own comment above exists to
    // prevent. Indefinite retry at a ceiling-bounded interval is this
    // sweep's whole posture.
  } catch (err) {
    // Covers a merge/update-branch call itself failing — including a 405
    // ("not mergeable") or 409 (head-SHA moved) racing this same read, both
    // ordinary expected outcomes here, not alarms; err.message already
    // carries the HTTP status (see githubRequest's own error formatting).
    const detail = err instanceof Error ? err.message : String(err);
    recordMergeError(app, task.id, `Merge attempt failed: ${detail}`);
  }
}

async function processMergeRequests(app: FastifyInstance): Promise<void> {
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  // Same gate as the transition itself — a merge is real GitHub state, not
  // a passive read.
  if (!resolvedTaskMaster.enabled) return;
  if (skipSweepIfGitHubRateLimited(app, "processMergeRequests")) return;

  const rows = app.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(isNotNull(tasks.mergeRequestedAt), isNotNull(tasks.prNumber), eq(tasks.status, "done")),
    )
    .all();
  if (rows.length === 0) return;

  const now = Date.now();
  let attempted = 0;

  // Deliberately NOT grouped/concurrent by host the way retryStrandedDraftPRs
  // is above. That grouping exists because openDraftPRForTask does a real
  // git push with up to GIT_TIMEOUT_MS (120s); this sweep only ever makes
  // GitHub API calls with a 5s timeout (REQUEST_TIMEOUT_MS, github-write.ts),
  // so there's no slow-host stall here worth isolating a flat sequential
  // loop from.
  for (const { task, project } of rows) {
    if (attempted >= MAX_MERGE_RETRIES_PER_SWEEP) return;
    if (isGitHubRateLimited()) return; // #759 — see the draft-PR sweep's own comment

    const state = mergeRetryState.get(task.id);
    if (state !== undefined && now - state.lastAttemptedAt < mergeRetryBackoffMs(state.attempts))
      continue;

    attempted++;
    if (!mergeRetryState.has(task.id) && mergeRetryState.size >= MAX_MERGE_RETRY_ENTRIES) {
      const oldest = mergeRetryState.keys().next().value;
      if (oldest !== undefined) mergeRetryState.delete(oldest);
    }
    // Hermes review, PR #827 (round 3): MUST spread `state` here — this
    // write ran unconditionally, without preserving `lastReassertedSha`,
    // immediately before every `attemptMerge` call. That silently wiped the
    // re-assert memoization on the very next tick regardless of what
    // `attemptMerge` itself had just recorded, making the round-2 fix a
    // complete no-op: the exact "re-post an identical APPROVE every tick
    // forever" spin it was written to prevent.
    mergeRetryState.set(task.id, {
      ...state,
      lastAttemptedAt: now,
      attempts: (state?.attempts ?? 0) + 1,
    });

    await attemptMerge(app, task, project);
  }
}

// Autorelease sweep (#744's automatic half) — a per-project
// projects.autoTagRelease setting has this sweep merge the repo's own open
// release-please PR once every task armed since the last release has been
// quiet for RELEASE_QUIET_MS, closing the last manual step of the loop: task
// PR merges (attemptMerge's own case "clean" above arms
// tasks.releaseRequestedAt) -> release-please's `on: push` regenerates the
// release PR -> this sweep merges it (resolveReleaseMerge,
// services/release-merge.ts — the same decision logic
// POST .../release/merge uses).
//
// Intent is armed per-task, but this sweep groups by project and acts once
// per project per tick — a burst of N task merges coalesces into ONE release
// PR merge attempt, not N. The quiet window is what makes that safe without a
// "was the release PR regenerated after the newest task landed" check of its
// own: it has to outlast both release-please's own run (well under a minute,
// measured on this repo) and GitHub's async mergeable_state recompute after
// the regenerating push (seconds) by a wide margin.
//
// Deliberately does NOT gate on "no task on this project has
// mergeRequestedAt set" — attemptMerge never clears that column for a task PR
// stuck on dirty/blocked/unstable (see its own comment: never give up), so a
// single permanently-conflicted task PR would silently block autorelease on
// that project forever if this waited for it to clear first.
const RELEASE_QUIET_MS = 10 * 60 * 1000;
const RELEASE_RETRY_TTL_MS = 60 * 1000;
const RELEASE_RETRY_MAX_TTL_MS = 30 * 60 * 1000;
const MAX_RELEASE_ATTEMPTS_PER_SWEEP = 20;
const MAX_RELEASE_RETRY_ENTRIES = 500;
const releaseRetryState = new Map<number, { lastAttemptedAt: number; attempts: number }>();

function releaseRetryBackoffMs(attempts: number): number {
  return Math.min(RELEASE_RETRY_TTL_MS * 2 ** (attempts - 1), RELEASE_RETRY_MAX_TTL_MS);
}

function recordReleaseError(app: FastifyInstance, taskIds: number[], message: string): void {
  app.db.update(tasks).set({ releaseError: message }).where(inArray(tasks.id, taskIds)).run();
}

function releaseMergeErrorMessage(result: ReleaseMergeResult): string {
  switch (result.reason) {
    case "no-release-pr":
      return "No open release-please PR yet — waiting for it to be generated";
    case "draft":
      return "Release PR is a draft — mark it ready for review";
    case "computing":
      return "GitHub is still computing the release PR's mergeability";
    case "behind":
      return "Release PR is behind main — waiting for release-please to regenerate it";
    case "blocked":
      return "Required checks on the release PR are red or still pending";
    case "unstable":
      return "A non-required check on the release PR is failing or still running";
    case "dirty":
      return "Release PR has a merge conflict with main";
    case "merge-failed":
    default:
      return result.detail ?? "Release PR merge failed";
  }
}

async function attemptRelease(
  app: FastifyInstance,
  project: typeof projects.$inferSelect,
  taskIds: number[],
): Promise<void> {
  // Hermes review, PR #818 — unlike attemptMerge's own repoRef/token
  // resolution above (which silently no-ops on either failure), these two
  // record a releaseError: every OTHER branch in this function does, and a
  // project whose repo ref/token happens to be momentarily unavailable
  // would otherwise leave every armed task showing "Release pending"
  // forever, indistinguishable from a release that's genuinely still
  // waiting on its quiet window or on GitHub.
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) {
    recordReleaseError(app, taskIds, "Could not resolve this project's GitHub repo");
    return;
  }
  const token = await resolveGitHubToken(app, repoRef, "read");
  if (!token) {
    recordReleaseError(app, taskIds, "No GitHub token available for this project");
    return;
  }

  // Distinguish "genuinely not configured" (give up, clear the intent —
  // retrying forever against a misconfigured toggle is pointless noise) from
  // every other detection outcome, which self-heals or is worth retrying (a
  // scope problem may get fixed; a transient failure resolves on its own) —
  // same split detectReleaseWorkflow's own doc comment describes.
  let detection;
  try {
    detection = await detectReleaseWorkflow(token, repoRef.owner, repoRef.repo);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordReleaseError(app, taskIds, `Release workflow detection failed: ${detail}`);
    return;
  }
  if (detection.kind === "not-configured") {
    // Give up (unlike every other branch here, which retries indefinitely):
    // clear the durable intent AND the backoff entry (same as
    // clearReleaseState), but — UNLIKE clearReleaseState — leave a message
    // behind rather than nulling releaseError too, so the human sees WHY
    // autorelease stopped instead of the row just silently going quiet.
    app.db
      .update(tasks)
      .set({
        releaseRequestedAt: null,
        releaseError:
          "Project has no release-please workflow — turn off Auto-tag release, or add one",
      })
      .where(inArray(tasks.id, taskIds))
      .run();
    releaseRetryState.delete(project.id);
    return;
  }
  if (detection.kind === "no-actions-scope") {
    recordReleaseError(app, taskIds, "GitHub token can't list Actions workflows");
    return;
  }

  // resolveReleaseMerge itself clears tasks.releaseRequestedAt/releaseError
  // for every task on this project on a `merged: true` outcome (see its own
  // doc comment) — the same call the manual Merge route makes, so the DB
  // side of "release shipped" only happens in one place regardless of which
  // caller triggered it. Only the in-memory backoff entry is this sweep's
  // own to clear.
  const result = await resolveReleaseMerge(app, repoRef, token, project.id);
  if (result.merged) {
    releaseRetryState.delete(project.id);
    return;
  }
  recordReleaseError(app, taskIds, releaseMergeErrorMessage(result));
}

async function processReleaseRequests(app: FastifyInstance): Promise<void> {
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  // Same gate as processMergeRequests above — a release merge is real GitHub
  // state, not a passive read.
  if (!resolvedTaskMaster.enabled) return;
  if (skipSweepIfGitHubRateLimited(app, "processReleaseRequests")) return;

  const rows = app.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(isNotNull(tasks.releaseRequestedAt), eq(projects.autoTagRelease, true)))
    .all();
  if (rows.length === 0) return;

  // Group by project — the coalescing: N tasks armed on the same project
  // become ONE attemptRelease call per tick, not N.
  const byProject = new Map<
    number,
    { project: typeof projects.$inferSelect; taskIds: number[]; maxRequestedAt: number }
  >();
  for (const { task, project } of rows) {
    const requestedAt = task.releaseRequestedAt?.getTime() ?? 0;
    const existing = byProject.get(project.id);
    if (existing) {
      existing.taskIds.push(task.id);
      existing.maxRequestedAt = Math.max(existing.maxRequestedAt, requestedAt);
    } else {
      byProject.set(project.id, { project, taskIds: [task.id], maxRequestedAt: requestedAt });
    }
  }

  const now = Date.now();
  let attempted = 0;

  for (const { project, taskIds, maxRequestedAt } of byProject.values()) {
    if (attempted >= MAX_RELEASE_ATTEMPTS_PER_SWEEP) return;
    if (isGitHubRateLimited()) return; // #759 — see the draft-PR sweep's own comment

    // Quiet gate: wait until no task on this project has landed for
    // RELEASE_QUIET_MS since the MOST RECENT one — a fresh landing resets the
    // window, so a steady trickle of merges never fires until it stops.
    if (now - maxRequestedAt < RELEASE_QUIET_MS) continue;

    const state = releaseRetryState.get(project.id);
    if (state !== undefined && now - state.lastAttemptedAt < releaseRetryBackoffMs(state.attempts))
      continue;

    attempted++;
    if (!releaseRetryState.has(project.id) && releaseRetryState.size >= MAX_RELEASE_RETRY_ENTRIES) {
      const oldest = releaseRetryState.keys().next().value;
      if (oldest !== undefined) releaseRetryState.delete(oldest);
    }
    releaseRetryState.set(project.id, {
      lastAttemptedAt: now,
      attempts: (state?.attempts ?? 0) + 1,
    });

    await attemptRelease(app, project, taskIds);
  }
}

// Auto-approve sweep — a per-project projects.autoApprove setting has a
// "reviewing" task approve itself, no human click, once ALL of these hold:
//   1. Task Master is enabled.
//   2. The task's CURRENT review round has actually been ingested
//      (reviewFindingsIngestedSessionId === reviewSessionId — the latest
//      round's verdict, never a stale one from an earlier round).
//   3. That round's verdict (tasks.lastReviewVerdict, written alongside
//      ingestion in processReviewingTasks above) is "clean".
//   4. CI on the PR head reads an explicit "success".
//   5. The task is still "reviewing" at the moment of the write — enforced
//      by approveTask's own CAS, not checked here; a human racing the
//      sweep simply wins.
// Anything else — no review agent configured (never ingests a verdict at
// all), "changes-requested", "inconclusive", CI red/still running/absent —
// leaves the task in "reviewing" for a human, exactly today's behavior...
// EXCEPT one case #755 now closes: a red REQUIRED check (per
// `fetchRequiredStatusContexts`, github.ts) returns the task to the worker
// automatically, same as a "changes-requested" review round — even for a
// project with no review agent configured at all (gate 2 would otherwise
// never pass for those) and even when the verdict is "inconclusive" (gate 3
// would otherwise never pass). See `attemptReturnRedCiToWorker`'s own doc
// comment for why that check runs BEFORE gates 2/3, not folded into gate 4.
//
// Gate 4 deliberately has NO deadline, unlike resolveReviewCi's own
// wait-then-proceed-anyway posture for spawning the reviewer in the first
// place: a repo with no CI configured at all must never auto-approve,
// since the whole point of this gate is to BE a gate, not a formality that
// eventually rubber-stamps itself. "in_progress"/null status, no
// resolvable repo/token, or a thrown lookup are all simply "not yet" here
// — forever, until CI genuinely reports success.
const AUTO_APPROVE_RETRY_TTL_MS = 60 * 1000;
const AUTO_APPROVE_RETRY_MAX_TTL_MS = 30 * 60 * 1000;
const MAX_AUTO_APPROVALS_PER_SWEEP = 20;
const MAX_AUTO_APPROVE_RETRY_ENTRIES = 500;
const autoApproveRetryState = new Map<number, { lastAttemptedAt: number; attempts: number }>();

function autoApproveRetryBackoffMs(attempts: number): number {
  return Math.min(AUTO_APPROVE_RETRY_TTL_MS * 2 ** (attempts - 1), AUTO_APPROVE_RETRY_MAX_TTL_MS);
}

/**
 * #755 — a red REQUIRED check on a task's PR sends it back to the worker
 * for one automatic round, same mechanism as a "changes-requested" review
 * (`autoReturnTask`, `reason: "ci"`). Deliberately hoisted ABOVE
 * `attemptAutoApprove`'s gates 2/3 (the ingested-verdict and "clean"
 * checks) rather than folded into gate 4's CI check below: gate 2 never
 * passes for a project with no review agent configured at all (no verdict
 * is ever written), and gate 3 never passes for an "inconclusive" verdict —
 * so red-required-CI-plus-either-of-those would otherwise stall in
 * "reviewing" forever, exactly the failure class #755 exists to close.
 *
 * Matches against `required_status_checks.contexts`
 * (`fetchRequiredStatusContexts`, github.ts) by CHECK RUN name
 * (`fetchCheckRunsForHead`) — NOT `current.runs`, which is Workflow Run
 * data from a different GitHub API namespace that never overlaps with the
 * required set (fresh-review finding; see `fetchCheckRunsForHead`'s own
 * doc comment for the full story). A red NON-required check (this repo's
 * own `test-e2e`) is not a reason to return the worker, since the merge
 * sweep itself doesn't gate on it either. `null` from the required-contexts
 * lookup (a 403/404 — no `administration` scope, or no protection
 * configured) is a fail-closed "don't know", not "nothing is required":
 * returns `false` without returning the worker, same as `current.status
 * !== "failure"`.
 *
 * Shares `autoReturnTask`'s round counter/cap with every other trigger
 * (#756's model). When the cap is already spent, posts one PR comment
 * naming it (same `postReviewFindingsComment` mechanism the review-feedback
 * loop's own cap-reached path uses) and leaves the task in "reviewing" —
 * silence here would be the same "capped looks identical to never going to
 * auto-return" gap #756 already fixed for the review path. Deduped via
 * `ciCapCommentedRounds` (below) so a task stuck red+capped gets exactly
 * one comment per round, not a fresh one every sweep tick indefinitely —
 * unlike the review-feedback loop's own cap comment, which is naturally
 * single-shot (tied to a findings-ingestion CAS write), this function runs
 * unconditionally every tick a candidate row matches, with no equivalent
 * state transition to hang a "have I already said this" check on.
 *
 * Returns whether it actually returned the task (or posted the cap-reached
 * comment) — either way, `attemptAutoApprove` must not fall through to its
 * own approve gates for this tick.
 */
const MAX_CI_CAP_COMMENTED_ENTRIES = 500;
const ciCapCommentedRounds = new Map<number, number>();

async function attemptReturnRedCiToWorker(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  current: NonNullable<Awaited<ReturnType<typeof fetchCurrentCiStatus>>>,
): Promise<boolean> {
  if (current.status !== "failure") return false;
  if (task.worktreePath === null || task.agentCommand === null) return false;
  if (!commandSupportsSeed(task.agentCommand)) return false;

  const token = await resolveGitHubToken(app, current.repoRef, "read");
  if (!token) return false;
  const requiredContexts = await fetchRequiredStatusContexts(
    token,
    current.repoRef.owner,
    current.repoRef.repo,
    current.baseRef,
  );
  // Fail closed — see this function's own doc comment.
  if (requiredContexts === null || requiredContexts.length === 0) return false;

  const checkRuns = await fetchCheckRunsForHead(
    token,
    current.repoRef.owner,
    current.repoRef.repo,
    current.headSha,
  );
  // Fresh-review finding: a bare `=== "failure"` missed `timed_out` and
  // `action_required` — conclusions GitHub's own merge gate blocks on just
  // like a plain failure, but which the coarse Workflow-Run pre-filter
  // above (`computeCiStatus`) already treats as "not passing." Matching
  // the same "not success, not skipped, not cancelled, not still-running"
  // definition here keeps the two checks consistent — a required check
  // that fails BOTH ways it can fail (a bare "failure", or one of these)
  // now returns the worker either way, rather than reintroducing the
  // exact "stalls in reviewing forever" gap #755 exists to close, just at
  // a different conclusion value.
  const redRequired = checkRuns.some(
    (c) =>
      requiredContexts.includes(c.name) &&
      c.conclusion !== null &&
      c.conclusion !== "success" &&
      c.conclusion !== "skipped" &&
      c.conclusion !== "cancelled" &&
      c.conclusion !== "neutral",
  );
  if (!redRequired) return false;

  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  if (!resolvedTaskMaster.enabled) return false;

  const maxRounds = resolveMaxAutoReturnRounds(project);
  if (task.autoReturnRounds >= maxRounds) {
    if (ciCapCommentedRounds.get(task.id) === task.autoReturnRounds) return true;
    // Issue #1038 — unlike processReviewingTasks's cap notice, this trigger
    // has no other durable write to piggyback on, so it gets its own,
    // CAS'd write, set BEFORE the post for the same reason (a crash
    // between write and post must leave the banner correct, not stuck).
    // Checked BEFORE touching the dedup map or posting: a losing CAS means
    // the task moved on (approve/reject/give-up) since this trigger last
    // read it, and posting a "needs a human" comment — or marking the
    // in-memory dedup map as if one had been posted — for a task that's no
    // longer in "reviewing" would be wrong either way, not merely stale.
    const announced = app.db
      .update(tasks)
      .set({ autoReturnCapAnnouncedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
      .run();
    if (announced.changes === 0) return true;
    if (
      !ciCapCommentedRounds.has(task.id) &&
      ciCapCommentedRounds.size >= MAX_CI_CAP_COMMENTED_ENTRIES
    ) {
      const oldest = ciCapCommentedRounds.keys().next().value;
      if (oldest !== undefined) ciCapCommentedRounds.delete(oldest);
    }
    ciCapCommentedRounds.set(task.id, task.autoReturnRounds);
    // #737 — deliberately no `verdict` here: this is a notice about EXTERNAL
    // state (a required CI check), not the review agent's own verdict on
    // the diff, so it stays a plain COMMENT regardless of a reviewer App
    // being configured.
    await postReviewFindingsComment(app, task, project, {
      body: `A required CI check is failing on this task's PR, but it has already reached its automatic round cap (${maxRounds}) — it needs a human to take it from here.`,
    });
    return true;
  }

  // #778 — resolved against the OWNING host's own sessionsDir; see
  // spawnReviewAgentNow's own comment for the full rationale.
  const commitTitlePath = project.conventionalCommitTitles
    ? taskCommitTitlePath(
        await resolveSessionsDirWithFallback(app, resolveBackend(app, project.hostId), {
          taskId: task.id,
          hostId: project.hostId,
        }),
        task.id,
      )
    : undefined;
  const prompt = buildCiFailurePrompt({
    task,
    branchName: task.branchName ?? deriveTaskBranchName(task),
    worktreePath: task.worktreePath,
    budgetMinutes: resolvedTaskMaster.budgetMinutes,
    auto: true,
    ci: { headSha: current.headSha, status: current.status, runs: current.runs },
    commitTitlePath,
  });
  await autoReturnTask(app, task, project, { reason: "ci", seedPrompt: prompt });
  return true;
}

// #757 — same dedup shape as ciCapCommentedRounds above, kept as a SEPARATE
// map: the two triggers post different comment text and can each hit the
// cap for a task independently (a task could have red CI capped in one
// round and, separately, new PR comments capped in a later round).
const MAX_PR_COMMENT_CAP_COMMENTED_ENTRIES = 500;
const prCommentCapCommentedRounds = new Map<number, number>();

/**
 * #757 — new GitHub PR review comments (unresolved threads, excluding
 * Mullion's own review posts) send a "reviewing" task back to its worker
 * for one automatic round, same mechanism as a "changes-requested" review
 * (`autoReturnTask`, `reason: "pr-comment"`). Hoisted the same way
 * `attemptReturnRedCiToWorker` is — above `attemptAutoApprove`'s
 * ingested-verdict/"clean" gates — for the identical reason: a project with
 * no review agent configured never writes a verdict at all, and an
 * "inconclusive" verdict never reaches the changes-requested check, so PR
 * comments plus either of those would otherwise stall in "reviewing"
 * forever.
 *
 * `tasks.lastPrReviewCommentAt` is the whole reason this can't just check
 * "any unresolved thread exists": a GitHub review thread stays unresolved
 * until a human clicks Resolve, so without a cursor the SAME thread would
 * drive a fresh round on every reconcile tick forever. Only advanced once
 * `autoReturnTask` actually confirms the round started (`{ ok: true }`) —
 * never on a lost CAS race, so a losing attempt doesn't skip comments a
 * later, successful attempt still needs to see.
 *
 * Resolves its own `repoRef` rather than reusing `attemptAutoApprove`'s own
 * CI lookup — deliberately decoupled, so a CI-fetch failure (or a project
 * with no CI runs at all) doesn't also block PR-comment ingestion. Fresh
 * review, PR #784: the caller must actually let this run when the CI
 * lookup throws, not `return` before reaching it — REST and GraphQL are
 * metered against separate rate-limit buckets, so a REST-side failure is
 * exactly the case where this call would otherwise still succeed.
 */
async function attemptReturnPrCommentsToWorker(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<boolean> {
  if (task.prNumber === null) return false;
  if (task.worktreePath === null || task.agentCommand === null) return false;
  if (!commandSupportsSeed(task.agentCommand)) return false;

  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return false;
  // "write", not "read" — deliberately matching postReviewFindingsComment's
  // own scope (task-github-sync.ts), even though this call itself only
  // reads. Fresh review, PR #784: an App installed before the "read" scope
  // (actions/metadata) existed on it 422s a "read" mint specifically and
  // falls back to the PAT (see getInstallationToken's own doc comment,
  // github-app.ts) while a "write" mint for the SAME installation still
  // succeeds — so a "read" token here could authenticate as a genuinely
  // different identity (the PAT owner) than postReviewFindingsComment's
  // "write" token (the App). Matching scopes keeps the PRIMARY identity
  // consistent between the two calls; the reviewer App's own identity
  // (below) is resolved independently and doesn't depend on this.
  const token = await resolveGitHubToken(app, repoRef, "write");
  if (!token) return false;

  let result: Awaited<ReturnType<typeof fetchPullRequestReviewThreads>>;
  try {
    result = await fetchPullRequestReviewThreads(token, repoRef.owner, repoRef.repo, task.prNumber);
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id },
      "task reconcile: PR review comment fetch failed — waiting to retry",
    );
    return false;
  }
  if (result.truncated) {
    app.log.warn(
      { taskId: task.id, prNumber: task.prNumber },
      "task reconcile: PR review threads/comments exceeded the fetch page size — some may be missed this round",
    );
  }

  const cursor = task.lastPrReviewCommentAt;
  // Unresolved + cursor-filtered only, author identity NOT yet checked —
  // deliberately ordered before resolveMullionReviewLogins below (round 2,
  // self-review): that call is a live, uncached GraphQL round trip (the
  // reviewer App's login never changes, but nothing here caches it), and
  // the ordinary case — nothing new since last tick — should never pay for
  // it. Only a task with an actual candidate comment reaches that call.
  const candidateComments = result.threads
    .filter((t) => !t.isResolved)
    .flatMap((t) => t.comments)
    .filter((c) => c.author !== null)
    .filter((c) => cursor === null || new Date(c.createdAt).getTime() > cursor.getTime());
  if (candidateComments.length === 0) return false;

  // Fresh review: a gating review round (#737/#827) posts its findings from
  // the REVIEWER App, a distinct identity from the primary token above —
  // `result.viewerLogin` alone no longer covers "Mullion's own comments."
  // Without this, an unresolved thread from Mullion's own review gets
  // re-ingested here as if a human had posted it, on the very same tick a
  // clean follow-up verdict lands, burning an auto-return round on nothing.
  const mullionLogins = await resolveMullionReviewLogins(app, repoRef, result.viewerLogin);

  // Excludes Mullion's own review posts (primary identity or reviewer App —
  // see resolveMullionReviewLogins). `c.author` is non-null by construction
  // of `candidateComments` above (TypeScript can't see that through the
  // closure, hence the redundant-looking check).
  const newComments = candidateComments.filter(
    (c) => c.author !== null && !mullionLogins.has(c.author),
  );
  if (newComments.length === 0) return false;

  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  if (!resolvedTaskMaster.enabled) return false;

  const newestCommentAt = new Date(
    Math.max(...newComments.map((c) => new Date(c.createdAt).getTime())),
  );

  const maxRounds = resolveMaxAutoReturnRounds(project);
  if (task.autoReturnRounds >= maxRounds) {
    if (prCommentCapCommentedRounds.get(task.id) === task.autoReturnRounds) return true;
    // Issue #1038 — same reasoning as the red-CI cap notice above: no other
    // durable write to piggyback on, so its own CAS'd write, set before the
    // post, and checked BEFORE touching the dedup map or posting — a
    // losing CAS means the task moved on since this trigger last read it,
    // and neither the comment nor the in-memory "already commented" mark
    // should apply to a task that's no longer in "reviewing".
    const announced = app.db
      .update(tasks)
      .set({ autoReturnCapAnnouncedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
      .run();
    if (announced.changes === 0) return true;
    if (
      !prCommentCapCommentedRounds.has(task.id) &&
      prCommentCapCommentedRounds.size >= MAX_PR_COMMENT_CAP_COMMENTED_ENTRIES
    ) {
      const oldest = prCommentCapCommentedRounds.keys().next().value;
      if (oldest !== undefined) prCommentCapCommentedRounds.delete(oldest);
    }
    prCommentCapCommentedRounds.set(task.id, task.autoReturnRounds);
    // #737 — same reasoning as the red-CI notice above: this reports an
    // external event (new PR review comments), not the review agent's own
    // verdict on the diff, so it stays COMMENT-only.
    await postReviewFindingsComment(app, task, project, {
      body: `New review comments came in on this pull request, but it has already reached its automatic round cap (${maxRounds}) — it needs a human to take it from here.`,
    });
    return true;
  }

  // #778 — resolved against the OWNING host's own sessionsDir; see
  // spawnReviewAgentNow's own comment for the full rationale.
  const commitTitlePath = project.conventionalCommitTitles
    ? taskCommitTitlePath(
        await resolveSessionsDirWithFallback(app, resolveBackend(app, project.hostId), {
          taskId: task.id,
          hostId: project.hostId,
        }),
        task.id,
      )
    : undefined;
  const prompt = buildPrReviewCommentsPrompt({
    task,
    branchName: task.branchName ?? deriveTaskBranchName(task),
    worktreePath: task.worktreePath,
    budgetMinutes: resolvedTaskMaster.budgetMinutes,
    auto: true,
    commitTitlePath,
    comments: newComments.map((c): PrReviewCommentInfo => ({
      author: c.author,
      path: c.path,
      line: c.line,
      body: c.body,
    })),
  });
  const returned = await autoReturnTask(app, task, project, {
    reason: "pr-comment",
    seedPrompt: prompt,
  });
  if (returned.ok) {
    app.db
      .update(tasks)
      .set({ lastPrReviewCommentAt: newestCommentAt })
      .where(eq(tasks.id, task.id))
      .run();
  }
  return true;
}

async function attemptAutoApprove(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<void> {
  // Fresh review, PR #784: `current` is left `null` (not returned-out-of)
  // on a thrown CI lookup — attemptReturnPrCommentsToWorker's own doc
  // comment already claims it's decoupled from a CI-fetch failure (it
  // resolves its own repoRef/token independently), but that was only true
  // in isolation; an early `return` right here, before it was ever called,
  // silently defeated that decoupling for every REST-side failure (a
  // 404'd PR, a REST-bucket rate limit distinct from GraphQL's own) even
  // though the GraphQL call underneath would very likely still have
  // succeeded. `current && ...` below already guards
  // attemptReturnRedCiToWorker against a null current, so this costs
  // nothing on the CI-return path — it just stops blocking the unrelated
  // PR-comment path on a CI-only failure.
  let current: Awaited<ReturnType<typeof fetchCurrentCiStatus>> | null = null;
  try {
    current = await fetchCurrentCiStatus(app, task, project);
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id },
      "task reconcile: auto-approve CI lookup failed — waiting to retry",
    );
  }

  if (current && (await attemptReturnRedCiToWorker(app, task, project, current))) return;
  if (await attemptReturnPrCommentsToWorker(app, task, project)) return;
  if (!current) return;

  if (
    task.reviewFindingsIngestedSessionId === null ||
    task.reviewFindingsIngestedSessionId !== task.reviewSessionId
  ) {
    return;
  }
  if (task.lastReviewVerdict !== "clean") return;

  if (!current || current.status !== "success") return;

  const outcome = await approveTask(app, task, project, "auto-approve");
  if (outcome.ok) {
    app.log.info(
      { taskId: task.id, prNumber: task.prNumber, prUrl: outcome.task.prUrl },
      "task reconcile: auto-approved",
    );
    // Hermes review, PR #768 — drop the retry-state entry rather than
    // leaving it to linger until the 500-cap evicts it (same fix as the
    // merge sweep's own clearMergeState, PR #763's Hermes finding). Not
    // strictly load-bearing the way it was there (this task's status just
    // flipped to "done", dropping it out of this sweep's own `status =
    // "reviewing"` WHERE clause on the next tick regardless), but keeping
    // the map to live-in-flight candidates only is worth the one line.
    autoApproveRetryState.delete(task.id);
    return;
  }

  // What happens once `approveTask` actually runs — the check above says
  // WHEN to attempt; this says what to do with each `ApproveOutcome`. In a
  // sweep there's no human reading a 409, so every reason needs a named
  // disposition, same posture as the merge sweep's own per-`mergeableState`
  // table above.
  switch (outcome.reason) {
    case "cas-lost":
      // A human approved/rejected in the same window — silent no-op, not
      // an error. The task's status already changed out from under this
      // sweep's own WHERE clause, so — same reasoning as the success case
      // above — this entry would never be read again regardless, but drop
      // it now rather than waiting on the eviction cap.
      autoApproveRetryState.delete(task.id);
      return;
    case "dirty-tree":
      // A review agent leaving a scratch file behind looks permanent but
      // is genuinely transient. Back off and retry indefinitely; never
      // mark anything failed.
      app.log.warn(
        { taskId: task.id },
        "task reconcile: auto-approve blocked on a dirty worktree — retrying",
      );
      return;
    case "remote-not-supported":
      // Permanent for this host — logged once per attempt (the backoff
      // below still bounds how often that is). #760 made review-findings
      // ingestion remote-capable, so a remote-hosted task CAN now reach a
      // "clean" verdict and land here for real, not just for completeness.
      app.log.warn(
        { taskId: task.id },
        "task reconcile: auto-approve not supported for this task's host",
      );
      return;
    case "no-worktree":
    case "no-repo":
    case "no-token":
    case "push-failed":
    case "pr-create-failed":
      // Back off and retry indefinitely, same posture as every other
      // GitHub-write path in this file.
      app.log.warn(
        { taskId: task.id, reason: outcome.reason, detail: outcome.detail },
        "task reconcile: auto-approve attempt failed — retrying",
      );
      return;
    default: {
      // Hermes review, PR #768 — exhaustiveness guard: if ApproveOutcome's
      // failure-reason union ever grows, this line fails to typecheck
      // instead of silently falling through the switch with no log and no
      // named disposition, the exact gap the missing "no-worktree" case
      // above was.
      const exhaustiveCheck: never = outcome;
      app.log.warn(
        { taskId: task.id, outcome: exhaustiveCheck },
        "task reconcile: auto-approve failed with an unrecognized reason — retrying",
      );
      return;
    }
  }
}

async function processAutoApprovals(app: FastifyInstance): Promise<void> {
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  if (!resolvedTaskMaster.enabled) return;
  if (skipSweepIfGitHubRateLimited(app, "processAutoApprovals")) return;

  const rows = app.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(eq(tasks.status, "reviewing"), eq(projects.autoApprove, true), isNotNull(tasks.prNumber)),
    )
    .all();
  if (rows.length === 0) return;

  const now = Date.now();
  let attempted = 0;

  for (const { task, project } of rows) {
    if (attempted >= MAX_AUTO_APPROVALS_PER_SWEEP) return;
    if (isGitHubRateLimited()) return; // #759 — see the draft-PR sweep's own comment

    const state = autoApproveRetryState.get(task.id);
    if (
      state !== undefined &&
      now - state.lastAttemptedAt < autoApproveRetryBackoffMs(state.attempts)
    )
      continue;

    attempted++;
    if (
      !autoApproveRetryState.has(task.id) &&
      autoApproveRetryState.size >= MAX_AUTO_APPROVE_RETRY_ENTRIES
    ) {
      const oldest = autoApproveRetryState.keys().next().value;
      if (oldest !== undefined) autoApproveRetryState.delete(oldest);
    }
    autoApproveRetryState.set(task.id, {
      lastAttemptedAt: now,
      attempts: (state?.attempts ?? 0) + 1,
    });

    await attemptAutoApprove(app, task, project);
  }
}

// Task Master trial 220921 / PR #743's incident — `derived.status ===
// "finished"` used to be trusted as "the review is over, and if there's no
// findings file, there never will be" the INSTANT it was observed, with no
// allowance for a review agent that's still writing its own output. That
// incident's review agent posted a real `verdict: "clean"` file 21 SECONDS
// after this reconciler's tick had already read `finished` off a stale
// latch, concluded "inconclusive," and durably recorded
// `reviewFindingsIngestedSessionId` — permanently. The real file could then
// never be read again (see the `parsed === null` branch of `isUsableSignal`
// below): a recoverable timing miss became an unrecoverable dead task.
//
// This constant is the fix's other half: for a MISSING file specifically
// (`parsed === null`), "finished" alone is no longer enough — the review
// session's own age (`sessions.createdAt`, already joined into this query,
// so no schema change) must also have crossed this grace window. The
// review prompt (`buildReviewPrompt`, task-prompt.ts) now asks the agent to
// run the repo's WHOLE verification gate before writing its findings file,
// so several minutes of silence with no file yet is the ordinary case, not
// evidence of a crash. `derived.status === "exited"` still ingests
// immediately regardless of this window — a session that has genuinely
// exited can't write anything more no matter how long is waited.
//
// This window alone is NOT sufficient, though (Hermes review, PR #754):
// crossing it while the session is demonstrably still active
// (`derived.severity === "busy"` — working/compacting/subagent/background)
// must not conclude "nothing is coming" either — a slow verification suite
// genuinely still running past 30 minutes would otherwise hit the exact
// same permanent-latch dead end this constant exists to fix, just relocated
// here instead of at 21 seconds. See `isUsableSignal`'s own comment for the
// busy exclusion this pairs with.
const REVIEW_FINDINGS_GRACE_MS = 30 * 60_000;

/**
 * The review-findings loop — a SEPARATE poll from the claimed/in_progress
 * one below (see reconcileTasks's own doc comment for why a "reviewing"
 * task otherwise has no liveness/budget dependency here at all: this is the
 * one narrow exception, scoped to reading a finished review session's
 * output, never to session death or the time budget).
 *
 * For every "reviewing" task with a review session whose derived status is
 * "finished" AND whose output hasn't already been processed
 * (`reviewFindingsIngestedSessionId !== reviewSessionId` — see that
 * column's own doc comment in schema.ts for why this check exists: a task
 * can sit "reviewing" with zero findings for a long time, polled every
 * tick, and without this marker it would be re-ingested and re-commented
 * forever):
 *
 *  - reads the round-suffixed findings file the review prompt told the
 *    agent to write to (`taskReviewFindingsPath`, task-prompt.ts) and
 *    parses it (`parseReviewFindings`) into a verdict — a missing or empty
 *    file is NOT read as "clean": `buildReviewPrompt` tells the agent to
 *    ALWAYS write the file, so an absent one means the review never really
 *    happened (crash, killed session, an agent that ignored the contract),
 *    and is posted as inconclusive instead. See `parseReviewFindings`'s own
 *    doc comment for the full contract, including its tolerant fallback for
 *    an agent that writes freeform text instead of JSON.
 *  - posts what it found (a rendered verdict either way — this is exactly
 *    the visibility gap the review-findings loop exists to close: previously
 *    a finished review was invisible outside the session's own terminal) as
 *    one comment on the task's PR, falling back to its linked issue
 *    (`postReviewFindingsComment`, task-github-sync.ts).
 *  - appends it to `tasks.reviewFindings` under a "## Round N" header —
 *    never replaces, so an earlier round survives a later one.
 *  - if the verdict is "changes-requested" AND this task hasn't already spent
 *    its round budget (`task.autoReturnRounds` vs. the resolved per-project
 *    cap — `resolveMaxAutoReturnRounds`, default
 *    `DEFAULT_MAX_AUTO_RETURN_ROUNDS`; #756 replaced the original hardcoded
 *    single round) AND Task Master is enabled: hands off to `autoReturnTask`
 *    (`reason: "review"`), the mechanism shared by every automatic
 *    "reviewing -> in_progress" trigger — flips the task back to
 *    "in_progress", increments `autoReturnRounds` (a compare-and-swap write,
 *    same as every other transition in this file — a concurrent
 *    approve/reject/give-up simply wins the race and this loop no-ops), and
 *    re-seeds the worker (`reseedTaskIfSessionExited`, task-reseed.ts,
 *    shared with reject's own re-seed but called with `force: true` here —
 *    see that function's own doc comment on why: nobody is watching to type
 *    into a still-alive worker session the way a human reviewing a reject
 *    is) with the findings as its prompt. A "clean" verdict never
 *    auto-returns — that's the whole reason file-existence stopped being
 *    the signal (see `parseReviewFindings`'s doc comment). A task that
 *    wanted another round but had none left gets one extra sentence folded
 *    into its posted comment instead, naming the cap, so a human can tell
 *    a capped task apart from one that was never going to auto-return.
 *
 * Gated on `resolveTaskMasterConfig(app).enabled` for the auto-return step
 * only (same reasoning as the claimed/in_progress loop's own "enabled"
 * gates below) — reading and posting the findings themselves is pure
 * visibility, ungated, so a disabled install still surfaces "review
 * finished" instead of going silent.
 */

// #772's roadmap follow-up — a task's auto-return budget was previously
// hardcoded to exactly one round, gated on a changes-requested review
// verdict alone. This is the shared model every automatic "send it back to
// the worker" trigger now registers against, so the cap/give-up posture and
// the DB write itself exist in exactly one place rather than drifting
// across a growing list of triggers (review feedback here; a red required
// CI check and an unresolved PR review comment are later triggers on the
// same model — see the roadmap plan).
export type AutoReturnReason = "review" | "ci" | "pr-comment";

// `via` naming for recordTaskTransition — kept distinct from
// AutoReturnReason itself (rather than reusing the reason string directly)
// so a future reason can pick its own `via` wording without also having to
// match a stable enum value stored durably on the row.
const AUTO_RETURN_VIA: Record<AutoReturnReason, string> = {
  review: "review-feedback",
  ci: "ci-feedback",
  "pr-comment": "pr-comment-feedback",
};

// Today's default — a single automatic round for an advisory review agent's
// own findings was a reasonable default; a closed automatic loop (this
// follow-up's whole point) needs more than one chance before it strands a
// task in "reviewing" waiting for a human. Overridable per project via
// `projects.maxAutoReturnRounds` (null = use this default).
export const DEFAULT_MAX_AUTO_RETURN_ROUNDS = 2;

export function resolveMaxAutoReturnRounds(project: {
  maxAutoReturnRounds: number | null;
}): number {
  return project.maxAutoReturnRounds ?? DEFAULT_MAX_AUTO_RETURN_ROUNDS;
}

/**
 * Sends a "reviewing" task back to its worker for one automatic round —
 * the mechanism shared by every auto-return trigger (see `AutoReturnReason`
 * above). Callers decide WHETHER a round is affordable
 * (`resolveMaxAutoReturnRounds` vs. `task.autoReturnRounds`) before calling
 * this; it does not check the cap itself and always spends one round once
 * it runs.
 *
 * CAS on `status = "reviewing"` — a concurrent approve/reject/give-up
 * racing this call simply wins outright; this function then does nothing
 * further and returns `{ ok: false }`.
 *
 * On a failed re-seed (`reseedTaskIfSessionExited` returning `false` —
 * terminate/spawn error, or ITS OWN lost race against a still-later
 * transition), BOTH the round increment and the "reviewing" -> "in_progress"
 * status write are rolled back, CAS'd on the exact `autoReturnRounds` value
 * this call itself just wrote, so a genuinely later attempt can still use
 * the round. Issue #973 — this used to leave `status` at "in_progress" (a
 * quirk carried over from the review-feedback loop this function was
 * extracted from, Hermes review PR #580, deliberately preserved rather than
 * fixed at the time) while `sessionId` still pointed at the OLD session
 * `reseedTaskIfSessionExited` was trying to replace. task-state.ts treats
 * "in_progress" as session-liveness-dependent ("agent's turn ended / session
 * died") but "reviewing" as not, so an "in_progress" task left pointing at a
 * dead-or-dying `sessionId` for any length of time is exposed to
 * session-reconciler.ts's session-death hook flipping it to "failed" with a
 * misleading "session exited" reason that has nothing to do with the real
 * re-seed failure. Rolling `status` back too undoes every write THIS call
 * itself made (status, the round, `lastAutoReturnReason`) — not
 * `reviewFindings`/`lastReviewVerdict`/the posted PR comment from an
 * earlier, already-committed step, which correctly survive — landing the
 * task back in "reviewing", invisible to the liveness/budget checks that
 * only run against "claimed"/"in_progress". For a level-triggered reason
 * ("ci", "pr-comment" — re-evaluated against live external state every
 * sweep) this also acts as a natural retry: the next tick calls this
 * function again as long as the underlying condition persists, with no
 * separate retry/backoff mechanism needed. "review" is edge-triggered on a
 * findings file appearing (already unlinked and ingest-marked by the time
 * this runs), so a failure there does NOT self-retry — it still needs a
 * human to notice the stalled "reviewing" task — but at least no longer
 * masquerades as an unrelated session death.
 *
 * This closes the INDEFINITE version of that exposure (a re-seed that fails
 * outright and returns), but on its own did not close the WINDOW between
 * the forward CAS above and this rollback — which spans the entire re-seed
 * attempt, `force: true`'s own terminate-then-spawn included. The incident
 * this fixes (task 258971, PR #136, 2026-09-02) actually raced inside that
 * window, not after it: `reseedTaskIfSessionExited`'s `terminate()` call
 * hung for a full 90s systemd `TimeoutStopSec` (the prior session's process
 * wasn't responding to SIGTERM) before being SIGKILLed, and a concurrent
 * `reconcileExitedSessions` tick landed 27s into that hang and treated the
 * scope's `deactivating` state identically to "genuinely gone." That tick
 * flipped the task to "failed" via session-death 63 seconds before this
 * function's own rollback ran, AND removed the task's worktree via
 * `removeWorktreeIfClean`. The re-seed's OWN spawn — already in flight,
 * re-seeding into that exact SAME worktree path per this function's own doc
 * comment above — then ran with a `cwd` that no longer existed, surfacing as
 * the misleading "spawn systemd-run ENOENT" the original bug report opened
 * on (Node/libuv blames the command, not a missing `cwd`); systemd-run
 * itself was never missing.
 *
 * Two changes since have closed the mechanism that produced the incident.
 * #1001 (issues #987/#988's first pass): `reseedTaskIfSessionExited`'s force
 * path now flips the still-active session to "killed" — CAS'd — BEFORE
 * awaiting `terminate()`, not after, so it drops out of
 * `reconcileExitedSessions`'s own `status = "active"` candidate query for
 * the entire stop window rather than just after it; and
 * `isMasterAlive`/`isMasterAliveBatch` (session-process.ts) now treat
 * `deactivating` as alive, a second layer for any termination that doesn't
 * go through that kill-CAS. #988's follow-up closes the specific
 * SELECT-vs-kill-CAS staleness those two left open: `reconcileExitedSessions`'s
 * own SELECT can still cache an "active" snapshot of this exact session a
 * moment before the kill-CAS above lands, and if the terminating process
 * responds to SIGTERM fast enough, its later `isMasterAlive` check
 * legitimately observes "not alive" against that stale snapshot.
 * `session-reconciler.ts` now CASes its own flip-to-"exited" write on
 * `status = "active"` too, and skips the task-failure/worktree-removal block
 * entirely when that CAS loses — the "in flight" recording this comment used
 * to say was missing, implemented as the session row's own status rather
 * than a new column. This does NOT claim every theoretical interleaving is
 * closed — e.g. a `terminate()` call that itself throws (a remote host RPC
 * failure, not a slow-but-successful stop) reverts the kill-CAS back to
 * "active" so the standard reconciler can determine the truth on its own;
 * if that reconciler's own `isMasterAlive` then genuinely reports "not
 * alive" for the same session, failing the task via session-death is the
 * correct outcome (the process really is gone), not a race this fix needs
 * to prevent — re-seeding already gave up by that point.
 *
 * By the time this function's own rollback runs today, `status:
 * "in_progress"` in its CAS below still correctly no-ops if the task
 * somehow already left `in_progress` some other way — belt-and-suspenders,
 * not the load-bearing fix anymore.
 *
 * Deliberately does NOT call `syncTaskTransition` for this rollback (unlike
 * the real "in_progress -> reviewing" transition elsewhere in this file,
 * which does): the forward "reviewing -> in_progress" write just above
 * ALSO skips it, so GitHub's own labels/comments never left "reviewing" in
 * the first place — syncing here would post a duplicate "Task ready for
 * review" comment for a review that was already announced.
 */
export async function autoReturnTask(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  opts: { reason: AutoReturnReason; seedPrompt: string },
): Promise<{ ok: boolean }> {
  const updated = app.db
    .update(tasks)
    .set({
      status: "in_progress",
      autoReturnRounds: task.autoReturnRounds + 1,
      lastAutoReturnReason: opts.reason,
      // Issue #1038 — every caller of autoReturnTask already gated on
      // !capReached, so this is null already in every designed path; clear
      // it explicitly anyway so this write is the one place that can never
      // leave a stale announcement behind if that invariant ever slips.
      autoReturnCapAnnouncedAt: null,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
    .run();
  if (updated.changes === 0) return { ok: false };

  recordTaskTransition(app, {
    taskId: task.id,
    projectId: project.id,
    from: "reviewing",
    to: "in_progress",
    via: AUTO_RETURN_VIA[opts.reason],
  });

  // force: true — nobody is watching an automated auto-return round the way
  // a human reviewing a reject is; see reseedTaskIfSessionExited's own doc
  // comment on why force is the right default for every unattended caller.
  const reseeded = await reseedTaskIfSessionExited(
    app,
    task,
    project,
    opts.seedPrompt,
    `task auto-return (${opts.reason})`,
    { force: true },
  );
  if (!reseeded) {
    const rolledBack = app.db
      .update(tasks)
      .set({
        // Issue #973 — restores "reviewing", not just the round: see this
        // function's own doc comment on why leaving "in_progress" behind
        // with a stale `sessionId` let an unrelated session-death event
        // clobber the task with the wrong failure reason.
        status: "reviewing",
        autoReturnRounds: task.autoReturnRounds,
        // Fresh subagent review, PR #774 — a rolled-back attempt means no
        // auto-return round actually completed, so leaving this set to
        // whatever reason the earlier CAS just wrote would contradict this
        // column's own doc comment (schema.ts): "which trigger most
        // recently drove an auto-return round" — this one didn't.
        lastAutoReturnReason: task.lastAutoReturnReason,
        // Issue #1038 — status and the round roll back together; this rides
        // along for the same reason (see the main write's own comment
        // above) — restores the pre-attempt value rather than assuming
        // null, though every designed caller already had it null here.
        autoReturnCapAnnouncedAt: task.autoReturnCapAnnouncedAt,
      })
      // Adding `status = "in_progress"` here (issue #973) is a real
      // semantic change, not just a tighter guard: status and the round now
      // roll back TOGETHER or not at all. If a concurrent transition
      // already moved the task off "in_progress" (approve/reject/give-up
      // landing in the gap between the CAS above and here), this CAS loses
      // and the round stays spent — weakening #580's original "a failed
      // re-seed must never silently burn the round" promise for that one
      // race. That's the right trade: the alternative would be writing
      // `status: "reviewing"` back onto a task a concurrent call already
      // moved to "failed"/"done"/elsewhere, resurrecting a resolved task
      // out from under whoever resolved it — worse than losing one round.
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.status, "in_progress"),
          eq(tasks.autoReturnRounds, task.autoReturnRounds + 1),
        ),
      )
      .run();
    if (rolledBack.changes > 0) {
      recordTaskTransition(app, {
        taskId: task.id,
        projectId: project.id,
        from: "in_progress",
        to: "reviewing",
        via: "reconcile",
        context: { reason: opts.reason },
      });
    }
    app.log.warn(
      { taskId: task.id, reason: opts.reason, rolledBack: rolledBack.changes > 0 },
      "task reconcile: auto-return re-seed failed — rolled back the spent auto-return round and status so a later attempt can still use it",
    );
  }
  return { ok: reseeded };
}

// #760 — takes a resolved backend + round rather than a raw path, so this
// works identically for a local or a remote-hosted task's review session
// (SessionBackend.deleteTaskReviewFindings derives the actual path on
// whichever host holds it). Best-effort by design, same as before this
// PR: a delete failure (including a remote host going unreachable between
// the read above and this call) is logged and otherwise ignored — the
// content is already durably ingested into the DB by the time this runs,
// so a leftover file on disk costs nothing but a stray bytes; it would
// only ever cause a same-round re-review (reject keeps the round
// unchanged) to needlessly re-read it, not a correctness problem.
async function unlinkFindingsFileIfPresent(
  app: FastifyInstance,
  backend: SessionBackend,
  taskId: number,
  round: number,
): Promise<void> {
  try {
    await backend.deleteTaskReviewFindings(taskId, round);
  } catch (err) {
    app.log.warn(
      { err, taskId, round },
      "task reconcile: failed to remove an ingested review findings file",
    );
  }
}

/**
 * D1 — on any repo with `required_conversation_resolution` enabled (this
 * repo's own `main` included), an anchored review finding blocks merge
 * FOREVER once its thread is created: nothing before this called GitHub's
 * thread-resolution mutation at all (`docs/tasks.md`'s own known-limitations
 * section documented the resulting false-positive "blocked" read, but never
 * closed it). Confirmed live in a dry run (2026-08-27): a real anchored
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
async function resolveMullionOwnThreadsIfClean(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<Awaited<ReturnType<typeof fetchPullRequestReviewThreads>> | null> {
  if (task.prNumber === null) return null;

  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return null;
  const token = await resolveGitHubToken(app, repoRef, "write");
  if (!token) return null;

  let result: Awaited<ReturnType<typeof fetchPullRequestReviewThreads>>;
  try {
    result = await fetchPullRequestReviewThreads(token, repoRef.owner, repoRef.repo, task.prNumber);
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id },
      "task reconcile: review-thread fetch failed while checking for Mullion's own threads to resolve",
    );
    return null;
  }
  if (result.truncated) {
    app.log.warn(
      { taskId: task.id, prNumber: task.prNumber },
      "task reconcile: review threads/comments exceeded the fetch page size — skipping auto-resolve this tick rather than resolving an incomplete set",
    );
    return null;
  }

  // Independent review, round 2: cheap pre-filter before the reviewer
  // identity lookup below, same reasoning as attemptReturnPrCommentsToWorker's
  // own ordering (D0) — resolveMullionReviewLogins is a live, uncached
  // GraphQL round trip, and this function is called from a merge-retry
  // backoff loop, not a one-shot verdict ingestion, so paying for it on
  // every tick even when nothing is unresolved would reproduce the exact
  // pattern D0 fixed elsewhere in this file.
  if (!result.threads.some((t) => !t.isResolved)) return result;

  const mullionLogins = await resolveMullionReviewLogins(app, repoRef, result.viewerLogin);
  const ownUnresolved = result.threads.filter(
    (t) =>
      !t.isResolved &&
      t.comments.length > 0 &&
      t.comments.every((c) => mullionLogins.has(c.author ?? "")),
  );
  if (ownUnresolved.length === 0) return result;

  for (const thread of ownUnresolved) {
    try {
      await resolveReviewThread(token, thread.id);
    } catch (err) {
      app.log.warn(
        { err, taskId: task.id, threadId: thread.id },
        "task reconcile: failed to resolve one of Mullion's own review threads",
      );
    }
  }
  return result;
}

async function processReviewingTasks(app: FastifyInstance): Promise<void> {
  const allRows = app.db
    .select({ task: tasks, session: sessions, project: projects })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.reviewSessionId, sessions.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.status, "reviewing"))
    .all();
  if (allRows.length === 0) return;

  const now = Date.now();
  const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
  const resolvedTaskMaster = resolveTaskMasterConfig(app);

  // #760 — every host, not just LOCAL_HOST_ID. readTaskReviewFindings
  // below (SessionBackend) is what makes this safe now: it reads from
  // whichever host actually ran the review agent, instead of this
  // process's own local sessionsDir the way the pre-#760 version of this
  // loop did (which is why remote-hosted tasks used to be skipped
  // entirely here — see git history/#760 for the "why not just read
  // local and risk a false inconclusive" reasoning this used to document).
  const byHost = new Map<string, typeof allRows>();
  for (const row of allRows) {
    const group = byHost.get(row.project.hostId) ?? [];
    group.push(row);
    byHost.set(row.project.hostId, group);
  }
  if (byHost.size === 0) return;

  await Promise.all(
    [...byHost.entries()].map(async ([hostId, hostRows]) => {
      const backend = resolveBackend(app, hostId);
      let liveMap: Record<string, SessionInfo | null>;
      try {
        liveMap = await backend.liveStatus(
          hostRows.map((r) => String(r.session.id)),
          idleThresholdMs,
        );
      } catch (err) {
        app.log.warn(
          { hostId, err },
          "task reconcile: host unreachable, skipping its review sessions",
        );
        return;
      }

      for (const row of hostRows) {
        const { task, session, project } = row;

        if (task.reviewFindingsIngestedSessionId === task.reviewSessionId) continue;

        const info = liveMap[String(session.id)];
        if (info === undefined) continue;
        const derived = deriveSessionStatus({
          dbStatus: session.status,
          info: defaultDeriveStatusInfo(info),
        });

        // #760 — genuinely absent/empty (readTaskReviewFindings resolves
        // `null`) is NOT the same outcome as a read failure (it throws):
        // the former means "the review really did write nothing, treat as
        // inconclusive"; the latter (host unreachable, a peer 5xx, a
        // filesystem permission error, or a 404 from a peer too old to
        // have this route — version skew) means "we don't actually know
        // yet" and must `continue` to the next row rather than fall
        // through and ingest a guess. The pre-#760 local-only version of
        // this block did NOT make that distinction — a read failure fell
        // through to `findings = null` exactly like a missing file,
        // silently risking a false "inconclusive" comment on a real read
        // error. Fixed here as part of introducing the same read for
        // remote hosts, where a transient network blip is far more likely
        // than a local disk read ever failing.
        let findings: string | null;
        try {
          findings = await backend.readTaskReviewFindings(task.id, task.autoReturnRounds);
        } catch (err) {
          app.log.warn(
            { err, taskId: task.id, round: task.autoReturnRounds },
            "task reconcile: failed to read review findings file — retrying next tick",
          );
          continue;
        }
        // `parseReviewFindings`'s own doc comment: file-existence stopped
        // being a safe signal the moment `buildReviewPrompt` started asking
        // for an explicit verdict — `parsed` (not `findings`) is now what
        // both gates below key off. `parsed === null` covers a missing OR
        // empty file, i.e. "wrote nothing", never a real "clean" verdict.
        const parsed = findings !== null ? parseReviewFindings(findings) : null;

        // Hermes review, PR #576 — a review agent that never derives
        // "finished" (exits right after its turn instead of staying running,
        // unlike the worker preamble's own instruction — buildReviewPrompt
        // now tells it to as well, but this doesn't rely on compliance) was
        // previously skipped forever: no comment, no auto-return, silent.
        // "exited" is always a usable signal — a session that has genuinely
        // exited can't write anything more no matter how long is waited, so
        // there's nothing left to gain by delaying past it, whether or not
        // it left a findings file behind. (This also closes a pre-existing
        // gap this comment used to document: a session that crashed BEFORE
        // writing anything used to leave `parsed === null` unaccepted here,
        // and the task just stalled in "reviewing" forever with no comment
        // at all — "exited" alone now surfaces it as inconclusive instead.)
        //
        // Split on whether a findings file was actually read (see
        // `REVIEW_FINDINGS_GRACE_MS`'s own doc comment for the incident
        // this split fixes). A REAL file (`parsed !== null`) is trustworthy
        // the instant `finished` latches — nothing more to wait for. A
        // MISSING file (`parsed === null`) is NOT immediately trustworthy
        // as "never coming": `finished` is a hook-confirmed "a turn ended,"
        // not "the review agent gave up entirely," and the review prompt
        // now asks for a full verification-gate run before the file is
        // written. Deliberately NOT re-gated on `finished` for the
        // grace-elapsed branch below — a review session that's been alive
        // this long with no findings file and hasn't even reached
        // "finished" once is itself the failure worth surfacing (a hung or
        // runaway session), not a reason to keep waiting silently forever.
        //
        // Hermes review, PR #754 — grace-elapsed alone isn't enough: a
        // session with `severity === "busy"` (working/compacting/subagent/
        // background — session-status.ts's own grouping) is DEMONSTRABLY
        // still doing something, e.g. genuinely still running the repo's
        // verification gate past 30 minutes on a slow suite. Ingesting that
        // as inconclusive would permanently latch `reviewFindingsIngestedSessionId`
        // out from under a real verdict that's still coming — the exact
        // dead end this PR exists to fix, just relocated to the 30-minute
        // mark, and worse than main: main never ingested a still-active
        // session at all. Only a session that has gone quiet (idle,
        // blocked on a human, erroring, or genuinely `finished`) past the
        // grace window, or `exited` outright, is treated as "nothing more
        // is coming."
        const isUsableSignal =
          parsed !== null
            ? derived.status === "finished" || derived.status === "exited"
            : derived.status === "exited" ||
              (derived.severity !== "busy" &&
                now - session.createdAt.getTime() >= REVIEW_FINDINGS_GRACE_MS);
        if (!isUsableSignal) continue;

        const roundLabel = `## Round ${task.autoReturnRounds + 1}`;
        // Hermes review, PR #754 — wording keyed on `derived.status`
        // itself, not just "was it exited," so a session ingested via the
        // grace-elapsed branch above (which — per the comment on
        // `isUsableSignal` — can be `finished`, `idle`, an `awaiting_*`
        // block, or an error state, never `busy`) never gets a claim about
        // what happened to it that isn't true. A killed/crashed session
        // (`exited`) never "finished" anything; a merely quiet-but-not-
        // finished session didn't either.
        const noFindingsReason =
          derived.status === "exited"
            ? "Review agent ended without writing a findings file"
            : derived.status === "finished"
              ? "Review agent finished but wrote no findings file"
              : "Review agent produced no findings file within the expected time";
        const commentBody = parsed
          ? `${roundLabel}\n\n${renderReviewFindingsMarkdown(parsed)}`
          : `${roundLabel}\n\n${noFindingsReason} — treat this review as inconclusive.`;

        const appendedFindings = task.reviewFindings
          ? `${task.reviewFindings}\n\n${commentBody}`
          : commentBody;

        // Hermes review, PR #576 — a non-seed-capable worker adapter (e.g.
        // aider/gemini/pi — every registered adapter, including OpenCode,
        // has initialPromptArgs by now; see getAdapterInitialPromptArgs's
        // own doc comment for the current list) can't receive the findings
        // as an initial prompt at all (reseedTaskIfSessionExited delivers
        // argv-only, same as every other Task Master spawn). Auto-returning
        // anyway would burn the task's
        // one round, flip it to in_progress, and spawn a fresh session with
        // NO instructions — one that never ends a turn, so the task just
        // rides its budget out and fails. Recording + commenting the
        // findings still happens; only the auto-return (and the round it
        // would spend) is skipped, leaving a human to act on what's now
        // visible on the task and the PR.
        // Hermes review, PR #580 — a review agent that crashes mid-review
        // AFTER writing a partial findings file also derives "exited" with
        // a non-null file, so accepting "exited" for INGESTION (above)
        // would also let a half-written review consume the task's one
        // auto-return round. Only a genuine "finished" (a deliberate,
        // complete turn end) is trustworthy enough to act on automatically
        // — "exited" findings are still ingested and commented, just not
        // auto-returned.
        //
        // `parsed?.verdict === "changes-requested"` (not `findings !== null`)
        // is the regression guard this verdict contract exists for: a
        // reviewer that writes JSON with `verdict: "clean"` must NOT
        // auto-return. Under the old "findings !== null means act on it"
        // rule, always writing a file (this PR's whole point — see
        // buildReviewPrompt) would have made a clean review indistinguishable
        // from one requesting changes, spending the task's one auto-return
        // round respawning the worker with nothing to do.
        // #756 — "wants to" is now distinct from "is allowed to": a verdict
        // of "changes-requested" alone no longer decides the outcome, the
        // resolved per-project cap does too. Split so a capped task can
        // still be told WHY it's stuck (see cappedNote below) rather than
        // silently doing nothing, which was the pre-#756 behavior once a
        // task had already spent its one round.
        const wantsAutoReturn =
          derived.status === "finished" &&
          parsed !== null &&
          parsed.verdict === "changes-requested" &&
          resolvedTaskMaster.enabled &&
          task.worktreePath !== null &&
          task.agentCommand !== null &&
          commandSupportsSeed(task.agentCommand);
        const maxRounds = resolveMaxAutoReturnRounds(project);
        const capReached = task.autoReturnRounds >= maxRounds;
        const shouldAutoReturn = wantsAutoReturn && !capReached;

        // Hermes review, PR #576 — record BEFORE posting the PR comment
        // (previously the reverse), and CAS on `status = "reviewing"` even
        // for the non-transitioning write: a concurrent approve/reject/
        // give-up racing this same tick should win outright — this loop
        // then does neither the DB write nor the PR comment for a decision
        // the task no longer reflects, rather than a comment landing with
        // no matching DB write behind it.
        //
        // lastReviewVerdict rides this same write (durable, not re-derived
        // from the rendered reviewFindings prose) — the auto-approve sweep
        // (processAutoApprovals) reads it back later to gate approving a
        // task with no human in the loop. Written here regardless of
        // whether auto-approve exists/is enabled on this project: the write
        // is inert until read, and landing it now means real verdict data
        // has already accumulated by the time auto-approve ships.
        //
        // #756 — no longer bundles the round-increment fields (autoReturnRounds/
        // status/lastAutoReturnReason): those now live in autoReturnTask's own
        // CAS write, shared with every other auto-return trigger, not just this
        // one. This write stays CAS'd on `status = "reviewing"` on its own —
        // splitting the two writes narrows, but doesn't remove, the same
        // "a concurrent decision wins outright" guarantee: if THIS write's CAS
        // succeeds and a concurrent approve/reject/give-up lands before
        // autoReturnTask's own CAS runs, that second CAS simply fails and
        // autoReturnTask returns `{ ok: false }` — no round is spent, no
        // transition is recorded.
        // #737 — one local, not two independent `parsed?.verdict ??
        // "inconclusive"` expressions: this is both the durable column
        // value AND the verdict `postReviewFindingsComment` maps onto a
        // gating review event below, and they can't be allowed to drift.
        const verdict = parsed?.verdict ?? "inconclusive";
        // Issue #1038 — folded into this same durable write, not a
        // follow-up write after the GitHub comment post below: this column
        // is the ground truth "the machine actually stopped" signal the
        // board reads, and this write IS the moment a capped task's
        // findings are durably ingested (reviewFindingsIngestedSessionId
        // below), regardless of what the verdict turned out to be. Setting
        // it here, ahead of the post, means a crash between this write and
        // the post (reached only when wantsAutoReturn, i.e. changes were
        // requested — see cappedNote below) leaves the banner CORRECT
        // (needs a human) with only the notice comment missing.
        //
        // Hermes review (PR #1040) — deliberately `capReached` alone, NOT
        // `wantsAutoReturn && capReached`: a capped task whose FINAL review
        // comes back clean or inconclusive is just as genuinely parked as
        // one that wanted (and was denied) another round — nothing
        // auto-returns a non-"changes-requested" verdict either way — but
        // gating on wantsAutoReturn left that case never announced, so the
        // board kept claiming "review in flight" on a task nothing further
        // would ever touch. This durable write only runs when a review's
        // output is being ingested (isUsableSignal above), so `capReached`
        // alone already means "a capped task's findings were just
        // ingested" — no separate ingest-pointer comparison needed here.
        const announcingCap = capReached;
        // Issue #1039 — the PR head SHA this round's ingested findings are
        // actually about, read from the existing github-pr-poller.ts cache
        // (zero-cost, no GitHub call from this reconcile tick). Best-effort:
        // a cache miss (poller hasn't hit this repo yet, or no prNumber)
        // just leaves the column at its previous value, same as any other
        // best-effort lookup in this loop.
        let cachedHeadSha: string | undefined;
        if (task.prNumber !== null) {
          const repoRef = await resolveRepoRef(app, project);
          const cached = repoRef ? getPRsStatus(repoRef.owner, repoRef.repo) : null;
          cachedHeadSha = cached?.prs.find((p) => p.number === task.prNumber)?.headSha;
        }
        const updated = app.db
          .update(tasks)
          .set({
            reviewFindings: appendedFindings,
            reviewFindingsIngestedSessionId: task.reviewSessionId,
            lastReviewVerdict: verdict,
            ...(announcingCap ? { autoReturnCapAnnouncedAt: new Date() } : {}),
            ...(cachedHeadSha !== undefined ? { lastReviewedHeadSha: cachedHeadSha } : {}),
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
          .run();
        // Lost the race — the findings file is still stale for whatever
        // reconcile this task next (a rejected task keeps the same
        // autoReturnRounds, so its next review reuses this exact
        // round-suffixed path), so unlink it here too, before giving up on
        // this row.
        if (updated.changes === 0) {
          await unlinkFindingsFileIfPresent(app, backend, task.id, task.autoReturnRounds);
          continue;
        }

        // The DB write above is now durable — the file has nothing left to
        // offer a later reconcile pass, and leaving it in place is exactly
        // what would cause a same-round re-review (reject keeps
        // autoReturnRounds unchanged) to re-ingest THIS round's content as
        // if it were fresh.
        await unlinkFindingsFileIfPresent(app, backend, task.id, task.autoReturnRounds);
        // #756 — a task that wanted another round but had none left gets one
        // extra sentence folded into the SAME comment, rather than a second
        // post: today's single-comment-per-round shape stays exactly that,
        // shape, just occasionally longer. This is also the only place a
        // human ever learns the round cap was the reason nothing moved —
        // without it, a capped task looks identical to one that was never
        // going to auto-return in the first place.
        //
        // Task 258971's investigation: this note must be appended to
        // `reviewSummary` too, not just `body` — `postReviewFindingsComment`
        // posts `reviewSummary` as the review's own text whenever there are
        // anchored findings (`params.findings !== undefined && anchored.length
        // > 0`), which is the common case for a real changes-requested
        // verdict. Appending only to `body` meant the note was silently
        // dropped on every review that actually had findings to anchor —
        // exactly the capped-and-parked case this exists to surface.
        const cappedNote =
          wantsAutoReturn && capReached
            ? `\n\n_Automatic round cap (${maxRounds}) reached for this task — it needs a human to take it from here._`
            : "";
        await postReviewFindingsComment(
          app,
          task,
          project,
          parsed
            ? {
                body: commentBody + cappedNote,
                reviewSummary: `${roundLabel}\n\n${renderReviewFindingsMarkdown(parsed, "review-body")}${cappedNote}`,
                findings: parsed.findings,
                verdict,
              }
            : { body: commentBody + cappedNote, verdict },
        );

        // D1 — a "clean" verdict is corroborating evidence any of Mullion's
        // own earlier anchored findings on this PR were actually addressed;
        // resolve them now so a repo requiring conversation resolution
        // doesn't deadlock on a self-inflicted stale thread. Never fires on
        // "changes-requested" (there's nothing to corroborate yet) or
        // "inconclusive" (a crashed/silent reviewer confirms nothing).
        if (verdict === "clean") {
          await resolveMullionOwnThreadsIfClean(app, task, project);
        }

        if (!shouldAutoReturn) continue;

        const prompt = buildReviewFeedbackPrompt({
          task,
          branchName: task.branchName ?? deriveTaskBranchName(task),
          worktreePath: task.worktreePath!,
          budgetMinutes: resolvedTaskMaster.budgetMinutes,
          // Nobody is watching an automated review-feedback round.
          auto: true,
          // Rendered, not the raw findings-file content — `shouldAutoReturn`
          // guarantees `parsed !== null` here, but `parsed` may be JSON; the
          // worker should read prose, not the wire format Mullion parses.
          findings: renderReviewFindingsMarkdown(parsed!, "worker-prompt"),
          // #778 — resolved against the OWNING host's own sessionsDir; see
          // spawnReviewAgentNow's own comment for the full rationale.
          commitTitlePath: project.conventionalCommitTitles
            ? taskCommitTitlePath(
                await resolveSessionsDirWithFallback(app, backend, {
                  taskId: task.id,
                  hostId: project.hostId,
                }),
                task.id,
              )
            : undefined,
        });
        await autoReturnTask(app, task, project, { reason: "review", seedPrompt: prompt });
      }
    }),
  );
}

/**
 * Issue #1039 — the follow-up half of #1038's fix. A capped, parked task
 * (`autoReturnCapAnnouncedAt` non-null — see that column's own doc comment
 * in schema.ts) has spent every automatic round it's allowed, but a human
 * can still fix the underlying problem out-of-band by pushing directly to
 * the PR branch instead of clicking Reject in the UI. Before this, nothing
 * ever re-evaluated that task: `reviewSessionId` stays fixed, no new review
 * spawns (processPendingReviewSpawns only spawns for a null reviewSessionId
 * — see the docblock on `reconcileTasks` below), and `lastReviewVerdict`
 * stays frozen at whatever the last automatic round produced — so a human
 * had to hand-approve even a fix that visibly resolved everything.
 *
 * This re-arms exactly ONE more genuine review when the PR's head SHA has
 * moved past the one the task's own findings were last ingested against —
 * clearing `autoReturnCapAnnouncedAt`/`reviewSessionId`/`reviewSeedDelivered`/
 * `reviewSpawnClaimedAt` so `processPendingReviewSpawns` picks the task back
 * up, the same shape the `in_progress -> reviewing` transition below already
 * produces (all four fields, not three — a successful spawn never clears its
 * own `reviewSpawnClaimedAt` claim, so it's still set from the round that
 * produced this parked state; leaving it would make processPendingReviewSpawns'
 * own claim CAS refuse to spawn for up to REVIEW_SPAWN_CLAIM_STALE_MS, or
 * permanently once this row stops matching this sweep's own query below).
 * Deliberately does NOT touch `autoReturnRounds` — the human did the work,
 * not the worker, so this doesn't spend a round. It also can't loop
 * autonomously — each cycle requires a fresh, GENUINE head-SHA change —
 * because this write always stamps `lastReviewedHeadSha` itself, even on a
 * null-baseline re-arm (see below): without that, a re-arm whose own
 * triggered review happened to ingest while the poller's cache was cold
 * (routine, not rare — `CACHE_TTL_MS` is shorter than
 * `GITHUB_POLL_INTERVAL_QUIET` can be) would leave the baseline null again,
 * and the very next sweep tick would re-arm a second time with no human
 * push anywhere in the cycle. If the triggered round comes back
 * `changes-requested` again, `processReviewingTasks` re-announces the cap
 * (still capped, same `autoReturnRounds`) and the task parks again exactly
 * as before — now with a real baseline, so it stays parked until an actual
 * push moves the SHA.
 *
 * Reads the PR's current head SHA from github-pr-poller.ts's own cache
 * (`getPRsStatus`) rather than fetching it fresh — this sweep runs every
 * reconcile tick, and a capped task can sit parked for a long time, so a
 * live GitHub call per tick per parked task would be pure waste against
 * data the poller already keeps warm independently.
 */
async function reannounceCappedTasksAfterHumanPush(app: FastifyInstance): Promise<void> {
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  if (!resolvedTaskMaster.enabled) return;

  const rows = app.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(tasks.status, "reviewing"),
        isNotNull(tasks.autoReturnCapAnnouncedAt),
        isNotNull(tasks.prNumber),
      ),
    )
    .all();
  if (rows.length === 0) return;

  for (const { task, project } of rows) {
    const repoRef = await resolveRepoRef(app, project);
    if (!repoRef) continue;
    const cached = getPRsStatus(repoRef.owner, repoRef.repo);
    if (!cached) continue;
    const pr = cached.prs.find((p) => p.number === task.prNumber);
    if (!pr) continue;

    // No baseline (the poller's cache was cold at the last ingest) is
    // treated as "unknown," not "unchanged": the two possible mistakes
    // aren't symmetric. Backfilling silently here risks recording a SHA
    // that's ALREADY the human's fix (the cache warmed up after the push,
    // not before it) — permanently losing the exact push this feature
    // exists to detect. Re-arming once on a null baseline costs one
    // advisory review that re-parks if there was nothing to find; that's
    // the safer direction to be wrong in.
    if (task.lastReviewedHeadSha !== null && pr.headSha === task.lastReviewedHeadSha) continue;

    // Narrowed by the query's own `isNotNull(tasks.autoReturnCapAnnouncedAt)`
    // filter above — TypeScript can't see that across the two queries.
    const announcedAt = task.autoReturnCapAnnouncedAt;
    if (announcedAt === null) continue;

    // CAS'd on the exact `autoReturnCapAnnouncedAt` value read above (not
    // just non-null) so a concurrent Reject/Approve/Give-up — which each
    // already clear or leave this task's row in a different shape — wins
    // outright rather than this write clobbering a decision that landed in
    // the gap between the read and this write. Also clears
    // `reviewSpawnClaimedAt` — a successful spawn (spawnReviewAgentNow)
    // never clears its own claim, only the `in_progress -> reviewing`
    // transition and a failed spawn do, so it's still set from the round
    // that produced this parked state; left as-is, processPendingReviewSpawns'
    // own claim CAS would refuse to spawn a fresh review for up to
    // REVIEW_SPAWN_CLAIM_STALE_MS (10 minutes) — or, once this row no
    // longer matches the `isNotNull(autoReturnCapAnnouncedAt)` filter above
    // after this write, forever.
    // Also stamps `lastReviewedHeadSha` here, not just at the next ingest:
    // without it, a null-baseline re-arm (the sha comparison above skips
    // entirely when there's no prior baseline) could loop autonomously —
    // if the fresh review that this re-arm triggers happens to ingest while
    // the poller's cache is cold (routine, not rare: CACHE_TTL_MS is 60s,
    // shorter than GITHUB_POLL_INTERVAL_QUIET can be), the ingest write's
    // own best-effort lookup misses too, `lastReviewedHeadSha` stays null,
    // the cap re-announces, and the NEXT sweep tick re-arms again — with no
    // human push anywhere in the cycle. Setting it here closes that gap:
    // the baseline is established the instant this fires, so only a
    // GENUINE subsequent head-SHA change can trigger another re-arm.
    app.db
      .update(tasks)
      .set({
        autoReturnCapAnnouncedAt: null,
        reviewSessionId: null,
        reviewSeedDelivered: null,
        reviewSpawnClaimedAt: null,
        lastReviewedHeadSha: pr.headSha,
      })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.status, "reviewing"),
          eq(tasks.autoReturnCapAnnouncedAt, announcedAt),
        ),
      )
      .run();
  }
}

/**
 * Phase 6 Task Master (6.2/#215) — the automatic-transition half of the
 * state machine (task-state.ts owns the legal-transition table; this is
 * what actually walks it). Polls every task in "claimed"/"in_progress" and:
 *
 *  - flips it to "reviewing" once its worker session's derived status is
 *    "finished" (the same "turn is over" signal session-status.ts already
 *    derives — see deriveSessionStatus's own precedence rules; not a new
 *    heuristic) — but only while Task Master is enabled. Hermes review, PR
 *    #480 (second pass): approve/reject are the only routes that can
 *    resolve a "reviewing" task, and both are gated on the same "enabled"
 *    flag, so entering "reviewing" while disabled would strand the task
 *    with no way out short of re-enabling. A finished session while
 *    disabled is left in claimed/in_progress instead — still reachable by
 *    the budget force-fail below, and it transitions normally on the next
 *    tick once re-enabled.
 *  - does NOT flip "claimed" to "in_progress" — that transition used to
 *    live here (on the session showing any signal beyond pure idle
 *    silence), but task-claim queueing (the rate-limit-storm fix) moved it
 *    into dispatch's own reservation transaction, synchronous with the
 *    claim itself. A "claimed" row therefore never has a session by the
 *    time this loop's own query (an INNER JOIN on `sessions`) could
 *    observe one — see this loop's own comment further down, at its
 *    former call site, for the detail (also why task-state.ts's
 *    `claimed -> reviewing` edge, while still legal for the type system,
 *    is unreachable via this path today).
 *  - flips it to "failed" (and terminates the session) once
 *    MULLION_TASK_BUDGET_MINUTES has elapsed since claimedAt, regardless of
 *    what the session is doing — the budget is a hard backstop, not a
 *    negotiation with the agent's own judgment.
 *  - on entering "reviewing" (either path above), opens a draft PR
 *    (maybeOpenDraftPR above — best-effort, never blocks the transition)
 *    and spawns the configured review agent if one is set (see
 *    maybeSpawnReviewAgent above) — advisory only, in the worker's own
 *    worktree.
 *
 * Does NOT otherwise touch "reviewing" tasks — the roadmap's own
 * distinction: a reviewing task's session exiting doesn't fail it (the turn
 * is over, the work is committed on its branch, still promotable), so
 * reviewing tasks have no liveness/budget dependency here. That's #282's
 * job for claimed/in_progress specifically (session-reconciler.ts), and
 * approve/reject/give-up's job for reviewing. `processReviewingTasks` above
 * is the one narrow exception — it reads a finished REVIEW session's
 * output, never the worker session's, and never fails or terminates
 * anything.
 *
 * Grouped one liveStatus call per host, same shape as
 * session-reconciler.ts's reconcileExitedSessions — a host that's merely
 * unreachable right now is skipped entirely for this pass, never treated as
 * "every task on it should fail."
 */
export async function reconcileTasks(app: FastifyInstance): Promise<void> {
  // Independent of the claimed/in_progress pass below — must not sit behind
  // its own `rows.length === 0` early return, or a reviewing task's
  // findings would never be processed on a tick with no claimed/in_progress
  // work at all.
  await processReviewingTasks(app);
  // Runs right after processReviewingTasks, same tick — both re-read from
  // the DB, so a verdict ingested earlier in this pass is already visible
  // and can be acted on immediately, not deferred to the next tick.
  await processAutoApprovals(app);
  // Same independence reasoning — a stranded "reviewing" task with no PR
  // needs to keep being retried regardless of whether anything is currently
  // claimed/in_progress.
  await retryStrandedDraftPRs(app);
  // Same independence reasoning again — a "done" task with a merge
  // outstanding needs to keep being retried regardless of what's currently
  // claimed/in_progress.
  await processMergeRequests(app);
  // #744 — runs right after processMergeRequests, same tick and same
  // independence reasoning: a project with tasks awaiting autorelease needs
  // to keep being retried regardless of what's currently claimed/in_progress.
  await processReleaseRequests(app);
  // Issue #1039 — same independence reasoning again: a capped, parked task
  // waiting on a human's out-of-band push needs to keep being checked
  // regardless of what's currently claimed/in_progress.
  await reannounceCappedTasksAfterHumanPush(app);

  const rows = app.db
    .select({ task: tasks, session: sessions, project: projects })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.sessionId, sessions.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(inArray(tasks.status, ["claimed", "in_progress"]))
    .all();
  // `if (rows.length > 0) { ... }`, NOT an early `return` — processPendingReviewSpawns
  // below must run every tick regardless of whether anything is
  // claimed/in_progress (same reasoning as processReviewingTasks/
  // retryStrandedDraftPRs at the top of this function), or a task sitting
  // in "reviewing" waiting on CI with nothing else going on would never get
  // re-checked once its wait window ends.
  if (rows.length > 0) {
    const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
    // Settings-backed override of MULLION_TASK_BUDGET_MINUTES (Task Master
    // Settings UI follow-up) — see task-config.ts's doc comment. Resolved
    // once per pass and reused below for maybeSpawnReviewAgent's own gate.
    const resolvedTaskMaster = resolveTaskMasterConfig(app);
    const budgetMinutes = resolvedTaskMaster.budgetMinutes;

    const byHost = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = byHost.get(row.project.hostId) ?? [];
      group.push(row);
      byHost.set(row.project.hostId, group);
    }

    await Promise.all(
      [...byHost.entries()].map(async ([hostId, hostRows]) => {
        const backend = resolveBackend(app, hostId);
        let liveMap: Record<string, SessionInfo | null>;
        try {
          liveMap = await backend.liveStatus(
            hostRows.map((r) => String(r.session.id)),
            idleThresholdMs,
          );
        } catch (err) {
          app.log.warn({ hostId, err }, "task reconcile: host unreachable, skipping its tasks");
          return;
        }

        for (const row of hostRows) {
          const { task, session, project } = row;
          const now = new Date();

          // Budget check first — an expired task is failed regardless of
          // what its session is currently doing. 0 = unlimited (opt out).
          if (budgetMinutes > 0) {
            const deadline = new Date(task.claimedAt!.getTime() + budgetMinutes * 60_000);
            if (now > deadline) {
              const updated = app.db
                .update(tasks)
                .set({
                  status: "failed",
                  failureReason: `budget exceeded after ${budgetMinutes} minutes`,
                  completedAt: now,
                })
                .where(
                  and(eq(tasks.id, task.id), inArray(tasks.status, ["claimed", "in_progress"])),
                )
                .run();
              if (updated.changes > 0) {
                recordTaskTransition(app, {
                  taskId: task.id,
                  projectId: project.id,
                  // Narrowed by the WHERE clause above (`inArray(..., ["claimed", "in_progress"])`).
                  from: task.status as "claimed" | "in_progress",
                  to: "failed",
                  via: "budget-exceeded",
                  context: { sessionId: session.id, budgetMinutes },
                });
                // killSession, not a bare backend.terminate — same reasoning
                // as failReviewingGate's identical swap above: this task
                // just left claimed/in_progress for good, and a bare
                // terminate would leave the session "active" until the 30s
                // reconciler notices, never "killed."
                await killSession(app, session.id).catch((err) => {
                  app.log.warn(
                    { err, taskId: task.id, sessionId: session.id },
                    "task reconcile: failed to kill over-budget session",
                  );
                });
                await syncTaskTransition(
                  app,
                  {
                    ...task,
                    status: "failed",
                    failureReason: `budget exceeded after ${budgetMinutes} minutes`,
                    completedAt: now,
                  },
                  project,
                  "failed",
                );
                // 6.8/#283 — best-effort; a dirty tree is left in place for
                // inspection rather than retried forever (see
                // removeWorktreeIfClean's own doc comment on why "dirty" is
                // the only real refusal condition it has).
                if (task.worktreePath) {
                  await backend
                    .removeWorktreeIfClean(task.worktreePath, project.cwd)
                    .catch((err) => {
                      app.log.warn(
                        { err, taskId: task.id, worktreePath: task.worktreePath },
                        "task reconcile: removeWorktreeIfClean threw after budget failure",
                      );
                    });
                }
              }
              continue;
            }
          }

          // A key this reachable host's response omitted is "unknown," not
          // "idle" — same posture as session-reconciler.ts's own
          // "alive === undefined -> skip, don't guess" rule.
          const info = liveMap[String(session.id)];
          if (info === undefined) continue;

          const derived = deriveSessionStatus({
            dbStatus: session.status,
            info: defaultDeriveStatusInfo(info),
          });

          // The session already exited — #282's hook in
          // session-reconciler.ts owns flipping this task to failed (it runs
          // against the session row directly, and needs to coordinate with
          // worktree cleanup); this pass must not race it with a conflicting
          // write, so it just leaves an exited-session task alone.
          if (derived.status === "exited") continue;

          // A "claimed" task's own reconciliation (both "-> reviewing" on a
          // fast-finishing first turn, and "-> in_progress" on any other
          // real activity) used to live here. Task-claim queueing
          // (rate-limit-storm fix) removed it as dead code: "claimed" is now
          // the queue state (task-claim.ts's enqueueTask/dispatchClaimedTask
          // split), so a "claimed" row never has a session — `rows`/
          // `hostRows` above are built from an INNER JOIN on `sessions`,
          // which such a row can never satisfy. Dispatch itself now flips
          // "claimed" -> "in_progress" synchronously (inside its own
          // reservation transaction, task-claim.ts), so a task with a live
          // session is always already "in_progress" by the time this sweep
          // could ever observe it — the "claimed -> reviewing" direct edge
          // (task-state.ts's transition table) stays legal for the type
          // system but is unreachable via this path now.
          if (
            task.status === "in_progress" &&
            derived.status === "finished" &&
            resolvedTaskMaster.enabled &&
            turnFinishedSinceClaim(info, task)
          ) {
            // See the matching gate/comment on the claimed -> reviewing
            // branch above — same "don't strand it in reviewing" reasoning.
            const gate = await checkReviewingGate(app, task, project, info);
            if (!gate.ok) {
              await failReviewingGate(
                app,
                task,
                session,
                project,
                backend,
                "in_progress",
                gate.failureReason,
                now,
              );
              continue;
            }
            // #761 — read BEFORE the transition write below so the same
            // write that flips this task to "reviewing" also carries its
            // title, and task-promote.ts's createOrRecoverPR (called via
            // maybeOpenDraftPR just below) sees it on its very first PR
            // create. #778 — routed through SessionBackend so a
            // remote-hosted task's worker's title file (written on its own
            // host) is actually reachable, not just this process's local
            // filesystem. Absent, unreadable, or malformed all fall back
            // identically: `prTitle` stays `null`, and task-promote.ts
            // falls back to the raw task title — never blocking the
            // transition, so a `readTaskCommitTitle` throw (host
            // unreachable, version skew) gets the same graceful fallback as
            // a local read failure, not a "wait and retry" like the
            // stricter review-findings ingest above.
            let prTitle: string | null = null;
            if (project.conventionalCommitTitles) {
              try {
                const content = await backend.readTaskCommitTitle(task.id);
                prTitle = content === null ? null : parseCommitTitle(content);
                if (content !== null && prTitle === null) {
                  app.log.warn(
                    { taskId: task.id },
                    "task reconcile: worker's PR title file didn't parse as a Conventional Commits title — falling back to the raw task title",
                  );
                }
              } catch (err) {
                app.log.warn(
                  { err, taskId: task.id },
                  "task reconcile: failed to read the worker's PR title file — falling back to the raw task title",
                );
              }
            }
            const updated = app.db
              .update(tasks)
              .set({
                status: "reviewing",
                reviewingAt: now,
                // See the matching claimed -> reviewing branch above for why
                // these are nulled here rather than left alone.
                reviewSessionId: null,
                reviewSeedDelivered: null,
                reviewSpawnClaimedAt: null,
                // Issue #1038 — a fresh review is about to spawn off this
                // write (processPendingReviewSpawns has no cap check, by
                // design), so any prior announcement is stale the instant
                // this lands, same as the sibling session-id fields above.
                autoReturnCapAnnouncedAt: null,
                // #761 — `?? task.prTitle`, not a bare overwrite: a later
                // round that doesn't rewrite the title file (see
                // `taskCommitTitlePath`'s own doc comment on why that's
                // the expected common case, not an error) must not erase
                // an earlier round's good title.
                prTitle: prTitle ?? task.prTitle,
              })
              .where(and(eq(tasks.id, task.id), eq(tasks.status, "in_progress")))
              .run();
            if (updated.changes > 0) {
              // The write above just nulled reviewSessionId — on a
              // reject-and-re-review cycle, `task.reviewSessionId` (captured
              // before that write, still the OLD value in memory) is the
              // now-unreachable prior round's review session. Kill it here:
              // nothing else in this codebase ever terminates a review
              // session on this path, so without this it's left "active"
              // forever, no longer pointed to by any task row — exactly the
              // orphan this PR exists to stop creating (see #772).
              // Best-effort, fire-and-forget — deliberately NOT awaited,
              // unlike retryTask's/failReviewingGate's own kill calls
              // (task-claim.ts, above in this file): those run at the END
              // of their function, with nothing left to do afterward, so
              // awaiting costs nothing. This one sits in the MIDDLE of the
              // "-> reviewing" transition, with `recordTaskTransition` and
              // `syncTaskTransition` still to come — a kill failure must
              // not block or delay either of those, so it fires and moves
              // on rather than adding a network round-trip to this task's
              // own transition. Both postures are correct for where they
              // sit; this is not an inconsistency to "harmonize" later.
              if (task.reviewSessionId !== null) {
                void killSession(app, task.reviewSessionId).catch((err) => {
                  app.log.warn(
                    { err, taskId: task.id, reviewSessionId: task.reviewSessionId },
                    "task reconcile: failed to kill the superseded review session",
                  );
                });
              }
              recordTaskTransition(app, {
                taskId: task.id,
                projectId: project.id,
                from: "in_progress",
                to: "reviewing",
                via: "reconcile",
              });
              // #761 — carries the freshly-ingested `prTitle` (the DB write
              // above may have set it; `task` itself is still the
              // pre-transition in-memory snapshot) so `maybeOpenDraftPR`'s
              // very first PR-create call already has it, not just a later
              // reconcile tick's re-read.
              const transitionedTask = {
                ...task,
                status: "reviewing" as const,
                reviewingAt: now,
                prTitle: prTitle ?? task.prTitle,
              };
              await syncTaskTransition(app, transitionedTask, project, "reviewing", {
                diffStat: await computeTaskDiffStat(app, task, project),
              });
              await maybeOpenDraftPR(app, transitionedTask, project);
            }
          }
        }
      }),
    );
  }

  // Deliberately LAST, not alongside processReviewingTasks/
  // retryStrandedDraftPRs above: this needs to see tasks that transitioned
  // into "reviewing" during the claimed/in_progress loop just above, in
  // THIS SAME tick — the exact "freshly re-spawned session, not yet visible
  // to an earlier pass in the same call" ordering hazard
  // processReviewingTasks's own mockFinishedSessionIds doc comment
  // describes, just for the opposite pass. Running it first would only ever
  // see reviewing tasks left over from a PRIOR tick, and a task's own
  // "→ reviewing" transition — which is what actually nulls
  // reviewSessionId — hasn't happened yet at that point in this function.
  // One call covers both: a same-tick transition AND a leftover task a
  // previous tick decided to "wait" on (still `reviewSessionId IS NULL`
  // either way) — no separate leftover-specific pass needed.
  await processPendingReviewSpawns(app);
}
