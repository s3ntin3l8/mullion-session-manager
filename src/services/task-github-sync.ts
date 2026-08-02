// Phase 6 Task Master (6.4/#217) — transition -> GitHub side-effect map.
// Fires on every local task-status transition that has a linked issue;
// silently a no-op for a local-only task (issueNumber === null) or when no
// GitHub token is connected — the local row is always the hub and this
// sync must never block or roll back the transition that already
// committed locally.
//
// Best-effort by design: every write is wrapped so a GitHub failure is
// logged, never thrown back at the caller and never re-applied to local
// state. Accepted, stated gap (not silently dropped): there is still no
// persistent retry queue here — a sync that fails during a transient
// GitHub outage is not automatically retried on the next watcher sweep. A
// real retry needs either an in-memory "retry once on next sweep" (which
// would replay every write for every non-terminal linked task on every
// process restart — including posting a duplicate "Task claimed" comment
// on an issue claimed days ago) or genuinely tracking per-write retry
// state, more machinery than this module takes on. What #485 DID add: the
// failure is no longer visible only in a server log — tasks.githubSyncError
// (see recordGithubSyncError/clearGithubSyncError below) durably records
// the most recent failure on the task row itself, cleared the next time a
// GitHub WRITE for that task succeeds (not a read — see
// syncClosedIssueToLocal's own comment on why a successful read proves
// nothing about write scope, Hermes review PR #495). Visibility, not
// automatic recovery.
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import { getToken, getIntegration } from "./github-integration.js";
import { resolveRepoRef } from "./github-webhook.js";
import {
  addLabels,
  removeLabel,
  createComment,
  setAssignees,
  closeIssue,
  getIssueState,
} from "./github-write.js";
import { canTransition, type TaskStatus } from "./task-state.js";
import { resolveTaskMasterConfig } from "./task-config.js";

export const LABEL_CLAIMED = "mullion-claimed";
export const LABEL_REVIEWING = "mullion-reviewing";
export const LABEL_DONE = "mullion-done";
const ACTIVE_LABELS = [LABEL_CLAIMED, LABEL_REVIEWING];

export type TaskSyncEvent =
  "claimed" | "in_progress" | "reviewing" | "done" | "failed" | "rejected";

type TaskRow = typeof tasks.$inferSelect;
// Narrowed to exactly what resolveRepoRef needs, not the full projects row
// — lets task-watcher.ts's read-back sweep (which only has a project's
// id/cwd from its own lightweight localProjectRows() query, not a full
// row) call into this module without an extra full-row fetch.
type ProjectRef = { cwd: string; hostId: string };

// Per-task last-progress-comment timestamp, in-memory only — a process
// restart resets the throttle (one extra comment at worst), same
// "approximate is fine" posture as this file's other in-memory state.
const lastProgressCommentAt = new Map<number, number>();

/** Test-only reset — the throttle Map is module-level and would otherwise
 * leak state between test files/cases. */
export function resetProgressThrottleForTests(): void {
  lastProgressCommentAt.clear();
}

// #485 — tasks.githubSyncError is the durable, UI-visible record of the
// most recent GitHub write/scope failure for a task (a 403 from an
// under-scoped token, most commonly) — write/scope, not "write/read"
// (Hermes review, PR #495, third pass): a read-back failure is deliberately
// never recorded here (see syncClosedIssueToLocal's own catch block).
// Previously every failure on this module's paths was logged and dropped
// with nothing surfaced anywhere durable — even task-promote.ts's
// promotion failures, despite docs claiming those were the one visible
// exception; they were only ever shown via transient component state, gone
// on remount. These two helpers are shared by this file's own catch blocks
// and by task-promote.ts, so the column's write-only recording shape lives
// in exactly one place.
// Both helpers below swallow their own DB errors (Hermes review, PR #495,
// third pass) rather than letting every caller wrap them individually — an
// unguarded `.run()` throwing (e.g. a locked DB) would otherwise escape
// callers like syncTaskTransition that are documented to "never throw," or
// mask the ORIGINAL GitHub error a catch block was already in the middle of
// handling when it called recordGithubSyncError. This is purely visibility
// bookkeeping; a failure to record/clear it is never worth failing louder
// than the thing it's recording.
export function recordGithubSyncError(app: FastifyInstance, taskId: number, message: string): void {
  try {
    app.db.update(tasks).set({ githubSyncError: message }).where(eq(tasks.id, taskId)).run();
  } catch (err) {
    app.log.warn({ err, taskId }, "[task-github-sync] failed to record githubSyncError");
  }
}

