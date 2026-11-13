import type { FastifyInstance } from "fastify";
import { getProjectById, getTaskById, updateTask } from "../services/task-store.js";
import { resolveTaskMasterConfig } from "../services/task-config.js";
import * as mergeHuman from "../services/task-merge-human.js";
import { resetMergeBackoff } from "../services/task-reconciler.js";
import {
  getIntegration,
  getToken,
  resolveMullionReviewLogins,
} from "../services/github-integration.js";
import { resolveRepoRef } from "../services/host-git.js";
import {
  fetchPullRequestReviewThreads,
  replyToReviewThread,
  resolveReviewThread,
} from "../services/github-write.js";
import {
  DISMISS_COMMENT_MAX,
  DISMISS_REASONS,
  dismissCodeScanningAlert,
  fetchCodeScanningAlert,
  type DismissReason,
} from "../services/code-scanning.js";
import { insertDismissal, toTaskDismissal } from "../services/code-scanning-audit.js";
import { replyWriteError } from "./project-github-writes.js";

// #2999 — dismiss the code-scanning alert a done task's PR is blocked on.
//
// HUMAN-ONLY, dashboard REST only. There is deliberately no control-socket op
// (src/plugins/control-socket-ops.ts), MCP tool (src/mcp/tools.mjs) or CLI
// command (src/cli/core.mjs) for this: a dismissal is a judgement a person
// makes, never something an agent (a worker, a reviewer, a hook) may do.
// `test/routes/task-blocking-alert-dismiss.test.ts` fails if any of them ever
// references `blocking-alerts`.
//
// Every GitHub call here uses the connected human account's token
// (`getToken`), never a GitHub App token: an App has no `security_events`
// write, and the dismissal is that person's own act, recorded under their
// login. With no account connected the route refuses; it does not fall back.

const dismissSchema = {
  body: {
    type: "object",
    required: ["reason", "comment"],
    additionalProperties: false,
    properties: {
      reason: { type: "string", enum: [...DISMISS_REASONS] },
      comment: { type: "string" },
    },
  },
} as const;

export async function taskBlockingAlertDismissRoute(app: FastifyInstance) {
  app.post<{
    Params: { id: string; alertNumber: string };
    Body: { reason: DismissReason; comment: string };
  }>(
    "/api/tasks/:id/blocking-alerts/:alertNumber/dismiss",
    { schema: dismissSchema, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!resolveTaskMasterConfig(app).enabled) {
        return reply.forbidden(
          "Task Master is disabled (deploy-time default or a Settings → Task Master override)",
        );
      }
      const taskId = Number(request.params.id);
      if (!Number.isInteger(taskId)) return reply.badRequest("Invalid task id");
      if (!/^[1-9]\d*$/.test(request.params.alertNumber)) {
        return reply.badRequest("Invalid alert number");
      }
      const alertNumber = Number(request.params.alertNumber);
      const { reason } = request.body;
      const comment = request.body.comment.trim();
      if (!comment) return reply.badRequest("A dismissal comment is required");
      if (comment.length > DISMISS_COMMENT_MAX) {
        return reply.badRequest(`The comment must be at most ${DISMISS_COMMENT_MAX} characters`);
      }

      const task = getTaskById(app, taskId);
      if (!task) return reply.notFound();
      if (task.status !== "done") {
        return reply.conflict(`Cannot dismiss an alert for a task in status "${task.status}"`);
      }
      const prNumber = task.prNumber;
      if (prNumber === null) return reply.conflict("Task has no linked pull request");
      if (task.needsHumanReason !== "blocked-threads") {
        return reply.conflict("Task is not blocked on review threads");
      }

      const token = getToken(app);
      if (!token) return reply.forbidden("Connect a GitHub account in Settings to dismiss alerts.");
      const project = getProjectById(app, task.projectId);
      const ref = project ? await resolveRepoRef(app, project) : null;
      if (!ref) return reply.badGateway("Could not resolve the project's GitHub repo");

      const notBlocking = (message: string) =>
        reply.code(409).send({ message, statusCode: 409, code: "alert-not-blocking" });

      // Re-check against GitHub right now, not the stored snapshot: the alert
      // must be named in an open thread somebody else opened on THIS PR, and
      // still be open itself. Nothing is written until both hold.
      let threadId: string;
      let alert: Awaited<ReturnType<typeof fetchCodeScanningAlert>>;
      try {
        const result = await fetchPullRequestReviewThreads(token, ref.owner, ref.repo, prNumber);
        if (result.truncated) {
          return notBlocking(
            "The PR's review threads couldn't be fully read, so the alert can't be confirmed as blocking",
          );
        }
        const foreign = await mergeHuman.foreignOpenThreads(result, (viewer) =>
          resolveMullionReviewLogins(app, ref, viewer),
        );
        const thread = foreign.find((t) => {
          const m = mergeHuman.ALERT_URL_RE.exec(t.comments[0]?.body ?? "");
          return m !== null && Number(m[1]) === alertNumber;
        });
        if (!thread) {
          return notBlocking(`Alert #${alertNumber} is not in an open review thread on this PR`);
        }
        threadId = thread.id;
        alert = await fetchCodeScanningAlert(token, ref, alertNumber);
      } catch (err) {
        return replyWriteError(reply, err, "check this alert");
      }
      if (alert.state !== "open") {
        return notBlocking(`Alert #${alertNumber} is already ${alert.state}`);
      }

      try {
        await dismissCodeScanningAlert(token, ref, alertNumber, reason, comment);
      } catch (err) {
        return replyWriteError(reply, err, "dismiss this alert");
      }

      // The dismissal stands whatever happens next. A failed reply skips the
      // resolve (a thread closed with no word on why is worse than one left
      // open), and either failure only downgrades `threadResolved`.
      let threadResolved = false;
      let warning: string | undefined;
      try {
        await replyToReviewThread(
          token,
          threadId,
          `Dismissed code-scanning alert #${alertNumber} as ${reason}: ${comment}`,
        );
        await resolveReviewThread(token, threadId);
        threadResolved = true;
      } catch (err) {
        app.log.warn(
          { err, taskId, alert: alertNumber },
          "blocking-alert dismiss: thread step failed",
        );
        warning = `Alert #${alertNumber} was dismissed, but the review thread could not be replied to and resolved; resolve it on GitHub.`;
      }

      const row = insertDismissal(app, {
        taskId,
        repo: `${ref.owner}/${ref.repo}`,
        prNumber,
        alertNumber,
        ruleId: alert.rule.id,
        path: alert.location?.path ?? null,
        reason,
        comment,
        dismissedBy: getIntegration(app).login ?? null,
        threadResolved,
      });

      // Reopen the merge exactly as POST /api/tasks/:id/merge does. If another
      // thread still blocks, the next attempt sets `blocked-threads` again.
      const updated = updateTask(app, taskId, {
        mergeRequestedAt: new Date(),
        ...mergeHuman.clearedFor(task.needsHumanReason),
      });
      resetMergeBackoff(taskId);

      return {
        dismissed: true,
        threadResolved,
        warning,
        dismissal: toTaskDismissal(row),
        task: updated,
      };
    },
  );
}
