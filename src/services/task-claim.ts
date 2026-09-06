import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, tasks } from "../db/schema.js";
// createSessionRecord/withLiveStatus are pure business logic, filed under
// services/ (session-lifecycle.ts/session-live-info.ts) precisely so a
// service can reuse them directly rather than reaching into routes/ — see
// those files' own doc comments for the createSessionRecord/killSession and
// buildLiveInfo/withLiveInfo/withLiveStatus split.
import { createSessionRecord, killSession } from "./session-lifecycle.js";
import { withLiveStatus } from "./session-live-info.js";
import {
  resolveBackend,
  resolveSessionsDirWithFallback,
  type SessionBackend,
} from "./session-backend.js";
import { HostRequestError } from "./remote-host-client.js";
import { resolveHostBaseRef } from "./host-git.js";
import { getStoredSettings } from "./settings.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { deriveTaskBranchName, deriveWorktreePath } from "./git-worktree.js";
import { CONCURRENCY_CAPPED_STATUSES, recordTaskTransition } from "./task-state.js";
import {
  resolveAgentCommand,
  commandSupportsSeed,
  resolveSeedDelivered,
} from "./task-agent-resolve.js";
import { resolveOpenCodeModel, resolveOpenCodeSmallModel } from "./task-model-resolve.js";
import { commandIsOpencode } from "./hook-adapters/index.js";
import { syncTaskTransition } from "./task-github-sync.js";
import { buildWorkerPrompt, taskCommitTitlePath } from "./task-prompt.js";
import { resolveTaskIssueContextSafe } from "./task-issue-context.js";

// Shared by claimTask's and retryTask's identical "cap" branches (Hermes
// review, PR #765) — the limit shown here is always the RESOLVED value
// (env default, possibly overridden by Settings → Task Master; see
// task-config.ts), so this deliberately doesn't name either knob: whichever
// one the deployment actually used is what set `limit`, not necessarily
// MULLION_TASK_MAX_CONCURRENT.
function capDetail(limit: number): string {
  return `At capacity: ${limit} task(s) already running`;
}

export type EnqueueTaskOutcome =
  | { ok: true; task: typeof tasks.$inferSelect }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "no-seed-channel";
      detail?: string;
    };

export type DispatchTaskOutcome =
  | { ok: true; session: Awaited<ReturnType<typeof withLiveStatus>>; seedDelivered: boolean }
  | {
      ok: false;
      reason: "not-queued" | "cap" | "worktree-failed" | "spawn-failed";
      detail?: string;
      /** Only set for "cap" — the concurrency limit that was hit. */
      limit?: number;
    };

/**
 * Task-claim queueing (rate-limit-storm fix) — `claimTask` used to reserve
 * (cap-check + status flip) and spawn (worktree + session) as one atomic
 * unit, which meant a claim past capacity had to be REJECTED with a 429:
 * there was no state that meant "accepted, but not started yet." Splitting
 * that into `enqueueTask` (this function) and `dispatchClaimedTask` (below)
 * makes "claimed" that state — every manual claim now succeeds
 * unconditionally and waits for `dispatchClaimedTask` to actually spawn it,
 * called either by task-dispatch.ts's opportunistic hook (fires off
 * task-state.ts's recordTaskTransition, see there) or its periodic sweep
 * off the task-watcher tick.
 *
 * `auto` still distinguishes a human clicking Claim from the watcher's
 * autonomous sweep for exactly one thing: a manual claim still queues even
 * when the resolved agent has no seed-delivery channel (the human is
 * present and can paste the prompt in themselves once it starts), but an
 * autonomous claim refuses to even queue rather than eventually spawning an
 * agent with silently no instructions at all.
 *
 * `agent`/`reviewAgent` overrides are persisted onto the row HERE, at
 * enqueue time — not held in a closure until dispatch, which may run in an
 * entirely separate call (a different tick, possibly after a process
 * restart). `dispatchClaimedTask` reads them back off the row exactly the
 * way this function used to read `opts.agent ?? task.agent` at call time.
 *
 * `worktreePath`/`branchName` are stamped here too, before anything is
 * created on disk (independent review, PR #476, predating the queue split)
 * — `plugins/task-watcher.ts`'s boot-time orphan sweep computes "orphan" as
 * "on disk, but not referenced by any non-terminal task's `worktreePath`,"
 * so a task must be DB-visibly claimed with its future path already
 * recorded before that path exists, not after. The queue makes this
 * predicted-but-not-yet-real window last far longer than before (a task can
 * now sit "claimed" for the queue's entire depth, not just the time it
 * takes to spawn) — safe only because `ACTIVE_WORKTREE_STATUSES`
 * (plugins/task-watcher.ts) already includes "claimed".
 */