/** Clears a previously-recorded sync error once a GitHub WRITE for this
 * task succeeds — the column reflects current write-scope state, not
 * history. Deliberately not called on a bare successful read (see
 * syncClosedIssueToLocal's own comment): a read proves connectivity, not
 * write scope, and #485's own failure mode is a token that reads fine but
 * 403s on writes. A harmless no-op when nothing was recorded. */
export function clearGithubSyncError(app: FastifyInstance, taskId: number): void {
  try {
    app.db.update(tasks).set({ githubSyncError: null }).where(eq(tasks.id, taskId)).run();
  } catch (err) {
    app.log.warn({ err, taskId }, "[task-github-sync] failed to clear githubSyncError");
  }
}

/**
 * Returns whether an actual GitHub write happened — `false` only for the
 * `in_progress` throttle's early-return no-op. `syncTaskTransition` uses
 * this to decide whether it's safe to clear a previously recorded
 * `githubSyncError` (Hermes review, PR #495): a throttled tick makes no
 * GitHub call at all, so treating it as a successful sync would silently
 * clear a real, still-unresolved write failure recorded by an earlier
 * transition.
 */
async function runSync(
  token: string,
  owner: string,
  repo: string,
  app: FastifyInstance,
  task: TaskRow,
  event: TaskSyncEvent,
  extra: { feedback?: string; prUrl?: string },
): Promise<boolean> {
  // Non-null: syncTaskTransition already returned early when
  // task.issueNumber is null.
  const issueNumber = task.issueNumber!;

  switch (event) {
    case "claimed": {
      await addLabels(token, owner, repo, issueNumber, [LABEL_CLAIMED]);
      await createComment(token, owner, repo, issueNumber, "Task claimed — agent starting…");
      const login = getIntegration(app).login;
      if (login) await setAssignees(token, owner, repo, issueNumber, [login]);
      break;
    }
    case "in_progress": {
      // Settings-backed override of MULLION_TASK_PROGRESS_COMMENT_MINUTES
      // (Task Master Settings UI follow-up) — see task-config.ts's doc comment.
      const throttleMs = resolveTaskMasterConfig(app).progressCommentMinutes * 60_000;
      const last = lastProgressCommentAt.get(task.id);
      if (throttleMs > 0 && last !== undefined && Date.now() - last < throttleMs) return false;
      await createComment(token, owner, repo, issueNumber, "Agent is working on this task.");
      lastProgressCommentAt.set(task.id, Date.now());
      break;
    }
    case "reviewing": {
      await removeLabel(token, owner, repo, issueNumber, LABEL_CLAIMED);
      await addLabels(token, owner, repo, issueNumber, [LABEL_REVIEWING]);
      // Deliberately no diff-stat summary here: the branch's actual base
      // at claim time isn't persisted anywhere on the task row, so the
      // only way to compute one here would be re-resolving the project's
      // *current* default base ref — which, on an active repo where main
      // has moved since the task branched, reports the diff against a
      // base the branch was never actually cut from (task changes PLUS
      // everything merged to main since). A wrong "+2847/-1203" in an
      // issue comment is worse than no number at all.
      await createComment(token, owner, repo, issueNumber, "Task ready for review.");
      break;
    }
    case "done": {
      await removeLabel(token, owner, repo, issueNumber, LABEL_REVIEWING);
      await addLabels(token, owner, repo, issueNumber, [LABEL_DONE]);
      await createComment(
        token,
        owner,
        repo,
        issueNumber,
        extra.prUrl ? `Approved — see ${extra.prUrl}` : "Approved.",
      );
      await closeIssue(token, owner, repo, issueNumber);
      // Terminal — this task will never post another progress comment, so
      // its throttle entry (if any) is dead weight for the rest of the
      // process's life. Pruned on both terminal events (here and "failed"
      // below) rather than left to accumulate.
      lastProgressCommentAt.delete(task.id);
      break;
    }
    case "failed": {
      for (const label of ACTIVE_LABELS) {
        await removeLabel(token, owner, repo, issueNumber, label);
      }
      await createComment(
        token,
        owner,
        repo,
        issueNumber,
        `Task failed: ${task.failureReason ?? "unknown reason"}`,
      );
      lastProgressCommentAt.delete(task.id);
      break;
    }
    case "rejected": {
      await createComment(
        token,
        owner,
        repo,
        issueNumber,
        extra.feedback ? `Changes requested: ${extra.feedback}` : "Changes requested.",
      );
      break;
    }
  }
  return true;
}

