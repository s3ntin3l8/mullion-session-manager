// Reject flow's delivery of the human's feedback to the task's agent
// (`routes/tasks.ts`'s POST /api/tasks/:id/reject).
//
// A worker whose task reached review is almost always still ALIVE, idle at
// its prompt, so the feedback is typed into that session
// (promptLiveTaskWorker, task-reseed.ts) — keeping its context and
// scrollback — and its next turn end sends the task back to review. When
// the session can't take it (blocked on a dialog, busy mid-turn, an agent
// with no typed-prompt support) the still-active worker is terminated and
// re-seeded the way task-reconciler.ts's review-feedback auto-return does
// (`force: true`): a stuck worker must not leave the feedback undelivered.
// When the session had already exited, a fresh one is spawned in the SAME
// worktree, seeded with the feedback, so a reject doesn't strand the task
// with no agent attached. The spawn-or-not mechanics are shared with that
// auto-return via reseedTaskIfSessionExited (task-reseed.ts), so the paths
// can't drift apart.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import type { projects, tasks } from "../db/schema.js";
import { deriveTaskBranchName } from "./git-worktree.js";
import { resolveBackend, resolveSessionsDirWithFallback } from "./session-backend.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { resolveTaskIssueContextSafe } from "./task-issue-context.js";
import {
  buildRejectFollowUpPrompt,
  buildRejectPrompt,
  taskCommitTitlePath,
} from "./task-prompt.js";
import { promptLiveTaskWorker, reseedTaskIfSessionExited } from "./task-reseed.js";

/**
 * Returns whether the task is left with a live agent holding the feedback:
 * `true` covers "typed into the live worker" and "re-seeded a fresh
 * session" (and a task with no session to speak of — nothing to deliver
 * to). `false` means a re-seed was needed AND failed (spawn failure, a
 * failed terminate, or lost a race) — issue #987: that used to leave the
 * task sitting at "in_progress" with a dead session and a stale
 * `sessionId` forever, since nothing ever revisits it. The caller fails the
 * task explicitly instead.
 */
export async function deliverRejectFeedback(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  feedback: string | null,
): Promise<boolean> {
  if (!task.sessionId || !task.worktreePath || !task.agentCommand) return true;
  const [session] = app.db.select().from(sessions).where(eq(sessions.id, task.sessionId)).all();
  const wasActive = session?.status === "active";
  const branchName = task.branchName ?? deriveTaskBranchName(task);
  // #778 — resolved against the OWNING host's own sessionsDir; see
  // task-reconciler.ts's spawnReviewAgentNow for the full rationale.
  const commitTitlePath = project.conventionalCommitTitles
    ? taskCommitTitlePath(
        await resolveSessionsDirWithFallback(app, resolveBackend(app, project.hostId), {
          taskId: task.id,
          hostId: project.hostId,
        }),
        task.id,
      )
    : undefined;
  if (wasActive) {
    const typed = await promptLiveTaskWorker(
      app,
      task,
      buildRejectFollowUpPrompt({ branchName, feedback, commitTitlePath }),
      "task reject",
    );
    if (typed) return true;
  }
  // Includes the task spec, not just the feedback: this reaches a FRESH
  // agent that has no memory of the task — the previous feedback-only
  // prompt told it "this was rejected, here's why" about work it had never
  // seen and a spec it had never read.
  // #939/#1016 — resolved once per spawn, fail-open — see
  // task-issue-context.ts's own doc comment.
  const issueContext = await resolveTaskIssueContextSafe(app, task, project);
  const prompt = buildRejectPrompt({
    task: {
      ...task,
      comments: issueContext?.comments,
      parent: issueContext?.parent,
      siblings: issueContext?.siblings,
    },
    branchName,
    worktreePath: task.worktreePath,
    budgetMinutes: resolveTaskMasterConfig(app).budgetMinutes,
    feedback,
    agentCommand: task.agentCommand,
    commitTitlePath,
  });
  return reseedTaskIfSessionExited(app, task, project, prompt, "task reject", {
    force: wasActive,
  });
}
