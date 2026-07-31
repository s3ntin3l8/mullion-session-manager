import { describe, it, expect, vi } from "vitest";
import {
  buildClaudeHookSettings,
  claudeCodeAdapter,
} from "../../src/services/hook-adapters/claude-code.js";
import { codexAdapter } from "../../src/services/hook-adapters/codex.js";
import { agyAdapter } from "../../src/services/hook-adapters/agy.js";
import {
  buildForwarderMessage,
  detectGitCheckout,
  detectWorktreeAdd,
  formatClaudeCodeGateDecision,
  formatClaudeCodeSessionStartOutput,
  formatGateDecision,
  formatSessionStartOutput,
  mapAgyEvent,
  mapClaudeCodeCwdChanged,
  mapClaudeCodeElicitation,
  mapClaudeCodeElicitationResult,
  mapClaudeCodeEvent,
  mapClaudeCodeNotification,
  mapClaudeCodePermissionDenied,
  mapClaudeCodePermissionRequest,
  mapClaudeCodePostToolUse,
  mapClaudeCodePostToolUseFailure,
  mapClaudeCodePreCompact,
  mapClaudeCodePostCompact,
  mapClaudeCodePreToolUse,
  mapClaudeCodeExitPlanMode,
  mapClaudeCodeSessionEnd,
  mapClaudeCodeSessionStart,
  mapClaudeCodeStop,
  mapClaudeCodeStopFailure,
  mapClaudeCodeSubagentStart,
  mapClaudeCodeSubagentStop,
  mapClaudeCodeUserPromptSubmit,
  mapCodexEvent,
  mapCodexPostToolUse,
  mapCodexStop,
  mapCodexUserPromptSubmit,
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
  it("maps a Write tool call to [file_change, tool_done]", () => {
    expect(
      mapClaudeCodePostToolUse({ tool_name: "Write", tool_input: { file_path: "/repo/a.ts" } }),
    ).toEqual([
      { kind: "file_change", path: "/repo/a.ts", action: "modify" },
      { kind: "tool_done", tool: "Write" },
    ]);
  });

  it("maps an Edit tool call to [file_change, tool_done]", () => {
    expect(
      mapClaudeCodePostToolUse({ tool_name: "Edit", tool_input: { file_path: "/repo/b.ts" } }),
    ).toEqual([
      { kind: "file_change", path: "/repo/b.ts", action: "modify" },
      { kind: "tool_done", tool: "Edit" },
    ]);
  });

  it("falls back to notebook_path for NotebookEdit", () => {
    expect(
      mapClaudeCodePostToolUse({
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "/repo/nb.ipynb" },
      }),
    ).toEqual([
      { kind: "file_change", path: "/repo/nb.ipynb", action: "modify" },
      { kind: "tool_done", tool: "NotebookEdit" },
    ]);
  });

  // Fix: status-clearing-semantics — every completed tool call now also
  // reports a bare tool_done (the forward-progress evidence that releases a
  // pending permission_request/plan_ready for that tool), even when there's
  // no file_change/git_branch to report alongside it.
  it("returns a bare tool_done for a non-file, non-Bash tool", () => {
    expect(
      mapClaudeCodePostToolUse({ tool_name: "View", tool_input: { path: "/repo/a.ts" } }),
    ).toEqual({ kind: "tool_done", tool: "View" });
  });

  it("returns [git_branch, tool_done] when the Bash command creates a worktree", () => {
    expect(
      mapClaudeCodePostToolUse({
        tool_name: "Bash",
        tool_input: { command: "git worktree add -b feat/foo /tmp/foo main" },
      }),
    ).toEqual([
      { kind: "git_branch", branch: "feat/foo", worktree: "/tmp/foo" },
      { kind: "tool_done", tool: "Bash" },
    ]);
  });

  it("returns [git_branch, tool_done] when the Bash command is a plain git checkout", () => {
    expect(
      mapClaudeCodePostToolUse({
        tool_name: "Bash",
        tool_input: { command: "git checkout feat/bar" },
      }),
    ).toEqual([
      { kind: "git_branch", branch: "feat/bar" },
      { kind: "tool_done", tool: "Bash" },
    ]);
  });

  it("returns a bare tool_done for a Bash command that is not a worktree add or checkout", () => {
    expect(mapClaudeCodePostToolUse({ tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({
      kind: "tool_done",
      tool: "Bash",
    });
  });

  it("returns a bare tool_done when tool_input has no usable path", () => {
    expect(mapClaudeCodePostToolUse({ tool_name: "Write", tool_input: {} })).toEqual({
      kind: "tool_done",
      tool: "Write",
    });
  });

  it("returns a bare tool_done when tool_input is missing entirely", () => {
    expect(mapClaudeCodePostToolUse({ tool_name: "Write" })).toEqual({
      kind: "tool_done",
      tool: "Write",
    });
  });

  it("returns null when tool_name itself is missing (nothing to tag a tool_done with)", () => {
    expect(mapClaudeCodePostToolUse({ tool_input: { file_path: "/repo/a.ts" } })).toBeNull();
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
    ).toEqual([
      { kind: "file_change", path: "x", action: "modify" },
      { kind: "tool_done", tool: "Write" },
    ]);
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

  // Phase 5 (Track A) — per Hermes review feedback on #414: the stamping
  // pipeline from a raw Claude Code payload through to the mapped message
  // was previously only exercised with empty `{}` payloads (no agent_id/
  // agent_type to stamp). This exercises the real path: a PostToolUseFailure
  // fired inside a subagent carries agent_id/agent_type on the payload
  // itself (verified empirically against a live subagent invocation — see
  // docs/agent-hooks.md's "Agent-attribution envelope" section), and
  // mapClaudeCodeEvent must stamp both onto the resulting tool_failure
  // message via applyAgentEnvelope.
  it("stamps agentId/agentType from the payload onto an attributable message (agent-attribution envelope)", () => {
    expect(
      mapClaudeCodeEvent("PostToolUseFailure", {
        tool_name: "Bash",
        error: "exit code 1",
        agent_id: "sub-1",
        agent_type: "Explore",
      }),
    ).toEqual({
      kind: "tool_failure",
      tool: "Bash",
      error: "exit code 1",
      summary: "Bash",
      agentId: "sub-1",
      agentType: "Explore",
    });
  });

  it("does not stamp agentId/agentType onto a non-attributable message kind (tool_done)", () => {
    // PostToolUse on a non-file tool maps to a bare tool_done — not one of
    // AGENT_ATTRIBUTABLE_KINDS — so the envelope must be a no-op even when
    // the payload carries agent_id/agent_type.
    expect(
      mapClaudeCodeEvent("PostToolUse", {
        tool_name: "Read",
        agent_id: "sub-1",
        agent_type: "Explore",
      }),
    ).toEqual({ kind: "tool_done", tool: "Read" });
  });

  // Issue #441 — applyAgentEnvelope's array branch (mapClaudeCodePostToolUse
  // returns [file_change, tool_done] for a file-editing tool) had no test
  // exercising a real agent_id/agent_type payload; only the single-message
  // branch was pinned above. Confirms per-element stamping: file_change is
  // attributable and gets stamped, tool_done sits right next to it in the
  // same array and must NOT.
  it("stamps only the file_change element of a [file_change, tool_done] array, never the sibling tool_done", () => {
    expect(
      mapClaudeCodeEvent("PostToolUse", {
        tool_name: "Write",
        tool_input: { file_path: "/repo/a.ts" },
        agent_id: "subagent-test-id-1",
        agent_type: "Explore",
      }),
    ).toEqual([
      {
        kind: "file_change",
        path: "/repo/a.ts",
        action: "modify",
        agentId: "subagent-test-id-1",
        agentType: "Explore",
      },
      { kind: "tool_done", tool: "Write" },
    ]);
  });

  // Independent review finding on #414 — mapClaudeCodeSubagentStart
  // deliberately drops an EMPTY agent_type via its own truthy check (see
  // that function), but withAgentEnvelope independently re-extracted
  // agent_type from the same raw payload with only a `typeof === "string"`
  // check, silently undoing the mapper's own drop by re-stamping
  // `agentType: ""` right back onto the message. Locks in the fix: an
  // empty agent_id/agent_type is never stamped, full stop, regardless of
  // what a specific mapper already decided.
  it("never stamps an empty agent_id/agent_type, even onto a message the mapper didn't already touch", () => {
    expect(mapClaudeCodeEvent("SubagentStart", { agent_type: "" })).toEqual({
      kind: "subagent",
      state: "started",
    });
    expect(
      mapClaudeCodeEvent("PostToolUseFailure", {
        tool_name: "Bash",
        error: "x",
        agent_id: "",
        agent_type: "",
      }),
    ).toEqual({ kind: "tool_failure", tool: "Bash", error: "x", summary: "Bash" });
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

  it("dispatches UserPromptSubmit/PreCompact/PostCompact/SubagentStart/SubagentStop/PermissionDenied/Elicitation/ElicitationResult to their mappers", () => {
    expect(mapClaudeCodeEvent("UserPromptSubmit", { prompt: "fix the bug" })).toEqual({
      kind: "turn_start",
    });
    expect(mapClaudeCodeEvent("PreCompact", { trigger: "auto" })).toEqual({
      kind: "compact",
      state: "started",
      trigger: "auto",
    });
    expect(mapClaudeCodeEvent("PostCompact", {})).toEqual({ kind: "compact", state: "finished" });
    expect(mapClaudeCodeEvent("SubagentStart", { agent_type: "Explore" })).toEqual({
      kind: "subagent",
      state: "started",
      agentType: "Explore",
    });
    expect(mapClaudeCodeEvent("SubagentStop", {})).toEqual({ kind: "subagent", state: "finished" });
    expect(mapClaudeCodeEvent("PermissionDenied", {})).toEqual({ kind: "permission_resolved" });
    expect(mapClaudeCodeEvent("Elicitation", { server: "my-mcp" })).toEqual({
      kind: "elicitation",
      state: "started",
      server: "my-mcp",
    });
    expect(mapClaudeCodeEvent("ElicitationResult", {})).toEqual({
      kind: "elicitation",
      state: "finished",
    });
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

  it("detects git worktree add chained after another command with && (real-world regression case)", () => {
    // Verbatim from a real session transcript that missed detection before
    // segment-splitting: the leading `git fetch` hid the worktree creation.
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: {
          command:
            "git fetch origin main --quiet && git worktree add .worktrees/fix-preview-proxy-forwarded-headers -b fix/preview-proxy-forwarded-headers origin/main",
        },
      }),
    ).toEqual({
      kind: "git_branch",
      branch: "fix/preview-proxy-forwarded-headers",
      worktree: ".worktrees/fix-preview-proxy-forwarded-headers",
    });
  });

  it("resolves a relative worktree path to absolute when resolveCwd is provided", () => {
    expect(
      detectWorktreeAdd(
        {
          tool_name: "Bash",
          tool_input: {
            command: "git worktree add -b feat/x .worktrees/feat/x main",
          },
        },
        "/workspace/repo",
      ),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: "/workspace/repo/.worktrees/feat/x",
    });
  });

  it("passes an already-absolute worktree path through unchanged when resolveCwd is provided", () => {
    expect(
      detectWorktreeAdd(
        {
          tool_name: "Bash",
          tool_input: {
            command: "git worktree add -b feat/x /workspace/worktrees/feat/x main",
          },
        },
        "/workspace/repo",
      ),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: "/workspace/worktrees/feat/x",
    });
  });

  it("returns the raw worktree path when resolveCwd is not provided (backward compat)", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: {
          command: "git worktree add -b feat/x .worktrees/feat/x main",
        },
      }),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: ".worktrees/feat/x",
    });
  });

  it("detects git worktree add chained before another command with && (real-world regression case)", () => {
    // Verbatim from a second real session transcript — the worktree
    // creation is the FIRST segment this time, with unrelated setup after.
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: {
          command:
            "mkdir -p .worktrees && git worktree add -b fix/dock-terminal-webgl-atlas-corruption .worktrees/fix-dock-terminal-webgl-atlas-corruption main",
        },
      }),
    ).toEqual({
      kind: "git_branch",
      branch: "fix/dock-terminal-webgl-atlas-corruption",
      worktree: ".worktrees/fix-dock-terminal-webgl-atlas-corruption",
    });
  });

  it("detects git worktree add after a `;`-separated command", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: { command: "echo starting; git worktree add -b feat/x /tmp/wt/x main" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/x", worktree: "/tmp/wt/x" });
  });

  it("last worktree-add segment wins when a command chains two of them", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: {
          command:
            "git worktree add -b feat/first /tmp/wt/first main && git worktree add -b feat/second /tmp/wt/second main",
        },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/second", worktree: "/tmp/wt/second" });
  });

  it("detects git -C <path> worktree add", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: { command: "git -C /repo worktree add -b feat/y /repo/.worktrees/y main" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/y", worktree: "/repo/.worktrees/y" });
  });

  it("detects git -c <key>=<value> worktree add (config override, common in CI/agent scripts)", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: {
          command: "git -c core.hooksPath=/dev/null worktree add -b feat/z /repo/.worktrees/z main",
        },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/z", worktree: "/repo/.worktrees/z" });
  });

  it("detects git worktree add with multiple leading -c/-C global flags in any order", () => {
    expect(
      detectWorktreeAdd({
        tool_name: "Bash",
        tool_input: {
          command: "git -c a.b=c -C /repo -c d.e=f worktree add -b feat/w /repo/.worktrees/w main",
        },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/w", worktree: "/repo/.worktrees/w" });
  });

  it("returns raw relative path when resolveCwd is provided but a cd precedes the worktree add", () => {
    // When `cd` changes directory before the `git worktree add`,
    // resolveCwd (the starting cwd) is no longer correct for resolution.
    // Returning the raw relative path preserves the pre-resolveCwd behavior:
    // downstream rejects it via the absolute-path guard.
    expect(
      detectWorktreeAdd(
        {
          tool_name: "Bash",
          tool_input: {
            command: "cd /other/dir && git worktree add -b feat/x .worktrees/feat/x main",
          },
        },
        "/workspace/repo",
      ),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: ".worktrees/feat/x",
    });
  });

  it("treats cd in a later segment (after the worktree add) as not affecting resolution", () => {
    // `cd` after a matched segment should not block resolution.
    expect(
      detectWorktreeAdd(
        {
          tool_name: "Bash",
          tool_input: {
            command: "git worktree add -b feat/x .worktrees/feat/x main && cd /other/dir",
          },
        },
        "/workspace/repo",
      ),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: "/workspace/repo/.worktrees/feat/x",
    });
  });

  it("resolves relative worktree path against git -C target when provided with resolveCwd", () => {
    expect(
      detectWorktreeAdd(
        {
          tool_name: "Bash",
          tool_input: {
            command: "git -C /other/dir worktree add -b feat/x .worktrees/feat/x main",
          },
        },
        "/workspace/repo",
      ),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: "/other/dir/.worktrees/feat/x",
    });
  });

  it("resolves relative worktree path against last -C when multiple are given", () => {
    expect(
      detectWorktreeAdd(
        {
          tool_name: "Bash",
          tool_input: {
            command: "git -C /first -C /second worktree add -b feat/x .worktrees/feat/x main",
          },
        },
        "/workspace/repo",
      ),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: "/second/.worktrees/feat/x",
    });
  });

  it("passes absolute worktree path through unchanged even with git -C and resolveCwd", () => {
    expect(
      detectWorktreeAdd(
        {
          tool_name: "Bash",
          tool_input: {
            command: "git -C /other/dir worktree add -b feat/x /abs/path main",
          },
        },
        "/workspace/repo",
      ),
    ).toEqual({
      kind: "git_branch",
      branch: "feat/x",
      worktree: "/abs/path",
    });
  });
});

