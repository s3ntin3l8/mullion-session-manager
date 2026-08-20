// Task-claim queueing (rate-limit-storm fix) — the scheduler half of the
// claim/dispatch split (task-claim.ts). `enqueueTask` and `retryTask` write
// "claimed" unconditionally; this module is what actually turns a queued
// row into a running worker, respecting MULLION_TASK_MAX_CONCURRENT.
//
// Two triggers call `dispatchQueuedTasks`:
//   - task-watcher.ts's poll tick (MULLION_TASK_POLL_INTERVAL, default 60s)
//     — the backstop, guaranteeing eventual dispatch even if every
//     opportunistic trigger below is somehow missed.
//   - the opportunistic hook registered below, off task-state.ts's
//     `recordTaskTransition` — fires the moment a task joins the queue
//     (`to === "claimed"`) or a worker slot frees (`from === "in_progress"`),
//     so a claim with room right now doesn't wait for the next tick.
//
// Registered here, not imported by task-state.ts: task-claim.ts already
// imports FROM task-state.ts (recordTaskTransition, CONCURRENCY_CAPPED_STATUSES),
// so task-state.ts importing this module's dispatch function back would be
// an import cycle. registerTaskTransitionListener is task-state.ts's own
// generic escape hatch for exactly this shape of problem — see its doc
// comment there.
import { asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { tasks } from "../db/schema.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { dispatchClaimedTask } from "./task-claim.js";
import { registerTaskTransitionListener } from "./task-state.js";

// Same backoff shape as task-reconciler.ts's retryStrandedDraftPRs /
// draftPrRetryState — process-local, not a DB column (a restart resetting
// a broken task's backoff to "try immediately" is never worse than today's
// behavior, and this is a strictly best-effort scheduling aid, not
// correctness state). A task that keeps failing dispatch (a persistently
// dirty leftover worktree, a host that's down) must not be retried in a
// tight loop every time some OTHER task's transition fires the
// opportunistic hook — see dispatchQueuedTasks's own doc comment for the
// concrete loop this prevents.
const DISPATCH_RETRY_TTL_MS = 5 * 60 * 1000;
const DISPATCH_RETRY_MAX_TTL_MS = 60 * 60 * 1000;
// Hermes review, PR #770 — bounded, not just process-lifetime-scoped: a
// task that fails dispatch once and is then deleted (or never gets picked
// again) would otherwise leave its entry in this Map forever. Map
// preserves insertion order, so evicting the OLDEST entry once the cap is
// hit is a cheap, correct-enough LRU-ish bound — the evicted task simply
// loses its backoff and gets tried again on the next sweep, which is a
// safe direction (retrying sooner, never a correctness issue) for an
// already-rare, already-pathological case.
const DISPATCH_BACKOFF_MAX_ENTRIES = 500;
const dispatchBackoffState = new Map<number, { nextAttemptAt: number; attempts: number }>();

function dispatchBackoffMs(attempts: number): number {
  return Math.min(DISPATCH_RETRY_TTL_MS * 2 ** (attempts - 1), DISPATCH_RETRY_MAX_TTL_MS);
}

function isBackedOff(taskId: number, now: number): boolean {
  const state = dispatchBackoffState.get(taskId);
  return state !== undefined && state.nextAttemptAt > now;
}

function recordDispatchFailure(taskId: number, now: number): void {
  const prior = dispatchBackoffState.get(taskId);
  const attempts = (prior?.attempts ?? 0) + 1;
  if (
    !dispatchBackoffState.has(taskId) &&
    dispatchBackoffState.size >= DISPATCH_BACKOFF_MAX_ENTRIES
  ) {
    const oldestKey = dispatchBackoffState.keys().next().value;
    if (oldestKey !== undefined) dispatchBackoffState.delete(oldestKey);
  }
  dispatchBackoffState.set(taskId, { nextAttemptAt: now + dispatchBackoffMs(attempts), attempts });
}

function clearDispatchBackoff(taskId: number): void {
  dispatchBackoffState.delete(taskId);
}

/** Test-only reset — module-level state would otherwise leak between test
 * cases/files that re-import this module. */
export function resetDispatchBackoffForTests(): void {
  dispatchBackoffState.clear();
}

// Coalescing reentrancy guard: `dispatchQueuedTasks` can be triggered many
// times in quick succession (several transitions committing close
// together, or the opportunistic hook racing the watcher tick). A bare
// "skip if already running" guard would silently DROP a trigger that
// arrives mid-sweep — if that trigger represented a newly-freed slot the
// in-flight sweep's own snapshot predates, nothing would retry it until
// the next watcher tick (up to 60s later). Instead, a trigger that arrives
// while a sweep is running sets `pending`, and the running sweep loops
// once more before returning — bounded to exactly one extra pass, never
// unbounded, and never silently dropped.
let sweepInFlight = false;
let sweepPending = false;

/** Test-only reset — like resetDispatchBackoffForTests above, this is
 * module-level state, so it would otherwise leak between test cases/files.
 * Specifically: a still-running background sweep from a PRIOR test's app
 * (kicked off by the opportunistic hook, fire-and-forget) can still be
 * holding `sweepInFlight` true when the next test's own explicit
 * dispatchQueuedTasks call runs — that call would then silently no-op
 * (`sweepPending = true; return`) against a sweep that, from the new
 * test's perspective, was never requested and touches a different app
 * entirely. Call from `afterEach`/`beforeEach`, not mid-test — resetting
 * while a sweep genuinely started BY THIS test is still running would let
 * a second call run truly concurrently against the same app. */
export function resetDispatchStateForTests(): void {
  sweepInFlight = false;
  sweepPending = false;
}

/**
 * Dispatches as many queued ("claimed") tasks as there is room for, ordered
 * `(boardOrder, id)` — the same ordering `autoClaimReadyTasks`
 * (task-watcher.ts) already uses for the `ready` backlog, so a task's
 * position in the UI matches the order it's actually likely to start in.
 *
 * Stops as soon as capacity is gone (mirrors autoClaimReadyTasks' own
 * "stop the sweep at capacity" posture) or the queue is exhausted. A task
 * still inside its own backoff window (see above) is skipped, not
 * counted against capacity, and not treated as blocking later candidates —
 * this is the fix for a real bug caught during design: without per-task
 * backoff, a task whose dispatch fails deterministically (a dirty
 * leftover worktree, an unreachable host) would release back to "claimed"
 * via `dispatchClaimedTask`'s own release(), which fires a
 * `from: "in_progress", to: "claimed"` transition — matching this
 * function's own opportunistic trigger condition and re-invoking this same
 * sweep immediately, retrying the identical failure forever.
 */
export async function dispatchQueuedTasks(app: FastifyInstance): Promise<void> {
  if (sweepInFlight) {
    sweepPending = true;
    return;
  }
  sweepInFlight = true;
  try {
    do {
      sweepPending = false;
      await runOneSweep(app);
    } while (sweepPending);
  } finally {
    sweepInFlight = false;
  }
}

async function runOneSweep(app: FastifyInstance): Promise<void> {
  const maxConcurrent = resolveTaskMasterConfig(app).maxConcurrent;
  const now = Date.now();
  const queued = app.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, "claimed"))
    .orderBy(asc(tasks.boardOrder), asc(tasks.id))
    .all();

  for (const { id: taskId } of queued) {
    if (isBackedOff(taskId, now)) continue;

    // Re-checked every iteration, not hoisted above the loop — a prior
    // iteration in THIS sweep may have just filled the last slot.
    const inFlight = app.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.status, ["in_progress"]))
      .all().length;
    if (inFlight >= maxConcurrent) return;

    const outcome = await dispatchClaimedTask(app, taskId);
    if (outcome.ok) {
      clearDispatchBackoff(taskId);
      continue;
    }
    if (outcome.reason === "cap") {
      // Lost a race with another dispatch attempt for the last slot —
      // not this task's fault, and no room left either way.
      return;
    }
    if (outcome.reason === "not-queued") {
      // Something else already moved this row (another dispatch attempt
      // won it, or it was deleted/edited concurrently) — not a failure of
      // this task's own dispatch, no backoff, just move on.
      continue;
    }
    app.log.warn(
      { taskId, reason: outcome.reason, detail: outcome.detail },
      "[task-dispatch] dispatch failed, backing off this task",
    );
    recordDispatchFailure(taskId, now);
  }
}

