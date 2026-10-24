// Issue #1734 — a Codex provider rate limit has to reach Task Master's
// rate-limit grace window.
//
// The problem this suite pins down is not "can we classify 429" — it is
// "where does the signal come from at all". Codex's hook payload schemas are
// `additionalProperties: false` and NOT ONE of them carries an error, status
// or usage field, and codex does not fire `Stop` for a turn that failed. The
// signal lives in the session's rollout file, as a machine-readable
// `codex_error_info`, and this suite drives that file the way the real thing
// writes it.
//
// The fixture text below is the shape a real codex-cli 0.164.0 rollout
// writes, captured from a live session whose API answered 429 (see the PR
// body for the spike's raw output).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCodexRateLimitSignal,
  readCodexRateLimitSignal,
} from "../../src/hooks/codex-rollout.mjs";
import { buildForwarderMessage } from "../../src/hooks/forwarder-core.mjs";

/** A rollout line: the outer envelope codex writes around every event. */
function rolloutLine(payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-10-24T08:45:21.000Z",
    ordinal: 42,
    type: "event_msg",
    payload,
  });
}

/** The exact `task_complete` codex writes when a turn fails on a 429. */
const RATE_LIMITED_TASK_COMPLETE = rolloutLine({
  type: "task_complete",
  root_turn_id: "01a16ca8-2666-79f1-9f91-c026a979190e",
  turn_id: "01a16ca8-2666-79f1-9f91-c026a979190e",
  last_agent_message: null,
  error: {
    message: "exceeded retry limit, last status: 429 Too Many Requests",
    codex_error_info: {
      response_too_many_failed_attempts: { http_status_code: 429 },
    },
  },
  started_at: 1792791556,
  completed_at: 1792791556,
  duration_ms: 130,
});

/** A turn that completed cleanly. */
const CLEAN_TASK_COMPLETE = rolloutLine({
  type: "task_complete",
  root_turn_id: "01a16ca8-2666-79f1-9f91-c026a979190e",
  turn_id: "01a16ca8-2666-79f1-9f91-c026a979190e",
  last_agent_message: "done",
  started_at: 1792791556,
  completed_at: 1792791560,
  duration_ms: 4000,
});

describe("parseCodexRateLimitSignal", () => {
  it("reports a rate limit for the 429 codex actually recorded", () => {
    const signal = parseCodexRateLimitSignal(RATE_LIMITED_TASK_COMPLETE);
    expect(signal).not.toBeNull();
    expect(signal!.rateLimited).toBe(true);
    expect(signal!.status).toBe(429);
    expect(signal!.variant).toBe("response_too_many_failed_attempts");
    expect(signal!.message).toContain("429");
    expect(signal!.turnId).toBe("01a16ca8-2666-79f1-9f91-c026a979190e");
  });

  it("reports a rate limit for codex's own rate_limit_exceeded variant", () => {
    const signal = parseCodexRateLimitSignal(
      rolloutLine({
        type: "task_complete",
        turn_id: "turn-1",
        error: { message: "rate limit reached", codex_error_info: { rate_limit_exceeded: {} } },
      }),
    );
    expect(signal!.rateLimited).toBe(true);
    expect(signal!.variant).toBe("rate_limit_exceeded");
  });

  it("reports a rate limit for codex's own usage_limit_exceeded variant", () => {
    const signal = parseCodexRateLimitSignal(
      rolloutLine({
        type: "task_complete",
        turn_id: "turn-1",
        error: { message: "usage limit reached", codex_error_info: { usage_limit_exceeded: {} } },
      }),
    );
    expect(signal!.rateLimited).toBe(true);
  });

  it("does NOT report a rate limit for an ordinary server error", () => {
    // The false positive this guards is the expensive one: a task parked in
    // a rate-limit grace window for minutes on a failure that will not
    // recover.
    const signal = parseCodexRateLimitSignal(
      rolloutLine({
        type: "task_complete",
        turn_id: "turn-1",
        error: {
          message: "internal server error",
          codex_error_info: { internal_server_error: { http_status_code: 500 } },
        },
      }),
    );
    expect(signal!.rateLimited).toBe(false);
    expect(signal!.status).toBe(500);
  });

  it("does NOT report a rate limit for server_overloaded", () => {
    const signal = parseCodexRateLimitSignal(
      rolloutLine({
        type: "task_complete",
        turn_id: "turn-1",
        error: {
          message: "server overloaded",
          codex_error_info: { server_overloaded: { http_status_code: 529 } },
        },
      }),
    );
    expect(signal!.rateLimited).toBe(false);
  });

  it("does NOT report a rate limit when the same variant carries a non-429 status", () => {
    // `response_too_many_failed_attempts` with a 500 is a server failure, not
    // a quota failure.
    const signal = parseCodexRateLimitSignal(
      rolloutLine({
        type: "task_complete",
        turn_id: "turn-1",
        error: {
          message: "too many failed attempts",
          codex_error_info: { response_too_many_failed_attempts: { http_status_code: 500 } },
        },
      }),
    );
    expect(signal!.rateLimited).toBe(false);
  });

  it("reports a clean turn as not rate limited", () => {
    const signal = parseCodexRateLimitSignal(CLEAN_TASK_COMPLETE);
    expect(signal).not.toBeNull();
    expect(signal!.rateLimited).toBe(false);
    expect(signal!.message).toBeNull();
  });

  it("uses the LAST completed turn, not the first", () => {
    // The rollout keeps every turn. A session that failed once and then
    // succeeded must not stay rate limited.
    const failed = rolloutLine({
      type: "task_complete",
      turn_id: "turn-failed",
      error: {
        message: "429 Too Many Requests",
        codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } },
      },
    });
    const signal = parseCodexRateLimitSignal([failed, CLEAN_TASK_COMPLETE].join("\n"));
    expect(signal!.rateLimited).toBe(false);
    expect(signal!.turnId).toBe("01a16ca8-2666-79f1-9f91-c026a979190e");
  });

  it("skips a partial first line from a tail read", () => {
    // The tail of a rollout can begin mid-line; a partial line must not
    // abort the parse of the lines after it.
    const partial = '{"timestamp":"2026-10-24T08:45:20.000Z","type":"event_msg","pay';
    const signal = parseCodexRateLimitSignal([partial, RATE_LIMITED_TASK_COMPLETE].join("\n"));
    expect(signal!.rateLimited).toBe(true);
  });

  it("returns null for text with no completed turn", () => {
    expect(parseCodexRateLimitSignal("")).toBeNull();
    expect(parseCodexRateLimitSignal("not json at all")).toBeNull();
    expect(
      parseCodexRateLimitSignal(
        rolloutLine({ type: "task_started", turn_attribution: { turn_trigger: "user" } }),
      ),
    ).toBeNull();
  });
});

