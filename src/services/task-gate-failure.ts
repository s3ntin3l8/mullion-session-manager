import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import type { projects, sessions } from "../db/schema.js";
import { tasks } from "../db/schema.js";
import { commitHostWipChanges, resolveHostGitStatus } from "./host-git.js";
import { resolveGitIdentity } from "./git-identity.js";
import { getStoredSettings } from "./settings.js";
import { killSession } from "./session-lifecycle.js";
import { resolveTaskWorkerHost } from "./session-live-info.js";
import type { SessionBackend } from "./session-backend.js";
import type { SessionInfo } from "./pty-manager.js";
import { syncTaskTransition } from "./task-github-sync.js";
import { recordTaskTransition } from "./task-state.js";
import {
  collectRecentEvents,
  collectScrollbackTail,
  formatFailureDiagnostics,
  type DiagnosticParts,
} from "./task-failure-diagnostics.js";

/**
 * Executes the #722 "no commits ahead of base" failure found by
 * `checkReviewingGate`: probes `commitHostWipChanges` FIRST (issue #1100),
 * THEN — only if that probe succeeds — claims the task via the same CAS
 * `.where(status = fromStatus)` every other automatic transition in this
 * file uses, then cleans up exactly like the budget-exceeded branch above:
 * terminate the session, sync the failure to GitHub, remove the worktree if
 * (now) clean. This is what makes Retry able to recover the work — before
 * this, a dirty leftover worktree at the deterministic path permanently
 * blocked `resumeTaskWorktree`'s own `git worktree add`.
 *
 * `commitHostWipChanges` (host-git.ts) IS the capability probe here — no
 * separate probe/capability-check endpoint exists or is needed. It's
 * idempotent for this purpose: a clean tree returns `{ committed: false }`,
 * a no-op; a dirty tree does the useful salvage work anyway. `ok: false`
 * (`"unsupported"` — an agent build predating that route — or
 * `"unreachable"`) means this host can't even be asked, so this function
 * logs a warning naming the reason and returns WITHOUT touching the task's
 * status — the same fail-open posture `checkReviewingGate` used to apply
 * unconditionally to every remote host, now correctly scoped to only the
 * version-skew/unreachable case.
 *
 * Salvage BEFORE the CAS, reversing PR #726's own fix (which moved the CAS
 * before the salvage commit specifically so a task that lost a race with a
 * concurrent transition — e.g. a human Reject landing mid-flight — couldn't
 * still get a stray wip commit pushed onto a branch this function no longer
 * owned). That race is real, but narrower than the harm of keeping CAS
 * first here: CAS-first means an `"unsupported"`/`"unreachable"` remote
 * host's task gets marked "failed" BEFORE the salvage is even attempted,
 * and that transition can never be backed out — the session is killed and
 * `removeWorktreeIfClean` then refuses (dirty is its one real refusal
 * condition), permanently stranding the task exactly like the harm the
 * original local-only guards existed to avoid. Probing first accepts the
 * rare concurrent-transition race in exchange for not stranding a task
 * behind a remote host's version skew ON THIS PATH SPECIFICALLY — the
 * unconditional budget-exceeded check earlier in the reconcile loop fails a
 * task with no salvage attempt at all, host-independent and pre-existing,
 * so a remote host stuck behind version skew can still eventually strand
 * once/if its task budget expires (same as a local host today). This
 * function's own guard only ever protected the no-commits-gate path.
 */
