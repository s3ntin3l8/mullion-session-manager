import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Issue #271 follow-up — promote-to-worktree full-context carryover for
// opencode. A `--session <id> --fork` resume was rejected: `--fork` pins the
// forked session's `directory` to the ORIGINAL session's stored directory,
// so a "promoted" agent's tool calls would silently run back in the live
// main checkout, defeating worktree isolation.
//
// Instead: `opencode session export <id>` -> id-rewrite -> `opencode session
// import <file> --directory <worktree>`. The importer re-keys the session's
// location to the worktree, which is exactly the override `--fork` lacked.
//
// Why every id gets rewritten before import (v2 import 409s with
// ImportConflictError on an existing session id rather than upserting, and
// message ids must not collide with the source session's rows either).
//
// opencode v2 only (minimum 2.0.29): the export is flat
// `{ info, messages: SessionMessage.Info[] }` — see rewriteSessionIds. Every
// call passes `--standalone` so it runs against a private, per-invocation
// server rather than attaching to (or spawning, with Mullion's own env) the
// user's shared background service. v2's HTTP `session.move`/`fork` routes
// are therefore not reachable from here — CLI export/import is the only
// mechanism.
//
// This is explicitly a capability probe, not a guaranteed mechanism. Every
// failure mode degrades to `{ transferred: false }` rather than throwing —
// the caller (routes/sessions.ts's promote handler) MUST treat that as "fall
// back to the ordinary seed prompt (if one was supplied)," never as a
// promote failure.
//
// A successful transfer is resumed with `--session <id>`; v2's TUI now
// auto-submits `--prompt` on a resumed session too, so the caller may pair
// them (see hook-adapters/opencode.ts's `resumeSessionArgs`).

const OPENCODE_TRANSFER_TIMEOUT_MS = 20_000;
// B9 — same escalation shape as git-refs.ts/git-worktree.ts's runGit
// siblings (a SIGTERM grace period before SIGKILL).
const KILL_ESCALATION_MS = 2_000;
// A conversation transcript is unbounded in principle (long sessions,
// attached files) — cap how much of `opencode session export`'s stdout this module
// will buffer in memory, same "don't amplify a runaway output into an OOM"
// posture as scrollback-buffer.ts's own SCROLLBACK_MAX_BYTES, just a more
// generous ceiling since a full transcript is expected to be larger than a
// terminal's scrollback.
const MAX_TRANSFER_STDOUT_BYTES = 20 * 1024 * 1024;
// Kept from each original id's own `<prefix>_<random>` shape — e.g.
// `ses_ff7c7aa42ffeR8htL6o3tdEqhl` keeps `ses_ff7c7aa42ffe` (prefix + first
// 12 chars of the random portion) and gets a fresh random tail. Sampled
// real ids empirically during the spike: the kept portion encodes ordering
// (ascending for messages/parts, descending for sessions — opencode inverts
// session timestamps so newest sorts first), which the
// `(session_id, time_created, id)` index relies on as a tiebreaker. Keeping
// it intact preserves that ordering without needing to reverse-engineer the
// timestamp encoding itself.
const ID_PREFIX_KEEP_CHARS = 12;
const ID_SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function isSafeAbsolutePath(cwd: string): boolean {
  return path.isAbsolute(cwd) && !path.normalize(cwd).split(path.sep).includes("..");
}

