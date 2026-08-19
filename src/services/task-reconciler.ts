import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, sessions, tasks } from "../db/schema.js";
import type { SessionInfo } from "./pty-manager.js";
// createSessionRecord is pure business logic filed under services/
// (session-lifecycle.ts) precisely so a service can reuse it directly.
import { createSessionRecord } from "./session-lifecycle.js";
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
} from "./task-prompt.js";
import { openDraftPRForTask } from "./task-promote.js";
import { reseedTaskIfSessionExited } from "./task-reseed.js";
import { resolveHostGitStatus } from "./host-git.js";
import { commitWipChanges } from "./git-worktree.js";

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
 */
async function maybeSpawnReviewAgent(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  skipPermissions: boolean,
): Promise<void> {
  if (!task.worktreePath) return;
  const reviewCommand = resolveReviewAgentCommand(app, {
    taskReviewAgent: task.reviewAgent,
    issueBody: task.body,
    projectDefaultReviewAgent: project.defaultReviewAgent,
  });
  if (reviewCommand === null) return;

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
    const prompt = buildReviewPrompt({ task, worktreePath: task.worktreePath, findingsPath });
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
      return;
    }
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
    app.db
      .update(tasks)
      .set({ reviewSessionId: result.row.id, reviewSeedDelivered: seedDelivered })
      .where(eq(tasks.id, task.id))
      .run();
    app.log.info(
      { taskId: task.id, reviewSessionId: result.row.id, reviewCommand, seedDelivered },
      "task reconcile: review agent spawned",
    );
  } catch (err) {
    app.log.warn({ err, taskId: task.id, reviewCommand }, "task reconcile: review agent threw");
  }
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
 *    agent to write to (`taskReviewFindingsPath`, task-prompt.ts) — a
 *    missing file means no findings, not an error; the prompt tells the
 *    agent not to create one when it has none.
 *  - posts what it found (or a "no findings" note either way — this is
 *    exactly the visibility gap the review-findings loop exists to close:
 *    previously a finished review was invisible outside the session's own
 *    terminal) as one comment on the task's PR, falling back to its linked
 *    issue (`postReviewFindingsComment`, task-github-sync.ts).
 *  - appends it to `tasks.reviewFindings` under a "## Round N" header —
 *    never replaces, so an earlier round survives a later one.
 *  - if the findings are non-empty AND this task hasn't already used its
 *    one auto-return (`reviewRounds < 1`) AND Task Master is enabled: flips
 *    the task back to "in_progress", increments `reviewRounds` (a
 *    compare-and-swap write, same as every other transition in this file —
 *    a concurrent approve/reject/give-up simply wins the race and this
 *    loop no-ops), and re-seeds the worker
 *    (`reseedTaskIfSessionExited`, task-reseed.ts, shared with reject's own
 *    re-seed but called with `force: true` here — see that function's own
 *    doc comment on why: nobody is watching to type into a still-alive
 *    worker session the way a human reviewing a reject is) with the
 *    findings as its prompt.
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
    // falsely conclude "no findings", ingesting and commenting a lie. Skip
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

        // Hermes review, PR #576 — a review agent that never derives
        // "finished" (exits right after its turn instead of staying running,
        // unlike the worker preamble's own instruction — buildReviewPrompt
        // now tells it to as well, but this doesn't rely on compliance) was
        // previously skipped forever: no comment, no auto-return, silent.
        // Accept "exited" too, but ONLY when a findings file actually
        // exists — a session killed by a human, or one that crashed
        // mid-review, also derives "exited", and would otherwise get
        // ingested as a false "Review complete — no findings." permanently
        // marked processed.
        const isUsableSignal =
          derived.status === "finished" || (derived.status === "exited" && findings !== null);
        if (!isUsableSignal) continue;

        const roundLabel = `## Round ${task.reviewRounds + 1}`;
        const commentBody = findings
          ? `${roundLabel}\n\n${findings}`
          : `${roundLabel}\n\nReview complete — no findings.`;

        const appendedFindings = task.reviewFindings
          ? `${task.reviewFindings}\n\n${commentBody}`
          : commentBody;

        // Hermes review, PR #576 — a non-seed-capable worker adapter (e.g.
        // OpenCode) can't receive the findings as an initial prompt at all
        // (reseedTaskIfSessionExited delivers argv-only, same as every other
        // Task Master spawn). Auto-returning anyway would burn the task's
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
        const shouldAutoReturn =
          derived.status === "finished" &&
          findings !== null &&
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
        const updated = app.db
          .update(tasks)
          .set(
            shouldAutoReturn
              ? {
                  status: "in_progress",
                  reviewFindings: appendedFindings,
                  reviewFindingsIngestedSessionId: task.reviewSessionId,
                  reviewRounds: task.reviewRounds + 1,
                }
              : {
                  reviewFindings: appendedFindings,
                  reviewFindingsIngestedSessionId: task.reviewSessionId,
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
        await postReviewFindingsComment(app, task, project, commentBody);

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
          findings: findings!,
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

  const rows = app.db
    .select({ task: tasks, session: sessions, project: projects })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.sessionId, sessions.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(inArray(tasks.status, ["claimed", "in_progress"]))
    .all();
  if (rows.length === 0) return;

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
              .where(and(eq(tasks.id, task.id), inArray(tasks.status, ["claimed", "in_progress"])))
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
                await backend.removeWorktreeIfClean(task.worktreePath, project.cwd).catch((err) => {
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

        if (task.status === "claimed") {
          // Hermes review, PR #480 (second pass) — entering "reviewing" is
          // gated on "enabled" entirely, not just the review-agent spawn
          // below. approve/reject are BOTH gated on the same flag (they
          // write real GitHub state — PR creation, re-seeding a session),
          // so a task that reached "reviewing" while disabled would be
          // stuck there with no way to resolve it until re-enabled. Leaving
          // it in claimed/in_progress instead keeps it reachable by the
          // still-ungated budget force-fail below, and it picks up the
          // normal reviewing transition on the next tick once re-enabled.
          if (
            derived.status === "finished" &&
            resolvedTaskMaster.enabled &&
            turnFinishedSinceClaim(info, task)
          ) {
            const gate = await checkReviewingGate(app, task, project, info);
            if (!gate.ok) {
              await failReviewingGate(
                app,
                task,
                session,
                project,
                backend,
                "claimed",
                gate.failureReason,
                now,
              );
              continue;
            }
            const updated = app.db
              .update(tasks)
              .set({ status: "reviewing", startedAt: task.startedAt ?? now, reviewingAt: now })
              .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
              .run();
            if (updated.changes > 0) {
              recordTaskTransition(app, {
                taskId: task.id,
                projectId: project.id,
                from: "claimed",
                to: "reviewing",
                via: "reconcile",
              });
              await syncTaskTransition(
                app,
                {
                  ...task,
                  status: "reviewing",
                  startedAt: task.startedAt ?? now,
                  reviewingAt: now,
                },
                project,
                "reviewing",
                { diffStat: await computeTaskDiffStat(app, task, project) },
              );
              await maybeOpenDraftPR(app, task, project);
              await maybeSpawnReviewAgent(app, task, project, resolvedTaskMaster.skipPermissions);
            }
          } else if (derived.status !== "idle" && derived.status !== "finished") {
            const updated = app.db
              .update(tasks)
              .set({ status: "in_progress", startedAt: now })
              .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
              .run();
            if (updated.changes > 0) {
              recordTaskTransition(app, {
                taskId: task.id,
                projectId: project.id,
                from: "claimed",
                to: "in_progress",
                via: "reconcile",
              });
              await syncTaskTransition(
                app,
                { ...task, status: "in_progress", startedAt: now },
                project,
                "in_progress",
              );
            }
          }
        } else if (
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
            .set({ status: "reviewing", reviewingAt: now })
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
            await maybeSpawnReviewAgent(app, task, project, resolvedTaskMaster.skipPermissions);
          }
        }
      }
    }),
  );
}