describe("detectGitCheckout (issue: sidebar worktree detection)", () => {
  it("detects git switch <branch> and returns git_branch with no worktree", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git switch feat/foo" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/foo" });
  });

  it("detects git switch -c <branch> (new branch)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git switch -c feat/new" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/new" });
  });

  it("detects git checkout -b <branch> (new branch)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git checkout -b feat/new" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/new" });
  });

  it("detects git checkout <branch> (bare ref switch)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git checkout main" },
      }),
    ).toEqual({ kind: "git_branch", branch: "main" });
  });

  it("returns null for git checkout -- <file> (pathspec restore, not a branch switch)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git checkout -- src/index.ts" },
      }),
    ).toBeNull();
  });

  it("returns null for git checkout <ref> <path> (file restore from a ref)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git checkout main src/index.ts" },
      }),
    ).toBeNull();
  });

  it("returns null for git checkout . (discard working-tree changes, not a branch switch)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git checkout ." },
      }),
    ).toBeNull();
  });

  it("returns null for git checkout <file> (restoring a single tracked file)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git checkout package.json" },
      }),
    ).toBeNull();
  });

  it("returns null for git checkout <glob> (pathspec, not a branch name)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git checkout src/*.ts" },
      }),
    ).toBeNull();
  });

  it("still returns a branch for a path-like git switch argument — switch has no file-restore form to be ambiguous with", () => {
    // `git switch` has no file-restore form, so a single positional is
    // always treated as a branch name, even one that looks path-like.
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git switch some.branch" },
      }),
    ).toEqual({ kind: "git_branch", branch: "some.branch" });
  });

  it("detects git checkout - (switch to the previously-checked-out branch)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git checkout -" },
      }),
    ).toEqual({ kind: "git_branch", branch: "-" });
  });

  it("detects git switch - (switch to the previously-checked-out branch)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git switch -" },
      }),
    ).toEqual({ kind: "git_branch", branch: "-" });
  });

  it("returns null for a non-checkout git command", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
    ).toBeNull();
  });

  it("returns null for a non-git command", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      }),
    ).toBeNull();
  });

  it("returns null for a non-Bash tool", () => {
    expect(
      detectGitCheckout({
        tool_name: "Write",
        tool_input: { file_path: "/workspace/a.ts" },
      }),
    ).toBeNull();
  });

  it("returns null for an empty command", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "" },
      }),
    ).toBeNull();
  });

  it("returns null when tool_input is missing entirely", () => {
    expect(detectGitCheckout({ tool_name: "Bash" })).toBeNull();
  });

  it("detects a checkout chained after another command with && (cd X && git checkout Y)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "cd /workspace/project && git checkout feat/chained" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/chained" });
  });

  it("last checkout segment wins when a command chains two of them", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git checkout feat/first && git checkout feat/second" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/second" });
  });

  it("still rejects a file-restore-shaped segment even inside a chained command", () => {
    // A chained command whose git segment is still an ambiguous file-restore
    // form (extension-bearing filename) must not start matching just
    // because segment-splitting was added — same false-positive guard as
    // the un-chained case, applied per segment.
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "npm ci && git checkout package.json" },
      }),
    ).toBeNull();
  });

  it("detects git -C <path> checkout <branch>", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git -C /workspace/project checkout feat/dash-c" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/dash-c" });
  });

  it("detects git -C <path> switch <branch>", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git -C /workspace/project switch feat/dash-c-switch" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/dash-c-switch" });
  });

  it("detects git -c <key>=<value> checkout <branch> (config override, common in CI/agent scripts)", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git -c core.hooksPath=/dev/null checkout feat/config-override" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/config-override" });
  });

  it("detects git checkout with multiple leading -c/-C global flags in any order", () => {
    expect(
      detectGitCheckout({
        tool_name: "Bash",
        tool_input: { command: "git -c a.b=c -C /repo -c d.e=f checkout feat/multi-flag" },
      }),
    ).toEqual({ kind: "git_branch", branch: "feat/multi-flag" });
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

describe("mapClaudeCodeEvent cwd piggyback (issue: worktree/branch detection)", () => {
  it("leaves a single-object result untouched when payload has no cwd", () => {
    expect(mapClaudeCodeEvent("Notification", { message: "hi" })).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "hi",
    });
  });

  it("appends a cwd_changed message when payload.cwd is present, even for an event whose own mapper returns nothing (a PostToolUse with no tool_name)", () => {
    expect(mapClaudeCodeEvent("PostToolUse", { cwd: "/workspace/project" })).toEqual([
      { kind: "cwd_changed", cwd: "/workspace/project" },
    ]);
  });

  it("appends cwd_changed BEFORE a single-object mapped result (Notification)", () => {
    expect(
      mapClaudeCodeEvent("Notification", { message: "hi", cwd: "/workspace/project" }),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/workspace/project" },
      { kind: "notification", title: "Claude Code", body: "hi" },
    ]);
  });

  it("appends cwd_changed BEFORE a git_branch result from PostToolUse, so a fresh worktree's cwd wins over the stale pre-command one", () => {
    const result = mapClaudeCodeEvent("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git worktree add -b feat/x /tmp/wt/x main" },
      cwd: "/workspace/project",
    });
    expect(result).toEqual([
      { kind: "cwd_changed", cwd: "/workspace/project" },
      { kind: "git_branch", branch: "feat/x", worktree: "/tmp/wt/x" },
      { kind: "tool_done", tool: "Bash" },
    ]);
  });

  it("does NOT piggyback for the CwdChanged event itself (its base cwd is the pre-change directory, not new_cwd)", () => {
    expect(
      mapClaudeCodeEvent("CwdChanged", {
        old_cwd: "/workspace/src",
        new_cwd: "/workspace/src/lib",
        cwd: "/workspace/src",
      }),
    ).toEqual({ kind: "cwd_changed", cwd: "/workspace/src/lib" });
  });

  it("ignores an empty-string cwd the same as a missing one", () => {
    expect(mapClaudeCodeEvent("Notification", { message: "hi", cwd: "" })).toEqual({
      kind: "notification",
      title: "Claude Code",
      body: "hi",
    });
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

  it("extracts errorType alongside errorDetails", () => {
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

  it("extracts exitCode when present", () => {
    expect(mapClaudeCodeSessionEnd({ reason: "crashed", exit_code: 1 })).toEqual({
      kind: "session_end",
      reason: "crashed",
      exitCode: 1,
    });
  });
});

describe("mapClaudeCodeUserPromptSubmit (issue: extend surfaced session statuses)", () => {
  it("maps to turn_start with no fields", () => {
    expect(mapClaudeCodeUserPromptSubmit()).toEqual({ kind: "turn_start" });
  });
});

describe("mapClaudeCodePreCompact / mapClaudeCodePostCompact", () => {
  it("maps PreCompact to compact: started, carrying the trigger", () => {
    expect(mapClaudeCodePreCompact({ trigger: "manual" })).toEqual({
      kind: "compact",
      state: "started",
      trigger: "manual",
    });
  });

  it("maps PreCompact without a recognized trigger to compact: started alone", () => {
    expect(mapClaudeCodePreCompact({})).toEqual({ kind: "compact", state: "started" });
  });

  it("maps PostCompact to compact: finished", () => {
    expect(mapClaudeCodePostCompact()).toEqual({ kind: "compact", state: "finished" });
  });
});

describe("mapClaudeCodeSubagentStart / mapClaudeCodeSubagentStop", () => {
  it("maps SubagentStart to subagent: started, carrying agentType", () => {
    expect(mapClaudeCodeSubagentStart({ agent_type: "Explore" })).toEqual({
      kind: "subagent",
      state: "started",
      agentType: "Explore",
    });
  });

  it("maps SubagentStart without an agentType to subagent: started alone", () => {
    expect(mapClaudeCodeSubagentStart({})).toEqual({ kind: "subagent", state: "started" });
  });

  it("maps SubagentStop to subagent: finished", () => {
    expect(mapClaudeCodeSubagentStop()).toEqual({ kind: "subagent", state: "finished" });
  });

  // Issue #428 — SubagentStop is the drain signal for a background
  // subagent's own outstanding work; mirrors mapClaudeCodeStop's own
  // background_tasks forwarding above.
  it("maps SubagentStop to subagent: finished with backgroundTasks when present", () => {
    const tasks = [{ id: "t1", type: "subagent", status: "completed", description: "Explore" }];
    expect(mapClaudeCodeSubagentStop({ background_tasks: tasks })).toEqual({
      kind: "subagent",
      state: "finished",
      backgroundTasks: tasks,
    });
  });

  it("maps SubagentStop with both last_assistant_message and background_tasks", () => {
    const tasks = [{ id: "t1", type: "shell", status: "running", description: "tail logs" }];
    expect(
      mapClaudeCodeSubagentStop({ last_assistant_message: "Done.", background_tasks: tasks }),
    ).toEqual({
      kind: "subagent",
      state: "finished",
      summary: "Done.",
      backgroundTasks: tasks,
    });
  });

  it("ignores non-array background_tasks on SubagentStop", () => {
    expect(mapClaudeCodeSubagentStop({ background_tasks: "not-an-array" })).toEqual({
      kind: "subagent",
      state: "finished",
    });
  });
});

describe("mapClaudeCodePermissionDenied", () => {
  it("maps to permission_resolved with no fields", () => {
    expect(mapClaudeCodePermissionDenied()).toEqual({ kind: "permission_resolved" });
  });
});

describe("mapClaudeCodeElicitation / mapClaudeCodeElicitationResult", () => {
  it("maps Elicitation to elicitation: started, carrying the server", () => {
    expect(mapClaudeCodeElicitation({ server: "my-mcp-server" })).toEqual({
      kind: "elicitation",
      state: "started",
      server: "my-mcp-server",
    });
  });

  it("maps Elicitation without a server to elicitation: started alone", () => {
    expect(mapClaudeCodeElicitation({})).toEqual({ kind: "elicitation", state: "started" });
  });

  it("maps ElicitationResult to elicitation: finished", () => {
    expect(mapClaudeCodeElicitationResult()).toEqual({ kind: "elicitation", state: "finished" });
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
      { kind: "cwd_changed", cwd: "/workspace" },
      { kind: "git_branch", branch: "feat/foo", worktree: "/workspace/.worktrees/foo" },
    ]);
  });

  it("returns git_branch + cwd_changed for a Bash git checkout command", () => {
    expect(
      mapCodexPostToolUse({
        tool_name: "Bash",
        tool_input: { command: "git checkout feat/bar" },
        cwd: "/workspace",
      }),
    ).toEqual([
      { kind: "cwd_changed", cwd: "/workspace" },
      { kind: "git_branch", branch: "feat/bar" },
    ]);
  });

  it("returns cwd_changed alone for a Bash command that is not a worktree add or checkout", () => {
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
      { kind: "cwd_changed", cwd: "/repo" },
      { kind: "git_branch", branch: "fix", worktree: "/tmp/wt" },
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

  it("dispatches UserPromptSubmit to turn_start (issue: extend surfaced session statuses — previously a generic notification)", () => {
    expect(mapCodexEvent("UserPromptSubmit", { prompt: "fix the bug" })).toEqual({
      kind: "turn_start",
    });
  });
});

describe("mapCodexUserPromptSubmit (issue: extend surfaced session statuses)", () => {
  it("maps to turn_start with no fields", () => {
    // Takes no parameters (unlike Claude Code's own UserPromptSubmit
    // dispatch, this one never needed the raw payload) — CodeQL flagged an
    // earlier revision of both this test and its call site in
    // mapCodexEvent for passing a superfluous argument here.
    expect(mapCodexUserPromptSubmit()).toEqual({ kind: "turn_start" });
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
      { kind: "cwd_changed", cwd: "/workspace/project" },
      { kind: "git_branch", branch: "feat/wt-1", worktree: "/tmp/wt-1" },
      {
        kind: "review_gate",
        state: "waiting",
        prompt: "run_command: git worktree add -b feat/wt-1 /tmp/wt-1 main",
      },
    ]);
  });

  it("maps PreToolUse with a plain git checkout run_command to git_branch (no worktree) + cwd_changed + review_gate", () => {
    const result = mapAgyEvent("PreToolUse", {
      toolCall: {
        name: "run_command",
        args: {
          CommandLine: "git checkout feat/bar",
          Cwd: "/workspace/project",
        },
      },
    });
    expect(result).toEqual([
      { kind: "cwd_changed", cwd: "/workspace/project" },
      { kind: "git_branch", branch: "feat/bar" },
      {
        kind: "review_gate",
        state: "waiting",
        prompt: "run_command: git checkout feat/bar",
      },
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

  describe("SessionStart (issue #321)", () => {
    it("maps SessionStart to a session_start message", () => {
      expect(mapAgyEvent("SessionStart", {})).toEqual({ kind: "session_start" });
    });

    it("carries source through when present", () => {
      expect(mapAgyEvent("SessionStart", { source: "startup" })).toEqual({
        kind: "session_start",
        source: "startup",
      });
    });
  });

  describe("SessionEnd (issue #321)", () => {
    it("maps SessionEnd to a session_end message", () => {
      expect(mapAgyEvent("SessionEnd", { reason: "clear" })).toEqual({
        kind: "session_end",
        reason: "clear",
      });
    });

    it("defaults reason to 'other' when missing", () => {
      expect(mapAgyEvent("SessionEnd", {})).toEqual({
        kind: "session_end",
        reason: "other",
      });
    });
  });
});

// Issue: extend surfaced session statuses — the mechanical check that keeps
// each adapter's `emits` capability list (hook-adapters/*.ts) from drifting
// out of sync with what its own forwarder mapper can actually produce, the
// same way docs/agent-hooks.md drifted from the real hook wiring. For every
// event an adapter registers, feeds a representative payload through its
// mapper and asserts every resulting kind is declared in that adapter's
// `emits`. Deliberately one-directional (declared-but-unproduced-by-this-
// payload is fine; produced-but-undeclared is not) — a richer payload could
// always reveal one more reachable kind, but an undeclared one reaching the
// frontend's capability-filtered UI would be a real, user-visible bug.
describe("hook adapter emits capability parity (issue: extend surfaced session statuses)", () => {
  function kindsOf(mapped) {
    if (mapped === null || mapped === undefined) return [];
    return Array.isArray(mapped) ? mapped.map((m) => m.kind) : [mapped.kind];
  }

  it("claude-code: every registered hook event's mapped kind(s) are declared in emits", () => {
    const settings = buildClaudeHookSettings("/forwarder");
    const payloadsByEvent = {
      Notification: [{ message: "hi" }],
      Stop: [{}],
      SessionStart: [{ source: "startup" }],
      CwdChanged: [{ new_cwd: "/tmp" }],
      PostToolUse: [
        { tool_name: "Write", tool_input: { file_path: "x" } },
        { tool_name: "Bash", tool_input: { command: "git worktree add -b fix /tmp/wt" } },
      ],
      PermissionRequest: [{ tool_name: "Bash", tool_input: { command: "npm test" } }],
      StopFailure: [{ error: "rate_limit" }],
      PostToolUseFailure: [{ tool_name: "Bash", error: "boom" }],
      SessionEnd: [{ reason: "clear" }],
      PreToolUse: [{ tool_name: "ExitPlanMode", tool_input: { plan: "1. Fix" } }],
      UserPromptSubmit: [{ prompt: "fix the bug" }],
      PreCompact: [{ trigger: "auto" }],
      PostCompact: [{}],
      SubagentStart: [{ agent_type: "Explore" }],
      SubagentStop: [{}],
      PermissionDenied: [{}],
      Elicitation: [{ server: "my-mcp" }],
      ElicitationResult: [{}],
    };

    const registeredEvents = Object.keys(settings.hooks);
    expect(registeredEvents.length).toBeGreaterThan(0);
    for (const event of registeredEvents) {
      expect(
        payloadsByEvent[event],
        `no test payload declared for registered event ${event}`,
      ).toBeDefined();
      for (const payload of payloadsByEvent[event]) {
        for (const kind of kindsOf(mapClaudeCodeEvent(event, payload))) {
          expect(claudeCodeAdapter.emits).toContain(kind);
        }
      }
    }
  });

  it("codex: every registered hook event's mapped kind(s) are declared in emits", () => {
    // Hand-listed rather than derived from mergeCodexHooks — that function
    // performs real file I/O (reads/writes ~/.codex/hooks.json), which a
    // pure mapper-parity test shouldn't need to touch. Matches the six
    // events codex.ts's mergeCodexHooks registers.
    const payloadsByEvent = {
      Stop: [{}],
      SessionStart: [{ source: "startup" }],
      SessionEnd: [{ reason: "clear" }],
      PermissionRequest: [{ tool_name: "Bash", tool_input: { command: "npm test" } }],
      UserPromptSubmit: [{ prompt: "fix the bug" }],
      PostToolUse: [
        { tool_name: "apply_patch", tool_input: { command: "*** Update File: a.ts" } },
        {
          tool_name: "Bash",
          tool_input: { command: "git worktree add -b fix /tmp/wt" },
          cwd: "/repo",
        },
      ],
    };

    for (const [event, payloads] of Object.entries(payloadsByEvent)) {
      for (const payload of payloads) {
        for (const kind of kindsOf(mapCodexEvent(event, payload))) {
          expect(codexAdapter.emits).toContain(kind);
        }
      }
    }
  });

  it("agy: every registered hook event's mapped kind(s) are declared in emits", () => {
    // Hand-listed rather than derived from mergeAgyHooks — same file-I/O
    // reasoning as the codex case above. Matches the five hooks agy.ts's
    // mergeAgyHooks registers (issue #321 added SessionStart/SessionEnd).
    const payloadsByEvent = {
      Stop: [{}, { terminationReason: "error", error: "boom" }],
      PreToolUse: [
        {
          toolCall: {
            name: "run_command",
            args: { CommandLine: "git worktree add -b fix /tmp/wt", Cwd: "/repo" },
          },
        },
      ],
      PostToolUse: [{ toolCall: { name: "write_to_file", args: { TargetFile: "/tmp/x" } } }],
      SessionStart: [{}, { source: "startup" }],
      SessionEnd: [{ reason: "clear" }, {}],
    };

    for (const [event, payloads] of Object.entries(payloadsByEvent)) {
      for (const payload of payloads) {
        // PreToolUse(run_command) always ALSO constructs a review_gate
        // message at the mapper level — the runtime gate that actually
        // decides whether it's sent lives one layer up, in forwarder.mjs's
        // MULLION_REVIEW_GATE_ENABLED check, which this mapper-level test
        // doesn't exercise. Excluded here for the same reason AGY_EMITS's
        // own doc comment excludes review_gate from the declared list.
        const kinds = kindsOf(mapAgyEvent(event, payload)).filter((k) => k !== "review_gate");
        for (const kind of kinds) {
          expect(agyAdapter.emits).toContain(kind);
        }
      }
    }
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
    expect(formatGateDecision("agy", "denied", "unsafe")).toEqual({
      decision: "deny",
      reason: "unsafe",
    });
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
