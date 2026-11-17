import type { FastifyInstance } from "fastify";
import { getProjectById, getTaskById, updateTask } from "../services/task-store.js";
import { resolveTaskMasterConfig } from "../services/task-config.js";
import * as mergeHuman from "../services/task-merge-human.js";
import { resolveMergeOverrideHead } from "../services/task-merge-override.js";
import { resetMergeBackoff } from "../services/task-reconciler.js";

// Merge-on-approve — "Merge now" / "Retry merge". Re-arms the merge sweep
// (task-reconciler.ts's processMergeRequests) rather than merging inline:
// the same branch-protection reasoning as approve above applies here too
// (an up-to-date branch + green required checks a fresh click can't
// guarantee synchronously), so this only sets intent and resets the
// sweep's own backoff so the next tick attempts it immediately instead of
// waiting out whatever interval it was already on.
export async function taskMergeRoute(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Querystring: { overrideNonRequiredChecks?: string } }>(
    "/api/tasks/:id/merge",
    async (request, reply) => {
      if (!resolveTaskMasterConfig(app).enabled) {
        return reply.forbidden(
          "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
        );
      }
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
      const existing = getTaskById(app, taskId);
      if (!existing) return reply.notFound();
      if (existing.status !== "done") {
        return reply.conflict(`Cannot request a merge for a task in status "${existing.status}"`);
      }
      if (existing.prNumber === null) {
        return reply.conflict("Task has no linked pull request to merge");
      }

      // "Merge anyway" (?overrideNonRequiredChecks=true): bind the override to the
      // head GitHub reports right now; the sweep merges only while it still matches.
      let overrideHeadSha: string | undefined;
      if (request.query.overrideNonRequiredChecks === "true") {
        const project = getProjectById(app, existing.projectId);
        if (!project) return reply.notFound();
        const head = await resolveMergeOverrideHead(app, existing, project);
        if ("refusal" in head) {
          return head.status === 409
            ? reply.conflict(head.refusal)
            : reply.badGateway(head.refusal);
        }
        overrideHeadSha = head.headSha;
        app.log.info(
          { taskId, headSha: overrideHeadSha },
          "task merge: non-required checks overridden",
        );
      }
      // Every human merge request re-decides the override: the clear drops a
      // previous one, and only this click's (if any) is set after it.
      const updated = updateTask(app, taskId, {
        mergeRequestedAt: new Date(),
        ...mergeHuman.clearedFor(existing.needsHumanReason),
        ...(overrideHeadSha ? { mergeOverrideHeadSha: overrideHeadSha } : {}),
      });
      resetMergeBackoff(taskId);
      return updated;
    },
  );
}