// Hermes review, PR #696 — flagged that rewriteSessionIds below only knows
// how to rewrite the specific id fields opencode's export format has today
// (info.id, message info.id/sessionID, part id/messageID/sessionID), and
// suggested nulling/validating any OTHER id-shaped field on the theory that
// a forked session's export might carry a stale `parentID` pointing at the
// source session's lineage. Investigated and REJECTED, not implemented:
//  - Checked empirically against a real forked session's export (opencode
//    1.18.18, `opencode run --session <id> --fork`): no `parentID` field
//    exists in the export payload at all — the concern this would have
//    guarded against doesn't currently occur.
//  - Worse, a blind "any field ending in ID whose value looks like an
//    opencode id" heuristic is actively unsafe: a real tool part carries
//    `callID` (e.g. `"call_b8bc662c5c2e41c5b3157ea6"`, confirmed against a
//    real bash-tool export), which matches that shape but is a
//    same-message tool-call correlation id, NOT a cross-session reference —
//    nulling it would silently corrupt the resumed session's rendering of
//    every past tool call. There is no reliable way to tell "stale
//    cross-session reference" apart from "legitimate same-payload
//    correlation id" without opencode's real schema, which isn't published
//    (this module's whole approach already rests on decompiled/observed
//    behavior — see the header comment). An allowlist-of-known-safe-fields
//    approach has the same problem in reverse: every export sample so far
//    has turned up a new benign id field (`projectID`, now `callID`), so
//    "everything not on the allowlist" is a moving, unverifiable target.
//    Sticking to the exact, verified id fields already handled below is the
//    safer choice.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Truncates a subprocess's stderr for inclusion in a warning/log line —
 * same 300-char cap git-worktree.ts's own createWorktree uses for the
 * identical reason (a raw CLI error can be arbitrarily long). */
