import { describe, it, expect, vi } from "vitest";
import {
  buildForwarderMessage,
  formatClaudeCodeGateDecision,
  formatClaudeCodeSessionStartOutput,
  formatGateDecision,
  formatSessionStartOutput,
  mapAgyEvent,
  mapClaudeCodeEvent,
  mapClaudeCodeNotification,
  mapClaudeCodePostToolUse,
  mapClaudeCodePreToolUse,
  mapClaudeCodeSessionStart,
  mapClaudeCodeStop,
  mapCodexEvent,
  mapCodexPostToolUse,
  mapCodexStop,
  parseHookStdin,
} from "../../src/hooks/forwarder-core.mjs";

describe("parseHookStdin (issue #174)", () => {
  it("parses a well-formed JSON object", () => {
    expect(parseHookStdin('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for malformed JSON", () => {
    expect(parseHookStdin("not json")).toBeNull();
  });

  it("returns null for a JSON array", () => {
    expect(parseHookStdin("[1,2,3]")).toBeNull();
  });

  it("returns null for a bare JSON scalar", () => {
    expect(parseHookStdin("42")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseHookStdin("")).toBeNull();
  });
});

describe("mapClaudeCodeNotification", () => {
  it("maps the message field to the notification body", () => {
    expect(mapClaudeCodeNotification({ message: "Waiting for input" })).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "Waiting for input",
    });
  });

  it("falls back to an empty body when message is missing", () => {
    expect(mapClaudeCodeNotification({})).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "",
    });
  });
});

describe("mapClaudeCodeStop", () => {
  it("always maps to a done progress message", () => {
    expect(mapClaudeCodeStop()).toEqual({ kind: "progress", phase: "done" });
  });
});

describe("mapClaudeCodePostToolUse", () => {
  it("maps a Write tool call to a file_change message", () => {
    expect(
      mapClaudeCodePostToolUse({ tool_name: "Write", tool_input: { file_path: "/repo/a.ts" } }),
    ).toEqual({ kind: "file_change", path: "/repo/a.ts", action: "modify" });
  });

  it("maps an Edit tool call to a file_change message", () => {
    expect(
      mapClaudeCodePostToolUse({ tool_name: "Edit", tool_input: { file_path: "/repo/b.ts" } }),
    ).toEqual({ kind: "file_change", path: "/repo/b.ts", action: "modify" });
  });

  it("falls back to notebook_path for NotebookEdit", () => {
    expect(
      mapClaudeCodePostToolUse({
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "/repo/nb.ipynb" },
      }),
    ).toEqual({ kind: "file_change", path: "/repo/nb.ipynb", action: "modify" });
  });

  it("returns null for a non-file tool", () => {
    expect(
      mapClaudeCodePostToolUse({ tool_name: "Bash", tool_input: { command: "ls" } }),
    ).toBeNull();
  });

  it("returns null when tool_input has no usable path", () => {
    expect(mapClaudeCodePostToolUse({ tool_name: "Write", tool_input: {} })).toBeNull();
  });

  it("returns null when tool_input is missing entirely", () => {
    expect(mapClaudeCodePostToolUse({ tool_name: "Write" })).toBeNull();
  });
});

describe("mapClaudeCodePreToolUse (issue #178)", () => {
  it("summarizes a Bash command in the prompt", () => {
    expect(
      mapClaudeCodePreToolUse({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }),
    ).toEqual({ kind: "review_gate", state: "waiting", prompt: "Bash: rm -rf /tmp/x" });
  });

  it("falls back to file_path when there's no command field", () => {
    expect(
      mapClaudeCodePreToolUse({ tool_name: "Write", tool_input: { file_path: "/repo/a.ts" } }),
    ).toEqual({ kind: "review_gate", state: "waiting", prompt: "Write: /repo/a.ts" });
  });

  it("falls back to just the tool name with no usable detail at all", () => {
    expect(mapClaudeCodePreToolUse({ tool_name: "Bash", tool_input: {} })).toEqual({
      kind: "review_gate",
      state: "waiting",
      prompt: "Bash",
    });
    expect(mapClaudeCodePreToolUse({})).toEqual({
      kind: "review_gate",
      state: "waiting",
      prompt: "a tool",
    });
  });

  it("truncates a long command rather than embedding it in full", () => {
    const command = "x".repeat(500);
    const result = mapClaudeCodePreToolUse({ tool_name: "Bash", tool_input: { command } });
    expect(result.prompt.length).toBeLessThan(220);
    expect(result.prompt.endsWith("…")).toBe(true);
    expect(result.prompt.startsWith("Bash: xxx")).toBe(true);
  });
});

