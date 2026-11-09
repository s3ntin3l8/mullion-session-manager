// Extracted from routes/tasks.ts's approve handler (pure refactor, no
// behavior change) — the reconciler's auto-approve sweep needs the exact
// same promote -> CAS write -> recordTaskTransition -> syncTaskTransition ->
// cleanupTaskWorktree sequence a human's approve click runs, and having two
// implementations of that sequence drift apart over time is exactly the
// kind of bug this extraction exists to prevent. The route is now a thin
// HTTP-status mapper over this function's own discriminated-union outcome;
// see routes/tasks.ts's approve handler for that mapping.
import type { FastifyInstance } from "fastify";
import { resolveTaskWorkerHost } from "./session-live-info.js";
import { and, eq } from "drizzle-orm";
import { tasks, type projects } from "../db/schema.js";
import { clearMergeNeedsHumanReason, clearReviewPostFailedMarker } from "./task-merge-human.js";
import { promoteTaskToPR } from "./task-promote.js";
import { recordTaskTransition } from "./task-state.js";
import { syncTaskTransition } from "./task-github-sync.js";
// The worktree/session cleanup lives in its own module: task-github-sync.ts
// needs it too, and importing it from here closed an import cycle with
// task-approve.ts (issue #2414). Re-exported so every existing importer
// keeps its path.
import {
  cleanupMergedTaskBranch,
  cleanupTaskSessions,
  cleanupTaskWorktree,
} from "./task-cleanup.js";
export { cleanupMergedTaskBranch, cleanupTaskSessions, cleanupTaskWorktree };

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

export type ApproveOutcome =
  | { ok: true; task: TaskRow }
  | {
      ok: false;
      reason:
        | "no-worktree"
        | "dirty-tree"
        | "no-token"
        | "no-repo"
        | "push-failed"
        | "pr-create-failed"
        | "remote-not-supported"
        | "workflow-approval-required"
        | "push-forbidden";
      detail?: string;
    }
  // The promotion (push + PR) succeeded, but the task moved out of
  // "reviewing" (a concurrent reject, most plausibly) before the CAS write
  // below could land — the PR is real and left open; there is nothing to
  // roll back (see task-promote.ts's own doc comment on the narrower "PR
  // already exists" retry case this is adjacent to).
  | { ok: false; reason: "cas-lost"; prUrl: string; prNumber: number };

/**
 * Promotes a "reviewing" task's PR to non-draft/ready-for-review and flips
 * the task to "done" — the exact sequence a human's approve click runs,
 * factored out so the auto-approve sweep (task-reconciler.ts) can call the
 * identical implementation with `via: "auto-approve"` instead of via HTTP.
 *
 * Deliberately does NOT check `canTransition`/re-read the task's current
 * status before promoting: the CAS write below (`WHERE status =
 * "reviewing"`) is the actual race guard, and every caller either already
 * validated the transition is legal (the route, via `canTransition`) or
 * only ever selects `status = "reviewing"` rows in the first place (the
 * sweep's own candidate query) — a second check here would just duplicate
 * one of those without closing any gap the CAS doesn't already close.
 */
export async function approveTask(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRow,
  via: "approve" | "auto-approve",
): Promise<ApproveOutcome> {
  const promotion = await promoteTaskToPR(app, task, project, resolveTaskWorkerHost(app, task));
  if (!promotion.ok) return promotion;

  const [updated] = app.db
    .update(tasks)
    .set({
      status: "done",
      completedAt: new Date(),
      prUrl: promotion.prUrl,
      prNumber: promotion.prNumber,
      // Merge-on-approve — read from `promotion.prNumber`, not `task.prNumber`:
      // the latter can still be null here (the draft PR opened at "->
      // reviewing" is best-effort and can have failed), but `promotion`
      // above is awaited and guaranteed non-null on `ok: true`. The
      // reconciler's processMergeRequests sweep (task-reconciler.ts) picks
      // this up and lands the merge asynchronously once GitHub allows it —
      // never inline here, since main's branch protection requires an
      // up-to-date branch and green checks that a just-pushed commit almost
      // never has yet.
      mergeRequestedAt: project.mergeOnApprove ? new Date() : null,
      mergeError: null,
      // A human approving past a failed approving-review post acts on the hold
      // (holdsForReviewPost); leave it set and processMergeRequests would skip
      // the merge on every tick.
      needsHumanReason:
        task.needsHumanReason === "review-post-failed" ? null : clearMergeNeedsHumanReason,
      reviewPostPending: clearReviewPostFailedMarker,
      rebaseStartedAt: null,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
    .returning()
    .all();
  if (!updated) {
    return { ok: false, reason: "cas-lost", prUrl: promotion.prUrl, prNumber: promotion.prNumber };
  }

  recordTaskTransition(app, {
    taskId: task.id,
    projectId: project.id,
    from: "reviewing",
    to: "done",
    via,
    context: { prUrl: promotion.prUrl },
  });
  // Deliberately NOT awaited (Hermes review, PR #474) — syncTaskTransition
  // never throws (every failure is caught and logged inside it), so
  // awaiting its GitHub round-trips here would only add latency for no
  // benefit. Fire-and-forget.
  void syncTaskTransition(app, updated, project, "done", { prUrl: updated.prUrl ?? undefined });
  cleanupTaskWorktree(app, updated, project);
  cleanupTaskSessions(app, updated);

  return { ok: true, task: updated };
}
