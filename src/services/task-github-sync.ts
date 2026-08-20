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
import { getIntegration, resolveGitHubToken } from "./github-integration.js";
import { resolveRepoRef } from "./host-git.js";
import {
  addLabels,
  removeLabel,
  createComment,
  setAssignees,
  closeIssue,
  getIssueState,
  getPullRequestByNumber,
  createPullRequestReview,
} from "./github-write.js";
import { GitHubApiError } from "./github.js";
import { severityPrefix, type ReviewFinding } from "./task-prompt.js";
import { canTransition, recordTaskTransition, type TaskStatus } from "./task-state.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { getDiffStats, type GitDiffStats } from "./git-diff.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";

export const LABEL_CLAIMED = "mullion-claimed";
export const LABEL_REVIEWING = "mullion-reviewing";
export const LABEL_DONE = "mullion-done";
const ACTIVE_LABELS = [LABEL_CLAIMED, LABEL_REVIEWING];

export type TaskSyncEvent =
  "claimed" | "in_progress" | "reviewing" | "done" | "failed" | "rejected";

type TaskRow = typeof tasks.$inferSelect;
// Narrowed to exactly what resolveRepoRef needs, not the full projects row
// — lets task-watcher.ts's read-back sweep (which only has a project's
// id/cwd from its own lightweight pollableProjectRows() query, not a full
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
  extra: { feedback?: string; prUrl?: string; diffStat?: GitDiffStats },
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
      // #491 — the diff-stat, when available, is computed by the caller
      // (task-reconciler.ts) against tasks.baseSha, a commit SHA pinned at
      // claim time (task-claim.ts), and passed in via extra.diffStat. This
      // function stays filesystem-free by design (see its own doc comment
      // above) — it only ever formats what it's handed. `diffStat` is
      // absent (not just zero) for a remote-hosted task, or when the git
      // call itself failed — either way, omitting the number here is
      // strictly better than guessing one.
      const diffStatSuffix = extra.diffStat
        ? ` (+${extra.diffStat.insertions}/-${extra.diffStat.deletions} across ${extra.diffStat.filesChanged} file${extra.diffStat.filesChanged === 1 ? "" : "s"})`
        : "";
      await createComment(
        token,
        owner,
        repo,
        issueNumber,
        `Task ready for review.${diffStatSuffix}`,
      );
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
/**
 * #491 — best-effort diff-stat for a task's own worktree against its
 * pinned `baseSha`, for the `reviewing` transition's issue comment. Kept
 * separate from `syncTaskTransition`/`runSync` (which stay filesystem-free
 * by design — see this file's header comment) — callers that already have
 * a worktree/SHA/project to hand (task-reconciler.ts's `reviewing`
 * transitions) compute this and pass it through `extra.diffStat`. Returns
 * `undefined` (not stored, not shown) when the task has no worktree path or
 * no pinned SHA — a task claimed before the `baseSha` column existed, or a
 * remote-hosted task whose host was unreachable at claim time (#484 —
 * `resolveHostBaseRef`'s own unreachable/unsupported fallback) — or when
 * the diff itself can't be produced; never throws.
 *
 * #484 — dispatches to `getDiffStats` locally or
 * `/internal/git-diff` (already existing, `resolveGitDiffStats`) remotely,
 * since `task.worktreePath` only exists on whichever host actually owns
 * it. `resolveGitDiffStats` returns `{ isRepo, stats }`; both `isRepo:
 * false` and `stats: null` collapse to `undefined` here, the same value
 * the local branch already produces for a failed/absent diff — the value
 * `syncTaskTransition`'s callers already treat as "post the comment with
 * no number rather than a guessed one."
 */
export async function computeTaskDiffStat(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRef,
): Promise<GitDiffStats | undefined> {
  if (!task.worktreePath || !task.baseSha) return undefined;
  if (project.hostId === LOCAL_HOST_ID) {
    const stats = await getDiffStats(task.worktreePath, task.baseSha);
    return stats ?? undefined;
  }
  try {
    const { stats } = await getRemoteHostClient(app, project.hostId).resolveGitDiffStats(
      task.worktreePath,
      task.baseSha,
    );
    return stats ?? undefined;
  } catch {
    // Host unreachable, or an old agent build with no /internal/git-diff —
    // same "nothing to show" posture as every other failure mode above.
    return undefined;
  }
}

