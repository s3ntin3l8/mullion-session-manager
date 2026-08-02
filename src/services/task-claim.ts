import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, tasks } from "../db/schema.js";
// Reaches into routes/ from a service — an intentional, narrow exception.
// createSessionRecord/withLiveStatus already exist specifically for
// cross-file reuse (routes/tasks.ts's thin-slice claim endpoint was their
// first external consumer); this is the second, not a new precedent. Both
// are pure business logic that happen to be filed under routes/ for
// historical colocation with POST /api/sessions, not anything
// request/reply-shaped.
import { createSessionRecord, withLiveStatus } from "../routes/sessions.js";
import { resolveBackend, type SessionBackend } from "./session-backend.js";
import { resolveDefaultBaseRef, resolveCommitSha } from "./git-refs.js";
import { getStoredSettings } from "./settings.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { deriveWorktreePath } from "./git-worktree.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { CONCURRENCY_CAPPED_STATUSES } from "./task-state.js";
import { resolveAgentCommand, commandSupportsSeed } from "./task-agent-resolve.js";
import { syncTaskTransition } from "./task-github-sync.js";

export type ClaimTaskOutcome =
  | { ok: true; session: Awaited<ReturnType<typeof withLiveStatus>>; seedDelivered: boolean }
  | {
      ok: false;
      reason:
        "not-found" | "not-ready" | "cap" | "worktree-failed" | "spawn-failed" | "no-seed-channel";
      detail?: string;
      /** Only set for "cap" — the concurrency limit that was hit, so the
       * caller can build a specific error message without re-reading config. */
      limit?: number;
    };

/**
 * Phase 6 Task Master (6.2/#215) — the single claim orchestration both
 * `POST /api/tasks/:id/claim` (a human-initiated, manual claim) and the
 * watcher's auto-claim sweep (task-watcher.ts) call into, so the
 * reservation/spawn/rollback logic exists in exactly one place rather than
 * being duplicated between a route handler and a background loop.
 *
 * Reservation is atomic with the concurrency-cap check (Hermes/independent
 * review posture carried into 6.2): today's claim used to spawn first and
 * only conditionally UPDATE afterward, which is why a losing concurrent
 * request's worktree was left orphaned — the spawn had already happened
 * before the loss was detected. Here, one `app.db.transaction(...)` (
 * synchronous, better-sqlite3 — same shape as routes/sessions.ts's own
 * child-cap reservation) counts tasks in `claimed`/`in_progress` against
 * `MULLION_TASK_MAX_CONCURRENT`, then conditionally flips this task to
 * "claimed" — both checks succeed or fail together, so neither the
 * double-claim race nor the cap can be raced past by two concurrent
 * requests each reading a stale count.
 *
 * `auto` distinguishes a human clicking Claim from the watcher's autonomous
 * sweep: a manual claim still proceeds even when the resolved agent has no
 * seed-delivery channel (the human is present and can paste the prompt in
 * themselves), but an autonomous claim refuses outright rather than
 * spawning an agent with silently no instructions at all.
 *
 * Orphan clearing (6.8/#283): a claim that reserves the task but then
 * fails at worktree creation releases the reservation back to "ready", but
 * its deterministic branch/worktree path (`mullion/task-<id>`) can still be
 * left on disk from that attempt — a retry's `git worktree add -b` would
 * collide with it. Before creating, this function proactively clears
 * whatever sits at that deterministic path via `removeWorktreeIfClean` (see
 * git-worktree.ts) — a no-op when nothing's there, a refusal (surfaced as
 * `worktree-failed`) when something's there and dirty, since a dirty
 * leftover needs a human's eyes, not a silent overwrite.
 *
 * `worktreePath`/`branchName` are stamped into the row inside the SAME
 * reservation transaction that flips status to "claimed" — BEFORE anything
 * is actually created on disk — not only afterward once creation succeeds
 * (independent review, PR #476). Without this, there's a window where the
 * task is DB-visibly "claimed" with nothing in `worktreePath` yet, but the
 * worktree directory already exists on disk (`createWorktree` runs before
 * the post-success UPDATE below) — `plugins/task-watcher.ts`'s boot-time
 * sweep computes "orphan" as "on disk, but not referenced by any non-
 * terminal task's `worktreePath`," so a human clicking Claim moments after
 * a restart (no delay, unlike the watcher's own staggered auto-claim sweep)
 * could race the fire-and-forget sweep into deleting a worktree a live
 * claim just created. Stamping the DB-visible claim first closes the
 * window: the sweep's active-paths filter sees this task's path from the
 * moment reservation succeeds, well before the directory exists to be
 * mistaken for an orphan. `release()` clears both back to null on failure,
 * matching pre-6.8 behavior (never non-null for a "ready" task).
 */
