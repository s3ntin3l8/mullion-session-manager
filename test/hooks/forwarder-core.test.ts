import { describe, it, expect, vi } from "vitest";
import {
  buildForwarderMessage,
  detectWorktreeAdd,
  formatClaudeCodeGateDecision,
  formatClaudeCodeSessionStartOutput,
  formatGateDecision,
  formatSessionStartOutput,
  mapAgyEvent,
  mapClaudeCodeCwdChanged,
  mapClaudeCodeEvent,
  mapClaudeCodeNotification,
  mapClaudeCodePermissionRequest,
  mapClaudeCodePostToolUse,
  mapClaudeCodePostToolUseFailure,
  mapClaudeCodePreToolUse,
  mapClaudeCodeExitPlanMode,
  mapClaudeCodeSessionEnd,
  mapClaudeCodeSessionStart,
  mapClaudeCodeStop,
  mapClaudeCodeStopFailure,
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

  it("maps an idle_prompt notification to progress:done instead of a notification message", () => {
    expect(
      mapClaudeCodeNotification({ notification_type: "idle_prompt", message: "Claude is waiting" }),
    ).toEqual({ kind: "progress", phase: "done" });
  });
});

describe("mapClaudeCodeStop", () => {
  it("maps to a done progress message with optional enriched fields", () => {
    expect(mapClaudeCodeStop({})).toEqual({ kind: "progress", phase: "done" });
  });

  it("includes lastAssistantMessage and backgroundTasks when present", () => {
    expect(
      mapClaudeCodeStop({
        last_assistant_message: "Done!",
        background_tasks: [],
      }),
    ).toEqual({
      kind: "progress",
      phase: "done",
      lastAssistantMessage: "Done!",
      backgroundTasks: [],
    });
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

  it("returns null for a non-file, non-Bash tool", () => {
    expect(
      mapClaudeCodePostToolUse({ tool_name: "View", tool_input: { path: "/repo/a.ts" } }),
    ).toBeNull();
  });

  it("returns git_branch when the Bash command creates a worktree", () => {
    expect(
      mapClaudeCodePostToolUse({
        tool_name: "Bash",
        tool_input: { command: "git worktree add -b feat/foo /tmp/foo main" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/foo", worktree: "/tmp/foo" });
  });

  it("returns null for a Bash command that is not a worktree add", () => {
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
  it("dispatches notification/stop/posttooluse/pretooluse/sessionstart to their mappers", () => {
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
      mapClaudeCodeEvent("PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    ).toEqual({
      kind: "review_gate",
      state: "waiting",
      prompt: "Bash: ls",
    });
    expect(mapClaudeCodeEvent("SessionStart", { source: "startup" })).toEqual({
      kind: "session_start",
      source: "startup",
    });
  });

  it("dispatches PermissionRequest to the permission_request mapper", () => {
    expect(
      mapClaudeCodeEvent("PermissionRequest", {
        tool_name: "Bash",
        tool_input: { command: "npm install" },
      }),
    ).toEqual({
      kind: "permission_request",
      tool: "Bash",
      summary: "Bash: npm install",
    });
  });

  it("dispatches StopFailure to the stop_failure mapper", () => {
    expect(
      mapClaudeCodeEvent("StopFailure", { error: "rate_limit", error_details: "429" }),
    ).toEqual({
      kind: "stop_failure",
      error: "rate_limit",
      errorDetails: "429",
    });
  });

  it("dispatches PostToolUseFailure to the tool_failure mapper", () => {
    expect(
      mapClaudeCodeEvent("PostToolUseFailure", {
        tool_name: "Bash",
        error: "exit code 1",
        tool_input: { command: "npm test" },
      }),
    ).toEqual({
      kind: "tool_failure",
      tool: "Bash",
      error: "exit code 1",
      summary: "Bash: npm test",
    });
  });

  it("dispatches SessionEnd to the session_end mapper", () => {
    expect(mapClaudeCodeEvent("SessionEnd", { reason: "clear" })).toEqual({
      kind: "session_end",
      reason: "clear",
    });
  });

  it("dispatches PreToolUse with ExitPlanMode to the plan_ready mapper", () => {
    expect(
      mapClaudeCodeEvent("PreToolUse", {
        tool_name: "ExitPlanMode",
        tool_input: { plan: "## Refactor\n1. Extract module" },
      }),
    ).toEqual({
      kind: "plan_ready",
      plan: "## Refactor\n1. Extract module",
    });
  });

  it("returns null for an unrecognized kind", () => {
    expect(mapClaudeCodeEvent("SomeFutureKind", {})).toBeNull();
  });
});

describe("mapClaudeCodeCwdChanged (issue: sidebar worktree detection)", () => {
  it("maps new_cwd to a cwd_changed hook message", () => {
    expect(
      mapClaudeCodeCwdChanged({
        old_cwd: "/workspace/src",
        new_cwd: "/workspace/src/components",
      }),
    ).toEqual({ kind: "cwd_changed", cwd: "/workspace/src/components" });
  });

  it("returns null when new_cwd is missing", () => {
    expect(mapClaudeCodeCwdChanged({ old_cwd: "/workspace/src" })).toBeNull();
  });

  it("returns null when new_cwd is not a string", () => {
    expect(mapClaudeCodeCwdChanged({ new_cwd: null })).toBeNull();
  });

  it("returns null for an empty payload", () => {
    expect(mapClaudeCodeCwdChanged({})).toBeNull();
  });
});

describe("detectWorktreeAdd (issue: sidebar worktree detection)", () => {
  it("detects git worktree add with -b flag and returns git_branch", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: { command: "git worktree add -b feat/foo /workspace/.worktrees/foo main" },
      }),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/foo",
      worktree: "/workspace/.worktrees/foo",
    });
  });

  it("detects git worktree add without -b flag, deriving branch from path", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: { command: "git worktree add /workspace/.worktrees/fix-bug" },
      }),
    ).toEqual({
      kind: "git_branch",
      branch: "fix-bug",
      worktree: "/workspace/.worktrees/fix-bug",
    });
  });

  it("detects git worktree add <path> <existing-branch> (no -b flag, trailing commit-ish)", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: { command: "git worktree add /workspace/.worktrees/feat existing-branch" },
      }),
    ).toEqual({
      kind: "git_branch",
      branch: "existing-branch",
      worktree: "/workspace/.worktrees/feat",
    });
  });

  it("detects git worktree add with long flags (--force, --guess-remote)", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: {
          command:
            "git worktree add --force --guess-remote -b feat/bar /workspace/.worktrees/bar origin/main",
        },
      }),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/bar",
      worktree: "/workspace/.worktrees/bar",
    });
  });

  it("returns null for a non-worktree git command", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
    ).toBeNull();
  });

  it("returns null for a non-git command", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      }),
    ).toBeNull();
  });

  it("returns null for a non-Bash tool", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Write",
        tool_input: { file_path: "/workspace/a.ts" },
      }),
    ).toBeNull();
  });

  it("returns null for an empty command", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: { command: "" },
      }),
    ).toBeNull();
  });

  it("returns null when tool_input is missing entirely", () => {
    expect(detectWorktreeAdd({ tool_name: "Bash" })).toBeNull();
  });
});