// Hermes review, PR #770 — `app.addHook("onClose", ...)` registers a NEW,
// PERMANENT hook every call; Fastify never removes a hook once fired, so
// registering one per scheduled sweep (an earlier version of this file)
// grew the hook list unboundedly over a long-lived process's whole
// lifetime. Instead: exactly ONE `onClose` hook per app, which drains a
// per-app Set of pending handles. Each handle removes itself from the set
// once its own immediate actually fires, so the set only ever holds
// handles that are genuinely still pending.
//
// That single hook must be registered eagerly, in `registerDispatchCleanup`
// below — NOT lazily, on first use, from `scheduleDispatchSweep` itself (an
// earlier version of this file did exactly that, and it was broken: Fastify
// refuses `app.addHook(...)` once the instance has "started"
// (`FST_ERR_INSTANCE_ALREADY_LISTENING`), which happens on the very first
// `app.inject()`/request — i.e. before any real task transition could ever
// fire this listener. `recordTaskTransition` calls every listener inside a
// try/catch (task-state.ts), so that throw was silently swallowed on every
// single call — the opportunistic sweep never actually ran, in production
// or in any test past its first request. Caught by this module's own test
// suite (test/services/task-dispatch.test.ts), not by review.
const pendingImmediatesByApp = new WeakMap<FastifyInstance, Set<NodeJS.Immediate>>();

