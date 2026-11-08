import { and, eq, inArray, isNull } from "drizzle-orm";
import { forceRemoveCheckout } from "./checkout-removal.js";
import type { FastifyInstance } from "fastify";
import type { projects } from "../db/schema.js";
import { sessions, tasks } from "../db/schema.js";
import type { SessionInfo } from "./pty-manager.js";
// createSessionRecord is pure business logic filed under services/
// (session-lifecycle.ts) precisely so a service can reuse it directly.
import { createSessionRecord, killSession } from "./session-lifecycle.js";
import { resolveSessionHostId, resolveTaskWorkerHost } from "./session-live-info.js";
import { parseHostCwds, projectCwdOnHost } from "./placement.js";
// closeSessionBrowserBindings — the same "confirmed-terminate" side effect
// reseedTaskIfSessionExited's own force path applies (task-reseed.ts); see
// attemptAutoRebase's stale-attempt-termination branch below for why this
// needs it too.
import { closeSessionBrowserBindings } from "./session-browsers.js";
import { resolveBackend, resolveSessionsDirWithFallback } from "./session-backend.js";
import { getStoredSettings } from "./settings.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { CLEARED_REVIEW_RUN, hasReviewHandle } from "./task-review-handle.js";
import { stopHermesRunQuietly } from "./hermes-task-review.js";
import { commandSupportsSeed, resolveSeedDelivered } from "./task-agent-resolve.js";
import { resolveTaskIssueContextSafe } from "./task-issue-context.js";
import { buildRebasePrompt, taskCommitTitlePath } from "./task-prompt.js";
import {
  MAX_RAPID_REBASE_ABORTS,
  MAX_REBASE_OUTRUNS,
  RAPID_EXIT_BACKOFF_MS,
  readPrHeadAndMergeability,
  readPrHeadSha,
  workerExitedRapidly,
} from "./worker-rapid-exit.js";
import { deriveTaskBranchName, deriveWorktreePath } from "./git-worktree.js";

const CLOCK_SKEW_TOLERANCE_MS = 5_000;

// A confirmed-merged task never carries a merge error: `mergedAt` wins over a
// late failure from an in-flight request or a slow sweep (a webhook or a
// concurrent reconcile may have recorded the merge while this one was still
// waiting on a timeout), so the write is a no-op once `mergedAt` is set.
export function recordMergeError(app: FastifyInstance, taskId: number, message: string): void {
  app.db
    .update(tasks)
    .set({ mergeError: message })
    .where(and(eq(tasks.id, taskId), isNull(tasks.mergedAt)))
    .run();
}

// #758 — bounds how many times attemptAutoRebase spawns a worker for the
// SAME task across its whole lifecycle. A separate counter/cap from
// autoReturnRounds/maxAutoReturnRounds on purpose: this task is `done` and
// never transitions (see schema.ts's rebaseAttempts doc comment), so
// autoReturnTask's CAS-on-"reviewing" mechanism doesn't apply — only the
// same shape (bounded, give-up once spent) does. No per-project override, to
// keep this PR's scope to the reconciler; add one later if it turns out to
// matter in practice.
export const MAX_REBASE_ATTEMPTS = 2;

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
 * Judges the previous auto-rebase attempt once, when it has finished: a worker
 * that ended within RAPID_EXIT_MS of its spawn without moving the PR head (its
 * agent died at once, e.g. an exhausted quota) did not really try, so its
 * attempt is refunded and the next one waits RAPID_EXIT_BACKOFF_MS. After
 * MAX_RAPID_REBASE_ABORTS such aborts the refund stops and the normal give-up
 * applies. Fails open: an unreadable session or PR head leaves the attempt
 * counted. Returns "undetermined" when it could not reach a verdict (flaky or
 * still-computing read): the caller must then keep the in-flight marker so a
 * later tick judges again. Also refunds a finished attempt that landed a mergeable head
 * (main outran it), see MAX_REBASE_OUTRUNS. Mutates `task` in memory like clearRebaseHoldIfWorkerFinished.
 */
