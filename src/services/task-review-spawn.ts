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

export function clearReviewSpawnClaim(app: FastifyInstance, taskId: number): void {
  app.db
    .update(tasks)
    .set({ reviewSpawnClaimedAt: null })
    .where(and(eq(tasks.id, taskId), isNull(tasks.reviewSessionId)))
    .run();
}

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
  let spawnedSessionId: number | undefined;
  try {
    const seedCapable = commandSupportsSeed(reviewCommand);
    const workerHostId = resolveTaskWorkerHost(app, task);
    const backend = resolveBackend(app, workerHostId);
    const sessionsDir = await resolveSessionsDirWithFallback(app, backend, {
      taskId: task.id,
      hostId: workerHostId,
    });
    const findingsPath = taskReviewFindingsPath(sessionsDir, task.id, task.autoReturnRounds);
    await unlinkFindingsFileIfPresent(app, backend, task.id, task.autoReturnRounds);
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