export async function enqueueTask(
  app: FastifyInstance,
  taskId: number,
  opts: { auto: boolean; agent?: string | null; reviewAgent?: string | null },
): Promise<EnqueueTaskOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task) return { ok: false, reason: "not-found" };

  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-found" };

  const effectiveAgent = opts.agent !== undefined ? opts.agent : task.agent;

  const command = resolveAgentCommand(app, {
    taskAgent: effectiveAgent,
    issueBody: task.body,
    projectDefaultAgent: project.defaultAgent,
  });
  const seedCapable = commandSupportsSeed(command);
  if (!seedCapable && opts.auto) {
    return {
      ok: false,
      reason: "no-seed-channel",
      detail: `The resolved agent (${command}) can't receive an initial prompt — refusing to auto-claim with no instructions. Claim manually instead.`,
    };
  }

  // Derive the branch name through deriveTaskBranchName (git-worktree.ts)
  // so the shape is owned in one place. The id is in the name for
  // uniqueness (issueNumber is nullable — every local task shares NULL),
  // and the title-slug makes the branch self-describing in `git branch`
  // and on the GitHub PR header. Frozen at claim time — title edits after
  // claim do NOT rename the branch.
  const branchName = deriveTaskBranchName(task);
  const predictedWorktreePath = deriveWorktreePath(project.cwd, branchName);

  const reserved = app.db.transaction((tx) => {
    const [current] = tx.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (!current || current.status !== "ready") {
      return { reserved: false as const, currentStatus: current?.status };
    }
    const patch: Partial<typeof tasks.$inferInsert> = {
      status: "claimed",
      queuedAt: new Date(),
      worktreePath: predictedWorktreePath,
      branchName,
    };
    if (opts.agent !== undefined) patch.agent = opts.agent;
    if (opts.reviewAgent !== undefined) patch.reviewAgent = opts.reviewAgent;
    tx.update(tasks)
      .set(patch)
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "ready")))
      .run();
    return { reserved: true as const };
  });

  if (!reserved.reserved) {
    return {
      ok: false,
      reason: "not-ready",
      detail: `Task is not ready (status: ${reserved.currentStatus ?? "unknown"})`,
    };
  }

  const [queuedRow] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  recordTaskTransition(app, {
    taskId,
    projectId: project.id,
    from: "ready",
    to: "claimed",
    via: opts.auto ? "auto-claim-queue" : "claim-queue",
    context: { auto: opts.auto },
  });

  // Fire-and-forget, same reasoning as the old claimTask's own sync call
  // (still below, on dispatchClaimedTask's success — this is the "claimed"
  // half only). No sessionId/worktreePath/agentCommand yet — those don't
  // exist until dispatch.
  void syncTaskTransition(app, { ...task, status: "claimed" }, project, "claimed");

  return { ok: true, task: queuedRow };
}

/**
 * Task-claim queueing (rate-limit-storm fix) — the half of the old
 * `claimTask` that actually spawns a worker: reservation (now JUST the
 * concurrency-cap check + the "claimed" -> "in_progress" flip, since
 * `enqueueTask` above already did everything else) followed by the same
 * orphan-clear/base-ref/createSessionRecord sequence that function always
 * had.
 *
 * Reservation is atomic with the concurrency-cap check (Hermes/independent
 * review posture carried into 6.2, unchanged by the split): one
 * `app.db.transaction(...)` (synchronous, better-sqlite3) counts tasks
 * `in_progress` against `MULLION_TASK_MAX_CONCURRENT`, then conditionally
 * flips this task's status — both checks succeed or fail together, so two
 * concurrent dispatch attempts (the opportunistic hook AND the periodic
 * sweep can both fire for the same free slot) can't both win it.
 *
 * On success, status goes straight "claimed" -> "in_progress" — never
 * lands on an intermediate "in_progress, no session yet" the way the old
 * single-phase claimTask could transiently. `claimedAt`/`startedAt` are
 * BOTH stamped here (not `enqueueTask`'s `queuedAt`) — this is genuinely
 * "when did the CURRENT spell start," the same meaning
 * task-reconciler.ts's budget deadline and `turnFinishedSinceClaim` already
 * give `claimedAt` today; a task that queued for hours must not have that
 * time counted against its budget.
 *
 * On failure, `release()` returns the task to "claimed" (its queue
 * position), NOT "ready" — an enqueue was a real, unconditional commitment;
 * a transient dispatch failure (a dirty leftover worktree, a briefly
 * unreachable host) shouldn't cost the task its place in line. The caller
 * (task-dispatch.ts) is responsible for backing off a task that keeps
 * failing dispatch, so this doesn't retry the identical failure in a tight
 * loop — see that module's own doc comment.
 */
