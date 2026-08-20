import type { FastifyInstance } from "fastify";
import { TASK_STATUSES, type TaskStatus } from "../db/schema.js";
import { broadcastTaskEvent } from "./task-events.js";

export { TASK_STATUSES, type TaskStatus };

/**
 * Phase 6 Task Master (6.2/#215) — the legal transition table for a task's
 * lifecycle. Assigning this object literal directly to a
 * `Record<TaskStatus, ...>`-typed const (same pattern as session-status.ts's
 * SEVERITY_BY_STATUS) means TypeScript itself rejects a `TaskStatus` added
 * to the schema.ts union without a matching row here — a missing case is a
 * `make typecheck` failure, not a runtime surprise.
 *
 * backlog     -> ready, failed        (drag-to-ready / user-marked abandoned)
 * ready       -> claimed, backlog, failed
 * claimed     -> in_progress, reviewing, failed
 * in_progress -> reviewing, failed    (agent's turn ended / session died)
 * reviewing   -> done, in_progress, failed  (approve / reject / give up)
 * done        -> (terminal)
 * failed      -> backlog, ready       (explicit human retry, or an
 *                                       automatic relabel-resurrection —
 *                                       see upsertIssueTask, task-watcher.ts)
 *
 * `claimed -> reviewing` (skipping `in_progress`) is a real, reachable edge,
 * not a shortcut for convenience: the reconciler (task-reconciler.ts) polls
 * on an interval, and a task whose agent finishes its very first turn
 * between two poll ticks is observed going straight from "claimed" to
 * "finished" — there was no tick in between where it was ever seen
 * "in_progress". Modeling that as illegal would either drop the transition
 * or force a synthetic in_progress write nothing actually observed.
 *
 * Deliberately NOT `reviewing -> failed` via session death: a `reviewing`
 * task's session exiting doesn't fail it — the turn is already over and the
 * work is committed on its branch, still promotable. Only `claimed`/
 * `in_progress` are session-liveness-dependent (see #282's hook in
 * session-reconciler.ts). `reviewing -> failed` above is reachable only via
 * an explicit human "give up" action, not automatically.
 */
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ["ready", "failed"],
  ready: ["claimed", "backlog", "failed"],
  claimed: ["in_progress", "reviewing", "failed"],
  in_progress: ["reviewing", "failed"],
  reviewing: ["done", "in_progress", "failed"],
  done: [],
  failed: ["backlog", "ready"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/**
 * #488 — the single chokepoint every task status write should call through:
 * logs the transition (structured, matching the shape each call site used
 * individually before this existed) and broadcasts it on the `/ws/tasks`
 * live channel (task-events.ts) in one place, so neither can drift out of
 * sync with the other. Unlike `canTransition`, which is purely advisory and
 * bypassed in several places (routes/tasks.ts's approve/reject, every
 * reconciler write), this function doesn't gate anything — it's called
 * *after* a transition has already been committed to the DB, purely to
 * record and announce it. `via` is a short, greppable tag identifying which
 * code path drove the transition (e.g. "claim", "reconcile", "approve"),
 * distinguishing otherwise-identical from/to pairs reached different ways.
 */
export function recordTaskTransition(
  app: FastifyInstance,
  params: {
    taskId: number;
    projectId: number;
    from: TaskStatus;
    to: TaskStatus;
    via: string;
    context?: Record<string, unknown>;
  },
): void {
  app.log.info(
    { taskId: params.taskId, from: params.from, to: params.to, via: params.via, ...params.context },
    "task transition",
  );
  broadcastTaskEvent({
    taskId: params.taskId,
    projectId: params.projectId,
    kind: "transition",
    from: params.from,
    to: params.to,
    ts: Date.now(),
  });
}

/** Statuses that hold a live worker session and therefore consume a slot in
 * the MULLION_TASK_MAX_CONCURRENT cap and the reconciler's own polling
 * filter (task-reconciler.ts's SELECT) — backlog/ready haven't spawned
 * anything yet, and reviewing's worker turn is already over, so neither
 * occupies a slot. */
export const CONCURRENCY_CAPPED_STATUSES: readonly TaskStatus[] = ["claimed", "in_progress"];