describe("mapClaudeCodeEvent CwdChanged dispatch (issue: sidebar worktree detection)", () => {
  it("dispatches CwdChanged to mapClaudeCodeCwdChanged", () => {
    expect(
      mapClaudeCodeEvent("CwdChanged", {
        old_cwd: "/workspace/src",
        new_cwd: "/workspace/src/lib",
      }),
    ).toEqual({ kind: "cwd_changed", cwd: "/workspace/src/lib" });
  });

  it("still returns null for unrecognized event kinds", () => {
    expect(mapClaudeCodeEvent("SomeFutureKind", {})).toBeNull();
  });
});

describe("mapClaudeCodeSessionStart (issue #271)", () => {
  it("maps to session_start with source when present", () => {
    expect(mapClaudeCodeSessionStart({ source: "resume" })).toEqual({
      kind: "session_start",
      source: "resume",
    });
  });

  it("maps to a bare session_start message when source is absent", () => {
    expect(mapClaudeCodeSessionStart({})).toEqual({ kind: "session_start" });
  });

  it("always maps to session_start even with arbitrary payload", () => {
    expect(mapClaudeCodeSessionStart()).toEqual({ kind: "session_start" });
  });
});

describe("mapClaudeCodePermissionRequest", () => {
  it("extracts tool and summary from the permission request payload", () => {
    expect(
      mapClaudeCodePermissionRequest({
        tool_name: "Bash",
        tool_input: { command: "rm -rf node_modules", description: "Clean up" },
      }),
    ).toEqual({ kind: "permission_request", tool: "Bash", summary: "Bash: rm -rf node_modules" });
  });

  it("falls back to just the tool name with no usable input detail", () => {
    expect(mapClaudeCodePermissionRequest({ tool_name: "Read", tool_input: {} })).toEqual({
      kind: "permission_request",
      tool: "Read",
      summary: "Read",
    });
  });

  it("falls back to 'a tool' when tool_name is absent", () => {
    expect(mapClaudeCodePermissionRequest({})).toEqual({
      kind: "permission_request",
      tool: "a tool",
      summary: "a tool",
    });
  });
});

