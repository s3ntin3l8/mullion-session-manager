// `POST /api/tasks/:id/approve-proposal` and `/dismiss-proposal` — the only way
// out of "proposed" (see services/task-proposal.ts and the watcher's
// upsertIssueTask). Split out of tasks.ts, which is at its size ceiling.
import type { FastifyInstance } from "fastify";
import { getProjectById, getTaskById, updateTask } from "../services/task-store.js";
import { recordTaskTransition, type TaskStatus } from "../services/task-state.js";
import { resolveGitHubToken } from "../services/github-integration.js";
import { resolveRepoRef } from "../services/host-git.js";
import { closeIssue } from "../services/github-write.js";
import { proposalContentSha } from "../services/task-proposal.js";
import { isManualOnly } from "../services/task-watcher.js";
import { FAILURE_REASON_ISSUE_CLOSED } from "../services/task-github-sync.js";

export async function taskProposalsRoute(app: FastifyInstance) {
  // A proposal is a task from an issue this install's own bot filed. These two
  // routes are the only way out of "proposed", and are deliberately not
  // offered to agents (no MCP/CLI op): an agent must not approve its own.
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/approve-proposal",
    async (request, reply) => {
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
      const existing = getTaskById(app, taskId);
      if (!existing) return reply.notFound();
      if (existing.proposalState !== "proposed" || existing.status !== "backlog") {
        return reply.conflict("Task is not a proposal awaiting approval");
      }
      const openChildren = (existing.subIssueTotal ?? 0) - (existing.subIssueCompleted ?? 0) > 0;
      const target: TaskStatus = openChildren || isManualOnly(existing.body) ? "backlog" : "ready";
      const updated = updateTask(
        app,
        taskId,
        {
          proposalState: "approved",
          approvedBodySha: proposalContentSha(existing.title, existing.body),
          status: target,
        },
        { whenStatus: "backlog" },
      );
      if (!updated) return reply.conflict("Task changed — refresh and try again");
      if (target !== existing.status) {
        recordTaskTransition(app, {
          taskId,
          projectId: updated.projectId,
          from: "backlog",
          to: target,
          via: "proposal-approved",
        });
      }
      return updated;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/dismiss-proposal",
    async (request, reply) => {
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
      const existing = getTaskById(app, taskId);
      if (!existing) return reply.notFound();
      if (existing.proposalState !== "proposed" || existing.status !== "backlog") {
        return reply.conflict("Task is not a proposal awaiting approval");
      }
      if (existing.issueNumber === null) return reply.conflict("Task has no GitHub issue");
      const project = getProjectById(app, existing.projectId);
      if (!project) return reply.notFound();
      const repoRef = await resolveRepoRef(app, project);
      if (!repoRef) return reply.badGateway("Could not resolve the project's GitHub repo");
      const token = await resolveGitHubToken(app, repoRef);
      if (!token) return reply.badGateway("No GitHub token available to close the issue");
      try {
        await closeIssue(token, repoRef.owner, repoRef.repo, existing.issueNumber);
      } catch (err) {
        app.log.warn({ err, taskId }, "dismiss-proposal: closeIssue failed — task kept");
        return reply.badGateway("Failed to close the issue on GitHub — proposal kept");
      }
      const now = new Date();
      const updated = updateTask(
        app,
        taskId,
        {
          status: "failed",
          failureReason: FAILURE_REASON_ISSUE_CLOSED,
          completedAt: now,
          archivedAt: now,
        },
        { whenStatus: "backlog" },
      );
      if (updated) {
        recordTaskTransition(app, {
          taskId,
          projectId: updated.projectId,
          from: "backlog",
          to: "failed",
          via: "proposal-dismissed",
        });
      }
      return updated ?? existing;
    },
  );
}
