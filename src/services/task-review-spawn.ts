import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tasks, type projects } from "../db/schema.js";
import { createSessionRecord, killSession } from "./session-lifecycle.js";
import { resolveTaskWorkerHost } from "./session-live-info.js";
import {
  resolveBackend,
  resolveSessionsDirWithFallback,
  type SessionBackend,
} from "./session-backend.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { commandSupportsSeed, resolveSeedDelivered } from "./task-agent-resolve.js";
import { isOutcomeUnknown } from "./remote-host-errors.js";
import { buildReviewPrompt, taskReviewFindingsPath, type ReviewCiInfo } from "./task-prompt.js";
import { reviewPromptContext } from "./task-prior-round.js";
import { resolveMaxAutoReturnRounds } from "./task-reconciler.js";

export async function unlinkFindingsFileIfPresent(
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

// Guarded on `reviewSessionId IS NULL` — if some other path already landed a
// real session between the failure and this write (shouldn't happen, given
// the CAS claim, but this is a cheap belt-and-suspenders match for the
// discipline every other write in this file already follows), this must not
// clobber it back to an unspawned-looking state.
export function clearReviewSpawnClaim(app: FastifyInstance, taskId: number): void {
  app.db
    .update(tasks)
    .set({ reviewSpawnClaimedAt: null })
    .where(and(eq(tasks.id, taskId), isNull(tasks.reviewSessionId)))
    .run();
}

/**
 * Review agent decision — when a project or the task's own issue configures
 * one, entering "reviewing" spawns it IN THE WORKER'S OWN WORKTREE (no new
 * worktree — the worker's turn is already over by the time this runs, so
 * there's no concurrent-write race), seeded with a review-focused prompt.
 * Advisory only: its output is surfaced via `tasks.reviewSessionId`, and it
 * has no path to approve, reject, or otherwise transition the task itself.
 * Best-effort with respect to the reviewing transition that already
 * committed: a spawn failure is logged and swallowed, never rolled back into
 * the status change.
 *
 * #487 — unlike the worker claim (task-claim.ts), which refuses outright
 * when its resolved agent's adapter can't receive a seed, a review agent is
 * always spawned regardless: refusing would remove the one artifact (the
 * empty session) a human could notice something's wrong from. Instead this
 * warns and records `reviewSeedDelivered: false` on the task row.
 *
 * Called only once `processPendingReviewSpawns` has resolved a CI verdict and
 * CAS-claimed the slot. A failed spawn clears its own claim
 * (`clearReviewSpawnClaim`) so the next tick retries rather than leaving the
 * task with no reviewer forever — except an unknown outcome (#2621), which
 * adopts the row the failed create left behind instead of retrying.
 */
export async function spawnReviewAgentNow(
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
  // Hoisted out of the `try` (PR #742) — a throw AFTER createSessionRecord
  // succeeds (a DB error on the CAS update below, or resolveSeedDelivered
  // itself throwing) would fall into the generic `catch`, which only cleared
  // the claim and had no way to reach the session it had just created — left
  // "active" and untracked, it would surface later at the exited-session
  // reconciler as a mystery crash with no task behind it.
  let spawnedSessionId: number | undefined;
  try {
    // Delivered as argv, not stashSeed: SessionStart's `additionalContext`
    // injects context but never submits a turn, which would leave an
    // unattended review agent idling.
    const seedCapable = commandSupportsSeed(reviewCommand);
    // #1724 — the review agent reads the task's worktree, so it runs on the
    // host that HOLDS it: the worker session's own host. #778 — the sessions
    // dir it is told to write to is that host's too (falls back to the
    // primary's local path, with a warn, if the lookup fails), so it writes
    // somewhere it can actually reach on its own filesystem.
    const workerHostId = resolveTaskWorkerHost(app, task);
    const backend = resolveBackend(app, workerHostId);
    const sessionsDir = await resolveSessionsDirWithFallback(app, backend, {
      taskId: task.id,
      hostId: workerHostId,
    });
    // task.autoReturnRounds is the round THIS review belongs to — see
    // taskReviewFindingsPath's doc comment for why round-suffixing matters.
    const findingsPath = taskReviewFindingsPath(sessionsDir, task.id, task.autoReturnRounds);
    // A same-round re-review reuses this exact path, so a leftover from a
    // prior attempt (task 220921 / PR #743: a late-arriving findings file
    // that the on-ingest unlink ran too early to remove) would be silently
    // re-ingested as THIS attempt's output. Unlinking before the agent can
    // write anything makes whatever it writes the only thing the path holds.
    await unlinkFindingsFileIfPresent(app, backend, task.id, task.autoReturnRounds);
    // Clamped to 0: a project's cap can be lowered after a task has already
    // spent more rounds than the new cap allows.
    const roundsRemaining = Math.max(
      0,
      resolveMaxAutoReturnRounds(project, resolveTaskMasterConfig(app).maxAutoReturnRounds) -
        task.autoReturnRounds,
    );
    const prompt = buildReviewPrompt({
      task,
      worktreePath: task.worktreePath,
      findingsPath,
      ci,
      roundsRemaining,
      ...(await reviewPromptContext(app, task, project, ci?.headSha, workerHostId)),
    });
    let result;
    try {
      result = await createSessionRecord(app, {
        projectId: project.id,
        command: reviewCommand,
        cwd: task.worktreePath,
        initialPrompt: seedCapable ? prompt : undefined,
        skipPermissions,
        name: `Task #${task.id} · review`,
        nameLocked: true,
        model,
        smallModel,
        taskId: task.id,
        taskRole: "reviewer",
        unattended: true,
        hostId: workerHostId,
      });
    } catch (err) {
      if (isOutcomeUnknown(err)) {
        app.log.warn(
          { taskId: task.id, reviewCommand, err },
          "task reconcile: review agent spawn outcome unknown",
        );
        return;
      }
      clearReviewSpawnClaim(app, task.id);
      throw err;
    }
    if (!result.ok) {
      app.log.warn(
        { taskId: task.id, reviewCommand, reason: result.reason },
        "task reconcile: review agent spawn failed",
      );
      if (result.reason !== "outcome-unknown") {
        clearReviewSpawnClaim(app, task.id);
        return;
      }
      // #2621 — the spawn may have landed. Keeping the claim only defers the
      // respawn (the stale-claim sweep reclaims it after
      // REVIEW_SPAWN_CLAIM_STALE_MS), so adopt the session row createSessionRecord
      // left in place instead: if the agent started, it is now the task's
      // reviewer; if it did not, the ordinary dead-reviewer handling takes over.
      // Either way no second reviewer is spawned into the same worktree.
      if (result.sessionId !== undefined) {
        app.db
          .update(tasks)
          .set({ reviewSessionId: result.sessionId, reviewSeedDelivered: false })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
          .run();
      }
      return;
    }
    spawnedSessionId = result.row.id;
    const seedDelivered = resolveSeedDelivered(
      seedCapable,
      workerHostId,
      result.initialPromptApplied,
    );
    if (!seedDelivered) {
      app.log.warn(
        { taskId: task.id, reviewCommand, hostId: workerHostId, seedCapable },
        seedCapable
          ? "task reconcile: sent an initial prompt to a remote host but it wasn't confirmed applied — possible version skew"
          : "task reconcile: review agent's adapter can't receive an initial prompt — spawning with no instructions",
      );
    }
    // CAS on `status = "reviewing"`, not just `id`: the claim slot only
    // protects against a second `processPendingReviewSpawns` pass; it says
    // nothing about Reject/Give-up/Approve, which CAS on `status` alone and
    // can land while createSessionRecord (possibly a remote round-trip) is in
    // flight. If the task moved on, attaching `reviewSessionId` would leave a
    // live, untracked session pointed at a worktree Approve may be deleting.
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
      // killSession, not a bare backend.terminate: nothing else will ever flip
      // this never-attached session's row to "killed", and left "active" the
      // exited-session reconciler would surface it as a crash with no task.
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