export async function syncTaskTransition(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRef,
  event: TaskSyncEvent,
  extra: { feedback?: string; prUrl?: string; diffStat?: GitDiffStats } = {},
): Promise<void> {
  if (task.issueNumber === null) return;
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return;

  // #489 — repo-scoped (App installation token when configured, falling
  // back to the shared PAT/OAuth token) rather than the plain getToken
  // this used before.
  const token = await resolveGitHubToken(app, repoRef);
  if (!token) return;

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
 * "Label removed but issue still open" is handled separately, by
 * `syncUnlabeledIssueToLocal` below — kept as its own function rather than
 * folded in here because the two cases have different legal targets
 * (canTransition(status, "done") vs. only backlog/ready) and different
 * risk profiles (an already-claimed task has real work behind it and is
 * never touched by either path).
 */
export async function syncClosedIssueToLocal(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRef,
): Promise<void> {
  if (task.issueNumber === null) return;
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return;
  // #489 — see syncTaskTransition's own comment above.
  const token = await resolveGitHubToken(app, repoRef);
  if (!token) return;

  if (!canTransition(task.status as TaskStatus, "done")) {
    app.log.debug(
      { taskId: task.id, status: task.status },
      "[task-github-sync] issue closed on GitHub but task can't legally reach done from its current status, leaving it alone",
    );
    return;
  }

  try {
    const { state } = await getIssueState(token, repoRef.owner, repoRef.repo, task.issueNumber);
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
      recordTaskTransition(app, {
        taskId: task.id,
        projectId: task.projectId,
        from: task.status as TaskStatus,
        to: "done",
        via: "github-sync-closed",
        context: { issueNumber: task.issueNumber },
      });
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

/**
 * #490a — the "issue is no longer trackable" counterpart to
 * `syncClosedIssueToLocal` above, for a `backlog`/`ready` task (which
 * `syncClosedIssueToLocal`'s own `canTransition(status,"done")` gate never
 * admits). Two distinct triggers land here, both meaning the same thing for
 * a task with no work behind it yet: the tracking label was removed (the
 * webhook `unlabeled` handler in `routes/webhooks.ts` calls this directly,
 * since the payload already proves the label is gone), or the issue is
 * confirmed `closed` without ever losing the label (the poll loop's
 * read-back — `task-watcher.ts` — confirms via `getIssueState` before
 * calling this; see that call site's own comment on why BOTH cases must
 * settle here, not just the unlabel one — Hermes review, PR #510: a
 * `ready` task whose issue closed without an unlabel event would otherwise
 * never leave `ready`, re-probed every sweep forever and still eligible
 * for `autoClaimReadyTasks()` to spawn a real agent on a closed issue).
 * Both webhook and poll callers share this one function so they can't
 * drift, the same reason `upsertIssueTask` is shared for ingest.
 *
 * Only acts on `backlog`/`ready` tasks — never claimed, so there is no
 * worktree, no branch, and no in-flight agent to interrupt. Auto-failing
 * one is reversible: `failed` legally transitions back to `backlog`/`ready`
 * via the existing Retry path (`task-claim.ts`), so a mistaken unlabel (or
 * a since-reopened issue) costs one click to undo, not data loss. A task
 * that already has real work behind it (`claimed`/`in_progress`/
 * `reviewing`) is left strictly alone — silently failing it out from under
 * a label removal or closure would be destructive — matching this file's
 * existing "closed while claimed" precedent in `syncClosedIssueToLocal`
 * above. `failed`/`done` tasks never reach here at all (excluded upstream
 * by both callers).
 */
export async function syncUnlabeledIssueToLocal(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRef,
): Promise<void> {
  if (task.status !== "backlog" && task.status !== "ready") {
    app.log.debug(
      { taskId: task.id, status: task.status },
      "[task-github-sync] issue lost its tracking label but the task has real work behind it, leaving it alone",
    );
    return;
  }

  const now = new Date();
  const failureReason = "GitHub issue lost its tracking label";
  // Status-guarded, same reasoning as syncClosedIssueToLocal above — the
  // caller's snapshot of `task` may be stale by the time this write lands.
  const updated = app.db
    .update(tasks)
    .set({ status: "failed", failureReason, completedAt: now })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, task.status)))
    .run();
  if (updated.changes === 0) return;

  const fromStatus = task.status as TaskStatus;
  recordTaskTransition(app, {
    taskId: task.id,
    projectId: task.projectId,
    from: fromStatus,
    to: "failed",
    via: "github-sync-unlabeled",
    context: { issueNumber: task.issueNumber },
  });

  await syncTaskTransition(
    app,
    { ...task, status: "failed", failureReason, completedAt: now },
    project,
    "failed",
  );
}

