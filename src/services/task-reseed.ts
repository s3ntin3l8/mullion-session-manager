// Shared re-seed mechanism (6.7/#220, hoisted for the review-feedback loop
// added alongside this file) — spawns a fresh worker session in a task's
// SAME worktree (never a new one — the branch and its commits are exactly
// what should be built on). Originally reject's own local closure in
// routes/tasks.ts; now shared with task-reconciler.ts's review-feedback
// auto-return, so the two paths can't drift into two different re-seed
// behaviors — but they DO differ on one thing (see `opts.force` below),
// because reject and review-feedback have fundamentally different audiences.
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { sessions, tasks } from "../db/schema.js";
import type { projects } from "../db/schema.js";
import { commandSupportsSeed, resolveSeedDelivered } from "./task-agent-resolve.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { resolveBackend } from "./session-backend.js";
// createSessionRecord is pure business logic filed under services/
// (session-lifecycle.ts) precisely so a service can reuse it directly.
import { createSessionRecord } from "./session-lifecycle.js";
// Not killSession() here (see the doc comment at its call site below) — but
// killSession's OTHER two side effects (this one and cleanupPreviewWorktree)
// still need to happen on a confirmed-successful terminate, or they silently
// never run for this call site (fresh subagent review, PR #773 follow-up).
// cleanupPreviewWorktree is a no-op here regardless — a task worker session
// is never registered in the preview-worktree map — so only this one matters.
import { closeSessionBrowserBindings } from "./session-browsers.js";

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
 *
 * Returns whether it actually re-seeded (assigned a new `sessionId`) —
 * `false` covers every early-return below (no-op, terminate failure, spawn
 * failure, lost CAS race). Callers that spend a limited resource on the
 * assumption a re-seed happens (task-reconciler.ts's review-feedback
 * auto-return burns the task's one round) use this to roll that back when
 * it turns out nothing was actually re-seeded.
 */
export async function reseedTaskIfSessionExited(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
  prompt: string,
  logContext: string,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  if (!task.sessionId || !task.worktreePath || !task.agentCommand) return false;
  const [session] = app.db.select().from(sessions).where(eq(sessions.id, task.sessionId)).all();
  const wasActive = session?.status === "active";
  if (wasActive) {
    if (!opts.force) return false;
    // Issue #988's investigation: `terminate()` below awaits `stopScope()`
    // (session-process.ts), which awaits `systemctl --user stop` — this can
    // take up to systemd's own `DefaultTimeoutStopSec` (90s in the incident
    // that motivated this) if the prior session's process doesn't respond
    // to SIGTERM promptly. For that ENTIRE window, marking "killed" only on
    // confirmed success (the previous shape here) left the row reading
    // "active" — squarely in reconcileExitedSessions's own candidate query
    // (session-reconciler.ts selects `status = "active"`), so a concurrent
    // reconcile tick could independently decide this session had "exited on
    // its own", flip the TASK to "failed" with a misleading reason, and
    // delete the worktree this re-seed is about to spawn into (issue #973's
    // incident). Flipping to "killed" BEFORE awaiting terminate — CAS'd on
    // "active" so a losing race here costs nothing — takes this session out
    // of that candidate query's reach for the whole window, not just after
    // it. Restored back to "active" in the catch below if terminate throws,
    // since termination is then NOT confirmed and the normal 30s reconciler
    // must be free to notice this session for real (whether it actually
    // died or is still running).
    const claimedKilled = app.db
      .update(sessions)
      .set({ status: "killed" })
      .where(and(eq(sessions.id, task.sessionId), eq(sessions.status, "active")))
      .run();
    if (claimedKilled.changes === 0) {
      // Lost a race with something else that already moved this session
      // off "active" (a concurrent kill, or it genuinely exited on its own
      // between the read above and this write) — nothing left to
      // terminate, and no live session left to spawn a second agent
      // alongside.
      app.log.warn(
        { taskId: task.id, sessionId: task.sessionId },
        `${logContext}: lost a race marking the still-active session killed before force re-seeding, leaving it as-is`,
      );
      return false;
    }
    try {
      await resolveBackend(app, project.hostId).terminate(String(task.sessionId));
      closeSessionBrowserBindings(app, task.sessionId);
    } catch (err) {
      // Do NOT fall through to spawning anyway — a terminate failure means
      // the old session might still be alive and still writing to this
      // exact worktree; spawning a second agent into it concurrently would
      // be far worse than leaving the task as-is for a later pass to retry.
      app.db
        .update(sessions)
        .set({ status: "active" })
        .where(and(eq(sessions.id, task.sessionId), eq(sessions.status, "killed")))
        .run();
      app.log.warn(
        { err, taskId: task.id, sessionId: task.sessionId },
        `${logContext}: failed to terminate the still-active session before force re-seeding, leaving it as-is`,
      );
      return false;
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
    // Mark this session as an unattended Task Master worker so the
    // opencode adapter denies brainstorming / writing-plans /
    // finishing-a-development-branch — same marker every other Task
    // Master spawn site sets, see task-claim.ts's own worker-spawn
    // comments. The re-seed worker is every bit as unattended as a fresh
    // claim, and could hit the same failure mode (branchdam-mobile
    // tasks #66 / #67) if the brainstorming skill gates on a clarifying
    // question the worker can't answer.
    taskId: task.id,
  });
  if (!result.ok) {
    app.log.warn(
      {
        taskId: task.id,
        reason: result.reason,
        detail: "detail" in result ? result.detail : undefined,
      },
      `${logContext}: re-seed spawn failed, worktree left as-is for a manual claim/retry`,
    );
    return false;
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
  // Hermes review, PR #580 — no status guard here previously, and
  // `force: true`'s new caller (the auto-return path) makes the window
  // between that CAS (status: reviewing -> in_progress) and THIS write
  // reachable in a way reject's own path never was: reject's session was
  // already confirmed exited (or, on the force path, already terminated
  // just above) before this runs, but a concurrent reconcileTasks tick can
  // still observe the task as in_progress before this write lands and race
  // it. CAS on `status = "in_progress"` (the status every caller transitions
  // to just before calling this) so a losing race leaves the freshly-spawned
  // session orphaned rather than clobbering whatever a concurrent
  // approve/reject/give-up/reviewing-transition already decided.
  const updated = app.db
    .update(tasks)
    .set({ sessionId: result.row.id, seedDelivered })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "in_progress")))
    .run();
  if (updated.changes === 0) {
    app.log.warn(
      { taskId: task.id, newSessionId: result.row.id },
      `${logContext}: lost a race with a concurrent transition — the freshly re-seeded session is orphaned, left for a human to notice`,
    );
    return false;
  }
  app.log.info(
    { taskId: task.id, previousSessionId: task.sessionId, newSessionId: result.row.id },
    wasActive
      ? `${logContext}: force-terminated the still-active session and re-seeded a fresh one in the same worktree`
      : `${logContext}: re-seeded a fresh session in the same worktree (previous session had exited)`,
  );
  return true;
}