describe("readCodexRateLimitSignal", () => {
  function writeRollout(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "codex-rollout-test-"));
    const path = join(dir, "rollout-2026-10-24T08-45-21-abc.jsonl");
    writeFileSync(path, contents);
    return path;
  }

  it("reads a real file and finds the rate limit", () => {
    const path = writeRollout([RATE_LIMITED_TASK_COMPLETE, ""].join("\n"));
    const signal = readCodexRateLimitSignal(path);
    expect(signal!.rateLimited).toBe(true);
    expect(signal!.status).toBe(429);
  });

  it("returns null for a missing file rather than throwing", () => {
    expect(readCodexRateLimitSignal(join(tmpdir(), "definitely-not-here-1734.jsonl"))).toBeNull();
  });

  it("returns null for an empty file", () => {
    const path = writeRollout("");
    expect(readCodexRateLimitSignal(path)).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(readCodexRateLimitSignal("")).toBeNull();
  });
});

describe("the codex SessionStart hook carries the rollout path", () => {
  it("passes transcript_path through as transcriptPath", () => {
    // Issue #1734 — this path is the ONLY way the backend can reach the
    // rollout file, which is the only place a codex rate limit is visible.
    const message = buildForwarderMessage("codex", "SessionStart", {
      session_id: "01a16ca8-2666-79f1-9f91-c026a979190e",
      transcript_path: "/home/u/.codex/sessions/2026/10/24/rollout-x.jsonl",
      cwd: "/tmp/p",
      hook_event_name: "SessionStart",
      model: "gpt-6-luna",
      permission_mode: "bypassPermissions",
      source: "startup",
    });
    expect(message).toEqual({
      kind: "session_start",
      source: "startup",
      transcriptPath: "/home/u/.codex/sessions/2026/10/24/rollout-x.jsonl",
    });
  });

  it("omits transcriptPath when codex did not send one", () => {
    const message = buildForwarderMessage("codex", "SessionStart", {
      hook_event_name: "SessionStart",
      source: "startup",
    });
    expect(message).toEqual({ kind: "session_start", source: "startup" });
    expect(Object.hasOwn(message as object, "transcriptPath")).toBe(false);
  });

  it("does not add a transcriptPath to any other CLI's session_start", () => {
    const message = buildForwarderMessage("claude-code", "SessionStart", {
      hook_event_name: "SessionStart",
      source: "startup",
    });
    expect(Object.hasOwn(message as object, "transcriptPath")).toBe(false);
  });
});
