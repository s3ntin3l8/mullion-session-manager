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
import { parseHostCwds, projectCwdOnHost } from "./placement.js";
import { and, eq } from "drizzle-orm";
import { tasks, type projects } from "../db/schema.js";
import { promoteTaskToPR } from "./task-promote.js";
import { recordTaskTransition } from "./task-state.js";
import { syncTaskTransition } from "./task-github-sync.js";
import { resolveBackend } from "./session-backend.js";
import { killSession } from "./session-lifecycle.js";
import { stopHermesRunQuietly } from "./hermes-task-review.js";

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

// Phase 6's 6.8 (#283) — best-effort worktree cleanup once a task leaves
// "reviewing" for a terminal state. Fire-and-forget, same posture as the
// GitHub sync calls below it: cleanup succeeding or failing doesn't change
// whether the transition itself is valid, and removeWorktreeIfClean already
// leaves a dirty/unclear tree in place for a later pass to retry rather
// than losing anything. Exported — give-up's route (routes/tasks.ts) calls
// this too, on the same "left reviewing for a terminal state" posture.
//
// #775 — `project`'s type is deliberately narrower than the full `ProjectRow`
// (`{ id?, cwd, hostId }` rather than `typeof projects.$inferSelect`): the
// body only ever reads `hostId`/`cwd` (structural) and `id` (log field
// only), and task-github-sync.ts's syncClosedIssueToLocal needs to call this
// from a lightweight ProjectRef ({ cwd, hostId }, no `id`) without a second
// full-row fetch — see that file's own comment on why it narrows the same
// way. Every existing caller passes a full ProjectRow, which satisfies this
// structurally, so nothing else changes.
export function cleanupTaskWorktree(
  app: FastifyInstance,
  task: { worktreePath: string | null; sessionId?: number | null; projectId?: number },
  project: { id?: number; cwd: string; hostId: string; hostCwds?: string | null },
): void {
  if (!task.worktreePath) return;
  const target = resolveCleanupTarget(app, task, project);
  if (!target) return;
  void resolveBackend(app, target.hostId)
    .removeWorktreeIfClean(task.worktreePath, target.cwdOnHost)
    .catch((err) => {
      app.log.warn(
        { err, worktreePath: task.worktreePath, projectId: project.id },
        "task cleanup: removeWorktreeIfClean threw",
      );
    });
}

type CleanupProject = { id?: number; cwd: string; hostId: string; hostCwds?: string | null };

// Issue #1724 — the worktree lives on the host its worker session was
// PLACED on, which is not necessarily the project's own host. The
// project's host is the fallback for a task whose worker session is gone
// — and for every task from before placement existed. `cwdOnHost` is the
// project's path ON THAT HOST; null (-> this returns null) when the project
// is not mapped there, in which case that host cannot be holding the
// worktree or branch, so there is nothing to remove. The project's own root
// is NOT a stand-in: it is a path that host does not have, and removing
// against it fails silently and leaks the worktree.
function resolveCleanupTarget(
  app: FastifyInstance,
  task: { sessionId?: number | null; projectId?: number },
  project: CleanupProject,
): { hostId: string; cwdOnHost: string } | null {
  const hostId =
    task.sessionId !== undefined && task.sessionId !== null && task.projectId !== undefined
      ? resolveTaskWorkerHost(
          app,
          { sessionId: task.sessionId, projectId: task.projectId },
          project,
        )
      : project.hostId;
  const cwdOnHost = projectCwdOnHost(project, hostId, parseHostCwds(project.hostCwds));
  if (cwdOnHost === null) {
    app.log.warn(
      { projectId: project.id, hostId },
      "task cleanup: no path for this project on that host — the worktree there cannot be removed",
    );
    return null;
  }
  return { hostId, cwdOnHost };
}

// Once GitHub has CONFIRMED a task's PR merged, its local branch has no
// further use (the remote one is deleted on merge): remove the worktree,
// then the branch. Sequenced, not parallel — git refuses to delete a branch
// that is still checked out in a worktree, and concurrent git operations on
// one clone have corrupted shared objects before. A worktree that is dirty or
// conflicted is left in place and its branch with it. `force` is needed
// because a squash-merged branch is not an ancestor of the base; it is safe
// only because every caller has already confirmed the merge. Best-effort and
// fire-and-forget like cleanupTaskWorktree. Callers must run it only from
// the CAS that won the merge write, so one merge cleans up once.
export function cleanupMergedTaskBranch(
  app: FastifyInstance,
  task: {
    branchName: string | null;
    worktreePath: string | null;
    sessionId?: number | null;
    projectId?: number;
  },
  project: CleanupProject,
): void {
  if (!task.branchName) {
    cleanupTaskWorktree(app, task, project);
    return;
  }
  const target = resolveCleanupTarget(app, task, project);
  if (!target) return;
  const branchName = task.branchName;
  const backend = resolveBackend(app, target.hostId);
  void (async () => {
    if (task.worktreePath) {
      const res = await backend.removeWorktreeIfClean(task.worktreePath, target.cwdOnHost);
      if (!res.removed && res.reason !== "not-a-repo") {
        app.log.info(
          { projectId: project.id, branchName, reason: res.reason },
          "task cleanup: worktree left in place, keeping the merged task's branch",
        );
        return;
      }
    }
    const result = await backend.deleteBranch(target.cwdOnHost, branchName, { force: true });
    if (!result.deleted) {
      app.log.debug(
        { projectId: project.id, branchName, result },
        "task cleanup: merged task's branch was not deleted",
      );
    }
  })().catch((err) => {
    app.log.warn(
      { err, branchName, projectId: project.id },
      "task cleanup: deleting the merged task's branch threw",
    );
  });
}

// Best-effort session cleanup once a task leaves "reviewing" for a terminal
// state — the sibling of cleanupTaskWorktree above, same fire-and-forget
// posture: cleanup succeeding or failing never changes whether the
// transition itself is valid. Kills both the worker session and the
// (optional) review session — neither is ever terminated anywhere else once
// a task reaches "done", so leaving this out means both processes (and
// their systemd scopes/dtach masters) keep running indefinitely, and the
// sessions themselves linger as "active"/"exited" in the sidebar and the
// Unified Board's ad-hoc lane (both of which filter out "killed", never
// "active"/"exited"). Uses killSession, not a bare backend.terminate — the
// row must flip to "killed" or it reads as an unexplained crash later (same
// reasoning as the orphaned-review-spawn rollback in task-reconciler.ts).
// Exported — give-up's route (routes/tasks.ts) calls this too, on the same
// "left reviewing for a terminal state" posture.
export function cleanupTaskSessions(
  app: FastifyInstance,
  task: { sessionId: number | null; reviewSessionId: number | null; reviewRunId?: string | null },
): void {
  // An external reviewer's run (#2369) is the review's "session" too.
  stopHermesRunQuietly(app, task.reviewRunId);
  // A Set, not a plain pair — sessionId and reviewSessionId are never the
  // same column-for-column, but nothing enforces that at the type level,
  // so this stays correct (a single kill, not two) even if that ever
  // changed. killSession is itself idempotent either way, so this is
  // belt-and-suspenders, not a correctness fix.
  for (const sessionId of new Set([task.sessionId, task.reviewSessionId])) {
    if (sessionId === null) continue;
    void killSession(app, sessionId, "detach").catch((err) => {
      app.log.warn({ err, sessionId }, "task cleanup: killSession threw");
    });
  }
}

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
