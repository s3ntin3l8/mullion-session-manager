import { TASK_STATUSES, type TaskStatus } from "../db/schema.js";

export { TASK_STATUSES, type TaskStatus };

// Accepted, stated gap (6.2/#215's own issue body asks for state
// transitions to "emit notification events into the Phase 1.1 event
// model"; this deliberately does not): `NotificationEvent`
// (pty-manager.ts) is strictly per-session — construction is a `private`
// method on `Session`, keyed by a numeric sessionId that must already be a
// live-or-recently-live entry in PtyManager's own in-memory map. There is
// no session-less event path today. A task in "backlog"/"ready" (no
// session yet) has nothing to key an event on, and piggybacking task
// transitions onto an EXISTING session's event stream would conflate two
// different concepts a consumer can't tell apart (a task's lifecycle vs.
// its worker session's). Building a genuine session-less channel means
// touching PtyManager's internals — CLAUDE.md's own warning about that file
// applies — for a benefit (faster panel refresh) the Tasks panel doesn't
// strictly need: 6.5's own spec says tasks "refreshed via store-backed
// interval," i.e. polling was already the intended mechanism, not a live
// push. Structured `app.log.info`/`app.log.warn` calls at each transition
// site are the interim signal; real event-model integration is future
// work, not silently dropped.
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
 * failed      -> backlog, ready       (explicit human retry)
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

/** Statuses that represent a task still in play — the reconciler's own
 * "which tasks do I even need to look at" filter, and the claim-cap's
 * "what counts as consuming concurrency" set (a subset of this, not all of
 * it — see task-reconciler.ts). */
export const NON_TERMINAL_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
  (status) => status !== "done" && status !== "failed",
);

/** Statuses that hold a live worker session and therefore consume a slot in
 * the MULLION_TASK_MAX_CONCURRENT cap — narrower than NON_TERMINAL_STATUSES,
 * which also includes backlog/ready/reviewing (none of which occupy the
 * cap: backlog/ready haven't spawned anything yet, and reviewing's worker
 * turn is already over). */
export const CONCURRENCY_CAPPED_STATUSES: readonly TaskStatus[] = ["claimed", "in_progress"];