describe("mapClaudeCodeEvent", () => {
  it("dispatches Notification/Stop/PostToolUse/PreToolUse/SessionStart to their mappers", () => {
    expect(mapClaudeCodeEvent("Notification", { message: "hi" })).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "hi",
    });
    expect(mapClaudeCodeEvent("Stop", {})).toEqual({ kind: "progress", phase: "done" });
    expect(
      mapClaudeCodeEvent("PostToolUse", { tool_name: "Write", tool_input: { file_path: "x" } }),
    ).toEqual({ kind: "file_change", path: "x", action: "modify" });
    expect(
      mapClaudeCodeEvent("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }),
    ).toEqual({
      kind: "review_gate",
      state: "waiting",
      prompt: "Bash: ls",
    });
    expect(mapClaudeCodeEvent("SessionStart", {})).toEqual({ kind: "session_start" });
  });

  it("returns null for an unrecognized kind", () => {
    expect(mapClaudeCodeEvent("SomeFutureKind", {})).toBeNull();
  });
});

describe("mapClaudeCodeSessionStart (issue #271)", () => {
  it("always maps to a bare session_start message regardless of payload", () => {
    expect(mapClaudeCodeSessionStart()).toEqual({ kind: "session_start" });
  });
});

describe("mapCodexStop", () => {
  it("always maps to a done progress message", () => {
    expect(mapCodexStop()).toEqual({ kind: "progress", phase: "done" });
  });
});

describe("mapCodexPostToolUse (issue #252, unverified against a live Codex hook)", () => {
  it("extracts a single Update File as a modify", () => {
    expect(
      mapCodexPostToolUse({
        tool_name: "apply_patch",
        tool_input: {
          command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch",
        },
      }),
    ).toEqual([{ kind: "file_change", path: "src/a.ts", action: "modify" }]);
  });

  it("extracts multiple files from one patch, mapping each header verb to its action", () => {
    const command = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+content",
      "*** Update File: src/existing.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");
    expect(mapCodexPostToolUse({ tool_name: "apply_patch", tool_input: { command } })).toEqual([
      { kind: "file_change", path: "src/new.ts", action: "create" },
      { kind: "file_change", path: "src/existing.ts", action: "modify" },
      { kind: "file_change", path: "src/gone.ts", action: "delete" },
    ]);
  });

  it("returns an empty array for a non-apply_patch tool", () => {
    expect(mapCodexPostToolUse({ tool_name: "shell", tool_input: { command: "ls" } })).toEqual([]);
  });

  it("returns an empty array when tool_input.command has no recognizable header (defensive, unverified format)", () => {
    expect(
      mapCodexPostToolUse({ tool_name: "apply_patch", tool_input: { command: "no headers here" } }),
    ).toEqual([]);
  });

  it("returns an empty array when tool_input.command is missing entirely", () => {
    expect(mapCodexPostToolUse({ tool_name: "apply_patch", tool_input: {} })).toEqual([]);
    expect(mapCodexPostToolUse({ tool_name: "apply_patch" })).toEqual([]);
  });
});

describe("mapCodexEvent", () => {
  it("dispatches Stop and PostToolUse to their mappers", () => {
    expect(mapCodexEvent("Stop", {})).toEqual({ kind: "progress", phase: "done" });
    expect(
      mapCodexEvent("PostToolUse", {
        tool_name: "apply_patch",
        tool_input: { command: "*** Update File: a.ts" },
      }),
    ).toEqual([{ kind: "file_change", path: "a.ts", action: "modify" }]);
  });

  it("returns null for an event Codex has no hook for (e.g. Notification — doesn't exist for Codex)", () => {
    expect(mapCodexEvent("Notification", {})).toBeNull();
  });

  it("returns null for a gating event deferred to issue #178 (PreToolUse/PermissionRequest)", () => {
    expect(mapCodexEvent("PreToolUse", {})).toBeNull();
    expect(mapCodexEvent("PermissionRequest", {})).toBeNull();
  });
});

