// Server-owned "wait until a child prints X" (issue #1625). The sibling of
// session-wait.ts: that one waits on DERIVED STATUS; this one waits on PTY
// OUTPUT. Pure — no Fastify/PtyManager imports — so it is unit-testable with
// fake deps, like waitForSession.
import safeRegex from "safe-regex2";
import { stripTerminalEscapes } from "./terminal-text.js";

/** Longest `match` accepted, literal or regex. */
export const MAX_MATCH_LENGTH = 256;
/** Matching only ever looks at this much trailing ANSI-stripped text, so the
 * cost of one test is bounded however much the child prints. Best-effort
 * under a flood: >64 KiB of output inside one debounce can scroll a match out
 * of the raw window, and ANSI-heavy output strips to far fewer chars. */
export const OUTPUT_WINDOW_CHARS = 16 * 1024;
/** Raw bytes kept to rebuild the window (escape sequences inflate raw output). */
const RAW_WINDOW_BYTES = 64 * 1024;
/** Matches are evaluated at most this often while output streams in. */
const CHECK_DEBOUNCE_MS = 100;
/** `alive` is polled this often, so a child that exits mid-wait is noticed. */
const ALIVE_TICK_MS = 1000;

export type OutputMatcher =
  | { ok: true; find: (text: string) => { text: string; index: number } | null }
  | {
      ok: false;
      error: string;
    };

// Backreferences and lookarounds are rejected outright: safe-regex2 reasons
// about star height only, and these are the other classic ways to make a
// backtracking engine blow up.
const FORBIDDEN_REGEX_FEATURES = /\\[1-9]|\\k<|\(\?<?[=!]/;

/**
 * Compiles the caller's `match`. Literal substring by default. With `regex`,
 * the pattern must be short, free of backreferences/lookarounds, and have
 * star height <= 1 (safe-regex2) — Node regexes have no timeout, so anything
 * else could block the whole server's event loop (#1653 tracks a worker-based
 * alternative).
 */
export function compileOutputMatcher(match: unknown, regex: unknown): OutputMatcher {
  if (typeof match !== "string" || match.length === 0) {
    return { ok: false, error: "'match' is required" };
  }
  if (match.length > MAX_MATCH_LENGTH) {
    return { ok: false, error: `'match' exceeds ${MAX_MATCH_LENGTH} characters` };
  }
  if (regex !== undefined && typeof regex !== "boolean") {
    return { ok: false, error: "'regex' must be a boolean" };
  }
  if (regex !== true) {
    return {
      ok: true,
      find: (text) => {
        const index = text.indexOf(match);
        return index === -1 ? null : { text: match, index };
      },
    };
  }
  if (FORBIDDEN_REGEX_FEATURES.test(match)) {
    return { ok: false, error: "'match' may not use backreferences or lookarounds" };
  }
  // The pattern is caller-supplied BY DESIGN (the whole feature is "wait until
  // the child prints <pattern>"), and since #1951 it can arrive over an agent's
  // /internal/sessions/:id/wait-output as well as the control socket. The
  // containment is the guards above and below — length cap, no
  // backreferences/lookarounds, star height <= 1 (safe-regex2) — plus the
  // matching window being bounded to the last 16 KiB. CodeQL's
  // js/regex-injection only models escaping as a sanitizer, so the alert is
  // dismissed in GHAS with this argument (this repo's CodeQL workflow has no
  // step that turns an inline `codeql[...]` annotation into a dismissal).
  let re: RegExp;
  try {
    re = new RegExp(match, "m");
  } catch (err) {
    return { ok: false, error: `invalid regex: ${err instanceof Error ? err.message : err}` };
  }
  if (re.test("")) {
    return { ok: false, error: "'match' must not match the empty string" };
  }
  if (!safeRegex(re)) {
    return { ok: false, error: "'match' is too complex (nested quantifiers are not allowed)" };
  }
  return {
    ok: true,
    find: (text) => {
      const m = re.exec(text);
      return m ? { text: m[0], index: m.index } : null;
    },
  };
}

export interface OutputWaitDeps {
  /** Subscribes to the child's raw PTY output; returns the unsubscribe. */
  onData(listener: (chunk: Buffer) => void): () => void;
  /** Output already printed that should count (the prompt → wait gap). */
  seed?: Buffer;
  /** Whether the child's process is still running. */
  alive(): boolean;
  signal?: AbortSignal;
}

export type OutputWaitResult =
  | { matched: true; text: string; line: string }
  | { matched: false; timedOut: true }
  | { matched: false; gone: true }
  | { aborted: true };

export function waitForOutput(
  matcher: Extract<OutputMatcher, { ok: true }>,
  timeoutMs: number,
  deps: OutputWaitDeps,
): Promise<OutputWaitResult> {
  return new Promise<OutputWaitResult>((resolve) => {
    let settled = false;
    let raw = deps.seed ? deps.seed.subarray(-RAW_WINDOW_BYTES) : Buffer.alloc(0);
    let checkTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (result: OutputWaitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(aliveTick);
      if (checkTimer) clearTimeout(checkTimer);
      unsubscribe();
      deps.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const check = (): void => {
      checkTimer = null;
      if (settled) return;
      const text = stripTerminalEscapes(raw.toString("utf8")).slice(-OUTPUT_WINDOW_CHARS);
      const found = matcher.find(text);
      if (found === null) return;
      const at = found.index;
      const lineStart = text.lastIndexOf("\n", at) + 1;
      const lineEnd = text.indexOf("\n", at + found.text.length);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).replace(/\r/g, "");
      settle({ matched: true, text: found.text, line });
    };

    const onAbort = (): void => settle({ aborted: true });
    const timeout = setTimeout(() => settle({ matched: false, timedOut: true }), timeoutMs);
    const aliveTick = setInterval(() => {
      if (!deps.alive()) {
        // One last look: the final bytes may have landed with the exit.
        check();
        settle({ matched: false, gone: true });
      }
    }, ALIVE_TICK_MS);
    const unsubscribe = deps.onData((chunk) => {
      raw = Buffer.concat([raw, chunk]);
      if (raw.length > RAW_WINDOW_BYTES) raw = raw.subarray(raw.length - RAW_WINDOW_BYTES);
      if (!checkTimer) checkTimer = setTimeout(check, CHECK_DEBOUNCE_MS);
    });

    if (deps.signal?.aborted) {
      onAbort();
      return;
    }
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    // Output that was already there when the wait began.
    if (raw.length > 0) check();
  });
}
