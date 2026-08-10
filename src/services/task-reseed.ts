// Shared re-seed mechanism (6.7/#220, hoisted for the review-feedback loop
// added alongside this file) — spawns a fresh worker session in a task's
// SAME worktree (never a new one — the branch and its commits are exactly
// what should be built on). Originally reject's own local closure in
// routes/tasks.ts; now shared with task-reconciler.ts's review-feedback
// auto-return, so the two paths can't drift into two different re-seed
// behaviors — but they DO differ on one thing (see `opts.force` below),
// because reject and review-feedback have fundamentally different audiences.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { sessions, tasks } from "../db/schema.js";
import type { projects } from "../db/schema.js";
import { commandSupportsSeed, resolveSeedDelivered } from "./task-agent-resolve.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { resolveBackend } from "./session-backend.js";
// Reaches into routes/ from a service, same narrow exception task-claim.ts
// and task-reconciler.ts already document — createSessionRecord is pure
// business logic filed under routes/ for historical colocation with
// POST /api/sessions.
import { createSessionRecord } from "../routes/sessions.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/**
 * `prompt` is built by the caller (buildRejectPrompt/buildReviewFeedbackPrompt
 * in task-prompt.ts) — this function only decides WHETHER to spawn and
 * applies the result, never what to say. `logContext` prefixes every log
 * line (e.g. `"task reject"` / `"task review-feedback"`) so the two callers'
 * log lines stay distinguishable without this function needing to know
 * which caller it is.
 *
 * `opts.force` (default `false`) — reject's own default behavior: when the
 * previous session is still "active," do nothing at all, leaving the
 * worktree and session untouched so a HUMAN can pick the feedback up by
 * typing into that still-open terminal themselves. That assumption is
 * exactly backwards for an unattended caller: task-reconciler.ts's
 * review-feedback auto-return has no human watching, and the worker's own
 * prompt (task-prompt.ts's buildTaskMasterPreamble) explicitly tells it to
 * "End your turn and stay running" — so the common case is a still-"active"
 * but genuinely idle session that would otherwise wait forever for input
 * nobody will ever send. `force: true` terminates that survivor first, then
 * always spawns fresh via the same reliable argv-prompt mechanism every
 * other Task Master spawn uses (claim/retry/review) — never injects
 * keystrokes into the live TUI, which would depend on guessing that CLI's
 * current, possibly-mid-tool-call UI state.
 */
export async function reseedTaskIfSessionExited(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
  prompt: string,
  logContext: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!task.sessionId || !task.worktreePath || !task.agentCommand) return;
  const [session] = app.db.select().from(sessions).where(eq(sessions.id, task.sessionId)).all();
  const wasActive = session?.status === "active";
  if (wasActive) {
    if (!opts.force) return;
    try {
      await resolveBackend(app, project.hostId).terminate(String(task.sessionId));
    } catch (err) {
      // Do NOT fall through to spawning anyway — a terminate failure means
      // the old session might still be alive and still writing to this
      // exact worktree; spawning a second agent into it concurrently would
      // be far worse than leaving the task as-is for a later pass to retry.
      app.log.warn(
        { err, taskId: task.id, sessionId: task.sessionId },
        `${logContext}: failed to terminate the still-active session before force re-seeding, leaving it as-is`,
      );
      return;
    }
  }

  // Delivered as argv, not stashSeed — SessionStart's `additionalContext`
  // (stashSeed's only consumer) injects context but never submits a turn,
  // and every caller of this function re-seeds a session exactly as
  // unattended as an autonomous claim.
  const seedCapable = commandSupportsSeed(task.agentCommand);
  const taskMasterConfig = resolveTaskMasterConfig(app);
  const result = await createSessionRecord(app, {
    projectId: project.id,
    command: task.agentCommand,
    cwd: task.worktreePath,
    initialPrompt: seedCapable ? prompt : undefined,
    skipPermissions: taskMasterConfig.skipPermissions,
  });
  if (!result.ok) {
    app.log.warn(
      { taskId: task.id, reason: result.reason },
      `${logContext}: re-seed spawn failed, worktree left as-is for a manual claim/retry`,
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
      {
        taskId: task.id,
        newSessionId: result.row.id,
        command: task.agentCommand,
        hostId: project.hostId,
        seedCapable,
      },
      seedCapable
        ? `${logContext}: sent an initial prompt to a remote host but it wasn't confirmed applied — possible version skew`
        : `${logContext}: re-seeded agent's adapter can't receive an initial prompt — spawning with no instructions`,
    );
  }
  app.db
    .update(tasks)
    .set({ sessionId: result.row.id, seedDelivered })
    .where(eq(tasks.id, task.id))
    .run();
  app.log.info(
    { taskId: task.id, previousSessionId: task.sessionId, newSessionId: result.row.id },
    wasActive
      ? `${logContext}: force-terminated the still-active session and re-seeded a fresh one in the same worktree`
      : `${logContext}: re-seeded a fresh session in the same worktree (previous session had exited)`,
  );
}
