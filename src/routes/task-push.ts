// `POST /api/sessions/:id/task-push` — the push a Task Master worker makes
// through Mullion instead of with its own git credentials (#2102).
//
// A worker that pushes with the operator's ambient credentials bypasses the
// workflow-change approval gate and pushes as the human. So the agent asks
// Mullion to push INSIDE its own turn: the same gated path the reconciler
// uses (`openDraftPRForTask` -> `preparePromotion` -> `pushForPromotion`, bot
// identity, `--force-with-lease` for `mullion/task-*`), but with the outcome
// handed back to the agent. A failure it can fix (a stale lease after the
// remote moved, a dirty tree) is fixed and retried in the same turn; one only
// the operator can fix (workflow approval, credentials) is reported as such so
// the agent ends its turn instead of looking for another way to push.
//
// Reachable from a session via the `tasks.push` control-socket op, which pins
// the target to the caller's OWN session (control-socket.ts). Approving a
// workflow change is deliberately not reachable from here.
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { resolveTaskMasterConfig } from "../services/task-config.js";
import { resolveTaskWorkerHost } from "../services/session-live-info.js";
import { openDraftPRForTask } from "../services/task-promote.js";

// Statuses a worker session can still be pushing in: a review-fix or CI-fix
// round (back in `in_progress`), and the auto-rebase worker, which runs against
// a `reviewing` or `done` task. (`claimed` never has a PR yet, so it could only
// ever be refused below.)
const PUSHABLE_STATUSES = ["in_progress", "reviewing", "done"] as const;

/** What the agent should do next, per failure reason. */
const GUIDANCE: Record<string, string> = {
  "dirty-tree":
    "Your worktree has uncommitted changes. Commit them (or remove stray files), then call this again.",
  "push-failed":
    "Read the detail. If the remote moved (stale lease / non-fast-forward), fetch, rebase onto the base branch again, re-run the gate, then call this again. If it says permission denied or 403 (Mullion normally reports that as its own reason; this is a backstop), only the operator can fix it. Anything else you cannot fix: end your turn.",
  "no-worktree":
    "Mullion cannot find this task's worktree. If it was removed or reclaimed, only the operator can restore it: end your turn and say so.",
  "workflow-approval-required":
    "This branch changes .github/workflows/. Only the operator can approve that, in the Mullion UI. End your turn; do not try to push another way.",
  "push-forbidden":
    "GitHub refused the push for the credential Mullion uses. Only the operator can fix that. End your turn.",
  "no-token": "No GitHub credential is connected. Only the operator can fix that. End your turn.",
  "no-repo":
    "Mullion could not resolve this project's GitHub repository. Only the operator can fix that. End your turn.",
  "remote-not-supported":
    "This task's host cannot push through Mullion yet. End your turn and say so in your summary.",
};

export async function taskPushRoute(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/task-push",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!resolveTaskMasterConfig(app).enabled) {
        return reply.forbidden(
          "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
        );
      }
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      // Only a task's WORKER session may push (tasks.sessionId): a reviewer or
      // an ad-hoc session has no branch of its own to push through Mullion.
      const task = app.db
        .select()
        .from(tasks)
        // `mergedAt IS NULL`: a merged task's lingering worker session must
        // not be able to force-push (and so recreate) a branch that is gone.
        .where(
          and(
            eq(tasks.sessionId, sessionId),
            inArray(tasks.status, [...PUSHABLE_STATUSES]),
            isNull(tasks.mergedAt),
          ),
        )
        .get();
      if (!task)
        return reply.notFound("This session is not the worker session of a Task Master task");
      if (task.prNumber === null) {
        return reply.conflict(
          "This task has no pull request yet. Finish your turn: Mullion pushes the branch and opens the draft PR itself.",
        );
      }
      const project = app.db.select().from(projects).where(eq(projects.id, task.projectId)).get();
      if (!project) return reply.notFound("Project not found");

      const outcome = await openDraftPRForTask(
        app,
        task,
        project,
        resolveTaskWorkerHost(app, task, project),
      );
      if (outcome.ok) return { ok: true, prUrl: outcome.prUrl, prNumber: outcome.prNumber };
      const guidance =
        GUIDANCE[outcome.reason] ?? "End your turn and report the detail in your summary.";
      // `message` is what the control socket (and so the CLI and MCP tool)
      // hands the agent as the error text, so it carries the detail AND what
      // to do next; the structured fields stay for a REST caller.
      return reply.code(409).send({
        statusCode: 409,
        error: "Conflict",
        message: outcome.detail ? `${outcome.detail} — ${guidance}` : guidance,
        ok: false,
        reason: outcome.reason,
        detail: outcome.detail,
        guidance,
      });
    },
  );
}
