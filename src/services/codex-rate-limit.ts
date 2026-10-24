// Issue #1734 — detect a Codex provider rate limit and report it the way the
// other CLIs already report theirs.
//
// THE PROBLEM
//
// Task Master's rate-limit grace keys off one exact string:
// `recordRateLimitEvent` (task-rate-limit-grace.ts) fires only when
// `info.errorDetail === "rate_limit"`, and `isRateLimitGraceActive` requires
// it too. Claude Code supplies it (its Stop hook carries `error_type`), agy
// supplies it (RESOURCE_EXHAUSTED), opencode supplies it (#1700/#1702).
// Codex could not, and could not be made to.
//
// WHY NOT A HOOK
//
// Measured live against codex-cli 0.164.0, driven by a fake API that answers
// 429 (the spike's own raw findings):
//
// 1. Codex's hook payload schemas are `additionalProperties: false`, and NOT
//    one of them carries an error, a status, or a usage field. The `Stop`
//    event's exact property list is `cwd`, `hook_event_name`,
//    `last_assistant_message`, `model`, `permission_mode`, `session_id`,
//    `stop_hook_active`, `transcript_path`, `turn_id`. There is no
//    `StopFailure` equivalent either, so there is nothing to map a rate
//    limit FROM.
//
// 2. Codex does not fire `Stop` at all for a turn that failed. On the failed
//    turn only `SessionStart` and `UserPromptSubmit` fired; on a successful
//    turn `Stop` fired as usual. A classifier riding `Stop` would therefore
//    never see the failure it exists to catch.
//
// 3. Codex gates every command hook behind an interactive `/hooks` trust
//    grant (hook-adapters/codex.ts's file header documents this, and the
//    spike needed `--dangerously-bypass-hook-trust` to observe any hook at
//    all). Until that grant exists, codex hooks are silently skipped.
//
// WHERE THE SIGNAL IS
//
// Codex's session rollout file — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
// handed to every codex hook as `transcript_path` — records the failure as a
// machine-readable error:
//
//   {"type":"event_msg","payload":{"type":"task_complete",
//    "error":{"message":"exceeded retry limit, last status: 429 Too Many Requests",
//             "codex_error_info":{"response_too_many_failed_attempts":{"http_status_code":429}}}}}
//
// `codex_error_info` is codex's own error taxonomy. Only the quota-shaped
// variants count: `rate_limit_exceeded` and `usage_limit_exceeded` always,
// and `response_too_many_failed_attempts` only when its HTTP status is 429.
// A `server_overloaded` or an `internal_server_error` is a DIFFERENT failure
// and must not buy a task a rate-limit grace window — a false positive here
// would park a task in grace for minutes on a failure that will not recover.
//
// HOW IT IS REPORTED
//
// By emitting the SAME `stop_failure` hook message the other CLIs' adapters
// emit. That message's handler (hook-handlers.ts) already sets
// `errorState`/`errorAt`/`errorDetail`, and `errorDetail === "rate_limit"`
// is exactly what the grace window checks. So the whole existing machinery —
// the grace window, the reconciler's branches, the UI's error badge — works
// unchanged; only the SOURCE of the signal is new.
import type { FastifyInstance } from "fastify";
import { readCodexRateLimitSignal } from "../hooks/codex-rollout.mjs";

/** The label task-rate-limit-grace.ts keys off. Must match exactly. */
const RATE_LIMIT_ERROR_DETAIL = "rate_limit";

/**
 * Checks every live session that has a codex rollout path and reports a
 * newly-observed rate-limited turn as a `stop_failure` hook message.
 *
 * Each failed turn is reported exactly once: codex's rollout keeps saying
 * the last turn failed until the next turn completes, so without the
 * per-session "already reported this turn id" latch every tick would
 * re-report the same failure and restart the grace window forever. A NEW
 * failed turn has a new turn id, so it is reported (and restarts the window,
 * matching the "a fresh rate_limit resets the clock" model
 * task-rate-limit-grace.ts documents).
 *
 * Never throws: a rollout that cannot be read, or a session that vanished
 * mid-sweep, is simply skipped. A sweep that fails must not take the
 * reconcile timer down with it.
 */
export async function detectCodexRateLimits(app: FastifyInstance): Promise<void> {
  let sessions: Array<{ id: string; transcriptPath: string; codexHome: string }>;
  try {
    sessions = app.pty.codexTranscriptPathSessions();
  } catch {
    return;
  }

  for (const { id, transcriptPath, codexHome } of sessions) {
    let signal;
    try {
      // The SESSION's own codex home is the trust root — a session may be
      // spawned with its own `CODEX_HOME`, and its rollout lives under THAT
      // home's `sessions/`, not the backend's.
      signal = readCodexRateLimitSignal(transcriptPath, { codexHome });
    } catch {
      continue;
    }
    if (signal === null) continue;
    // A rollout whose last completed turn succeeded carries no error: there
    // is nothing to report, and nothing to clear here either — the session's
    // own error state is cleared by the next `progress`/`turn_start` hook.
    if (!signal.rateLimited) continue;

    const identity = signal.turnId;
    // The identity of the failed turn. `null` means the rollout carried no
    // usable identity (no `turn_id`, no `ordinal`, no `completed_at`), so
    // there is no way to tell "the same failed turn" from "a new one" — and
    // re-reporting the same failure on every tick would restart the
    // rate-limit grace window forever, so it is NOT reported at all.
    if (identity === null) {
      app.log.warn(
        { sessionId: id },
        "[codex-rate-limit] a rate-limited codex turn had no usable identity — not reporting it",
      );
      continue;
    }
    if (app.pty.reportedCodexRateLimitTurnId(id) === identity) continue;

    try {
      // `provesHookPipeline: false` — this message is NOT evidence that the
      // session's hook pipeline fires. It is Mullion's own synthesis from the
      // rollout file, and latching `hooksProven` from it would let a session
      // read as hook-proven when no hook has ever been delivered to it (the
      // one signal codex's `/hooks` trust gate would otherwise keep honest).
      app.pty.emitHookEvent(
        id,
        {
          kind: "stop_failure",
          error: signal.message ?? "codex reported a provider rate limit",
          errorType: RATE_LIMIT_ERROR_DETAIL,
        },
        Date.now(),
        { provesHookPipeline: false },
      );
      app.pty.setReportedCodexRateLimitTurnId(id, identity);
      app.log.info(
        { sessionId: id, turnId: identity, status: signal.status, variant: signal.variant },
        "[codex-rate-limit] reported a provider rate limit for a codex session",
      );
    } catch (err) {
      app.log.warn(
        { err, sessionId: id },
        "[codex-rate-limit] failed to report a codex rate limit",
      );
    }
  }
}