describe("mapClaudeCodeStopFailure", () => {
  it("extracts error and errorDetails", () => {
    expect(
      mapClaudeCodeStopFailure({ error: "rate_limit", error_details: "429 Too Many Requests" }),
    ).toEqual({ kind: "stop_failure", error: "rate_limit", errorDetails: "429 Too Many Requests" });
  });

  it("extracts error without errorDetails", () => {
    expect(mapClaudeCodeStopFailure({ error: "max_output_tokens" })).toEqual({
      kind: "stop_failure",
      error: "max_output_tokens",
    });
  });

  it("handles empty payload gracefully", () => {
    expect(mapClaudeCodeStopFailure({})).toEqual({ kind: "stop_failure", error: "unknown" });
  });
});

describe("mapClaudeCodePostToolUseFailure", () => {
  it("extracts tool, error, and summary from the payload", () => {
    expect(
      mapClaudeCodePostToolUseFailure({
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        error: "Command exited with non-zero status code 1",
      }),
    ).toEqual({
      kind: "tool_failure",
      tool: "Bash",
      error: "Command exited with non-zero status code 1",
      summary: "Bash: npm test",
    });
  });

  it("falls back to just tool name without command detail", () => {
    expect(
      mapClaudeCodePostToolUseFailure({
        tool_name: "Edit",
        tool_input: {},
        error: "permission denied",
      }),
    ).toEqual({
      kind: "tool_failure",
      tool: "Edit",
      error: "permission denied",
      summary: "Edit",
    });
  });

  it("handles missing tool_name gracefully", () => {
    expect(mapClaudeCodePostToolUseFailure({ error: "something went wrong" })).toEqual({
      kind: "tool_failure",
      tool: "a tool",
      error: "something went wrong",
      summary: "a tool",
    });
  });
});

describe("mapClaudeCodeSessionEnd", () => {
  it("extracts the reason from the payload", () => {
    expect(mapClaudeCodeSessionEnd({ reason: "clear" })).toEqual({
      kind: "session_end",
      reason: "clear",
    });
  });

  it("maps a resume reason", () => {
    expect(mapClaudeCodeSessionEnd({ reason: "resume" })).toEqual({
      kind: "session_end",
      reason: "resume",
    });
  });

  it("handles empty payload gracefully", () => {
    expect(mapClaudeCodeSessionEnd({})).toEqual({ kind: "session_end", reason: "other" });
  });
});