function summarizeFailure(label: string, result: OpencodeResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return `${label} (exit ${result.code ?? "timeout"})${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}

// CodeQL js/insecure-randomness — `byte % 62` over a 256-value byte biases
// the low 8 characters of the alphabet (256 % 62 == 8 extra values map to
// them) toward a very slightly higher probability than the rest. Cosmetic
// for an id suffix, not a security boundary, but trivial to do correctly:
// reject any byte at or past the largest multiple of the alphabet length
// that fits in a byte (`maxUnbiased`, 248) instead of taking it mod 62.
const ID_SUFFIX_MAX_UNBIASED_BYTE =
  ID_SUFFIX_ALPHABET.length * Math.floor(256 / ID_SUFFIX_ALPHABET.length);

function randomIdSuffix(length: number): string {
  let out = "";
  while (out.length < length) {
    // Over-request a little so the ~3% rejection rate (8/256) rarely needs
    // a second `randomBytes` call for the lengths this module actually uses.
    const bytes = randomBytes(length - out.length + 4);
    for (const byte of bytes) {
      if (out.length === length) break;
      if (byte >= ID_SUFFIX_MAX_UNBIASED_BYTE) continue;
      out += ID_SUFFIX_ALPHABET[byte % ID_SUFFIX_ALPHABET.length];
    }
  }
  return out;
}

/** Rewrites one opencode id to a fresh one, memoized per-transfer so every
 * reference to the same original id (a session id repeated across several
 * messages' `sessionID`, a message id repeated as several parts'
 * `messageID`) maps to the same new id. See this module's header comment
 * for why every id must change, never just the top-level session id. */
function rewriteId(oldId: string, seen: Map<string, string>): string {
  const cached = seen.get(oldId);
  if (cached) return cached;
  const underscoreIdx = oldId.indexOf("_");
  let rewritten: string;
  if (underscoreIdx === -1) {
    // Never observed in practice (every sampled id had a "type_" prefix),
    // but degrade rather than throw on an unrecognized shape — appending a
    // fresh random suffix still guarantees no collision with the original,
    // even if the ordering-preservation property this function otherwise
    // provides doesn't hold for this one id.
    rewritten = `${oldId}-${randomIdSuffix(8)}`;
  } else {
    const prefix = oldId.slice(0, underscoreIdx + 1);
    const rest = oldId.slice(underscoreIdx + 1);
    const keep = rest.slice(0, ID_PREFIX_KEEP_CHARS);
    const tailLength = Math.max(rest.length - keep.length, 8);
    rewritten = `${prefix}${keep}${randomIdSuffix(tailLength)}`;
  }
  seen.set(oldId, rewritten);
  return rewritten;
}

interface RewriteResult {
  payload: unknown;
  newSessionId: string;
}

/** Rewrites every id in an `opencode session export` payload — the
 * session's own id, plus each message's `id` (and `sessionID` when present)
 * — per this module's header comment. v2's export is flat
 * (`{ info, messages: SessionMessage.Info[] }`, assistant content lives
 * inline in the message), unlike 1.x's per-message `parts` arrays. Pure, no
 * I/O. Returns `null` on any shape this function doesn't recognize (a
 * version-skewed opencode build changed its export format) rather than
 * guessing — the caller treats that identically to any other transfer
 * failure. */
export function rewriteSessionIds(exported: unknown): RewriteResult | null {
  if (!isRecord(exported)) return null;
  const info = exported.info;
  if (!isRecord(info) || typeof info.id !== "string" || info.id.length === 0) return null;
  const messages = exported.messages;
  if (!Array.isArray(messages)) return null;

  const idMap = new Map<string, string>();
  const oldSessionId = info.id;
  const newSessionId = rewriteId(oldSessionId, idMap);
  const newInfo = { ...info, id: newSessionId };

  const newMessages = messages.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return entry;
    const newEntry: Record<string, unknown> = { ...entry, id: rewriteId(entry.id, idMap) };
    if (newEntry.sessionID === oldSessionId) newEntry.sessionID = newSessionId;
    return newEntry;
  });

  return { payload: { info: newInfo, messages: newMessages }, newSessionId };
}

interface OpencodeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `opencode <args>` with `cwd` set, capturing stdout/stderr. Never
 * rejects — a spawn error, timeout, or output-size overrun resolves with
 * `code: null` the same way a non-zero exit does, so the caller can treat
 * every "didn't work" case uniformly. `--standalone` is always the caller's
 * job to pass, not added here (a private server per call, never the shared
 * background service). */
function runOpencode(cwd: string, args: string[]): Promise<OpencodeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let overCap = false;
    // CodeQL's js/path-injection flags `cwd` here since it traces back to
    // request.body — the same "real mitigation, not a CodeQL-recognized
    // sanitizer shape" situation git-worktree.ts's/git-branch-delete.ts's
    // own isSafeAbsolutePath-gated calls already document for this
    // identical query (see e.g. dock-config.ts's readDockConfig). Both
    // `runOpencode` call sites below gate their `cwd` argument through this
    // module's own `isSafeAbsolutePath` in `transferOpencodeSession` before
    // ever reaching here — dismissed in GHAS as a false positive rather than
    // reshaping already-verified-safe code to chase a query that doesn't
    // model manual containment checks as sanitizers (this repo's codeql.yml
    // has no follow-up step to turn an in-line `codeql[...]` suppression
    // annotation into an actual Security-tab dismissal, so the dismissal
    // happens via the API/UI instead — see git-worktree.ts's own note).
    const child = spawnChild("opencode", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    const onStdoutData = (chunk: Buffer) => {
      if (overCap) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_TRANSFER_STDOUT_BYTES) {
        overCap = true;
        child.kill();
      }
    };
    const onStderrData = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const finish = (result: OpencodeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill(); // SIGTERM
      finish({ code: null, stdout, stderr: stderr || "timed out" });
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
    }, OPENCODE_TRANSFER_TIMEOUT_MS);

    child.on("error", (err) => {
      clearKillTimer();
      finish({ code: null, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearKillTimer();
      if (overCap) {
        finish({ code: null, stdout, stderr: stderr || "output exceeded size cap" });
        return;
      }
      finish({ code, stdout, stderr });
    });
  });
}

export interface TransferOpencodeSessionResult {
  transferred: boolean;
  /** Set only when `transferred` is true — the rewritten id the new
   * worktree session now exists under. */
  newSessionId?: string;
  /** Set only when `transferred` is false — a short, log/warning-safe
   * reason (never the full raw CLI output). */
  reason?: string;
}

/**
 * Attempts to carry `agentSessionId`'s full opencode conversation history
 * from `sourceCwd` into a brand-new session under `targetCwd` (the
 * promoted-to worktree). See this module's header comment for the mechanism
 * and its two prerequisites (fresh ids, `--standalone` on both legs). Always
 * resolves — never throws — with `{ transferred: false, reason }` on any
 * failure: export non-zero, unparseable/unrecognized JSON, or import
 * non-zero. The caller MUST fall back to the ordinary seed-only promote path
 * on `transferred: false`, per this module's own "capability probe, not a
 * guarantee" framing.
 */
export async function transferOpencodeSession(opts: {
  sourceCwd: string;
  agentSessionId: string;
  targetCwd: string;
}): Promise<TransferOpencodeSessionResult> {
  const { sourceCwd, agentSessionId, targetCwd } = opts;
  if (!isSafeAbsolutePath(sourceCwd) || !isSafeAbsolutePath(targetCwd)) {
    return { transferred: false, reason: "sourceCwd/targetCwd must be absolute paths" };
  }
  if (agentSessionId.length === 0 || agentSessionId.startsWith("-")) {
    // Same argv-injection hardening as git-worktree.ts's baseRef guard —
    // agentSessionId reaches here from a hook-reported value, not
    // user-typed, but it's still untrusted input landing in a subprocess's
    // argv.
    return { transferred: false, reason: "invalid agentSessionId" };
  }

  // Hermes review, PR #696 suggested `--sanitize` here (docs: "redact
  // sensitive transcript and file data") to protect the temp file below
  // against pasted secrets. Tested empirically against the real 1.18.18
  // binary before adding it — REJECTED: `--sanitize` doesn't selectively
  // scrub secret-shaped strings, it wholesale-replaces every message part's
  // `text` with a `[redacted:text:<id>]` placeholder (confirmed against a
  // real forked session's export). Using it here would silently defeat the
  // entire point of this module — the "transferred" session would carry
  // over zero real conversation content, indistinguishable at a glance from
  // a successful transfer. The 0600 mkdtemp temp file + unlink-in-`finally`
  // below is the actual mitigation for this payload sitting on disk
  // briefly; do not add `--sanitize` without re-verifying this against
  // whatever opencode version is installed at the time.
  const exportResult = await runOpencode(sourceCwd, [
    "session",
    "export",
    agentSessionId,
    "--standalone",
  ]);
  if (exportResult.code !== 0 || exportResult.stdout.trim().length === 0) {
    return {
      transferred: false,
      reason: summarizeFailure("opencode session export failed", exportResult),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(exportResult.stdout);
  } catch {
    return { transferred: false, reason: "opencode session export produced unparseable JSON" };
  }

  const rewritten = rewriteSessionIds(parsed);
  if (!rewritten) {
    return {
      transferred: false,
      reason: "opencode session export payload had an unrecognized shape",
    };
  }

  // Written to a fresh, 0700 (mkdtemp's own default) temp directory rather
  // than sourceCwd/targetCwd — this is an unsanitized full transcript on
  // disk, however briefly, and neither of those directories is a place this
  // module should be leaving new files lying around regardless. Deleted in
  // `finally` so a crash mid-import doesn't leak it.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mullion-opencode-transfer-"));
  const tempFile = path.join(tempDir, "session.json");
  try {
    await fs.writeFile(tempFile, JSON.stringify(rewritten.payload), { mode: 0o600 });
    // v2's `session import --directory` re-keys the imported session's
    // location to the worktree (it also defaults to the process cwd, which
    // `runOpencode` sets to `targetCwd` too). `--standalone` keeps this a
    // private, per-invocation server instead of attaching to (or spawning)
    // the user's shared background service with Mullion's own env.
    const importResult = await runOpencode(targetCwd, [
      "session",
      "import",
      tempFile,
      "--directory",
      targetCwd,
      "--standalone",
    ]);
    if (importResult.code !== 0) {
      return {
        transferred: false,
        reason: summarizeFailure("opencode session import failed", importResult),
      };
    }
    return { transferred: true, newSessionId: rewritten.newSessionId };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
