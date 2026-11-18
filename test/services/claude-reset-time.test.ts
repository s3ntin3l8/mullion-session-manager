import { describe, expect, it } from "vitest";
import { parseClaudeCodeResetTime } from "../../src/services/claude-reset-time.js";

// Captured live against Claude Code 2.1.326 on 2026-11-18T16:37:58Z with the
// 5-hour usage limit exhausted (issue #3265). The session transcript recorded
// `resetsAt: 1795023000` (2026-11-18T17:30:00.000Z = 6:30pm Europe/Berlin).
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

describe("parseClaudeCodeResetTime", () => {
  it("parses the verbatim captured StopFailure payload to the exact resetsAt instant", () => {
    const now = new Date("2026-11-18T16:37:58.000Z");
    const parsed = parseClaudeCodeResetTime(CAPTURED_STOP_FAILURE, now);
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe("2026-11-18T17:30:00.000Z");
    expect(parsed!.getTime()).toBe(1795023000 * 1000);
  });

  it("rolls a time-only reset forward to the next day when already past today", () => {
    // 22:00 Europe/Berlin (21:00Z in winter) -> "resets 1:30am (Europe/Berlin)" is next day 00:30Z
    const now = new Date("2026-11-30T21:00:00.000Z");
    const parsed = parseClaudeCodeResetTime(
      "You've hit your 5-hour limit · resets 1:30am (Europe/Berlin)",
      now,
    );
    expect(parsed?.toISOString()).toBe("2026-12-01T00:30:00.000Z");
  });

  it("parses on-the-hour times without minutes, 12am/12pm, and 24-hour times", () => {
    const now = new Date("2026-11-18T05:00:00.000Z");
    expect(parseClaudeCodeResetTime("resets 6pm (UTC)", now)?.toISOString()).toBe(
      "2026-11-18T18:00:00.000Z",
    );
    expect(parseClaudeCodeResetTime("resets 12pm (UTC)", now)?.toISOString()).toBe(
      "2026-11-18T12:00:00.000Z",
    );
    expect(parseClaudeCodeResetTime("resets 12am (UTC)", now)?.toISOString()).toBe(
      "2026-11-19T00:00:00.000Z",
    );
    expect(parseClaudeCodeResetTime("resets 18:30 (UTC)", now)?.toISOString()).toBe(
      "2026-11-18T18:30:00.000Z",
    );
  });

  it("parses a dated weekly reset with or without an explicit year", () => {
    const now = new Date("2026-11-18T16:00:00.000Z");
    expect(
      parseClaudeCodeResetTime(
        "You've hit your weekly limit · resets Nov 20, 6:30pm (Europe/Berlin)",
        now,
      )?.toISOString(),
    ).toBe("2026-11-20T17:30:00.000Z");

    expect(parseClaudeCodeResetTime("resets Nov 20, 2026 at 6pm (UTC)", now)?.toISOString()).toBe(
      "2026-11-20T18:00:00.000Z",
    );
  });

  it("handles year rollover on dated resets without an explicit year", () => {
    const now = new Date("2026-12-30T10:00:00.000Z");
    expect(parseClaudeCodeResetTime("resets Jan 2, 9am (UTC)", now)?.toISOString()).toBe(
      "2027-01-02T09:00:00.000Z",
    );
  });

  it("falls back to local time when no timezone is present", () => {
    const now = new Date(2026, 10, 18, 10, 0, 0, 0);
    const parsed = parseClaudeCodeResetTime("resets 6:30pm", now);
    expect(parsed).not.toBeNull();
    expect(parsed!.getFullYear()).toBe(2026);
    expect(parsed!.getMonth()).toBe(10);
    expect(parsed!.getDate()).toBe(18);
    expect(parsed!.getHours()).toBe(18);
    expect(parsed!.getMinutes()).toBe(30);
  });

  it("returns null for missing reset text, invalid timezones, invalid dates, or past dated resets", () => {
    const now = new Date("2026-11-18T16:37:58.000Z");
    expect(parseClaudeCodeResetTime(null, now)).toBeNull();
    expect(parseClaudeCodeResetTime({}, now)).toBeNull();
    expect(parseClaudeCodeResetTime({ error: "rate_limit" }, now)).toBeNull();
    expect(parseClaudeCodeResetTime("resets 6:30pm (Mars/Olympus)", now)).toBeNull();
    expect(parseClaudeCodeResetTime("resets Feb 31, 6:30pm (UTC)", now)).toBeNull();
    expect(parseClaudeCodeResetTime("resets Nov 18, 2026, 4:00pm (UTC)", now)).toBeNull();
    expect(parseClaudeCodeResetTime("resets later", now)).toBeNull();
  });
});
