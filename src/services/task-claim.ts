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
import { resolveBackend } from "./session-backend.js";
import { resolveDefaultBaseRef } from "./git-refs.js";
import { getStoredSettings } from "./settings.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { CONCURRENCY_CAPPED_STATUSES } from "./task-state.js";
import { resolveAgentCommand, commandSupportsSeed } from "./task-agent-resolve.js";

export type ClaimTaskOutcome =
  | { ok: true; session: Awaited<ReturnType<typeof withLiveStatus>>; seedDelivered: boolean }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-ready"
        | "cap"
        | "remote-unsupported"
        | "worktree-failed"
        | "spawn-failed"
        | "no-seed-channel";
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
 * Known, accepted gap (deferred to 6.8's worktree lifecycle, not silently
 * dropped): a claim that reserves the task but then fails at worktree
 * creation releases the reservation back to "ready", but its deterministic
 * branch/worktree path (`mullion/task-<id>`) is left on disk — a retry
 * hits the same `git worktree add -b` collision until 6.8's orphan-clearing
 * lands. This is the same "leave it for manual cleanup" posture every
 * other worktree operation in this codebase already has pre-6.8.
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
  if (project.hostId !== LOCAL_HOST_ID) {
    return {
      ok: false,
      reason: "remote-unsupported",
      detail: "Claiming a task on a remote-hosted project isn't supported yet (Phase 6's 6.8)",
    };
  }

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

  const maxConcurrent = app.config.MULLION_TASK_MAX_CONCURRENT;
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
      .set({ status: "claimed", claimedAt: new Date() })
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
  // consume a concurrency slot forever.
  async function release(reason: string): Promise<void> {
    app.db
      .update(tasks)
      .set({ status: "ready", claimedAt: null, failureReason: reason })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
      .run();
  }

  const baseRef = await resolveDefaultBaseRef(project.cwd);
  // Derived from task.id, not task.issueNumber: issueNumber is nullable
  // (6.9) and every local task shares the same NULL — branching on it
  // would collide every local task onto `mullion/task-null`.
  const branchName = `mullion/task-${task.id}`;

  const result = await createSessionRecord(app, {
    projectId: project.id,
    command,
    worktree: { baseRef, branchName },
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
    })
    .where(eq(tasks.id, taskId))
    .run();
  app.log.info(
    { taskId, from: "ready", to: "claimed", auto: opts.auto, command, seedDelivered },
    "task claim: transitioned",
  );

  const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
  const session = await withLiveStatus(app, result.row, idleThresholdMs, project.hostId);
  return { ok: true, session, seedDelivered };
}
