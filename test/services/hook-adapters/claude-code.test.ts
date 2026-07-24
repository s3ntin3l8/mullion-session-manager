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

describe("buildClaudeHookSettings (issue #174)", () => {
  const settings = buildClaudeHookSettings("/abs/path/forwarder.mjs", "/abs/path/node");

  it("registers only Notification, Stop, and PostToolUse by default — PreToolUse (the blocking review gate) is opt-in (MULLION_REVIEW_GATE_ENABLED)", () => {
    expect(Object.keys(settings.hooks).sort()).toEqual(["Notification", "PostToolUse", "Stop"]);
  });

  it("each hook command invokes the node binary and forwarder with the claude-code agent tag", () => {
    const notificationCommand = settings.hooks.Notification[0].hooks[0].command;
    expect(notificationCommand).toContain('"/abs/path/node"');
    expect(notificationCommand).toContain('"/abs/path/forwarder.mjs"');
    expect(notificationCommand).toContain("claude-code Notification");
  });

  it("restricts PostToolUse to the file-editing tools via matcher", () => {
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Write|Edit|MultiEdit|NotebookEdit");
  });

  it("defaults the node binary to process.execPath when not overridden", () => {
    const defaultSettings = buildClaudeHookSettings("/abs/path/forwarder.mjs");
    expect(defaultSettings.hooks.Stop[0].hooks[0].command).toContain(
      JSON.stringify(process.execPath),
    );
  });

  describe("with includeReviewGate: true (issue #178, MULLION_REVIEW_GATE_ENABLED=true)", () => {
    const gatedSettings = buildClaudeHookSettings(
      "/abs/path/forwarder.mjs",
      "/abs/path/node",
      true,
    );

    it("also registers PreToolUse", () => {
      expect(Object.keys(gatedSettings.hooks).sort()).toEqual([
        "Notification",
        "PostToolUse",
        "PreToolUse",
        "Stop",
      ]);
    });

    it("restricts PreToolUse (the review gate) to Bash only, with a much longer timeout than the fire-and-forget hooks", () => {
      expect(gatedSettings.hooks.PreToolUse[0].matcher).toBe("Bash");
      expect(gatedSettings.hooks.PreToolUse[0].hooks[0].timeout).toBe(300);
      expect(gatedSettings.hooks.Notification[0].hooks[0].timeout).toBe(10);
      const command = gatedSettings.hooks.PreToolUse[0].hooks[0].command;
      expect(command).toContain("claude-code PreToolUse");
    });
  });
});

describe("claudeCodeAdapter.prepareLaunch (issue #174)", () => {
  const ctx: HookAdapterContext = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    forwarderPath: "/abs/path/forwarder.mjs",
    reviewGateEnabled: false,
  };

  it("writes a per-session settings file under sessionsDir", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.settingsFiles).toHaveLength(1);
    expect(plan.settingsFiles?.[0].path).toBe("/tmp/mullion-sessions/42.hooks.json");
    const parsed = JSON.parse(plan.settingsFiles?.[0].contents ?? "{}");
    expect(parsed.hooks.Notification).toBeDefined();
  });

  it("does not include PreToolUse in the written settings file when reviewGateEnabled is false", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    const parsed = JSON.parse(plan.settingsFiles?.[0].contents ?? "{}");
    expect(parsed.hooks.PreToolUse).toBeUndefined();
  });

  it("includes PreToolUse in the written settings file when reviewGateEnabled is true", () => {
    const plan = claudeCodeAdapter.prepareLaunch({ ...ctx, reviewGateEnabled: true });
    const parsed = JSON.parse(plan.settingsFiles?.[0].contents ?? "{}");
    expect(parsed.hooks.PreToolUse).toBeDefined();
  });

  it("appends --settings <path> to the command via commandTransform", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform?.("claude")).toBe(
      'claude --settings "/tmp/mullion-sessions/42.hooks.json"',
    );
  });

  it("never sets envAdditions or managedInstall — fully ephemeral, no other launch requirements", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.envAdditions).toBeUndefined();
    expect(plan.managedInstall).toBeUndefined();
  });
});
