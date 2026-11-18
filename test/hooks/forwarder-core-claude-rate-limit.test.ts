import { describe, expect, it } from "vitest";
import { mapClaudeCodeEvent, mapClaudeCodeStopFailure } from "../../src/hooks/forwarder-core.mjs";

// Captured live from Claude Code 2.1.326 with the 5-hour quota exhausted
// (issue #3265): `error` carries `"rate_limit"` and the reset message is in
// `last_assistant_message` (neither `error_type` nor `error_details`).
const CAPTURED_STOP_FAILURE = {
  session_id: "a0ce1358-876e-4739-8237-ca52f8b02bdf",
  transcript_path:
    "/tmp/claude-spike/config/projects/-tmp-claude-spike-workdir/a0ce1358-876e-4739-8237-ca52f8b02bdf.jsonl",
  cwd: "/tmp/claude-spike/workdir",
  prompt_id: "d9776663-1538-4f6f-b058-b8e23eca9c64",
  effort: { level: "medium" },
  hook_event_name: "StopFailure",
  error: "rate_limit",
  last_assistant_message: "You've hit your 5-hour limit · resets 6:30pm (Europe/Berlin)",
};

describe("StopFailure on a rate-limited turn, as Claude Code really sends it (issue #3265)", () => {
  it("classifies the captured StopFailure payload as errorType: rate_limit with errorDetails", () => {
    expect(mapClaudeCodeEvent("StopFailure", CAPTURED_STOP_FAILURE)).toContainEqual({
      kind: "stop_failure",
      error: "rate_limit",
      errorDetails: "You've hit your 5-hour limit · resets 6:30pm (Europe/Berlin)",
      errorType: "rate_limit",
    });
  });

  it("does not loosely classify non-rate-limit errors that happen to mention quota or limit", () => {
    expect(
      mapClaudeCodeStopFailure({
        error: "invalid_request",
        last_assistant_message: "Context limit exceeded",
      }),
    ).toEqual({
      kind: "stop_failure",
      error: "invalid_request",
      errorDetails: "Context limit exceeded",
    });
  });

  it("extracts error, errorDetails, and errorType across StopFailure payload variants", () => {
    expect(
      mapClaudeCodeStopFailure({ error: "rate_limit", error_details: "429 Too Many Requests" }),
    ).toEqual({
      kind: "stop_failure",
      error: "rate_limit",
      errorDetails: "429 Too Many Requests",
      errorType: "rate_limit",
    });
    expect(mapClaudeCodeStopFailure({ error: "max_output_tokens" })).toEqual({
      kind: "stop_failure",
      error: "max_output_tokens",
    });
    expect(mapClaudeCodeStopFailure({})).toEqual({ kind: "stop_failure", error: "unknown" });
    expect(
      mapClaudeCodeStopFailure({
        error: "429",
        error_details: "429 Too Many Requests",
        error_type: "rate_limit",
      }),
    ).toEqual({
      kind: "stop_failure",
      error: "429",
      errorDetails: "429 Too Many Requests",
      errorType: "rate_limit",
    });
  });
});
