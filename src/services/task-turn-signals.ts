import type { SessionStatus } from "../shared/types.js";
import type { SessionInfo } from "./pty-manager.js";
import { CLOCK_SKEW_TOLERANCE_MS } from "./task-auto-rebase.js";

// Whether a worker's turn has ended since its claim, and whether a stuck
// background shell job is all that keeps it from reading as finished.
// Split out of task-reconciler.ts (#3111); the reconciler's handoff and its
// budget deadline both read them.

// #722's investigation, RC5 — session-status.ts's `derived.status ===
// "finished"` is a LATCH on `lastTurnEndedAt`, not an edge: once set, it
// stays true until the NEXT turn starts (hook-handlers.ts's `turn_start`) or
// a genuine keystroke clears it (pty-manager.ts's `isGenuineUserInput`).
// Reject (`reviewing -> in_progress`, routes/tasks.ts) deliberately leaves a
// still-active session's latch untouched so a human can type feedback into
// it themselves (task-reseed.ts's own `force: false` doc comment) — but
// that means the very next reconcile tick re-derives "finished" from that
// SAME stale latch and flips the task straight back to "reviewing" before
// the human ever gets a chance to type, pushing again and spawning a second
// review agent that clobbers `reviewSessionId`.
//
// Fixed by requiring the finish signal to postdate this specific
// claimed/in_progress spell, anchored on `claimedAt`: it's already reset to
// `now` on every fresh entry into that pool — a new claim, Retry, Reject
// (routes/tasks.ts's own reject handler, already documented there as the
// budget-deadline anchor), AND autoReturnTask (issue #1357 — the shared
// auto-return mechanism behind changes-requested review feedback, #755's
// CI-red return, and the PR-comment return) — so one comparison covers all
// four without a new column. A small tolerance guards against clock skew
// between this process and a remote-hosted project's own host (#484) — both
// are NTP-synced in practice, but a bare `>` would let a few hundred ms of
// skew wrongly stick a task in "in_progress" forever.
export function turnFinishedSinceClaim(
  info: SessionInfo | null,
  task: { claimedAt: Date | null },
): boolean {
  if (info === null || info.workFinishedAt === null || task.claimedAt === null) return false;
  // Issue #1735 — `workFinishedAt`, not `lastTurnEndedAt`. The latter says a
  // turn ENDED (which a machine-woken turn does too, and which drives the
  // session's derived `finished` status, `agentTurnInFlight` and the
  // "Finished" ping). The former says the agent's WORK is done — which is
  // the only thing this gate is about.
  //
  // Without that distinction a session that loops internally tripped this
  // gate MID-LOOP: the task advanced to `reviewing` while the worker was
  // still working, and the review agent judged an incomplete diff in the
  // same worktree the worker was still writing to.
  return info.workFinishedAt >= task.claimedAt.getTime() - CLOCK_SKEW_TOLERANCE_MS;
}

// How long a worker's finished turn may sit behind a still-"running"
// background SHELL job before the reconciler stops waiting on it. Such a job
// (a `until ...; do sleep 5; done` wait loop the worker started for its own
// gate run and never stopped — task 441117, issue #1380) holds the session
// at `derived.status === "background"` forever: nothing re-stamps
// `backgroundTasksAt` after the final turn, and the stale-latch sweep (busy
// TTL, default 2h, PLUS a PTY-silence requirement any later redraw breaks)
// can't beat the claim-anchored budget. Only shell tasks are excused —
// outstanding agent/MCP work still blocks the handoff (issue #428).
// A worker with no commits past base is never handed off on this path: it is
// mid-work behind a long job, and the budget deadline (when one is set; `0` is
// unlimited) is its backstop.
const SHELL_TAIL_GRACE_MS = 5 * 60_000;
const SHELL_TAIL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "background",
  "tool_failure",
  "needs_input",
]);

/**
 * True when the worker's turn ended since this claim and the ONLY thing
 * keeping the session from deriving `finished` is background `shell` tasks
 * that have outlived `SHELL_TAIL_GRACE_MS` past that turn end. The derived
 * status must be one a stuck shell tail can present as: `background` itself,
 * or a higher-precedence status that merely masks it (`tool_failure` after a
 * failed last gate run, byte-heuristic `needs_input` once the PTY goes
 * quiet). Every other status (awaiting_*, api_error, compacting, subagent,
 * exited, ...) is a real, separate reason not to hand off. The
 * commits-past-base check stays with the existing `checkReviewingGate`.
 */
export function isShellTailHandoff(
  derivedStatus: SessionStatus,
  info: SessionInfo | null,
  task: { claimedAt: Date | null },
  now: number,
): boolean {
  if (!SHELL_TAIL_STATUSES.has(derivedStatus)) return false;
  if (info === null || !turnFinishedSinceClaim(info, task)) return false;
  if (info.lastTurnEndedAt === null || now - info.lastTurnEndedAt < SHELL_TAIL_GRACE_MS) {
    return false;
  }
  const outstanding = info.outstandingBackgroundTasks;
  return outstanding.length > 0 && outstanding.every((t) => t.type === "shell");
}