/**
 * Syncs one local task-status transition to its linked GitHub issue (the
 * sync map above). No-op for a local-only task or when no GitHub token is
 * connected — both are normal, expected states, not errors. Never throws:
 * every write failure is caught and logged (`[task-github-sync]`), since a
 * GitHub-side problem must never block or unwind a transition that has
 * already committed to the local task row (the hub of record).
 */
export async function syncTaskTransition(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRef,
  event: TaskSyncEvent,
  extra: { feedback?: string; prUrl?: string } = {},
): Promise<void> {
  if (task.issueNumber === null) return;
  const token = getToken(app);
  if (!token) return;

  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return;

  try {
    const wrote = await runSync(token, repoRef.owner, repoRef.repo, app, task, event, extra);
    if (wrote) clearGithubSyncError(app, task.id);
  } catch (err) {
    app.log.warn(
      { taskId: task.id, issueNumber: task.issueNumber, event, err },
      "[task-github-sync] write failed — local task state is unaffected, see the accepted-gap note in this file for retry behavior",
    );
    recordGithubSyncError(app, task.id, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Read-back half (6.4/#217, building on PR1's watcher insert-or-update):
 * a task's issue closing on GitHub is reflected into the local row as
 * "done" — but ONLY when the task is legally allowed there (canTransition
 * gates this, not just "the issue looks closed"). A "claimed"/"in_progress"
 * task whose issue someone closed out-of-band still has a real agent
 * running in a live worktree; forcing it straight to "done" would silently
 * abandon that work mid-flight. Left alone (logged) in that case — a human
 * closing the issue early is expected to also deal with the in-flight
 * session, not have Mullion paper over it.
 *
 * Deliberately does NOT handle "label removed but issue still open" (the
 * plan's other half of "closed or unlabeled...syncs done/removal") — that
 * case is genuinely ambiguous (a human tidying up labels vs. abandoning
 * the task) and its most literal reading ("removal") would mean deleting a
 * local row that might be mid-flight, which is destructive enough to
 * deserve its own explicit decision rather than being inferred here.
 * Accepted, stated gap — not silently dropped.
 */
export async function syncClosedIssueToLocal(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRef,
): Promise<void> {
  if (task.issueNumber === null) return;
  const token = getToken(app);
  if (!token) return;
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return;

  if (!canTransition(task.status as TaskStatus, "done")) {
    app.log.debug(
      { taskId: task.id, status: task.status },
      "[task-github-sync] issue closed on GitHub but task can't legally reach done from its current status, leaving it alone",
    );
    return;
  }

  try {
    const state = await getIssueState(token, repoRef.owner, repoRef.repo, task.issueNumber);
    // Deliberately does NOT clearGithubSyncError here (Hermes review, PR
    // #495): a successful READ proves only read connectivity, not write
    // scope — exactly the #485 failure mode (an under-scoped token 403s
    // writes but reads fine). Clearing on a read success would let this
    // sweep silently clear a real, still-unresolved write-403 on its next
    // tick, making the banner flicker on and off instead of staying
    // accurate. Only a successful write (syncTaskTransition above) clears
    // the column.
    if (state !== "closed") return;

    const now = new Date();
    // Status-guarded (Hermes review, PR #474) — canTransition above ran
    // against a stale snapshot of `task`. Without this guard, a concurrent
    // reject (reviewing -> in_progress) landing between that check and this
    // write would get silently clobbered back to "done" — every other
    // transition write in this codebase (task-claim.ts, task-reconciler.ts,
    // routes/tasks.ts) already guards its UPDATE on the expected prior
    // status; this one now matches.
    const updated = app.db
      .update(tasks)
      .set({ status: "done", completedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
      .run();
    if (updated.changes > 0) {
      app.log.info(
        { taskId: task.id, issueNumber: task.issueNumber },
        "[task-github-sync] issue closed on GitHub, local task synced to done",
      );
    }
  } catch (err) {
    // Deliberately does NOT recordGithubSyncError here either (Hermes
    // review, PR #495, second pass): the column only has ONE clearing path
    // (a successful write, see syncTaskTransition above) — recording a
    // transient read-back failure (a rate limit, a 5xx) here would leave it
    // stuck on the banner until some unrelated write happens to fire,
    // wildly outliving the transient problem that caused it. githubSyncError
    // stays scoped to write/scope failures, which is also what its own doc
    // comment and the UI's banner copy ("GitHub sync: …") already promise —
    // a read-back hiccup is logged, not durably surfaced.
    app.log.warn(
      { taskId: task.id, issueNumber: task.issueNumber, err },
      "[task-github-sync] read-back check failed",
    );
  }
}
