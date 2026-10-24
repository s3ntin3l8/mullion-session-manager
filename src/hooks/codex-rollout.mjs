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
//
// THE PATH IS UNTRUSTED.
//
// The rollout path arrives over the hook channel, and hook-protocol.ts
// documents that channel as untrusted: any subprocess holding the hook token
// can forge a `session_start`. So the path is NOT taken at face value. It
// must resolve inside codex's OWN sessions directory, it must be a regular
// file (not a FIFO — opening one for reading blocks the event loop
// forever — and not a device or a directory), and the file is opened with
// O_NOFOLLOW and re-checked with fstat so a symlink swapped in between the
// check and the open cannot be followed.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** How many bytes of the rollout's tail to read. A rollout grows for the
 * whole session, but the signal we want — the last completed turn — is
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
 * The payload tags that mean "this turn completed".
 *
 * Upstream defines the event as
 * `#[serde(rename = "task_complete", alias = "turn_complete")]` for v2
 * interop (codex-rs/protocol/src/protocol.rs), so a v2 rollout writes
 * `turn_complete` and a v1 rollout writes `task_complete`. Both are
 * accepted: reading only one of them would silently report nothing on the
 * other.
 */
const COMPLETED_TAGS = new Set(["task_complete", "turn_complete"]);

/**
 * Codex's home directory — the same rule as `resolveCodexHome()` in
 * src/services/hook-adapters/codex.ts (`CODEX_HOME` or `~/.codex`).
 *
 * Duplicated here rather than imported because that module imports the
 * adapter graph, and this file is plain ESM on the hook side of the fence.
 * test/hooks/codex-rate-limit.test.ts pins the two in agreement, so they
 * cannot drift apart silently.
 */
export function resolveCodexHome() {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

/** The directory codex writes its session rollouts into. */
export function codexSessionsDir() {
  return path.join(resolveCodexHome(), "sessions");
}

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
    /**
     * A stable identity for the completed turn this signal describes, used
     * to report each failed turn exactly once.
     *
     * `turn_id` is codex's own id and is what we want. It is NOT always
     * present, though, so this falls back to the rollout envelope's
     * `ordinal` (the file's own monotonically increasing line counter) and
     * then to `completed_at`. When none of them is available the signal
     * carries `null`, and the caller must NOT report it: with no stable
     * identity there is no way to tell "the same failed turn" from "a new
     * one", and re-reporting the same failure on every tick would restart
     * the rate-limit grace window forever.
     */
    this.identity = turnId;
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
 * True when `candidate` really is a file inside codex's sessions directory.
 *
 * Three checks, each closing a hole the previous one leaves:
 *
 * 1. `lstatSync` (NOT `statSync`) and `isFile()` — a symlink is not a
 *    regular file, so it is rejected outright, and a FIFO or a device is
 *    rejected too. Opening a FIFO for reading blocks the event loop
 *    forever, which is the sharpest edge of "any readable file gets read".
 * 2. The REAL path of the file must sit inside the REAL path of codex's
 *    sessions directory. The real path is what the kernel will actually
 *    open, so this is the check that defeats a `..` traversal or a symlinked
 *    parent directory.
 * 3. The directory check is done against a real path too, so a symlinked
 *    sessions directory does not make every path outside it look inside it.
 */
export function isCodexRolloutPath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  let sessionsDir;
  let fileRealPath;
  try {
    sessionsDir = realpathSync(codexSessionsDir());
    fileRealPath = realpathSync(candidate);
  } catch {
    return false;
  }
  const relative = path.relative(sessionsDir, fileRealPath);
  // A path outside the directory (or the directory itself) is not a
  // rollout. `relative` starting with ".." is the outside case.
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  return true;
}

/**
 * Reads the tail of a rollout file and reports the last completed turn's
 * error, if any.
 *
 * Returns null when the path is not a codex rollout, when the file is
 * missing or unreadable, when it is empty, or when it holds no completed
 * turn — every one of which means "no signal", never "no rate limit" in a
 * way a caller could mistake for a positive finding.
 */
export function readCodexRateLimitSignal(rolloutPath, options = {}) {
  if (!isCodexRolloutPath(rolloutPath)) return null;
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;

  let handle;
  try {
    // O_NOFOLLOW: if the path was swapped for a symlink between the lstat
    // above and this open, the open FAILS rather than following it. The
    // fstat below then re-checks the handle we actually hold.
    handle = openSync(rolloutPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(handle);
    if (!stat.isFile()) return null;
    if (stat.size === 0) return null;
    const length = Math.min(stat.size, tailBytes);
    const buffer = Buffer.alloc(length);
    // readSync may return FEWER bytes than asked for (a short read). Using
    // the buffer as-is would leave NUL padding at the end, and the trailing
    // line — the newest one, the one this reader exists to read — would
    // fail to parse.
    const read = readSync(handle, buffer, 0, length, stat.size - length);
    return parseCodexRateLimitSignal(buffer.subarray(0, read).toString("utf8"));
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
  let completedOrdinal = null;
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
    if (!COMPLETED_TAGS.has(payload?.type)) continue;
    completed = payload;
    completedOrdinal = typeof parsed.ordinal === "number" ? parsed.ordinal : null;
  }
  if (completed === null) return null;

  // The identity of this completed turn, most specific first.
  const identity =
    typeof completed.turn_id === "string" && completed.turn_id.length > 0
      ? completed.turn_id
      : completedOrdinal !== null
        ? `ordinal:${completedOrdinal}`
        : typeof completed.completed_at === "number"
          ? `completed_at:${completed.completed_at}`
          : null;

  const error = completed.error ?? null;
  if (error === null) {
    // A turn that completed cleanly. Reported as a non-rate-limited signal
    // so a caller can see that the rollout IS being read and the last turn
    // was fine — which is what clears a previously reported rate limit.
    return new CodexRateLimitSignal({
      turnId: identity,
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
    turnId: identity,
    rateLimited,
    status,
    variant,
    message,
  });
}
