// Reads a Codex session's rollout file and reports whether its most recent
// turn ended on a provider rate limit.
//
// Plain ESM on purpose, the same arrangement src/cli/sun-path.mjs uses: this
// logic has to run in two places that cannot both be TypeScript — the
// forwarder (src/hooks/forwarder-core.mjs, plain ESM, spawned by codex as a
// hook command) and the compiled backend (src/services/codex-rate-limit.ts).
// The types live in codex-rollout.d.mts.
//
// WHY THE ROLLOUT FILE AT ALL — issue #1734.
//
// Task Master's rate-limit grace keys off one exact string:
// `recordRateLimitEvent` (src/services/task-rate-limit-grace.ts) fires only
// when `info.errorDetail === "rate_limit"`, and `isRateLimitGraceActive`
// requires it too. Claude Code supplies it (its Stop hook carries
// `error_type`), agy supplies it (RESOURCE_EXHAUSTED), opencode supplies it
// (#1700/#1702). Codex could not: codex-cli 0.163.0's and 0.164.0's hook
// payload schemas are `additionalProperties: false`, and NOT ONE of them
// carries an error, a status, or a usage field — the `Stop` event's exact
// property list is `cwd`, `hook_event_name`, `last_assistant_message`,
// `model`, `permission_mode`, `session_id`, `stop_hook_active`,
// `transcript_path`, `turn_id`. There is no `StopFailure` equivalent either.
//
// Worse: codex does not fire `Stop` at all for a turn that failed. Measured
// live against codex-cli 0.164.0 driven by a fake API that answers 429:
// on the failed turn only `SessionStart` and `UserPromptSubmit` fire, while
// on a successful turn `Stop` fires as usual. So even a hook that carried
// the error could not be relied on to arrive.
//
// The rollout file is where codex DOES record the failure, as a
// machine-readable error rather than a display string:
//
//   {"type":"event_msg","payload":{"type":"task_complete",
//    "error":{"message":"exceeded retry limit, last status: 429 Too Many Requests",
//             "codex_error_info":{"response_too_many_failed_attempts":{"http_status_code":429}}}}}
//
// `codex_error_info` is codex's own error taxonomy, whose variants are
// `rate_limit_exceeded`, `usage_limit_exceeded`,
// `response_too_many_failed_attempts`, `server_overloaded`,
// `internal_server_error`, `context_window_exceeded`, and a dozen more. Only
// the rate-limit-shaped ones count here: a `server_overloaded` or an
// `internal_server_error` is a DIFFERENT failure and must not buy a task a
// rate-limit grace window.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

/** How many bytes of the rollout's tail to read. A rollout grows for the
 * whole session, but the signal we want — the last `task_complete` — is
 * always in the final few lines. 256 KiB is far more than a few hundred
 * lines of JSONL need, and small enough to keep the per-tick read cheap. */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

/**
 * The `codex_error_info` variants that mean "the provider refused this turn
 * for quota reasons".
 *
 * `rate_limit_exceeded` and `usage_limit_exceeded` are codex's own direct
 * names for the condition. `response_too_many_failed_attempts` is the shape
 * codex actually reports when its RETRY loop gives up against a 429 — the
 * live measurement above produced exactly that, with `http_status_code: 429`
 * — so it counts only when the status says 429. The same variant with a 500
 * is a server failure, not a quota failure.
 */
const RATE_LIMIT_VARIANTS = new Set(["rate_limit_exceeded", "usage_limit_exceeded"]);

/** The variant whose own payload carries the HTTP status. */
const STATUS_CARRYING_VARIANT = "response_too_many_failed_attempts";

/** The HTTP status that means "too many requests". */
const TOO_MANY_REQUESTS = 429;

/**
 * The signal a rollout's last completed turn reports.
 *
 * `rateLimited` is false for every non-quota failure — including an
 * ordinary server error — so a caller can act on it without re-deriving
 * what counts as a rate limit.
 */
export class CodexRateLimitSignal {
  constructor({ turnId, rateLimited, status, variant, message }) {
    /** The turn the signal belongs to, so a caller can report it once. */
    this.turnId = turnId;
    /** True only for a quota-shaped provider refusal. */
    this.rateLimited = rateLimited;
    /** The provider's HTTP status, when codex recorded one. */
    this.status = status;
    /** The `codex_error_info` variant name, for diagnostics. */
    this.variant = variant;
    /** codex's own human-readable error message. */
    this.message = message;
  }
}

/**
 * Reads the tail of a rollout file and reports the last completed turn's
 * error, if any.
 *
 * Returns null when the file is missing, unreadable, empty, or holds no
 * completed turn — every one of which means "no signal", never "no rate
 * limit" in a way a caller could mistake for a positive finding.
 */
export function readCodexRateLimitSignal(rolloutPath, options = {}) {
  if (typeof rolloutPath !== "string" || rolloutPath.length === 0) return null;
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;

  let handle;
  try {
    if (!existsSync(rolloutPath)) return null;
    handle = openSync(rolloutPath, "r");
    const size = fstatSync(handle).size;
    if (size === 0) return null;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(handle, buffer, 0, length, size - length);
    return parseCodexRateLimitSignal(buffer.toString("utf8"));
  } catch {
    // A rollout that cannot be read (rotated away, a permissions problem, a
    // half-written file) is "no signal" — never a reason to fail a task.
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Nothing to do: the read already produced its result.
      }
    }
  }
}

/**
 * Parses the tail of a rollout into a signal.
 *
 * Exported for the test suite, which drives it with fixture text rather
 * than a real file.
 */
export function parseCodexRateLimitSignal(tailText) {
  if (typeof tailText !== "string" || tailText.length === 0) return null;

  // The tail can begin mid-line; a partial first line is not valid JSON and
  // is skipped rather than aborting the parse.
  const lines = tailText.split("\n");
  let completed = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed?.type !== "event_msg") continue;
    const payload = parsed.payload;
    if (payload?.type !== "task_complete") continue;
    completed = payload;
  }
  if (completed === null) return null;

  const error = completed.error ?? null;
  if (error === null) {
    // A turn that completed cleanly. Reported as a non-rate-limited signal
    // so a caller can see that the rollout IS being read and the last turn
    // was fine — which is what clears a previously reported rate limit.
    return new CodexRateLimitSignal({
      turnId: typeof completed.turn_id === "string" ? completed.turn_id : null,
      rateLimited: false,
      status: null,
      variant: null,
      message: null,
    });
  }

  const message = typeof error.message === "string" ? error.message : null;
  const info = error.codex_error_info ?? null;
  const variant = info && typeof info === "object" ? (Object.keys(info)[0] ?? null) : null;

  let status = null;
  if (variant !== null && info !== null) {
    const body = info[variant];
    const raw = body && typeof body === "object" ? body.http_status_code : undefined;
    if (typeof raw === "number") status = raw;
  }

  const rateLimited =
    (variant !== null && RATE_LIMIT_VARIANTS.has(variant)) ||
    (variant === STATUS_CARRYING_VARIANT && status === TOO_MANY_REQUESTS);

  return new CodexRateLimitSignal({
    turnId: typeof completed.turn_id === "string" ? completed.turn_id : null,
    rateLimited,
    status,
    variant,
    message,
  });
}
