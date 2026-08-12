import { describe, it, expect } from "vitest";
import {
  formatStatusLabel,
  isStatusReachable,
  rowClassNameForSeverity,
  STATUS_PRESENTATION,
} from "./sessionStatus.js";
import type { SessionSeverity, SessionStatus } from "./api/index.js";

const ALL_STATUSES = Object.keys(STATUS_PRESENTATION) as SessionStatus[];

// Known emits from src/services/hook-adapters/ — mirrors
// HOOK_ADAPTER_EMITS_BY_BIN in agent-detect.ts so these tests verify
// real backend capabilities, not aspirational ones.
const BASH_EMITS: string[] = [];
const CLAUDE_CODE_EMITS = [
  "notification",
  "progress",
  "file_change",
  "session_start",
  "cwd_changed",
  "permission_request",
  "tool_done",
  "stop_failure",
  "tool_failure",
  "session_end",
  "plan_ready",
  "git_branch",
  "turn_start",
  "compact",
  "subagent",
  "permission_resolved",
  "elicitation",
  "promote_request",
] as const satisfies readonly string[];
const OPENCODE_EMITS = [
  "progress",
  "file_change",
  "turn_start",
  "permission_request",
  "permission_resolved",
  "tool_failure",
  "notification",
  "git_branch",
  "cwd_changed",
  "promote_request",
  "compact",
  "subagent",
  "question",
  "todo",
  "session_diff",
] as const satisfies readonly string[];
const CODEX_EMITS = [
  "progress",
  "session_start",
  "session_end",
  "permission_request",
  "turn_start",
  "file_change",
  "git_branch",
  "cwd_changed",
] as const satisfies readonly string[];

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
      "awaiting_question",
      "awaiting_elicitation",
      "needs_input",
    ];
    for (const status of shouldNotify) {
      expect(STATUS_PRESENTATION[status].defaultNotify).toBe(true);
    }
    // Guard against this list going stale the way it did for
    // awaiting_question (#550 → #554): a newly-added status with
    // defaultNotify true and no entry here now fails, instead of silently
    // going untested.
    expect(new Set(ALL_STATUSES.filter((s) => STATUS_PRESENTATION[s].defaultNotify))).toEqual(
      new Set(shouldNotify),
    );
  });

  it("groups every 'blocked'-tier status under the same tone (permission), distinguished only by label", () => {
    const blockedStatuses: SessionStatus[] = [
      "awaiting_permission",
      "awaiting_review_gate",
      "awaiting_promote",
      "awaiting_question",
      "awaiting_elicitation",
    ];
    const tones = new Set(blockedStatuses.map((s) => STATUS_PRESENTATION[s].tone));
    expect(tones).toEqual(new Set(["permission"]));
    const labels = new Set(blockedStatuses.map((s) => STATUS_PRESENTATION[s].label));
    expect(labels.size).toBe(blockedStatuses.length);
    // Guard against this list going stale (see the shouldNotify guard above
    // for the same reasoning): every status with tone "permission" must be
    // listed here.
    expect(
      new Set(ALL_STATUSES.filter((s) => STATUS_PRESENTATION[s].tone === "permission")),
    ).toEqual(new Set(blockedStatuses));
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

describe("isStatusReachable", () => {
  it("returns true for basic statuses (no emits required) regardless of agent capabilities", () => {
    const basic: SessionStatus[] = ["exited", "needs_input", "working", "idle"];
    for (const status of basic) {
      expect(isStatusReachable(status, [])).toBe(true);
      expect(isStatusReachable(status, ["progress"])).toBe(true);
      expect(isStatusReachable(status, CLAUDE_CODE_EMITS)).toBe(true);
    }
  });

  it("returns false when a required emit is absent", () => {
    expect(isStatusReachable("api_error", [])).toBe(false);
    expect(isStatusReachable("tool_failure", [])).toBe(false);
    expect(isStatusReachable("awaiting_permission", [])).toBe(false);
    expect(isStatusReachable("awaiting_plan", [])).toBe(false);
    expect(isStatusReachable("awaiting_promote", [])).toBe(false);
    expect(isStatusReachable("awaiting_elicitation", [])).toBe(false);
    expect(isStatusReachable("finished", [])).toBe(false);
    expect(isStatusReachable("compacting", [])).toBe(false);
    expect(isStatusReachable("subagent", [])).toBe(false);
  });

  it("returns true when ALL required emits are present", () => {
    expect(isStatusReachable("api_error", ["stop_failure"])).toBe(true);
    expect(isStatusReachable("tool_failure", ["tool_failure"])).toBe(true);
    expect(isStatusReachable("awaiting_permission", ["permission_request"])).toBe(true);
    expect(isStatusReachable("awaiting_plan", ["plan_ready"])).toBe(true);
    expect(isStatusReachable("awaiting_promote", ["promote_request"])).toBe(true);
    expect(isStatusReachable("awaiting_elicitation", ["elicitation"])).toBe(true);
    expect(isStatusReachable("finished", ["progress"])).toBe(true);
    expect(isStatusReachable("compacting", ["compact"])).toBe(true);
    expect(isStatusReachable("subagent", ["subagent"])).toBe(true);
  });

  it("bash (empty emits) — only basic + Mullion-driven statuses reachable", () => {
    // awaiting_review_gate is Mullion-driven (blocking PreToolUse gate),
    // not agent-hook-driven, so it's always reachable.
    const reachable: SessionStatus[] = [
      "exited",
      "needs_input",
      "working",
      "idle",
      "awaiting_review_gate",
    ];
    for (const status of ALL_STATUSES) {
      expect(isStatusReachable(status, BASH_EMITS)).toBe(reachable.includes(status));
    }
  });

  it("Claude Code (full emits) — expected subset reachable", () => {
    const reachable: SessionStatus[] = ALL_STATUSES.filter(
      (status) => status !== "awaiting_question",
    );
    for (const status of ALL_STATUSES) {
      expect(isStatusReachable(status, CLAUDE_CODE_EMITS)).toBe(reachable.includes(status));
    }
  });

  it("opencode (mid emits) — expected subset reachable", () => {
    // opencode emits: progress, file_change, turn_start, permission_request,
    // permission_resolved, tool_failure, notification, git_branch,
    // cwd_changed, promote_request, compact, subagent, question, todo, session_diff
    const reachable: SessionStatus[] = [
      "exited",
      "needs_input",
      "working",
      "idle",
      "awaiting_review_gate",
      "tool_failure",
      "awaiting_permission",
      "awaiting_promote",
      "awaiting_question",
      "finished",
      "compacting",
      "subagent",
      // Issue #428 — "background" rides on the "progress" hook, same
      // closest-honest-mapping posture "finished" already uses; opencode
      // emits "progress" so this is reachable the same way "finished" is,
      // even though only Claude Code's forwarder currently ever populates
      // backgroundTasks in practice.
      "background",
    ];
    for (const status of ALL_STATUSES) {
      expect(isStatusReachable(status, OPENCODE_EMITS)).toBe(reachable.includes(status));
    }
  });

  it("codex — expected subset reachable", () => {
    // codex emits: progress, session_start, session_end, permission_request,
    // turn_start, file_change, git_branch, cwd_changed
    const reachable: SessionStatus[] = [
      "exited",
      "needs_input",
      "working",
      "idle",
      "awaiting_review_gate",
      "awaiting_permission",
      "finished",
      // Issue #428 — same reasoning as opencode's own "background" entry
      // above: codex emits "progress" too.
      "background",
    ];
    for (const status of ALL_STATUSES) {
      expect(isStatusReachable(status, CODEX_EMITS)).toBe(reachable.includes(status));
    }
  });

  it("single extra emit unlocks exactly one status", () => {
    expect(isStatusReachable("tool_failure", ["tool_failure"])).toBe(true);
    expect(isStatusReachable("tool_failure", ["progress", "tool_failure"])).toBe(true);
    expect(isStatusReachable("tool_failure", ["progress"])).toBe(false);
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