export async function dispatchClaimedTask(
  app: FastifyInstance,
  taskId: number,
): Promise<DispatchTaskOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task || task.status !== "claimed" || task.sessionId !== null) {
    return { ok: false, reason: "not-queued" };
  }

  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-queued" };

  // Re-resolved here, not carried from enqueue time: task.agent/reviewAgent
  // were already persisted onto the row by enqueueTask (or predate it, for
  // an unedited task), so re-reading them now picks up any edit made while
  // the task sat queued, the same way a fresh claimTask call always did.
  const command = resolveAgentCommand(app, {
    taskAgent: task.agent,
    issueBody: task.body,
    projectDefaultAgent: project.defaultAgent,
  });
  const seedCapable = commandSupportsSeed(command);

  const branchName = task.branchName ?? deriveTaskBranchName(task);
  const predictedWorktreePath = task.worktreePath ?? deriveWorktreePath(project.cwd, branchName);

  const taskMasterConfig = resolveTaskMasterConfig(app);
  const maxConcurrent = taskMasterConfig.maxConcurrent;
  const reservation = app.db.transaction((tx) => {
    const [current] = tx.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (!current || current.status !== "claimed" || current.sessionId !== null) {
      return { reserved: false as const };
    }
    const inFlight = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.status, CONCURRENCY_CAPPED_STATUSES))
      .all();
    if (inFlight.length >= maxConcurrent) {
      return { reserved: false as const, capped: true as const };
    }
    tx.update(tasks)
      .set({ status: "in_progress", claimedAt: new Date(), startedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
      .run();
    return { reserved: true as const };
  });

  if (!reservation.reserved) {
    if ("capped" in reservation && reservation.capped) {
      return { ok: false, reason: "cap", limit: maxConcurrent, detail: capDetail(maxConcurrent) };
    }
    // Lost a race with another dispatch attempt for this same task (or it
    // was deleted/edited out from under us) — not an error, just nothing
    // to do; the caller (task-dispatch.ts) moves on to the next candidate.
    return { ok: false, reason: "not-queued" };
  }

  recordTaskTransition(app, {
    taskId,
    projectId: project.id,
    from: "claimed",
    to: "in_progress",
    via: "dispatch",
  });

  // Mirrors enqueueTask's release() — puts the reservation back rather than
  // leaving an "in_progress" row with no session behind it. Releases to
  // "claimed" (see this function's own doc comment), not "ready" —
  // worktreePath/branchName are deliberately LEFT AS-IS (they're the
  // queue's still-correct predicted path, needed for the next dispatch
  // attempt's own orphan-clearing). baseSha/seedDelivered ARE nulled, same
  // belt-and-suspenders reasoning as enqueueTask's release() below: no path
  // in this codebase today lands a genuinely-committed prior spell's values
  // back on a "claimed" row, but a "claimed" row must never carry them
  // forward regardless — only this function's own commit block ever WRITES
  // them.
  async function release(reason: string): Promise<void> {
    const updated = app.db
      .update(tasks)
      .set({
        status: "claimed",
        claimedAt: null,
        startedAt: null,
        failureReason: reason,
        baseSha: null,
        seedDelivered: null,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "in_progress"), isNull(tasks.sessionId)))
      .run();
    if (updated.changes > 0) {
      recordTaskTransition(app, {
        taskId,
        projectId: project.id,
        from: "in_progress",
        to: "claimed",
        via: "dispatch-release",
        context: { reason },
      });
    }
  }

  // Same throw/rollback posture as the old claimTask — see its own doc
  // comment (still on enqueueTask above) for why this try/catch exists and
  // what `committed` guards.
  let committed = false;
  try {
    const backend = resolveBackend(app, project.hostId);
    // Orphan-clearing (6.8/#283) — unchanged from the old claimTask.
    const clearResult = await backend.clearOrphanedTaskWorktree(
      project.cwd,
      predictedWorktreePath,
      branchName,
    );
    if (!clearResult.cleared) {
      await release(
        `a previous attempt left an unclean worktree at ${predictedWorktreePath} (${clearResult.reason})`,
      );
      return {
        ok: false,
        reason: "worktree-failed",
        detail: `A previous attempt left an unclean worktree at this task's branch path (${clearResult.reason}) — resolve it manually before retrying`,
      };
    }

    // #484/#491 — unchanged from the old claimTask; see git blame on this
    // function's prior revision (before the queue split) for the full
    // base-ref-pinning rationale.
    const baseRefResult = await resolveHostBaseRef(app, project.hostId, project.cwd);
    const { baseRef, baseSha } = baseRefResult.ok
      ? { baseRef: baseRefResult.value.baseRef, baseSha: baseRefResult.value.sha }
      : { baseRef: "HEAD", baseSha: null };
    // #939/#1016 — resolved once per spawn, fail-open (a GitHub hiccup here
    // degrades to today's plain title+body prompt, never blocks the claim).
    const issueContext = await resolveTaskIssueContextSafe(app, task, project);
    const prompt = buildWorkerPrompt({
      task: {
        ...task,
        comments: issueContext?.comments,
        parent: issueContext?.parent,
        siblings: issueContext?.siblings,
      },
      branchName,
      worktreePath: predictedWorktreePath,
      budgetMinutes: taskMasterConfig.budgetMinutes,
      mode: "claim",
      // #778 — resolved against the OWNING host's own sessionsDir; see
      // task-reconciler.ts's spawnReviewAgentNow for the full rationale.
      commitTitlePath: project.conventionalCommitTitles
        ? taskCommitTitlePath(
            await resolveSessionsDirWithFallback(app, backend, {
              taskId: task.id,
              hostId: project.hostId,
            }),
            task.id,
          )
        : undefined,
    });
    const model = commandIsOpencode(command)
      ? (resolveOpenCodeModel(app, {
          taskModel: task.model ?? null,
          issueBody: task.body,
          role: "implementer",
        }) ?? undefined)
      : undefined;
    const smallModel = commandIsOpencode(command)
      ? (resolveOpenCodeSmallModel(app, {
          taskSmallModel: task.smallModel ?? null,
          issueBody: task.body,
        }) ?? undefined)
      : undefined;
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command,
      worktree: { baseRef: baseSha ?? baseRef, branchName },
      initialPrompt: seedCapable ? prompt : undefined,
      skipPermissions: taskMasterConfig.skipPermissions,
      // #9 — named and locked so this session reads as "task #N's worker"
      // anywhere it's shown, instead of the bare launch command (currently
      // indistinguishable from a manually-launched session of the same
      // agent). `nameLocked: true` is a deliberate deviation from this
      // column's own documented default intent (schema.ts) — a launch-time
      // name pattern deliberately leaves it false so a live OSC title
      // update can still override it, but a task session's whole point is
      // a name that reliably identifies which task it belongs to, which an
      // OSC update would defeat.
      name: `Task #${task.id} · worker`,
      nameLocked: true,
      model,
      smallModel,
      // Mark this session as an unattended Task Master worker so the
      // opencode adapter denies superpowers skills that gate on a human in
      // the loop (brainstorming / writing-plans /
      // finishing-a-development-branch — verified failing in branchdam-
      // mobile tasks #66 / #67).
      taskId: task.id,
    });
    if (!result.ok) {
      if (result.reason === "worktree-failed") {
        await release("worktree creation failed");
        return { ok: false, reason: "worktree-failed" };
      }
      await release("session spawn failed");
      return { ok: false, reason: "spawn-failed" };
    }

    const seedDelivered = resolveSeedDelivered(
      seedCapable,
      project.hostId,
      result.initialPromptApplied,
    );
    if (seedCapable && !seedDelivered) {
      app.log.warn(
        { taskId, hostId: project.hostId, command },
        "task dispatch: sent an initial prompt to a remote host but it wasn't confirmed applied — possible version skew (the remote agent build may not support initialPrompt yet)",
      );
    }

    app.db
      .update(tasks)
      .set({
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        branchName,
        agentCommand: command,
        model,
        smallModel,
        baseSha,
        seedDelivered,
      })
      .where(eq(tasks.id, taskId))
      .run();
    committed = true;

    // Fire-and-forget, matching the reconciler's own now-removed
    // "claimed -> in_progress" branch (task-reconciler.ts), which synced
    // this exact event before dispatch existed.
    void syncTaskTransition(
      app,
      {
        ...task,
        status: "in_progress",
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        branchName,
        agentCommand: command,
        baseSha,
        startedAt: new Date(),
      },
      project,
      "in_progress",
    );

    const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
    const session = await withLiveStatus(app, result.row, idleThresholdMs, project.hostId);
    return { ok: true, session, seedDelivered };
  } catch (err) {
    if (committed) throw err;
    await release(err instanceof Error ? err.message : "unexpected error during dispatch");
    app.log.error({ err, taskId }, "task dispatch: unexpected error, reservation released");
    return {
      ok: false,
      reason: "spawn-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export type RetryTaskOutcome =
  | { ok: true; session: Awaited<ReturnType<typeof withLiveStatus>>; seedDelivered: boolean }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-failed"
        | "cap"
        | "no-worktree"
        | "remote-not-supported"
        | "worktree-failed"
        | "spawn-failed";
      detail?: string;
      /** Only set for "cap" — mirrors claimTask's own shape. */
      limit?: number;
    };

/**
 * #483 — retries a `failed` task by resuming on its preserved
 * `mullion/task-<id>-<slug>` branch (git-worktree.ts's `resumeTaskWorktree`)
 * rather than starting over from `baseRef`. Every task that ever reaches
 * "failed" got there from "claimed"/"in_progress" (session-reconciler.ts's
 * session-died hook, or task-reconciler.ts's budget force-fail) — both
 * paths only run once a worktree/branch already exist, and neither nulls
 * `worktreePath`/`branchName` on the failing write, so `task.branchName` is
 * reliably present here. `removeWorktreeIfClean` (the `→ failed` cleanup
 * itself) removes only the worktree directory, never the branch — see that
 * function's own doc comment — which is exactly what makes resuming
 * possible.
 *
 * Goes straight from "failed" to "claimed", not through "ready" —
 * task-state.ts's table only allows `failed → ready`/`backlog`, but this
 * function IS the resolution of "then immediately re-claim it," the same
 * way `claimTask` itself resolves `ready → claimed` as one action rather
 * than requiring two round trips. A local-only reservation helper, not a
 * new table edge, since nothing else needs `failed → claimed` directly.
 *
 * Always human-initiated (there's no autonomous retry sweep), so unlike
 * `claimTask`'s `auto`/manual split, this never refuses on an unseedable
 * agent — a person clicked Retry and can paste the prompt in themselves,
 * same posture as a manual claim.
 *
 * #484 — resuming a remote-hosted task's preserved branch now proxies
 * through `SessionBackend.resumeTaskWorktree` the same way every other
 * worktree-lifecycle op on that interface already does; `remote-not-
 * supported` in `RetryTaskOutcome`'s union survives only as the
 * version-skew case (an agent build predating this proxy route).
 */
export async function retryTask(
  app: FastifyInstance,
  taskId: number,
  opts: { agent?: string | null; reviewAgent?: string | null } = {},
): Promise<RetryTaskOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task) return { ok: false, reason: "not-found" };

  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-found" };

  const effectiveAgent = opts.agent !== undefined ? opts.agent : task.agent;

  const command = resolveAgentCommand(app, {
    taskAgent: effectiveAgent,
    issueBody: task.body,
    projectDefaultAgent: project.defaultAgent,
  });
  const seedCapable = commandSupportsSeed(command);

  // Same atomic reservation shape as claimTask's own — see that function's
  // doc comment for why the cap check and the status flip must succeed or
  // fail together. The branchName check is INSIDE this transaction's
  // status gate, not before it (independent of whether the task is even
  // "failed" yet) — a "ready"/"reviewing"/etc. task with no branch must
  // report "not-failed", the true diagnosis, not the misleading
  // "no-worktree" a pre-transaction check would produce.
  const taskMasterConfig = resolveTaskMasterConfig(app);
  const maxConcurrent = taskMasterConfig.maxConcurrent;
  const reservation = app.db.transaction((tx) => {
    const [current] = tx.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (!current || current.status !== "failed") {
      return { reserved: false as const, currentStatus: current?.status };
    }
    if (!current.branchName) {
      return { reserved: false as const, noBranch: true as const };
    }
    const inFlight = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.status, CONCURRENCY_CAPPED_STATUSES))
      .all();
    if (inFlight.length >= maxConcurrent) {
      return { reserved: false as const, capped: true as const };
    }
    tx.update(tasks)
      .set({
        status: "claimed",
        claimedAt: new Date(),
        // Clearing the prior attempt's leftovers so the retried task
        // doesn't carry its old failure text / stale PR link / dead
        // session id forward. worktreePath/branchName are left as-is —
        // they're the deterministic, still-correct values this retry is
        // about to resume onto. prUrl and prNumber are cleared together —
        // never one alone — so the row can't end up with a prNumber but no
        // prUrl (or vice versa), which is exactly the inconsistent pair
        // that made the PR link vanish from the UI (#972).
        failureReason: null,
        completedAt: null,
        sessionId: null,
        prUrl: null,
        prNumber: null,
        // Review fix (#1015) — a failed task can be archived (hidden from
        // the board by default) without losing its Retry affordance;
        // resuming it must un-hide it too, or it vanishes from the board
        // the instant it starts running again (still holding a
        // maxConcurrent slot) until someone happens to toggle "Show
        // archived". mergedAt is left alone: nothing ever sets it on a
        // non-`done` task, so there's nothing to clear.
        archivedAt: null,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "failed")))
      .run();
    return { reserved: true as const, branchName: current.branchName };
  });

  if (!reservation.reserved) {
    if ("capped" in reservation && reservation.capped) {
      // See claimTask's identical branch above for why this is logged here
      // rather than via recordTaskTransition — the reservation transaction
      // short-circuited before any status changed.
      app.log.info({ taskId, limit: maxConcurrent }, "task retry: at capacity");
      return { ok: false, reason: "cap", limit: maxConcurrent, detail: capDetail(maxConcurrent) };
    }
    if ("noBranch" in reservation && reservation.noBranch) {
      return {
        ok: false,
        reason: "no-worktree",
        detail: "Task has no recorded branch to resume — nothing to retry",
      };
    }
    return {
      ok: false,
      reason: "not-failed",
      detail: `Task is not failed (status: ${reservation.currentStatus ?? "unknown"})`,
    };
  }

  // The reservation above already nulled tasks.sessionId — this task's
  // OLD session (from `task`, read before the transaction) is now
  // unreachable from the row, so kill it here rather than leaving it an
  // orphan: nothing else in this codebase ever terminates it once the
  // pointer is gone. Best-effort — a kill failure must not block the retry
  // itself, same posture as every other fire-and-forget cleanup on this
  // path (see `release`'s own worktree cleanup below).
  if (task.sessionId !== null) {
    try {
      await killSession(app, task.sessionId, "detach");
    } catch (err) {
      app.log.warn(
        { err, taskId, sessionId: task.sessionId },
        "task retry: failed to kill the previous session, leaving it as-is",
      );
    }
  }

  // Mirrors claimTask's own release() — puts the reservation back rather
  // than leaving a "claimed" row with nothing spawned behind it. Releases
  // to "failed", not "ready": a retry that couldn't even resume the
  // worktree is still the same failed task, safely retryable again.
  //
  // Deliberately does NOT null seedDelivered, unlike claimTask's release()
  // — this retry attempt's own commit block is the only place that would
  // ever overwrite it, so a rolled-back attempt leaves the field exactly as
  // it was: the LAST REAL spawn's actual delivery status (from the original
  // claim, or an earlier successful retry), which is still accurate — this
  // attempt never got far enough to produce a new one.
  //
  // #483/Hermes review: also removes a just-resumed worktree, when one
  // exists — unlike claimTask (which only ever creates a NEW worktree that
  // clearOrphanedTaskWorktree can find and clear on a later attempt),
  // retry's resumeTaskWorktree checks out the task's PRESERVED branch. A
  // release that left that checkout in place would permanently occupy the
  // deterministic path: the next retry's resumeTaskWorktree/`git worktree
  // add <path> <branch>` fails because the path already exists and the
  // branch is already checked out there, worktree-failed forever until a
  // human intervenes — recreating exactly the dead end this feature
  // removes. Best-effort and clean-check-gated (removeWorktreeIfClean,
  // never `--force`): the checkout is fresh with no agent having run yet,
  // so it's expected to be clean; if it somehow isn't, this leaves it in
  // place rather than destroying anything, same posture as every other
  // caller of removeWorktreeIfClean.
  async function release(reason: string, worktreeToClean?: { path: string }): Promise<void> {
    if (worktreeToClean) {
      await resolveBackend(app, project.hostId)
        .removeWorktreeIfClean(worktreeToClean.path, project.cwd)
        .catch((err: unknown) => {
          app.log.warn(
            { err, taskId, worktreePath: worktreeToClean.path },
            "task retry: failed to clean up the resumed worktree after a later failure",
          );
        });
    }
    const updated = app.db
      .update(tasks)
      .set({ status: "failed", failureReason: reason })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
      .run();
    // #488 — previously unlogged: retry's own rollback back to "failed" had
    // no signal of any kind before.
    if (updated.changes > 0) {
      recordTaskTransition(app, {
        taskId,
        projectId: project.id,
        from: "claimed",
        to: "failed",
        via: "retry-release",
        context: { reason },
      });
    }
  }

  const branchName = reservation.branchName;

  let committed = false;
  // Hoisted out of the try block (rather than a `const` declared inside
  // it) so the catch block below can also clean it up if anything between a
  // successful resume and the DB commit throws.
  let worktree: Awaited<ReturnType<SessionBackend["resumeTaskWorktree"]>> = null;
  try {
    // #484 — an old agent build (predating this proxy route) surfaces as a
    // 404 HostRequestError, distinguished here from every other resume
    // failure (branch missing/checked out elsewhere, or the host being
    // unreachable) so a version-skew gap reads as "not supported yet, ok
    // to retry once upgraded," not a generic worktree-failed. Independent
    // review, PR #590 — HostRequestError covers ANY 4xx (a genuine
    // resolveWithinRoots 400, not just a missing route), so this checks
    // `statusCode === 404` specifically rather than the class alone; any
    // other HostRequestError falls through to the generic catch below.
    const backend = resolveBackend(app, project.hostId);
    try {
      worktree = await backend.resumeTaskWorktree(project.cwd, branchName);
    } catch (err) {
      if (err instanceof HostRequestError && err.statusCode === 404) {
        await release("this host's agent build doesn't support retrying a remote-hosted task yet");
        return {
          ok: false,
          reason: "remote-not-supported",
          detail:
            "This host's agent build doesn't support retrying a remote-hosted task yet — update it and retry",
        };
      }
      throw err;
    }
    if (!worktree) {
      await release(
        "could not resume the preserved branch — it may no longer exist or is checked out elsewhere",
      );
      return {
        ok: false,
        reason: "worktree-failed",
        detail: `Could not check out ${branchName} into a fresh worktree — it may no longer exist, or is already checked out elsewhere`,
      };
    }

    // No `worktree:` intent here (unlike claimTask's createSessionRecord
    // call) — the worktree above already exists on disk; `cwd` is used
    // directly rather than asking createSessionRecord to create a new one.
    // `initialPrompt`, not stashSeed — same reasoning as claimTask's own
    // doc comment: additionalContext never submits a turn, and a retry
    // spawning an unattended agent is exactly the unattended case that bit.
    // Same preamble as a fresh claim, plus a retry note — the branch
    // already carries the earlier attempt's commits, and without saying so
    // a retry looks like a fresh start on a mysteriously non-empty tree.
    // #939/#1016 — same resolve-once, fail-open context as claimTask's own
    // spawn above.
    const issueContext = await resolveTaskIssueContextSafe(app, task, project);
    const prompt = buildWorkerPrompt({
      task: {
        ...task,
        comments: issueContext?.comments,
        parent: issueContext?.parent,
        siblings: issueContext?.siblings,
      },
      branchName,
      worktreePath: worktree.path,
      budgetMinutes: taskMasterConfig.budgetMinutes,
      mode: "retry",
      // #778 — resolved against the OWNING host's own sessionsDir; see
      // task-reconciler.ts's spawnReviewAgentNow for the full rationale.
      commitTitlePath: project.conventionalCommitTitles
        ? taskCommitTitlePath(
            await resolveSessionsDirWithFallback(app, backend, {
              taskId: task.id,
              hostId: project.hostId,
            }),
            task.id,
          )
        : undefined,
    });
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command,
      cwd: worktree.path,
      initialPrompt: seedCapable ? prompt : undefined,
      skipPermissions: taskMasterConfig.skipPermissions,
      // #9 — see the claim spawn's own comment (above, in this same file).
      name: `Task #${task.id} · worker`,
      nameLocked: true,
      // Same "this is an unattended Task Master worker" marker as
      // dispatchClaimedTask's claim spawn above — see that block's own
      // comment for why a retry worker needs the brainstorming / writing-
      // plans / finishing-a-development-branch denials too (an opencode
      // worker respawned mid-task can hit the same failure mode).
      taskId: task.id,
    });
    if (!result.ok) {
      await release("session spawn failed", worktree);
      return { ok: false, reason: "spawn-failed" };
    }

    // Local-hosted only (this function refuses remote projects outright,
    // above) — no version-skew risk, so resolveSeedDelivered's remote
    // branch is unreachable here. Used anyway for one consistent definition
    // of "seedDelivered" across every spawn site.
    const seedDelivered = resolveSeedDelivered(
      seedCapable,
      project.hostId,
      result.initialPromptApplied,
    );

    // Task-claim queueing (rate-limit-storm fix) — status goes straight to
    // "in_progress" here, not "claimed": retryTask stays a single-phase,
    // unsplit operation (see this function's own doc comment on why —
    // the fresh-claim-vs-resume discriminator problem), but
    // `CONCURRENCY_CAPPED_STATUSES` now only counts "in_progress". A
    // successfully retried task already has a real, running session by
    // this point — leaving it at "claimed" would make it invisible to
    // MULLION_TASK_MAX_CONCURRENT entirely (a "claimed" row is defined
    // everywhere else as session-less/queued), silently uncapping retries.
    const patch: Partial<typeof tasks.$inferInsert> = {
      status: "in_progress",
      startedAt: new Date(),
      sessionId: result.row.id,
      worktreePath: result.row.cwd,
      agentCommand: command,
      seedDelivered,
      // Issue #1038 — a give-up on a capped, announced "reviewing" task
      // lands on "failed" without clearing this (give-up's own write only
      // touches status/failureReason/completedAt), so a retry from there is
      // the one path that can otherwise carry a stale announcement into a
      // fresh in_progress run.
      autoReturnCapAnnouncedAt: null,
    };
    if (opts.agent !== undefined) patch.agent = opts.agent;
    if (opts.reviewAgent !== undefined) patch.reviewAgent = opts.reviewAgent;

    app.db.update(tasks).set(patch).where(eq(tasks.id, taskId)).run();
    committed = true;
    recordTaskTransition(app, {
      taskId,
      projectId: project.id,
      from: "failed",
      to: "in_progress",
      via: "retry",
      context: { command, seedDelivered },
    });

    // Fire-and-forget, same reasoning as claimTask's own sync call.
    void syncTaskTransition(
      app,
      {
        ...task,
        status: "in_progress",
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        agentCommand: command,
        failureReason: null,
        completedAt: null,
      },
      project,
      "in_progress",
    );

    const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
    const session = await withLiveStatus(app, result.row, idleThresholdMs, project.hostId);
    return { ok: true, session, seedDelivered };
  } catch (err) {
    if (committed) throw err;
    await release(
      err instanceof Error ? err.message : "unexpected error during retry",
      worktree ?? undefined,
    );
    app.log.error({ err, taskId }, "task retry: unexpected error, reservation released");
    return {
      ok: false,
      reason: "spawn-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
