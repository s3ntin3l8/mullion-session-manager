import { describe, it, expect } from "vitest";
import {
  buildClaudeHookSettings,
  claudeCodeAdapter,
} from "../../../src/services/hook-adapters/claude-code.js";
import type { HookAdapterContext } from "../../../src/services/hook-adapters/types.js";

describe("claudeCodeAdapter.matches (issue #174)", () => {
  it("matches a bare claude invocation", () => {
    expect(claudeCodeAdapter.matches("claude")).toBe(true);
  });

  it("matches claude with trailing arguments", () => {
    expect(claudeCodeAdapter.matches("claude --continue")).toBe(true);
  });

  it("matches a path-qualified claude", () => {
    expect(claudeCodeAdapter.matches("/usr/local/bin/claude --continue")).toBe(true);
  });

  it("does not match a different program", () => {
    expect(claudeCodeAdapter.matches("bash")).toBe(false);
  });

  it("does not match claude as a substring of another program name", () => {
    expect(claudeCodeAdapter.matches("claude-wrapper")).toBe(false);
  });

  it("does not match a chained command even if it starts with claude", () => {
    expect(claudeCodeAdapter.matches("claude && npm test")).toBe(false);
  });

  it("does not match a piped command", () => {
    expect(claudeCodeAdapter.matches("echo hi | claude")).toBe(false);
  });

  it("does not match a redirected command", () => {
    expect(claudeCodeAdapter.matches("claude > out.log")).toBe(false);
  });

  it("tolerates leading/trailing whitespace around a simple invocation", () => {
    expect(claudeCodeAdapter.matches("  claude --continue  ")).toBe(true);
  });
});

describe("buildClaudeHookSettings", () => {
  const settings = buildClaudeHookSettings("/abs/path/forwarder.mjs", "/abs/path/node");

  it("registers all unconditional hooks: Notification, Stop, SessionStart, PostToolUse, PermissionRequest, StopFailure, PostToolUseFailure, SessionEnd, CwdChanged, PreToolUse (ExitPlanMode only), UserPromptSubmit, PreCompact, PostCompact, SubagentStart, SubagentStop, PermissionDenied, Elicitation, and ElicitationResult", () => {
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "CwdChanged",
      "Elicitation",
      "ElicitationResult",
      "Notification",
      "PermissionDenied",
      "PermissionRequest",
      "PostCompact",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "StopFailure",
      "SubagentStart",
      "SubagentStop",
      "UserPromptSubmit",
    ]);
  });

  it("PreToolUse has one entry (ExitPlanMode) by default, not Bash (the review gate)", () => {
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("ExitPlanMode");
  });

  it("each hook command invokes the node binary and forwarder with the claude-code agent tag", () => {
    const notificationCommand = settings.hooks.Notification[0].hooks[0].command;
    expect(notificationCommand).toContain('"/abs/path/node"');
    expect(notificationCommand).toContain('"/abs/path/forwarder.mjs"');
    expect(notificationCommand).toContain("claude-code Notification");
  });

  it("restricts PostToolUse to the file-editing tools, Bash, and the prompting tools via matcher", () => {
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit|NotebookEdit");
    expect(settings.hooks.PostToolUse[1].matcher).toBe("Bash");
    // Fix: status-clearing-semantics — the tools that can raise a
    // permission/plan dialog but aren't file edits or Bash.
    expect(settings.hooks.PostToolUse[2].matcher).toBe(
      "AskUserQuestion|WebFetch|WebSearch|ExitPlanMode|mcp__.*",
    );
  });

  it("defaults the node binary to process.execPath when not overridden", () => {
    const defaultSettings = buildClaudeHookSettings("/abs/path/forwarder.mjs");
    expect(defaultSettings.hooks.Stop[0].hooks[0].command).toContain(
      JSON.stringify(process.execPath),
    );
  });

  it("omits the Bash review gate when includeReviewGate is explicitly false", () => {
    const explicitlyOffSettings = buildClaudeHookSettings(
      "/abs/path/forwarder.mjs",
      "/abs/path/node",
      false,
    );
    expect(explicitlyOffSettings.hooks.PreToolUse).toHaveLength(1);
    expect(explicitlyOffSettings.hooks.PreToolUse[0].matcher).toBe("ExitPlanMode");
  });

  describe("with includeReviewGate: true", () => {
    const gatedSettings = buildClaudeHookSettings(
      "/abs/path/forwarder.mjs",
      "/abs/path/node",
      true,
    );

    it("PreToolUse gets a second entry (the Bash review gate)", () => {
      expect(gatedSettings.hooks.PreToolUse).toHaveLength(2);
      expect(gatedSettings.hooks.PreToolUse[0].matcher).toBe("ExitPlanMode");
      expect(gatedSettings.hooks.PreToolUse[1].matcher).toBe("Bash");
    });

    it("the Bash review gate has a 300s timeout, unlike the 10s fire-and-forget hooks", () => {
      expect(gatedSettings.hooks.PreToolUse[1].hooks[0].timeout).toBe(300);
      expect(gatedSettings.hooks.Notification[0].hooks[0].timeout).toBe(10);
      const command = gatedSettings.hooks.PreToolUse[1].hooks[0].command;
      expect(command).toContain("claude-code PreToolUse");
    });

    it("the ExitPlanMode entry still has the default 10s timeout (observational, not a gate)", () => {
      expect(gatedSettings.hooks.PreToolUse[0].hooks[0].timeout).toBe(10);
    });
  });

  it("SessionEnd has a 2s timeout (just above Claude Code's 1.5s default)", () => {
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(2);
  });

  it("PermissionRequest, StopFailure, PostToolUseFailure all have the default 10s timeout", () => {
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(10);
    expect(settings.hooks.StopFailure[0].hooks[0].timeout).toBe(10);
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].timeout).toBe(10);
  });
});