describe("mapClaudeCodeExitPlanMode", () => {
  it("extracts plan from the tool input", () => {
    expect(
      mapClaudeCodeExitPlanMode({
        tool_name: "ExitPlanMode",
        tool_input: { plan: "## Refactor\n1. Extract module" },
      }),
    ).toEqual({
      kind: "plan_ready",
      plan: "## Refactor\n1. Extract module",
    });
  });

  it("extracts filePath when present", () => {
    expect(
      mapClaudeCodeExitPlanMode({
        tool_name: "ExitPlanMode",
        tool_input: {
          plan: "## Refactor",
          plan_file_path: "/tmp/plans/refactor.md",
        },
      }),
    ).toEqual({
      kind: "plan_ready",
      plan: "## Refactor",
      filePath: "/tmp/plans/refactor.md",
    });
  });

  it("handles missing plan gracefully", () => {
    expect(mapClaudeCodeExitPlanMode({ tool_name: "ExitPlanMode", tool_input: {} })).toEqual({
      kind: "plan_ready",
      plan: "",
    });

    expect(mapClaudeCodeExitPlanMode({})).toEqual({
      kind: "plan_ready",
      plan: "",
    });
  });
});

describe("mapClaudeCodeStop — enriched", () => {
  it("maps to progress: done and includes lastAssistantMessage when present", () => {
    expect(
      mapClaudeCodeStop({ last_assistant_message: "I've completed the refactoring." }),
    ).toEqual({
      kind: "progress",
      phase: "done",
      lastAssistantMessage: "I've completed the refactoring.",
    });
  });

  it("maps to progress: done with background_tasks when present", () => {
    const tasks = [{ id: "t1", type: "shell", status: "running", description: "tail logs" }];
    expect(mapClaudeCodeStop({ background_tasks: tasks })).toEqual({
      kind: "progress",
      phase: "done",
      backgroundTasks: tasks,
    });
  });

  it("maps to progress: done with no extras when both fields are absent", () => {
    expect(mapClaudeCodeStop({})).toEqual({ kind: "progress", phase: "done" });
  });

  it("ignores non-string last_assistant_message", () => {
    expect(mapClaudeCodeStop({ last_assistant_message: 123 })).toEqual({
      kind: "progress",
      phase: "done",
    });
  });

  it("ignores non-array background_tasks", () => {
    expect(mapClaudeCodeStop({ background_tasks: "not-an-array" })).toEqual({
      kind: "progress",
      phase: "done",
    });
  });
});

describe("mapClaudeCodeNotification — idle_prompt detection", () => {
  it("maps an idle_prompt notification to progress: done instead of a notification message", () => {
    expect(
      mapClaudeCodeNotification({ notification_type: "idle_prompt", message: "Claude is waiting" }),
    ).toEqual({ kind: "progress", phase: "done" });
  });

  it("maps a permission_prompt notification to a regular notification (not idle)", () => {
    expect(
      mapClaudeCodeNotification({
        notification_type: "permission_prompt",
        message: "Needs approval",
      }),
    ).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "Needs approval",
    });
  });

  it("maps a generic notification without a type to a regular notification", () => {
    expect(mapClaudeCodeNotification({ message: "Something happened" })).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "Something happened",
    });
  });

  it("maps unknown notification types to a regular notification", () => {
    expect(
      mapClaudeCodeNotification({ notification_type: "auth_success", message: "Logged in" }),
    ).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "Logged in",
    });
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