export async function settleRapidRebaseExit(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  opts: { outrunOnly?: boolean } = {},
): Promise<"undetermined" | "settled"> {
  if (
    task.rebaseSpawnHeadSha === null ||
    task.rebaseStartedAt === null ||
    task.sessionId === null
  ) {
    return "settled";
  }
  const [session] = app.db.select().from(sessions).where(eq(sessions.id, task.sessionId)).all();
  if (session === undefined) return "settled";
  const hostId = resolveSessionHostId(app, session);
  const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
  let info: SessionInfo | null | undefined;
  try {
    const liveMap = await resolveBackend(app, hostId).liveStatus(
      [String(session.id)],
      idleThresholdMs,
    );
    info = liveMap[String(session.id)];
  } catch {
    return "settled";
  }
  // Still running (or no signal yet): judge it on a later tick.
  if (!info || !rebaseWorkerFinished(info, task)) return "settled";
  const rapid = await workerExitedRapidly(app, task, project, {
    sessionId: session.id,
    spawnedAt: task.rebaseStartedAt,
    workFinishedAt: info.workFinishedAt,
    headAtSpawn: task.rebaseSpawnHeadSha,
  });
  // `outrunOnly` (the auto-approve tick's post-push read): judge only a
  // pushed, mergeable head. A rapid exit or an unmoved head is left for the
  // dirty tick, so this never clears a marker the hold-back still depends on.
  if (rapid && opts.outrunOnly) return "settled";
  if (!rapid) {
    // An attempt that landed a mergeable head, which main then outran, did its
    // job: refund it (bounded by MAX_REBASE_OUTRUNS). The head must have moved
    // off the spawn head (so the worker's push is what GitHub reports on) and
    // GitHub must say mergeable; an unreadable or still-computing state fails
    // open and leaves the attempt counted.
    const headAtSpawn = task.rebaseSpawnHeadSha;
    const patch: Partial<typeof tasks.$inferSelect> = { rebaseSpawnHeadSha: null };
    if (task.rebaseOutrunCount < MAX_REBASE_OUTRUNS && task.rebaseAttempts > 0) {
      const pr = await readPrHeadAndMergeability(app, task, project);
      // Undetermined (unreadable, or GitHub still computing): keep the marker
      // so a later tick judges the attempt again instead of counting it for good.
      if (pr === null || (pr.headSha !== headAtSpawn && pr.mergeable === null)) {
        return "undetermined";
      }
      if (opts.outrunOnly && pr.headSha === headAtSpawn) return "undetermined";
      if (pr.headSha !== headAtSpawn && pr.mergeable) {
        patch.rebaseAttempts = task.rebaseAttempts - 1;
        patch.rebaseOutrunCount = task.rebaseOutrunCount + 1;
        app.log.info(
          { taskId: task.id, outruns: patch.rebaseOutrunCount },
          "task auto-rebase: the worker landed a mergeable head — refunding the attempt",
        );
      }
    }
    app.db.update(tasks).set(patch).where(eq(tasks.id, task.id)).run();
    Object.assign(task, patch);
    return "settled";
  }
  const aborted = task.rebaseAbortedAttempts + 1;
  const patch = {
    rebaseSpawnHeadSha: null,
    rebaseStartedAt: null,
    rebaseAbortedAttempts: aborted,
    rapidExitRetryAfter: new Date(Date.now() + RAPID_EXIT_BACKOFF_MS),
    rebaseAttempts:
      aborted >= MAX_RAPID_REBASE_ABORTS
        ? MAX_REBASE_ATTEMPTS
        : Math.max(0, task.rebaseAttempts - 1),
  };
  app.db.update(tasks).set(patch).where(eq(tasks.id, task.id)).run();
  Object.assign(task, patch);
  // The dead agent's session still holds the worktree the next attempt
  // recreates; best effort, a failure only leaves the next attempt to report it.
  if (session.status === "active") {
    try {
      await resolveBackend(app, hostId).terminate(String(session.id));
      app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, session.id)).run();
      closeSessionBrowserBindings(app, session.id);
    } catch (err) {
      app.log.warn(
        { err, taskId: task.id, sessionId: session.id },
        "task auto-rebase: could not stop the rapid-exit worker's session",
      );
    }
  }
  return "settled";
}

/**
 * Spawns a worker to resolve a real merge conflict (`dirty` mergeableState)
 * found on a `done` or `reviewing` task's PR — attemptMerge's `case "dirty"` and
 * attemptAutoApprove call this instead of only recording the error. Never
 * transitions the task's status: it stays in its current status (`done` or
 * `reviewing`) throughout, with rebaseStartedAt bounding attempt staleness.
 *
 * Gated on `project.autoApprove`, the same "nobody is watching" opt-in
 * `attemptAutoApprove`/`attemptReturnRedCiToWorker` use — spawning an
 * unattended worker against a task nobody asked to be re-touched is exactly
 * the kind of action that opt-in exists to gate.
 */