export async function failReviewingGate(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  session: typeof sessions.$inferSelect,
  project: typeof projects.$inferSelect,
  backend: SessionBackend,
  fromStatus: "claimed" | "in_progress",
  failureReason: string,
  now: Date,
  info: SessionInfo | null = null,
): Promise<void> {
  // Diagnostic snapshot — gathered BEFORE the salvage commit (which would
  // empty `git status`) and before the session/worktree are cleaned up.
  // Best-effort: every piece swallows its own error, and the whole thing is
  // guarded again so it can never change the failure transition below.
  const parts: DiagnosticParts = { scrollback: null, events: null, gitStatus: null, salvage: null };
  const workerHostId = resolveTaskWorkerHost(app, task);
  try {
    parts.scrollback = await collectScrollbackTail(app, backend, session.id);
    parts.events = collectRecentEvents(app, session.id);
    if (task.worktreePath) {
      const status = await resolveHostGitStatus(app, workerHostId, task.worktreePath);
      if (status.ok && status.value.status) {
        parts.gitStatus = {
          files: status.value.status.files.map((f) => ({ path: f.path, status: f.status })),
        };
      }
    }
  } catch (err) {
    app.log.warn({ err, taskId: task.id }, "task reconcile: failure diagnostics collection failed");
  }

  if (task.worktreePath) {
    // Issue #1724 — the worktree is on the WORKER's host, so the commit
    // happens there too.
    const commitResult = await commitHostWipChanges(
      app,
      workerHostId,
      task.worktreePath,
      undefined,
      resolveGitIdentity(project.gitIdentity, getStoredSettings(app.db).sessions.gitIdentity),
    );
    if (!commitResult.ok) {
      app.log.warn(
        {
          taskId: task.id,
          hostId: workerHostId,
          worktreePath: task.worktreePath,
          reason: commitResult.reason,
          ...(commitResult.reason === "unreachable" ? { detail: commitResult.detail } : {}),
        },
        commitResult.reason === "unsupported"
          ? "task reconcile: WIP salvage skipped — this host's agent build doesn't support committing WIP changes yet (see issue #1100), failing the reviewing gate open"
          : "task reconcile: WIP salvage skipped — host unreachable, failing the reviewing gate open",
      );
      return;
    }
    if (commitResult.value.error) {
      app.log.warn(
        { taskId: task.id, worktreePath: task.worktreePath, error: commitResult.value.error },
        "task reconcile: WIP salvage commit failed",
      );
      parts.salvage = `failed (${commitResult.value.error})`;
    } else if (commitResult.value.committed) {
      app.log.info({ taskId: task.id }, "task reconcile: committed a WIP salvage commit");
      parts.salvage = "committed a WIP commit";
    } else {
      parts.salvage = "nothing to commit";
    }
  }

  let failureDiagnostics: string | null = null;
  try {
    failureDiagnostics = formatFailureDiagnostics(
      task,
      parts,
      info?.lastTurnEndedAt ? new Date(info.lastTurnEndedAt) : now,
    );
  } catch (err) {
    app.log.warn({ err, taskId: task.id }, "task reconcile: failure diagnostics formatting failed");
  }

  const updated = app.db
    .update(tasks)
    .set({ status: "failed", failureReason, failureDiagnostics, completedAt: now })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, fromStatus)))
    .run();
  if (updated.changes === 0) return;

  recordTaskTransition(app, {
    taskId: task.id,
    projectId: project.id,
    from: fromStatus,
    to: "failed",
    via: "reconcile",
    context: { sessionId: session.id, reason: failureReason },
  });
  // killSession, not a bare backend.terminate — this task just left
  // claimed/in_progress for good, and nothing else will ever flip this
  // session's row to "killed." A bare terminate leaves it "active" until
  // the 30s exited-session reconciler notices and marks it "exited" —
  // never "killed", the one status the sidebar and the Unified Board's
  // ad-hoc lane don't already filter out of view.
  await killSession(app, session.id).catch((err) => {
    app.log.warn(
      { err, taskId: task.id, sessionId: session.id },
      "task reconcile: failed to kill session after the no-commits gate failure",
    );
  });
  await syncTaskTransition(
    app,
    { ...task, status: "failed", failureReason, failureDiagnostics, completedAt: now },
    project,
    "failed",
  );
  if (task.worktreePath) {
    await backend.removeWorktreeIfClean(task.worktreePath, project.cwd).catch((err) => {
      app.log.warn(
        { err, taskId: task.id, worktreePath: task.worktreePath },
        "task reconcile: removeWorktreeIfClean threw after the no-commits gate failure",
      );
    });
  }
}
