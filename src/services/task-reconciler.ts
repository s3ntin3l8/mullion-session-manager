import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, sessions, tasks } from "../db/schema.js";
import type { SessionInfo } from "./pty-manager.js";
// createSessionRecord is pure business logic filed under services/
// (session-lifecycle.ts) precisely so a service can reuse it directly.
import { createSessionRecord, killSession } from "./session-lifecycle.js";
import { resolveBackend, type SessionBackend } from "./session-backend.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { defaultDeriveStatusInfo, deriveSessionStatus } from "./session-status.js";
import { getStoredSettings } from "./settings.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import {
  resolveReviewAgentCommand,
  commandSupportsSeed,
  resolveSeedDelivered,
} from "./task-agent-resolve.js";
import {
  syncTaskTransition,
  computeTaskDiffStat,
  postReviewFindingsComment,
} from "./task-github-sync.js";
import { recordTaskTransition } from "./task-state.js";
import {
  buildReviewPrompt,
  buildReviewFeedbackPrompt,
  taskReviewFindingsPath,
  parseReviewFindings,
  renderReviewFindingsMarkdown,
  type ReviewCiInfo,
} from "./task-prompt.js";
import { openDraftPRForTask } from "./task-promote.js";
import { reseedTaskIfSessionExited } from "./task-reseed.js";
import { resolveHostGitStatus, resolveRepoRef } from "./host-git.js";
import { commitWipChanges } from "./git-worktree.js";
import { resolveGitHubToken } from "./github-integration.js";
import {
  getPullRequestByNumber,
  mergePullRequest,
  updatePullRequestBranch,
  deleteRemoteBranch,
} from "./github-write.js";
import { computeCiStatus, fetchRunsForHead } from "./github.js";

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
    // task.reviewRounds is the round THIS review belongs to: 0 for the
    // first review, 1 for the one spawned after an auto-returned round —
    // see taskReviewFindingsPath's own doc comment for why round-suffixing
    // matters here.
    const findingsPath = taskReviewFindingsPath(
      path.dirname(app.pty.hookSocketPath),
      task.id,
      task.reviewRounds,
    );
    // Task Master trial 220921 / PR #743's incident left exactly this file
    // on disk: `processReviewingTasks`'s own unlink-on-ingest ran before the
    // real (late-arriving) findings file existed, so it found nothing to
    // remove, and the file that appeared 21 seconds later was never cleaned
    // up. `reviewRounds` doesn't change on a same-round re-review (a
    // rejected task's next review reuses this exact round-suffixed path —
    // see `taskReviewFindingsPath`'s own doc comment on why round-suffixing
    // exists at all), so a leftover from a PRIOR attempt at this round would
    // otherwise be silently re-ingested as THIS attempt's fresh output.
    // Unlinking here, before the agent gets a chance to write anything, is
    // the fix: whatever this fresh spawn's own agent writes is now
    // guaranteed to be the only thing this path can ever contain.
    unlinkFindingsFileIfPresent(app, task.id, findingsPath);
    const prompt = buildReviewPrompt({ task, worktreePath: task.worktreePath, findingsPath, ci });
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command: reviewCommand,
      cwd: task.worktreePath,
      initialPrompt: seedCapable ? prompt : undefined,
      skipPermissions,
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
    const repoRef = await resolveRepoRef(app, project);
    if (!repoRef) return undefined;
    // "read" scope (#489's least-privilege split) — this only ever reads
    // the PR and its Actions runs, never writes.
    const token = await resolveGitHubToken(app, repoRef, "read");
    if (!token) return undefined;
    const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
    const runs = await fetchRunsForHead(token, repoRef.owner, repoRef.repo, pr.headSha);
    const status = computeCiStatus(runs);
    const runSummaries = runs.map((r) => ({
      name: r.name,
      conclusion: r.conclusion,
      htmlUrl: r.htmlUrl,
    }));

    if (status !== "in_progress" && status !== null) {
      return { headSha: pr.headSha, status, runs: runSummaries };
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
      headSha: pr.headSha,
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
  await backend.terminate(String(session.id)).catch((err) => {
    app.log.warn(
      { err, taskId: task.id, sessionId: session.id },
      "task reconcile: failed to terminate session after the no-commits gate failure",
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

async function retryStrandedDraftPRs(app: FastifyInstance): Promise<void> {
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  // Same gate as the transition itself (Hermes review, PR #480) — a retry
  // is still "real GitHub state," not a passive read.
  if (!resolvedTaskMaster.enabled) return;

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
const mergeRetryState = new Map<number, { lastAttemptedAt: number; attempts: number }>();

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

function clearMergeState(app: FastifyInstance, taskId: number): void {
  app.db
    .update(tasks)
    .set({ mergeRequestedAt: null, mergeError: null })
    .where(eq(tasks.id, taskId))
    .run();
  // Hermes review, PR #763 — without this, a resolved task's backoff entry
  // lingers in mergeRetryState until MAX_MERGE_RETRY_ENTRIES forces an
  // oldest-insertion eviction, which can evict an ACTIVELY retrying task's
  // entry instead of a resolved one, silently resetting its backoff/attempt
  // count. Deleting here (unlike draftPrRetryState's own "never gets read
  // again" reasoning, which relies on the row dropping out of that sweep's
  // WHERE clause) closes that gap directly.
  mergeRetryState.delete(taskId);
}

function recordMergeError(app: FastifyInstance, taskId: number, message: string): void {
  app.db.update(tasks).set({ mergeError: message }).where(eq(tasks.id, taskId)).run();
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

    if (pr.merged || pr.state === "closed") {
      // Merged or closed out of band (a human merged it directly on GitHub,
      // or closed it) — idempotent no-op, not an error.
      clearMergeState(app, task.id);
      return;
    }

    switch (pr.mergeableState) {
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
        clearMergeState(app, task.id);
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
        // needs a rebase (see the auto-rebase follow-up issue) or a human.
        recordMergeError(app, task.id, "Conflicts with main — needs manual resolution");
        return;
      }
      case "blocked": {
        // A required check is red or still pending.
        recordMergeError(app, task.id, "Required checks are red or still pending");
        return;
      }
      default: {
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

    const state = mergeRetryState.get(task.id);
    if (state !== undefined && now - state.lastAttemptedAt < mergeRetryBackoffMs(state.attempts))
      continue;

    attempted++;
    if (!mergeRetryState.has(task.id) && mergeRetryState.size >= MAX_MERGE_RETRY_ENTRIES) {
      const oldest = mergeRetryState.keys().next().value;
      if (oldest !== undefined) mergeRetryState.delete(oldest);
    }
    mergeRetryState.set(task.id, { lastAttemptedAt: now, attempts: (state?.attempts ?? 0) + 1 });

    await attemptMerge(app, task, project);
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
 *  - if the verdict is "changes-requested" AND this task hasn't already used
 *    its one auto-return (`reviewRounds < 1`) AND Task Master is enabled:
 *    flips the task back to "in_progress", increments `reviewRounds` (a
 *    compare-and-swap write, same as every other transition in this file —
 *    a concurrent approve/reject/give-up simply wins the race and this
 *    loop no-ops), and re-seeds the worker
 *    (`reseedTaskIfSessionExited`, task-reseed.ts, shared with reject's own
 *    re-seed but called with `force: true` here — see that function's own
 *    doc comment on why: nobody is watching to type into a still-alive
 *    worker session the way a human reviewing a reject is) with the
 *    findings as its prompt. A "clean" verdict never auto-returns — that's
 *    the whole reason file-existence stopped being the signal (see
 *    `parseReviewFindings`'s doc comment).
 *
 * Gated on `resolveTaskMasterConfig(app).enabled` for the auto-return step
 * only (same reasoning as the claimed/in_progress loop's own "enabled"
 * gates below) — reading and posting the findings themselves is pure
 * visibility, ungated, so a disabled install still surfaces "review
 * finished" instead of going silent.
 */
function unlinkFindingsFileIfPresent(
  app: FastifyInstance,
  taskId: number,
  findingsPath: string,
): void {
  try {
    if (existsSync(findingsPath)) unlinkSync(findingsPath);
  } catch (err) {
    app.log.warn(
      { err, taskId, findingsPath },
      "task reconcile: failed to remove an ingested review findings file",
    );
  }
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
  const sessionsDir = path.dirname(app.pty.hookSocketPath);

  const byHost = new Map<string, typeof allRows>();
  for (const row of allRows) {
    // Hermes review, PR #576 — the findings file the review prompt tells the
    // agent to write is read from THIS process's own local sessionsDir
    // below; a remote-hosted review agent's file lands on the REMOTE host's
    // filesystem instead, which SessionBackend has no generic file-read for.
    // Reading local-only wouldn't error — it would just find nothing and
    // falsely conclude the review was inconclusive, ingesting and commenting
    // a lie about a review that may have found real, unreported issues. Skip
    // entirely rather than mis-ingest. Unlike #484's other remote-hosted
    // gaps (promotion/ingest/orphan-sweep/retry, all now proxied), this one
    // stays local-only — it needs a generic remote file-read on
    // SessionBackend, a distinct piece of work, not part of #484's scope.
    if (row.project.hostId !== LOCAL_HOST_ID) {
      app.log.info(
        { taskId: row.task.id, hostId: row.project.hostId },
        "task reconcile: skipping review-findings ingestion for a remote-hosted task (not supported yet)",
      );
      continue;
    }
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

        const findingsPath = taskReviewFindingsPath(sessionsDir, task.id, task.reviewRounds);
        let findings: string | null = null;
        try {
          if (existsSync(findingsPath)) {
            const content = readFileSync(findingsPath, "utf8").trim();
            if (content.length > 0) findings = content;
          }
        } catch (err) {
          app.log.warn(
            { err, taskId: task.id, findingsPath },
            "task reconcile: failed to read review findings file",
          );
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

        const roundLabel = `## Round ${task.reviewRounds + 1}`;
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
        const shouldAutoReturn =
          derived.status === "finished" &&
          parsed !== null &&
          parsed.verdict === "changes-requested" &&
          task.reviewRounds < 1 &&
          resolvedTaskMaster.enabled &&
          task.worktreePath !== null &&
          task.agentCommand !== null &&
          commandSupportsSeed(task.agentCommand);

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
        const updated = app.db
          .update(tasks)
          .set(
            shouldAutoReturn
              ? {
                  status: "in_progress",
                  reviewFindings: appendedFindings,
                  reviewFindingsIngestedSessionId: task.reviewSessionId,
                  reviewRounds: task.reviewRounds + 1,
                  lastReviewVerdict: parsed?.verdict ?? "inconclusive",
                }
              : {
                  reviewFindings: appendedFindings,
                  reviewFindingsIngestedSessionId: task.reviewSessionId,
                  lastReviewVerdict: parsed?.verdict ?? "inconclusive",
                },
          )
          .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
          .run();
        // Lost the race — the findings file is still stale for whatever
        // reconcile this task next (a rejected task keeps the same
        // reviewRounds, so its next review reuses this exact round-suffixed
        // path), so unlink it here too, before giving up on this row.
        if (updated.changes === 0) {
          unlinkFindingsFileIfPresent(app, task.id, findingsPath);
          continue;
        }

        // The DB write above is now durable — the file has nothing left to
        // offer a later reconcile pass, and leaving it in place is exactly
        // what would cause a same-round re-review (reject keeps reviewRounds
        // unchanged) to re-ingest THIS round's content as if it were fresh.
        unlinkFindingsFileIfPresent(app, task.id, findingsPath);
        await postReviewFindingsComment(
          app,
          task,
          project,
          parsed
            ? {
                body: commentBody,
                reviewSummary: `${roundLabel}\n\n${parsed.summary}`,
                findings: parsed.findings,
              }
            : { body: commentBody },
        );

        if (!shouldAutoReturn) continue;

        recordTaskTransition(app, {
          taskId: task.id,
          projectId: project.id,
          from: "reviewing",
          to: "in_progress",
          via: "review-feedback",
        });

        const prompt = buildReviewFeedbackPrompt({
          task,
          branchName: task.branchName ?? `mullion/task-${task.id}`,
          worktreePath: task.worktreePath!,
          budgetMinutes: resolvedTaskMaster.budgetMinutes,
          // Nobody is watching an automated review-feedback round.
          auto: true,
          // Rendered, not the raw findings-file content — `shouldAutoReturn`
          // guarantees `parsed !== null` here, but `parsed` may be JSON; the
          // worker should read prose, not the wire format Mullion parses.
          findings: renderReviewFindingsMarkdown(parsed!),
        });
        // force: true — unlike reject's own re-seed, nobody is watching to
        // type into a still-alive worker (the worker's own instructions
        // tell it to stay running after finishing its turn, so "still
        // alive but idle" is the COMMON case here, not an edge case). See
        // reseedTaskIfSessionExited's own doc comment.
        const reseeded = await reseedTaskIfSessionExited(
          app,
          task,
          project,
          prompt,
          "task review-feedback",
          { force: true },
        );
        // Hermes review, PR #580 — a failed re-seed (terminate/spawn error,
        // or a lost race — see reseedTaskIfSessionExited's own doc comment)
        // must not silently burn the task's one auto-return round: nobody
        // received the findings, so a later, genuine round should still get
        // its chance. reviewRounds is never reset elsewhere, so rolling it
        // back here is the only way to keep that promise honest. Best-effort
        // and CAS'd on the exact value this iteration itself just wrote —
        // a concurrent write in between (e.g. approve/give-up) wins outright.
        if (!reseeded) {
          const rolledBack = app.db
            .update(tasks)
            .set({ reviewRounds: task.reviewRounds })
            .where(and(eq(tasks.id, task.id), eq(tasks.reviewRounds, task.reviewRounds + 1)))
            .run();
          app.log.warn(
            { taskId: task.id, rolledBack: rolledBack.changes > 0 },
            "task reconcile: review-feedback re-seed failed — rolled back the spent auto-return round so a later review can still use it",
          );
        }
      }
    }),
  );
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
 *  - flips "claimed" to "in_progress" once the session shows ANY signal
 *    beyond pure idle silence (derived.status !== "idle") — i.e. the agent
 *    has started doing something. A task whose very first observed signal
 *    is already "finished" skips straight there (task-state.ts's
 *    claimed -> reviewing edge) rather than forcing a synthetic
 *    intermediate write for a tick nothing was actually seen at.
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
  // Same independence reasoning — a stranded "reviewing" task with no PR
  // needs to keep being retried regardless of whether anything is currently
  // claimed/in_progress.
  await retryStrandedDraftPRs(app);
  // Same independence reasoning again — a "done" task with a merge
  // outstanding needs to keep being retried regardless of what's currently
  // claimed/in_progress.
  await processMergeRequests(app);

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
                await backend.terminate(String(session.id)).catch((err) => {
                  app.log.warn(
                    { err, taskId: task.id, sessionId: session.id },
                    "task reconcile: failed to terminate over-budget session",
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
              })
              .where(and(eq(tasks.id, task.id), eq(tasks.status, "in_progress")))
              .run();
            if (updated.changes > 0) {
              recordTaskTransition(app, {
                taskId: task.id,
                projectId: project.id,
                from: "in_progress",
                to: "reviewing",
                via: "reconcile",
              });
              await syncTaskTransition(
                app,
                { ...task, status: "reviewing", reviewingAt: now },
                project,
                "reviewing",
                { diffStat: await computeTaskDiffStat(app, task, project) },
              );
              await maybeOpenDraftPR(app, task, project);
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