export async function claimTask(
  app: FastifyInstance,
  taskId: number,
  opts: { auto: boolean },
): Promise<ClaimTaskOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task) return { ok: false, reason: "not-found" };

  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-found" };

  const command = resolveAgentCommand(app, {
    issueBody: task.body,
    projectDefaultAgent: project.defaultAgent,
  });
  const seedCapable = commandSupportsSeed(command);
  if (!seedCapable && opts.auto) {
    return {
      ok: false,
      reason: "no-seed-channel",
      detail: `The resolved agent (${command}) can't receive a seed prompt via SessionStart — refusing to auto-claim with no instructions. Claim manually instead.`,
    };
  }

  // Derived from task.id, not task.issueNumber: issueNumber is nullable
  // (6.9) and every local task shares the same NULL — branching on it
  // would collide every local task onto `mullion/task-null`. Computed
  // before the reservation transaction so both the DB stamp below and the
  // orphan-clear/create calls further down use the identical value.
  const branchName = `mullion/task-${task.id}`;
  const predictedWorktreePath = deriveWorktreePath(project.cwd, branchName);

  // Settings-backed override of MULLION_TASK_MAX_CONCURRENT (Task Master
  // Settings UI follow-up) — see task-config.ts's doc comment.
  const maxConcurrent = resolveTaskMasterConfig(app).maxConcurrent;
  const reservation = app.db.transaction((tx) => {
    const [current] = tx.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (!current || current.status !== "ready") {
      return { reserved: false as const, currentStatus: current?.status };
    }
    // Same "select + .length" cap-check shape as routes/sessions.ts's own
    // child-session cap reservation (createSessionRecord's maxChildren
    // check) — a plain row count, not a raw SQL count(*) template.
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
        // See this function's own doc comment on why these are stamped
        // here, before anything exists on disk (independent review, PR #476).
        worktreePath: predictedWorktreePath,
        branchName,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "ready")))
      .run();
    return { reserved: true as const };
  });

  if (!reservation.reserved) {
    if ("capped" in reservation && reservation.capped) {
      return { ok: false, reason: "cap", limit: maxConcurrent };
    }
    return {
      ok: false,
      reason: "not-ready",
      detail: `Task is not ready (status: ${reservation.currentStatus ?? "unknown"})`,
    };
  }

  // From here on the reservation is ours — any failure must release it
  // back to "ready" rather than leaving a "claimed" row with nothing
  // spawned behind it, which would both strand the task and silently
  // consume a concurrency slot forever. Clears worktreePath/branchName back
  // to null too, matching pre-6.8 behavior for a "ready" task (both are
  // now stamped speculatively at reservation time, above).
  async function release(reason: string): Promise<void> {
    app.db
      .update(tasks)
      .set({
        status: "ready",
        claimedAt: null,
        failureReason: reason,
        worktreePath: null,
        branchName: null,
        baseSha: null,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
      .run();
  }

  // None of resolveDefaultBaseRef/createSessionRecord/stashSeed/
  // removeWorktreeIfClean are known to throw today (traced:
  // resolveDefaultBaseRef is best-effort via runGit, createSessionRecord
  // returns {ok:false,...} for every documented failure, stashSeed/
  // removeWorktreeIfClean route through resolveBackend, which for a remote
  // host can throw synchronously on a misconfigured hostId) — this
  // try/catch exists to make good on this function's own doc-comment
  // promise ("any failure past this point releases the reservation")
  // rather than leaving it enforced only by every callee happening not to
  // throw. `committed` marks the point of no return: once the row is
  // stamped with sessionId, the claim has genuinely succeeded, so a later
  // throw (e.g. from withLiveStatus) must NOT release the reservation —
  // that would orphan a real, already-spawned session while making the
  // task claimable again — it propagates instead, same as before this
  // try/catch existed.
  let committed = false;
  try {
    // Orphan-clearing (6.8/#283) — see this function's own doc comment, and
    // clearOrphanedTaskWorktree's, for why this clears both the worktree
    // directory AND the branch ref at the deterministic path/name (a plain
    // removeWorktreeIfClean only clears the directory, leaving the branch
    // to collide with a fresh `git worktree add -b` on retry). Runs
    // regardless of whether this is a truly fresh claim (nothing there —
    // a no-op) or a retry after a prior attempt's worktree creation
    // succeeded but something later failed.
    const clearResult = await resolveBackend(app, project.hostId).clearOrphanedTaskWorktree(
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

    // resolveDefaultBaseRef only resolves local filesystem state (it shells
    // out `git` against `cwd` directly, not via resolveBackend) — for a
    // remote-hosted project it can't run at all. "HEAD" branches off
    // whatever that host's own checkout currently sits on, which is the
    // same last-resort fallback resolveDefaultBaseRef itself returns when
    // it can't otherwise determine a default branch, and matches the
    // common case (an idle project awaiting claims sits on its default
    // branch). Full remote base-ref resolution (a new internal proxy route)
    // is out of 6.8's scope — that issue is worktree lifecycle, not
    // base-ref resolution.
    const baseRef =
      project.hostId === LOCAL_HOST_ID ? await resolveDefaultBaseRef(project.cwd) : "HEAD";
    // #491 — pin baseRef to a commit SHA *before* creating the worktree,
    // and branch from the SHA rather than the symbolic ref. baseRef here
    // can be a moving target (e.g. "origin/main"); resolving it to a SHA
    // only after the worktree exists would be a second, independent
    // resolution of that same moving ref, and main could have advanced in
    // between — reproducing the exact "diff-stat against a base the branch
    // was never actually cut from" failure #491's own code comment refuses
    // to ship. Branching from the SHA directly makes the persisted value
    // and the branch's actual base provably identical, no window. Only
    // attempted for local hosts (remote's baseRef is always the literal
    // "HEAD", which resolveCommitSha would resolve trivially but which
    // carries no useful base — see the "HEAD" fallback rationale above);
    // a resolution failure just falls back to branching off the symbolic
    // ref exactly as before, with baseSha left null (no diff-stat, not a
    // wrong one).
    const baseSha =
      project.hostId === LOCAL_HOST_ID ? await resolveCommitSha(project.cwd, baseRef) : null;
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command,
      worktree: { baseRef: baseSha ?? baseRef, branchName },
    });
    if (!result.ok) {
      if (result.reason === "worktree-failed") {
        await release("worktree creation failed");
        return { ok: false, reason: "worktree-failed" };
      }
      if (result.reason === "unknown-project") {
        await release("project not found during spawn");
        return { ok: false, reason: "not-found" };
      }
      await release("session spawn failed");
      return { ok: false, reason: "spawn-failed" };
    }

    let seedDelivered = false;
    if (seedCapable) {
      const prompt = task.body ? `${task.title}\n\n${task.body}` : task.title;
      await resolveBackend(app, project.hostId).stashSeed(String(result.row.id), prompt);
      seedDelivered = true;
    }

    app.db
      .update(tasks)
      .set({
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        branchName,
        agentCommand: command,
        baseSha,
      })
      .where(eq(tasks.id, taskId))
      .run();
    committed = true;
    app.log.info(
      { taskId, from: "ready", to: "claimed", auto: opts.auto, command, seedDelivered },
      "task claim: transitioned",
    );

    // Best-effort GitHub sync (6.4/#217) — a no-op for a local task or an
    // unconnected install; failures are logged inside syncTaskTransition
    // and never thrown here. Uses the just-committed values directly
    // rather than re-querying (result.row is a SESSION row — only
    // sessionId/worktreePath/branchName/agentCommand are pulled from it,
    // never spread wholesale, since it shares field names like `id`/
    // `status` with the task row but means something different by them).
    //
    // Deliberately NOT awaited (Hermes review, PR #474) — this sits on
    // claim's HTTP request path, and syncTaskTransition makes 2-3
    // sequential GitHub round-trips with a 5s timeout each. Awaiting buys
    // nothing (the function never throws — every failure is already
    // caught and logged inside it) except adding up to ~15s of latency to
    // a slow/unreachable GitHub onto the claim response. Fire-and-forget.
    void syncTaskTransition(
      app,
      {
        ...task,
        status: "claimed",
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        branchName,
        agentCommand: command,
        baseSha,
      },
      project,
      "claimed",
    );

    const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
    const session = await withLiveStatus(app, result.row, idleThresholdMs, project.hostId);
    return { ok: true, session, seedDelivered };
  } catch (err) {
    if (committed) throw err;
    await release(err instanceof Error ? err.message : "unexpected error during claim");
    app.log.error({ err, taskId }, "task claim: unexpected error, reservation released");
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
 * `mullion/task-<id>` branch (git-worktree.ts's `resumeTaskWorktree`)
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
 * Local-hosted projects only for now (same scoping as task-promote.ts's
 * `isPromotionSupported`) — resuming needs local git worktree/branch
 * operations that don't yet proxy to a remote host; full remote support is
 * #484's scope.
 */
export async function retryTask(app: FastifyInstance, taskId: number): Promise<RetryTaskOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task) return { ok: false, reason: "not-found" };

  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-found" };

  if (project.hostId !== LOCAL_HOST_ID) {
    return {
      ok: false,
      reason: "remote-not-supported",
      detail:
        "Retrying a remote-hosted task isn't supported yet — resuming on its preserved branch needs local git operations, which don't yet proxy to remote hosts",
    };
  }
  const command = resolveAgentCommand(app, {
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
  const maxConcurrent = resolveTaskMasterConfig(app).maxConcurrent;
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
        // about to resume onto.
        failureReason: null,
        completedAt: null,
        sessionId: null,
        prUrl: null,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "failed")))
      .run();
    return { reserved: true as const, branchName: current.branchName };
  });

  if (!reservation.reserved) {
    if ("capped" in reservation && reservation.capped) {
      return { ok: false, reason: "cap", limit: maxConcurrent };
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

  // Mirrors claimTask's own release() — puts the reservation back rather
  // than leaving a "claimed" row with nothing spawned behind it. Releases
  // to "failed", not "ready": a retry that couldn't even resume the
  // worktree is still the same failed task, safely retryable again.
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
    app.db
      .update(tasks)
      .set({ status: "failed", failureReason: reason })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
      .run();
  }

  const branchName = reservation.branchName;

  let committed = false;
  // Hoisted out of the try block (rather than a `const` declared inside
  // it) so the catch block below can also clean it up — stashSeed, between
  // a successful resume and the DB commit, can throw too.
  let worktree: Awaited<ReturnType<SessionBackend["resumeTaskWorktree"]>> = null;
  try {
    worktree = await resolveBackend(app, project.hostId).resumeTaskWorktree(
      project.cwd,
      branchName,
    );
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
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command,
      cwd: worktree.path,
    });
    if (!result.ok) {
      await release("session spawn failed", worktree);
      return { ok: false, reason: "spawn-failed" };
    }

    let seedDelivered = false;
    if (seedCapable) {
      const prompt = task.body ? `${task.title}\n\n${task.body}` : task.title;
      await resolveBackend(app, project.hostId).stashSeed(String(result.row.id), prompt);
      seedDelivered = true;
    }

    app.db
      .update(tasks)
      .set({
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        agentCommand: command,
      })
      .where(eq(tasks.id, taskId))
      .run();
    committed = true;
    app.log.info(
      { taskId, from: "failed", to: "claimed", command, seedDelivered },
      "task retry: transitioned",
    );

    // Fire-and-forget, same reasoning as claimTask's own sync call.
    void syncTaskTransition(
      app,
      {
        ...task,
        status: "claimed",
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        agentCommand: command,
        failureReason: null,
        completedAt: null,
      },
      project,
      "claimed",
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