/**
 * #729 — read-only counterpart to the trackability check above
 * (`syncUnlabeledIssueToLocal`) and the one `task-watcher.ts`'s read-back
 * inlines (`state === "closed" || (state === "open" && !labels.includes(label))`,
 * task-watcher.ts:439): answers "would the watcher re-create this task on
 * its next sweep?" without acting on the answer, so the DELETE route
 * (routes/tasks.ts) can gate removing an orphaned `failed` task on the same
 * definition of "no longer trackable" the watcher itself uses. The
 * predicate itself is deliberately kept in sync by eyeball (both read
 * `app.config.MULLION_TASK_LABEL`, both invert to the same boolean) rather
 * than factored out from the watcher's inline copy: the watcher resolves
 * `repoRef`/`token` ONCE per sweep and reuses them across every task, while
 * this resolves both PER CALL — sharing the one-line boolean wouldn't save
 * the per-task resolve cost the watcher's own loop is structured to avoid,
 * and this function's actual job (a single on-demand check for one route)
 * doesn't need that sweep-wide reuse.
 *
 * Returns `false` only when a fresh GitHub read confirms the issue is
 * closed, or open but missing the tracking label — the two cases
 * `syncUnlabeledIssueToLocal` itself treats as "no longer relevant".
 * Returns `undefined` (NOT `false`) whenever the check couldn't actually
 * run — no linked issue, no resolvable repo/token, or the GitHub call
 * itself failed — so a transient outage or misconfiguration can't be
 * mistaken for "confirmed untrackable" and let a caller delete a task the
 * watcher would otherwise still re-ingest.
 */
export async function isIssueStillTrackable(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRef,
): Promise<boolean | undefined> {
  if (task.issueNumber === null) return undefined;
  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return undefined;
  const token = await resolveGitHubToken(app, repoRef);
  if (!token) return undefined;

  try {
    const { state, labels } = await getIssueState(
      token,
      repoRef.owner,
      repoRef.repo,
      task.issueNumber,
    );
    const label = app.config.MULLION_TASK_LABEL;
    return !(state === "closed" || (state === "open" && !labels.includes(label)));
  } catch (err) {
    app.log.warn(
      { taskId: task.id, issueNumber: task.issueNumber, err },
      "[task-github-sync] trackability read-back failed",
    );
    return undefined;
  }
}

/**
 * Posts the review agent's findings — as an actual PR review (`task.prNumber`,
 * the common case once a task has entered "reviewing") with each finding as
 * an inline anchored comment, falling back to an ordinary issue comment when
 * the task has no PR yet. Deliberately NOT folded into
 * `syncTaskTransition`/`runSync` above: those are issue-only and gated on
 * `task.issueNumber !== null`, so a local-only task (no linked issue, but
 * very much has a PR once `task-promote.ts` opens one) would silently lose
 * this comment if it rode that path instead. No-ops when the task has
 * neither a PR nor an issue — genuinely nothing to comment on (an unclaimed
 * remote-hosted task, or one whose draft-PR-open attempt hasn't succeeded
 * yet).
 *
 * `event: "COMMENT"` only — see `createPullRequestReview`'s own doc comment
 * for why: the PR is authored by this same GitHub App installation, and
 * GitHub 422s both APPROVE and REQUEST_CHANGES from a PR's own author. This
 * review has no merge-gating state; it exists for visibility in the Reviews
 * timeline with real inline comments, not prose citing `file:42`.
 *
 * A PR review needs two GitHub calls (`getPullRequestByNumber` for the head
 * SHA, then `createPullRequestReview`) where a plain comment needed one, on
 * a path with no second chance (the round's findings are already durably
 * ingested by the time this runs). If EITHER call fails for a task that also
 * has a linked issue, this falls back to an ordinary issue comment as a
 * last resort — so a PR-side failure (rate limit, the PR being deleted or
 * transferred, a transient 5xx) doesn't also mean GitHub never hears about
 * this round at all.
 *
 * Same best-effort posture as every other write in this file: never
 * throws, logs and records `githubSyncError` on failure, clears it on
 * success.
 */