/** Call once per app, before it starts (i.e. from buildApp, alongside every
 * other `onClose` registration there) — see the block comment above for why
 * this can't be done lazily from inside the transition listener. */
export function registerDispatchCleanup(app: FastifyInstance): void {
  const pending = new Set<NodeJS.Immediate>();
  pendingImmediatesByApp.set(app, pending);
  // Cancels every still-pending scheduled sweep for THIS app — without
  // this, a scheduled sweep outlives the app that scheduled it (relevant
  // any time more than one FastifyInstance exists against the same
  // database, e.g. this repo's own test suite building many short-lived
  // apps against one shared DB file per test file): a stale immediate
  // could fire after its app closed and act on a DIFFERENT, later app's
  // rows using a defunct connection. In production there is exactly one
  // long-lived app for the process's whole lifetime, so this fires at most
  // once, at real shutdown — inert until then, not test-only scaffolding.
  app.addHook("onClose", () => {
    for (const handle of pending) clearImmediate(handle);
    pending.clear();
  });
}

function scheduleDispatchSweep(app: FastifyInstance): void {
  // Falls back to an untracked (leak-on-close-race) schedule if this app
  // was never passed to registerDispatchCleanup — should be unreachable in
  // practice (every real app goes through buildApp), but a missing entry
  // here must never crash a task transition the way the old lazy-addHook
  // bug did.
  const pending = pendingImmediatesByApp.get(app);
  const handle = setImmediate(() => {
    pending?.delete(handle);
    void dispatchQueuedTasks(app).catch((err: unknown) => {
      app.log.error({ err }, "[task-dispatch] opportunistic dispatch sweep failed");
    });
  });
  pending?.add(handle);
}

registerTaskTransitionListener((app, { from, to }) => {
  if (to !== "claimed" && from !== "in_progress") return;
  // Deferred via setImmediate, not called inline — recordTaskTransition
  // runs synchronously inside enqueueTask/dispatchClaimedTask's own
  // transactions (better-sqlite3), and dispatchQueuedTasks's own DB reads
  // are ALSO synchronous up to its first real I/O call. Calling it inline
  // here would let dispatch's reservation transaction run nested inside
  // the SAME call stack as the transition that triggered it — meaning a
  // manual claim's HTTP response could nondeterministically already
  // reflect a dispatch that raced ahead of it, depending on how fast the
  // local git/worktree calls happen to complete. Deferring to the next
  // tick makes the split deterministic: the triggering call (enqueueTask,
  // a route handler's response, a reconciler pass) always finishes and
  // returns its own consistent snapshot BEFORE any dispatch attempt for
  // the slot it just affected can start.
  scheduleDispatchSweep(app);
});