describe("mapCodexPostToolUse Bash (issue: sidebar worktree detection)", () => {
  it("returns git_branch + cwd_changed for a Bash git worktree add command", () => {
    expect(
      mapCodexPostToolUse({
        tool_name: "Bash",
        tool_input: { command: "git worktree add -b feat/foo /workspace/.worktrees/foo main" },
        cwd: "/workspace",
      }),
    ).toEqual([
      { kind: "git_branch", branch: "feat/foo", worktree: "/workspace/.worktrees/foo" },
      { kind: "cwd_changed", cwd: "/workspace" },
    ]);
  });

  it("returns cwd_changed alone for a Bash command that is not a worktree add", () => {
    expect(
      mapCodexPostToolUse({
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        cwd: "/workspace",
      }),
    ).toEqual([{ kind: "cwd_changed", cwd: "/workspace" }]);
  });

  it("returns nothing when cwd is missing and command is not a worktree add", () => {
    expect(
      mapCodexPostToolUse({
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      }),
    ).toEqual([]);
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

  it("dispatches PostToolUse with Bash tool to worktree/cwd detection", () => {
    const result = mapCodexEvent("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git worktree add -b fix /tmp/wt" },
      cwd: "/repo",
    });
    expect(result).toEqual([
      { kind: "git_branch", branch: "fix", worktree: "/tmp/wt" },
      { kind: "cwd_changed", cwd: "/repo" },
    ]);
  });

  it("returns null for an event Codex has no hook for (e.g. Notification — doesn't exist for Codex)", () => {
    expect(mapCodexEvent("Notification", {})).toBeNull();
  });

  it("returns null for PreToolUse (still deferred to issue #178) and dispatches PermissionRequest", () => {
    expect(mapCodexEvent("PreToolUse", {})).toBeNull();
    expect(
      mapCodexEvent("PermissionRequest", {
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      }),
    ).toEqual({ kind: "permission_request", tool: "Bash", summary: "npm test" });
  });
});

describe("mapAgyEvent (issue #253)", () => {
  it("maps Stop to progress:done (in an array)", () => {
    expect(mapAgyEvent("Stop", {})).toEqual([{ kind: "progress", phase: "done" }]);
  });

  it("returns null for PostToolUse when payload lacks toolCall info", () => {
    expect(mapAgyEvent("PostToolUse", {})).toBeNull();
  });

  it("maps PreToolUse with run_command and git worktree add to git_branch + cwd_changed + review_gate", () => {
    const result = mapAgyEvent("PreToolUse", {
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "git worktree add -b feat/wt-1 /tmp/wt-1 main",
          Cwd: "/workspace/project",
        },
      },
    });
    expect(result).toEqual([
      { kind: "git_branch", branch: "feat/wt-1", worktree: "/tmp/wt-1" },
      { kind: "cwd_changed", cwd: "/workspace/project" },
      { kind: "review_gate", state: "waiting", prompt: "run_command: git worktree add -b feat/wt-1 /tmp/wt-1 main" },
    ]);
  });

  it("maps PreToolUse with non-worktree run_command to cwd_changed + review_gate", () => {
    const result = mapAgyEvent("PreToolUse", {
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "npm test",
          Cwd: "/workspace/project/src",
        },
      },
    });
    expect(result).toEqual([
      { kind: "cwd_changed", cwd: "/workspace/project/src" },
      { kind: "review_gate", state: "waiting", prompt: "run_command: npm test" },
    ]);
  });

  it("returns null for PreToolUse when the tool is not run_command", () => {
    expect(
      mapAgyEvent("PreToolUse", {
        toolCall: { name: "view_file", args: { AbsolutePath: "/repo/a.ts" } },
      }),
    ).toBeNull();
  });

  it("returns null for an unrecognized kind", () => {
    expect(mapAgyEvent("PreInvocation", {})).toBeNull();
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
    expect(buildForwarderMessage("agy", "Stop", {})).toEqual([{ kind: "progress", phase: "done" }]);
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

  it("dispatches to the agy dialect", () => {
    expect(formatGateDecision("agy", "approved")).toEqual({ decision: "allow" });
    expect(formatGateDecision("agy", "denied", "unsafe")).toEqual({ decision: "deny", reason: "unsafe" });
  });

  it("falls back to a generic shape for any agent without a real gate dialect yet", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(formatGateDecision("codex", "approved")).toEqual({ decision: "approved" });
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