describe("mapAgyEvent (issue #253)", () => {
  it("maps Stop to a done progress message", () => {
    expect(mapAgyEvent("Stop")).toEqual({ kind: "progress", phase: "done" });
  });

  it("returns null for PostToolUse — deliberately not wired up (unverified payload shape)", () => {
    expect(mapAgyEvent("PostToolUse")).toBeNull();
  });

  it("returns null for an unrecognized kind", () => {
    expect(mapAgyEvent("PreInvocation")).toBeNull();
  });
});

describe("buildForwarderMessage", () => {
  it("dispatches to the claude-code dialect", () => {
    expect(buildForwarderMessage("claude-code", "Stop", {})).toEqual({
      kind: "progress",
      phase: "done",
    });
  });

  it("dispatches to the codex dialect", () => {
    expect(buildForwarderMessage("codex", "Stop", {})).toEqual({ kind: "progress", phase: "done" });
  });

  it("dispatches to the agy dialect", () => {
    expect(buildForwarderMessage("agy", "Stop", {})).toEqual({ kind: "progress", phase: "done" });
  });

  it("returns null for an unknown agent", () => {
    expect(buildForwarderMessage("some-future-agent", "Stop", {})).toBeNull();
  });

  it("treats a null payload the same as an empty object", () => {
    expect(buildForwarderMessage("claude-code", "Stop", null)).toEqual({
      kind: "progress",
      phase: "done",
    });
  });
});

describe("formatClaudeCodeGateDecision (issue #178)", () => {
  it("maps 'approved' to permissionDecision 'allow'", () => {
    expect(formatClaudeCodeGateDecision("approved")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Approved via Mullion",
      },
    });
  });

  it("maps 'denied' to permissionDecision 'deny'", () => {
    expect(formatClaudeCodeGateDecision("denied")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Denied via Mullion",
      },
    });
  });

  it("prefers a given reason over the default text", () => {
    expect(formatClaudeCodeGateDecision("denied", "looks unsafe")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "looks unsafe",
      },
    });
  });
});

describe("formatGateDecision (issue #178)", () => {
  it("dispatches to the claude-code dialect", () => {
    expect(formatGateDecision("claude-code", "approved")).toEqual(
      formatClaudeCodeGateDecision("approved"),
    );
  });

  it("falls back to a generic shape (Mullion's own approved/denied vocabulary, not Claude Code's) for any agent without a real gate dialect yet", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(formatGateDecision("codex", "approved")).toEqual({ decision: "approved" });
      expect(formatGateDecision("agy", "denied")).toEqual({ decision: "denied" });
      expect(formatGateDecision("some-future-agent", "denied")).toEqual({ decision: "denied" });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("formatClaudeCodeSessionStartOutput (issue #271)", () => {
  it("wraps additionalContext in the SessionStart hookSpecificOutput shape", () => {
    expect(formatClaudeCodeSessionStartOutput("resume the refactor")).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "resume the refactor",
      },
    });
  });

  it("passes an empty string through unchanged", () => {
    expect(formatClaudeCodeSessionStartOutput("")).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" },
    });
  });
});

describe("formatSessionStartOutput (issue #271)", () => {
  it("dispatches to the claude-code dialect", () => {
    expect(formatSessionStartOutput("claude-code", "seed")).toEqual(
      formatClaudeCodeSessionStartOutput("seed"),
    );
  });

  it("falls back to an empty object for any agent without a SessionStart dialect", () => {
    expect(formatSessionStartOutput("codex", "seed")).toEqual({});
    expect(formatSessionStartOutput("agy", "seed")).toEqual({});
    expect(formatSessionStartOutput("some-future-agent", "seed")).toEqual({});
  });
});