export async function attemptAutoRebase(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  baseRef: string,
): Promise<void> {
  if (!project.autoApprove) {
    recordMergeError(app, task.id, "Conflicts with main — needs manual resolution");
    return;
  }

  await settleRapidRebaseExit(app, task, project);
  const now = Date.now();
  // Issue #1724 — the auto-rebase worker works in the task's EXISTING
  // worktree, and that worktree lives on the host the worker was placed
  // on — not necessarily the project's own host any more. So the backend
  // AND the project root it resolves against both follow the worker.
  const workerHostId = resolveTaskWorkerHost(app, task);
  // The project root ON THE WORKER'S HOST — see task-claim.ts's retry path
  // for the same reasoning: null here means there is no directory to
  // resume the worktree in, which is a failure, not a silent fallback to a
  // path that does not exist on this host.
  //
  // Checked BEFORE the "an attempt is in progress" and "gave up" returns
  // below: those report a task as still working, and a task that can never
  // be rebased would then keep saying "in progress" until the rebase
  // window lapsed, with the real cause only in the log. This is the one
  // state the operator has to act on, so it is the one that has to be
  // VISIBLE.
  const workerCwd = projectCwdOnHost(project, workerHostId, parseHostCwds(project.hostCwds));
  if (workerCwd === null) {
    recordMergeError(
      app,
      task.id,
      "Conflicts with main — the worker's host has no path for this project, so the rebase cannot run there",
    );
    return;
  }
  const backend = resolveBackend(app, workerHostId);

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

  // The previous worker's agent died at once: wait out the backoff before
  // spending a worktree and a session on another try.
  if (task.rapidExitRetryAfter !== null && now < task.rapidExitRetryAfter.getTime()) {
    recordMergeError(
      app,
      task.id,
      "Conflicts with main — the last auto-rebase worker exited at once, retrying shortly",
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

  // Pre-removal cleanup: terminate an active review session before force-removing
  // the worktree it is running in. On a reviewing task's first auto-rebase,
  // rebaseStartedAt is null, but task.reviewSessionId points to the active reviewer.
  // Terminating it before removeWorktree avoids removing the cwd from under a live process.
  // A Hermes review run is of the pre-rebase head and every path below clears
  // its columns, so it is stopped here; it holds no worktree to wait for.
  stopHermesRunQuietly(app, task.reviewRunId);
  if (task.reviewSessionId !== null) {
    const [reviewSession] = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, task.reviewSessionId))
      .all();
    if (reviewSession?.status === "active") {
      try {
        await backend.terminate(String(task.reviewSessionId));
        app.db
          .update(sessions)
          .set({ status: "killed" })
          .where(eq(sessions.id, task.reviewSessionId))
          .run();
        closeSessionBrowserBindings(app, task.reviewSessionId);
      } catch (err) {
        app.log.warn(
          { err, taskId: task.id, reviewSessionId: task.reviewSessionId },
          "task auto-rebase: active review session appears stuck and could not be stopped, leaving it for a later tick",
        );
        recordMergeError(
          app,
          task.id,
          "Conflicts with main — active review session appears stuck and could not be stopped, needs manual resolution",
        );
        return;
      }
    }
  }

  // Clear any leftover worktree from a prior attempt first. resumeTaskWorktree
  // targets a deterministic path (deriveWorktreePath), so a second attempt at
  // the same path fails outright unless the first attempt's worktree is gone.
  // Unconditional force-remove: the worker's preamble says to commit and leave
  // the tree clean, so what an already-superseded attempt left is a contract
  // violation, not work to preserve. Through the checkout helper, because the
  // new worktree reuses this path and the old browser context is keyed to it.
  // The path is derived from the worker's root (where it was cut from), not
  // the project's, which may not exist on the worker's host.
  const stalePath = deriveWorktreePath(workerCwd, branchName);
  await forceRemoveCheckout(app, project.id, workerHostId, stalePath, workerCwd).catch((err) => {
    app.log.warn({ err, taskId: task.id, stalePath }, "auto-rebase: stale worktree kept");
  });

  const worktree = await backend.resumeTaskWorktree(workerCwd, branchName);
  if (!worktree) {
    if (hasReviewHandle(task)) {
      app.db
        .update(tasks)
        .set({ reviewSessionId: null, ...CLEARED_REVIEW_RUN })
        .where(eq(tasks.id, task.id))
        .run();
    }
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

  const spawnHeadSha = await readPrHeadSha(app, task, project);
  const taskMasterConfig = resolveTaskMasterConfig(app);
  // #778 — resolved against the OWNING host's own sessionsDir; see
  // spawnReviewAgentNow's own comment above for the full rationale.
  const commitTitlePath = project.conventionalCommitTitles
    ? taskCommitTitlePath(
        await resolveSessionsDirWithFallback(app, backend, {
          taskId: task.id,
          hostId: workerHostId,
        }),
        task.id,
      )
    : undefined;
  const seedCapable = commandSupportsSeed(task.agentCommand);
  // #939/#1016 — resolved once per spawn, fail-open — see
  // task-issue-context.ts's own doc comment.
  const issueContext = await resolveTaskIssueContextSafe(app, task, project);
  const prompt = buildRebasePrompt({
    task: {
      ...task,
      comments: issueContext?.comments,
      parent: issueContext?.parent,
      siblings: issueContext?.siblings,
    },
    branchName: worktree.branch,
    worktreePath: worktree.path,
    budgetMinutes: taskMasterConfig.budgetMinutes,
    commitTitlePath,
    baseRef,
    agentCommand: task.agentCommand,
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
    // Issue #1724 — the rebase worker runs in the task's existing worktree
    // (`cwd: worktree.path`), so it joins the host that holds it.
    unattended: true,
    hostId: workerHostId,
  });
  // #2637 — an unknown outcome keeps the session row: adopt it below like a
  // successful spawn, so the next tick does not spawn a second rebase worker.
  const kept = !result.ok && result.reason === "outcome-unknown" ? result.sessionId : undefined;
  if (!result.ok && kept === undefined) {
    if (hasReviewHandle(task)) {
      app.db
        .update(tasks)
        .set({ reviewSessionId: null, ...CLEARED_REVIEW_RUN })
        .where(eq(tasks.id, task.id))
        .run();
    }
    recordMergeError(
      app,
      task.id,
      `Conflicts with main — failed to spawn an auto-rebase worker (${result.reason}), needs manual resolution`,
    );
    return;
  }
  const spawnedSessionId = result.ok ? result.row.id : kept!;
  const seedDelivered =
    result.ok && resolveSeedDelivered(seedCapable, workerHostId, result.initialPromptApplied);

  // CAS on status in ["done", "reviewing"] — guards against a concurrent transition
  // out of reviewing or done while spawning.
  const updated = app.db
    .update(tasks)
    .set({
      sessionId: spawnedSessionId,
      reviewSessionId: null,
      reviewFindingsIngestedSessionId: null,
      ...CLEARED_REVIEW_RUN,
      worktreePath: worktree.path,
      branchName: worktree.branch,
      seedDelivered,
      rebaseAttempts: task.rebaseAttempts + 1,
      rebaseStartedAt: new Date(now),
      rebaseSpawnHeadSha: spawnHeadSha,
      rapidExitRetryAfter: null,
      mergeError: "Conflicts with main — an auto-rebase attempt is in progress",
    })
    .where(and(eq(tasks.id, task.id), inArray(tasks.status, ["done", "reviewing"])))
    .run();
  if (updated.changes === 0) {
    if (hasReviewHandle(task)) {
      app.db
        .update(tasks)
        .set({ reviewSessionId: null, ...CLEARED_REVIEW_RUN })
        .where(eq(tasks.id, task.id))
        .run();
    }
    app.log.warn(
      { taskId: task.id, newSessionId: spawnedSessionId },
      "task auto-rebase: lost a race with a concurrent transition — killing the freshly spawned session, nothing points at it",
    );
    // Same for a clean spawn and an adopted unknown-outcome one (#2637): the CAS
    // lost, so the task never took the session as its handle and no later tick
    // would find it.
    await killSession(app, spawnedSessionId);
    return;
  }

  app.log.info(
    { taskId: task.id, sessionId: spawnedSessionId, attempt: task.rebaseAttempts + 1 },
    "task auto-rebase: spawned a worker to resolve a merge conflict",
  );
}

/**
 * True when the rebase worker's own work finished after the rebase began.
 * Same comparison as turnFinishedSinceClaim, anchored on `rebaseStartedAt`;
 * `workFinishedAt` (not `lastTurnEndedAt`) for the same #1735 reason.
 */
export function rebaseWorkerFinished(
  info: SessionInfo | null,
  task: { rebaseStartedAt: Date | null },
): boolean {
  if (info === null || info.workFinishedAt === null || task.rebaseStartedAt === null) {
    return false;
  }
  return info.workFinishedAt >= task.rebaseStartedAt.getTime() - CLOCK_SKEW_TOLERANCE_MS;
}
