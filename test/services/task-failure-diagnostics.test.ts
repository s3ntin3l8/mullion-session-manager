import { describe, it, expect } from "vitest";
import {
  FAILURE_DIAGNOSTICS_COMMENT_MAX_CHARS,
  FAILURE_DIAGNOSTICS_MAX_CHARS,
  capDiagnostics,
  formatFailureDiagnostics,
  sanitizeDiagnosticText,
  trimDiagnosticsForComment,
} from "../../src/services/task-failure-diagnostics.js";
import type { tasks } from "../../src/db/schema.js";

const task = {
  agentCommand: "agy",
  agent: null,
  model: "gemini-3.8-flash-medium",
  claimedAt: new Date(0),
} as typeof tasks.$inferSelect;

describe("task failure diagnostics", () => {
  it("strips ANSI and secrets", () => {
    const out = sanitizeDiagnosticText(
      "\u001b[1mhi\u001b[0m ghp_abcdefghijklmnopqrstuvwx Bearer abc.def",
    );
    expect(out).toBe("hi [redacted] [redacted]");
  });

  it("renders every piece, including unavailable ones", () => {
    const text = formatFailureDiagnostics(
      task,
      { scrollback: null, events: [], gitStatus: null, salvage: null },
      new Date(20 * 60_000),
    );
    expect(text).toContain("Agent: agy");
    expect(text).toContain("Model: gemini-3.8-flash-medium");
    expect(text).toContain("Runtime: 20 min");
    expect(text).toContain("Git status: unavailable");
    expect(text).toContain("Salvage commit: not attempted");
    expect(text).toContain("Session events: none recorded");
    expect(text).toContain("Terminal tail: unavailable");
  });

  it("caps the stored text", () => {
    const text = formatFailureDiagnostics(
      task,
      {
        scrollback: "x".repeat(50_000),
        events: null,
        gitStatus: { files: [] },
        salvage: "nothing to commit",
      },
      new Date(60_000),
    );
    expect(text.length).toBeLessThanOrEqual(FAILURE_DIAGNOSTICS_MAX_CHARS);
    expect(capDiagnostics("abc", 10)).toBe("abc");
  });

  it("trims the issue-comment copy and cannot close its own code fence", () => {
    const comment = trimDiagnosticsForComment("```\n" + "y".repeat(10_000));
    expect(comment.length).toBeLessThan(FAILURE_DIAGNOSTICS_COMMENT_MAX_CHARS + 200);
    expect(comment.match(/```/g)).toHaveLength(2);
  });
});