describe("claudeCodeAdapter.prepareLaunch (issue #174)", () => {
  const ctx: HookAdapterContext = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    reviewGateEnabled: false,
  };

  it("writes a per-session settings file and MCP config file under sessionsDir (issue #271)", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.settingsFiles).toHaveLength(2);
    expect(plan.settingsFiles?.[0].path).toBe("/tmp/mullion-sessions/42.hooks.json");
    const parsed = JSON.parse(plan.settingsFiles?.[0].contents ?? "{}");
    expect(parsed.hooks.Notification).toBeDefined();

    expect(plan.settingsFiles?.[1].path).toBe("/tmp/mullion-sessions/42.mcp.json");
    const mcpParsed = JSON.parse(plan.settingsFiles?.[1].contents ?? "{}");
    expect(mcpParsed.mcpServers.mullion).toMatchObject({
      type: "stdio",
      env: {
        MULLION_HOOK_SOCKET: ctx.hookSocketPath,
        MULLION_HOOK_TOKEN: ctx.hookToken,
        MULLION_SOCKET_PATH: ctx.controlSocketPath,
      },
    });
  });

  it("includes ExitPlanMode PreToolUse even when reviewGateEnabled is false", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    const parsed = JSON.parse(plan.settingsFiles?.[0].contents ?? "{}");
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("ExitPlanMode");
  });

  it("includes both ExitPlanMode and Bash PreToolUse entries when reviewGateEnabled is true", () => {
    const plan = claudeCodeAdapter.prepareLaunch({ ...ctx, reviewGateEnabled: true });
    const parsed = JSON.parse(plan.settingsFiles?.[0].contents ?? "{}");
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("ExitPlanMode");
    expect(parsed.hooks.PreToolUse[1].matcher).toBe("Bash");
  });

  it("appends --settings <path> and --mcp-config <path> to the command via commandTransform", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform?.("claude")).toBe(
      'claude --settings "/tmp/mullion-sessions/42.hooks.json" --mcp-config "/tmp/mullion-sessions/42.mcp.json"',
    );
  });

  it("never sets envAdditions or managedInstall — fully ephemeral, no other launch requirements", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.envAdditions).toBeUndefined();
    expect(plan.managedInstall).toBeUndefined();
  });
});