export async function postReviewFindingsComment(
  app: FastifyInstance,
  task: TaskRow,
  project: ProjectRef,
  params: {
    /** Full rendered text — round header, summary, and any findings as
     * `path:line` bullets. Used verbatim for the issue-comment fallback,
     * and as the PR review's own body when there's nothing to anchor (no
     * `findings`) or GitHub rejects the anchored attempt (see below). */
    body: string;
  } & (
    | {
        /** Round header + summary only, no bullets — the PR review's body
         * when `findings` are posted as inline anchors instead, so the same
         * content doesn't appear twice (once as an anchor, once as a
         * bullet). Hermes review, PR #736: this and `findings` are typed as
         * a pair, not two independent optionals, so a caller can't supply
         * one without the other and accidentally reintroduce that
         * duplication — `body` is what's used when there's nothing to
         * anchor at all. */
        reviewSummary: string;
        findings: ReviewFinding[];
      }
    | { reviewSummary?: undefined; findings?: undefined }
  ),
): Promise<void> {
  // Cheap short-circuit before any GitHub call: genuinely nothing to post
  // to (an unclaimed remote-hosted task, or one whose draft-PR-open attempt
  // hasn't succeeded yet and has no linked issue either).
  if (task.prNumber === null && task.issueNumber === null) return;

  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return;
  const token = await resolveGitHubToken(app, repoRef);
  if (!token) return;

  if (task.prNumber !== null) {
    try {
      const pr = await getPullRequestByNumber(token, repoRef.owner, repoRef.repo, task.prNumber);
      // Narrows `params.reviewSummary` to `string` on this branch — the
      // union above ties it to `findings` being present, so this check is
      // what makes the anchor/bullet duplication structurally impossible
      // rather than just documented.
      const anchored =
        params.findings !== undefined
          ? params.findings.map((f) => ({
              path: f.path,
              line: f.line,
              side: f.side,
              body: `${severityPrefix(f.severity)}${f.body}`,
            }))
          : [];
      try {
        await createPullRequestReview(token, repoRef.owner, repoRef.repo, task.prNumber, {
          body:
            params.findings !== undefined && anchored.length > 0
              ? params.reviewSummary
              : params.body,
          commitId: pr.headSha,
          comments: anchored.length > 0 ? anchored : undefined,
        });
      } catch (err) {
        // GitHub rejects the WHOLE review if even one comment's line isn't
        // part of the diff it has for this commit, and its 422 doesn't
        // reliably name the offender — retrying per-comment would mean up
        // to N extra round-trips to find it. Deliberately coarse for v1:
        // drop every anchor and fall back to `params.body`, which already
        // has the findings folded in as plain bullets.
        if (err instanceof GitHubApiError && err.statusCode === 422 && anchored.length > 0) {
          app.log.warn(
            { taskId: task.id, prNumber: task.prNumber, err },
            "[task-github-sync] PR review rejected with inline anchors (422) — retrying with findings folded into the body",
          );
          await createPullRequestReview(token, repoRef.owner, repoRef.repo, task.prNumber, {
            body: params.body,
            commitId: pr.headSha,
          });
        } else {
          throw err;
        }
      }
      clearGithubSyncError(app, task.id);
      return;
    } catch (err) {
      app.log.warn(
        { taskId: task.id, prNumber: task.prNumber, err },
        "[task-github-sync] failed to post review findings as a PR review",
      );
      // A PR review needs two calls (GET the head SHA, then POST the
      // review) where a plain comment needed one, and this whole path is
      // one-shot — the round's findings are already durably written to
      // `tasks.reviewFindings`/ingested, with nothing left to retry from.
      // A linked issue is a last-resort fallback so the failure doesn't
      // also mean GitHub never hears about this round at all.
      if (task.issueNumber !== null) {
        try {
          await createComment(token, repoRef.owner, repoRef.repo, task.issueNumber, params.body);
          clearGithubSyncError(app, task.id);
          return;
        } catch (fallbackErr) {
          app.log.warn(
            { taskId: task.id, issueNumber: task.issueNumber, err: fallbackErr },
            "[task-github-sync] issue-comment fallback also failed after the PR review post failed",
          );
          recordGithubSyncError(
            app,
            task.id,
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          );
          return;
        }
      }
      recordGithubSyncError(app, task.id, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  const commentTarget = task.issueNumber;
  if (commentTarget === null) return;
  try {
    await createComment(token, repoRef.owner, repoRef.repo, commentTarget, params.body);
    clearGithubSyncError(app, task.id);
  } catch (err) {
    app.log.warn(
      { taskId: task.id, commentTarget, err },
      "[task-github-sync] failed to post review findings comment",
    );
    recordGithubSyncError(app, task.id, err instanceof Error ? err.message : String(err));
  }
}
