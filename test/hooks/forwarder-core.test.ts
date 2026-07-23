import { describe, it, expect } from "vitest";
import {
  buildForwarderMessage,
  mapClaudeCodeEvent,
  mapClaudeCodeNotification,
  mapClaudeCodePostToolUse,
  mapClaudeCodeStop,
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

describe("mapClaudeCodeEvent", () => {
  it("dispatches Notification/Stop/PostToolUse to their mappers", () => {
    expect(mapClaudeCodeEvent("Notification", { message: "hi" })).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "hi",
    });
    expect(mapClaudeCodeEvent("Stop", {})).toEqual({ kind: "progress", phase: "done" });
    expect(
      mapClaudeCodeEvent("PostToolUse", { tool_name: "Write", tool_input: { file_path: "x" } }),
    ).toEqual({ kind: "file_change", path: "x", action: "modify" });
  });

  it("returns null for an unrecognized kind (e.g. a future PreToolUse before PR9)", () => {
    expect(mapClaudeCodeEvent("PreToolUse", {})).toBeNull();
  });
});

describe("buildForwarderMessage", () => {
  it("dispatches to the claude-code dialect", () => {
    expect(buildForwarderMessage("claude-code", "Stop", {})).toEqual({
      kind: "progress",
      phase: "done",
    });
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
