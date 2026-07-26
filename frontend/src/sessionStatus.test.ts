import { describe, it, expect } from "vitest";
import {
  formatStatusLabel,
  rowClassNameForSeverity,
  STATUS_PRESENTATION,
} from "./sessionStatus.js";
import type { SessionSeverity, SessionStatus } from "./api.js";

const ALL_STATUSES = Object.keys(STATUS_PRESENTATION) as SessionStatus[];

describe("STATUS_PRESENTATION", () => {
  it("gives every status a non-empty label, tone, and colorToken", () => {
    for (const status of ALL_STATUSES) {
      const presentation = STATUS_PRESENTATION[status];
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.tone.length).toBeGreaterThan(0);
      expect(presentation.colorToken.startsWith("--")).toBe(true);
    }
  });

  it("defaults `finished` to notify OFF (highest-frequency notifiable status)", () => {
    expect(STATUS_PRESENTATION.finished.defaultNotify).toBe(false);
  });

  it("defaults every blocked/failed/waiting status to notify ON", () => {
    const shouldNotify: SessionStatus[] = [
      "api_error",
      "tool_failure",
      "awaiting_permission",
      "awaiting_plan",
      "awaiting_review_gate",
      "awaiting_promote",
      "awaiting_elicitation",
      "needs_input",
    ];
    for (const status of shouldNotify) {
      expect(STATUS_PRESENTATION[status].defaultNotify).toBe(true);
    }
  });

  it("groups every 'blocked'-tier status under the same tone (permission), distinguished only by label", () => {
    const blockedStatuses: SessionStatus[] = [
      "awaiting_permission",
      "awaiting_review_gate",
      "awaiting_promote",
      "awaiting_elicitation",
    ];
    const tones = new Set(blockedStatuses.map((s) => STATUS_PRESENTATION[s].tone));
    expect(tones).toEqual(new Set(["permission"]));
    const labels = new Set(blockedStatuses.map((s) => STATUS_PRESENTATION[s].label));
    expect(labels.size).toBe(blockedStatuses.length);
  });
});

describe("formatStatusLabel", () => {
  it("appends the detail when showDetail is true and a detail is present", () => {
    expect(formatStatusLabel(STATUS_PRESENTATION.exited, "clear")).toBe("exited: clear");
  });

  it("omits the detail when showDetail is true but detail is null", () => {
    expect(formatStatusLabel(STATUS_PRESENTATION.exited, null)).toBe("exited");
  });

  it("omits the detail when showDetail is false, even if a detail is present", () => {
    // needs_input's detail is a raw attention-signal-kind string ("bell",
    // "silence", ...) — not something to show verbatim (see
    // STATUS_PRESENTATION.needs_input's own doc comment).
    expect(formatStatusLabel(STATUS_PRESENTATION.needs_input, "bell")).toBe("Needs input");
  });

  it("shows a subagent count as the detail", () => {
    expect(formatStatusLabel(STATUS_PRESENTATION.subagent, "2 running")).toBe(
      "Subagent: 2 running",
    );
  });
});

describe("rowClassNameForSeverity", () => {
  it.each([
    ["gone", "status-exited"],
    ["failed", "status-attention"],
    ["blocked", "status-attention"],
    ["done", "status-finished"],
    ["waiting", "status-attention"],
    ["busy", ""],
    ["dormant", ""],
  ] as const)("%s -> %s", (severity: SessionSeverity, expected) => {
    expect(rowClassNameForSeverity(severity)).toBe(expected);
  });
});
