import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { HookAdapterContext } from "../../../src/services/hook-adapters/types.js";

const mockResolveMullionBundleDir = vi.fn((): string | null => "/opt/mullion/dist/bundle");
const mockComposeClaudeSessionBundle = vi.fn(
  (): Array<{ path: string; contents: string }> | null => [
    { path: "/composed/.claude-plugin/plugin.json", contents: "{}" },
  ],
);
vi.mock("../../../src/services/hook-adapters/mullion-bundle.js", () => ({
  resolveMullionBundleDir: () => mockResolveMullionBundleDir(),
  composeClaudeSessionBundle: (destDir: string, content: unknown) =>
    mockComposeClaudeSessionBundle(destDir, content),
}));

// Issue #941 — defaults to "not synced" everywhere, matching today's
// per-session --plugin-dir behavior; the dedicated describe block below
// flips this to exercise the new fallback-skip path.
const mockIsBundleSyncedFor = vi.fn((_cli: string): boolean => false);
vi.mock("../../../src/services/bundle-sync.js", () => ({
  isBundleSyncedFor: (cli: string) => mockIsBundleSyncedFor(cli),
}));

const {
  buildClaudeHookSettings,
  claudeCodeAdapter,
  resolveClaudeConfigDir,
  resolveClaudePluginCacheDir,
} = await import("../../../src/services/hook-adapters/claude-code.js");

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

  it("PreToolUse has exactly one entry, ExitPlanMode — the Bash gate it used to also register was replaced by PermissionRequest-based approval (issue #264)", () => {
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

  it("SessionEnd has a 2s timeout (just above Claude Code's 1.5s default)", () => {
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(2);
  });

  it("StopFailure and PostToolUseFailure have the default 10s fire-and-forget timeout", () => {
    expect(settings.hooks.StopFailure[0].hooks[0].timeout).toBe(10);
    expect(settings.hooks.PostToolUseFailure[0].hooks[0].timeout).toBe(10);
  });

  it("PermissionRequest is registered unconditionally with the long 300s permission-approval timeout, not the 10s fire-and-forget default (issue #264)", () => {
    expect(settings.hooks.PermissionRequest).toHaveLength(1);
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBe(300);
    const command = settings.hooks.PermissionRequest[0].hooks[0].command;
    expect(command).toContain("claude-code PermissionRequest");
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
    injectAgentGuide: false,
    injectMullionBundle: false,
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

  it("includes exactly one PreToolUse entry, ExitPlanMode, and registers PermissionRequest unconditionally (issue #264)", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    const parsed = JSON.parse(plan.settingsFiles?.[0].contents ?? "{}");
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("ExitPlanMode");
    expect(parsed.hooks.PermissionRequest[0].hooks[0].timeout).toBe(300);
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

describe("claudeCodeAdapter.prepareLaunch — Mullion tooling bundle (--plugin-dir)", () => {
  const ctx: HookAdapterContext = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    injectAgentGuide: false,
    injectProjectBriefing: false,
    injectMullionBundle: true,
  };

  beforeEach(() => {
    mockResolveMullionBundleDir.mockClear();
    mockResolveMullionBundleDir.mockReturnValue("/opt/mullion/dist/bundle");
  });

  it("appends --plugin-dir <bundleDir> after --settings/--mcp-config when injectMullionBundle is on and the bundle exists", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform?.("claude")).toBe(
      'claude --settings "/tmp/mullion-sessions/42.hooks.json" --mcp-config "/tmp/mullion-sessions/42.mcp.json" --plugin-dir "/opt/mullion/dist/bundle"',
    );
  });

  it("omits --plugin-dir when injectMullionBundle is false, without even resolving the bundle dir", () => {
    const plan = claudeCodeAdapter.prepareLaunch({ ...ctx, injectMullionBundle: false });
    expect(plan.commandTransform?.("claude")).not.toContain("--plugin-dir");
    expect(mockResolveMullionBundleDir).not.toHaveBeenCalled();
  });

  it("omits --plugin-dir when the bundle isn't shipped on this install, even though injectMullionBundle is on", () => {
    mockResolveMullionBundleDir.mockReturnValue(null);
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform?.("claude")).not.toContain("--plugin-dir");
  });
});

// Issue #941 — once bundle-sync.ts's boot-time sync has globally installed
// the shipped bundle for claude-code, the plain "no project content"
// --plugin-dir branch becomes redundant and should be skipped.
describe("claudeCodeAdapter.prepareLaunch — bundle-sync fallback (issue #941)", () => {
  const ctx: HookAdapterContext = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    injectAgentGuide: false,
    injectProjectBriefing: false,
    injectMullionBundle: true,
  };

  beforeEach(() => {
    mockResolveMullionBundleDir.mockClear();
    mockResolveMullionBundleDir.mockReturnValue("/opt/mullion/dist/bundle");
    mockIsBundleSyncedFor.mockClear();
  });

  afterEach(() => {
    mockIsBundleSyncedFor.mockReturnValue(false);
  });

  it("omits --plugin-dir for the shipped bundle once bundle-sync reports claude-code as synced", () => {
    mockIsBundleSyncedFor.mockReturnValue(true);
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform?.("claude")).not.toContain("--plugin-dir");
    expect(mockIsBundleSyncedFor).toHaveBeenCalledWith("claude-code");
  });

  it("still emits --plugin-dir when bundle-sync reports claude-code as NOT synced (today's behavior)", () => {
    mockIsBundleSyncedFor.mockReturnValue(false);
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform?.("claude")).toContain('--plugin-dir "/opt/mullion/dist/bundle"');
  });

  it("never even checks bundle-sync status when injectMullionBundle is off", () => {
    mockIsBundleSyncedFor.mockReturnValue(true);
    const plan = claudeCodeAdapter.prepareLaunch({ ...ctx, injectMullionBundle: false });
    expect(plan.commandTransform?.("claude")).not.toContain("--plugin-dir");
    expect(mockIsBundleSyncedFor).not.toHaveBeenCalled();
  });
});

// PR-5 — a project with its own skill/reviewer content gets a per-session
// COMPOSED plugin dir instead of the static shipped one, per
// composeClaudeSessionBundle's own doc comment (mullion-bundle.ts).
describe("claudeCodeAdapter.prepareLaunch — per-project skill/reviewer composition", () => {
  const ctx: HookAdapterContext = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    injectAgentGuide: false,
    injectProjectBriefing: false,
    injectMullionBundle: true,
    projectSkill: "---\nname: my-skill\ndescription: d\n---\nbody",
  };

  beforeEach(() => {
    mockResolveMullionBundleDir.mockClear();
    mockResolveMullionBundleDir.mockReturnValue("/opt/mullion/dist/bundle");
    mockComposeClaudeSessionBundle.mockClear();
    mockComposeClaudeSessionBundle.mockReturnValue([
      {
        path: "/tmp/mullion-sessions/42.mullion-bundle/skills/my-skill/SKILL.md",
        contents: "body",
      },
    ]);
  });

  it("points --plugin-dir at the per-session composed dir, not the static shipped bundle", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform?.("claude")).toContain(
      '--plugin-dir "/tmp/mullion-sessions/42.mullion-bundle"',
    );
    expect(mockComposeClaudeSessionBundle).toHaveBeenCalledWith(
      "/tmp/mullion-sessions/42.mullion-bundle",
      { skill: ctx.projectSkill, reviewerAgent: undefined },
    );
    // resolveMullionBundleDir is still used internally by
    // composeClaudeSessionBundle (mocked away here), but this call site
    // itself never falls back to the plain shipped-dir resolution once
    // project content is present.
    expect(mockResolveMullionBundleDir).not.toHaveBeenCalled();
  });

  // Issue #941 — project content composition is a separate, always-per-session
  // mechanism, never gated on bundle-sync's global-install status.
  it("still composes the per-session dir even when bundle-sync reports claude-code as synced", () => {
    mockIsBundleSyncedFor.mockReturnValue(true);
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform?.("claude")).toContain(
      '--plugin-dir "/tmp/mullion-sessions/42.mullion-bundle"',
    );
    mockIsBundleSyncedFor.mockReturnValue(false);
  });

  it("includes composeClaudeSessionBundle's returned files in settingsFiles", () => {
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.settingsFiles).toContainEqual({
      path: "/tmp/mullion-sessions/42.mullion-bundle/skills/my-skill/SKILL.md",
      contents: "body",
    });
  });

  it("falls back to the plain shipped bundle when neither projectSkill nor projectReviewerAgent is set", () => {
    const plan = claudeCodeAdapter.prepareLaunch({
      ...ctx,
      projectSkill: undefined,
    });
    expect(plan.commandTransform?.("claude")).toContain('--plugin-dir "/opt/mullion/dist/bundle"');
    expect(mockComposeClaudeSessionBundle).not.toHaveBeenCalled();
  });

  it("omits --plugin-dir when composeClaudeSessionBundle returns null (no bundle shipped)", () => {
    mockComposeClaudeSessionBundle.mockReturnValue(null);
    const plan = claudeCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform?.("claude")).not.toContain("--plugin-dir");
  });
});

// Issue #470 — Claude Code resolves its entire user-scope config tree off
// CLAUDE_CONFIG_DIR when set, falling back to ~/.claude otherwise (verified
// statically against the installed 2.1.220 bundle: `Akl()` reads
// process.env.CLAUDE_CONFIG_DIR, `fn()` is `Akl() ?? path.join(homedir(),
// ".claude")`). agent-rules.ts's globalDir("claude-code"), skills.ts's global
// skills/plugin lookups, and claude-code-skills.ts's settings.json writer all
// used to hardcode ~/.claude directly, silently reading/writing a file Claude
// Code itself never touches on a CLAUDE_CONFIG_DIR host.
describe("claude-code.ts — config-dir resolvers (issue #470)", () => {
  let homeDir: string;
  const originalHome = process.env.HOME;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), "mullion-claude-code-home-"));
    process.env.HOME = homeDir;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    if (originalPluginCacheDir === undefined) delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
    else process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalPluginCacheDir;
    rmSync(homeDir, { recursive: true, force: true });
  });

  describe("resolveClaudeConfigDir", () => {
    it("resolves under ~/.claude when CLAUDE_CONFIG_DIR is unset", () => {
      expect(resolveClaudeConfigDir()).toBe(path.join(homeDir, ".claude"));
    });

    it("resolves under CLAUDE_CONFIG_DIR when set", () => {
      const configDir = mkdtempSync(path.join(os.tmpdir(), "mullion-claude-config-"));
      try {
        process.env.CLAUDE_CONFIG_DIR = configDir;
        expect(resolveClaudeConfigDir()).toBe(configDir);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    // Claude Code itself uses `??`, so CLAUDE_CONFIG_DIR="" resolves to the
    // empty string there. Mirroring that exactly would make every downstream
    // join cwd-relative — deliberately treated as unset instead (matching
    // resolveCodexHome()'s existing `||`).
    it("treats an empty CLAUDE_CONFIG_DIR as unset", () => {
      process.env.CLAUDE_CONFIG_DIR = "";
      expect(resolveClaudeConfigDir()).toBe(path.join(homeDir, ".claude"));
    });
  });

  describe("resolveClaudePluginCacheDir", () => {
    it("defaults to <configDir>/plugins", () => {
      expect(resolveClaudePluginCacheDir()).toBe(path.join(homeDir, ".claude", "plugins"));
    });

    it("follows CLAUDE_CONFIG_DIR when set", () => {
      const configDir = mkdtempSync(path.join(os.tmpdir(), "mullion-claude-config-"));
      try {
        process.env.CLAUDE_CONFIG_DIR = configDir;
        expect(resolveClaudePluginCacheDir()).toBe(path.join(configDir, "plugins"));
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it("prefers CLAUDE_CODE_PLUGIN_CACHE_DIR over the config dir", () => {
      const configDir = mkdtempSync(path.join(os.tmpdir(), "mullion-claude-config-"));
      const pluginCacheDir = mkdtempSync(path.join(os.tmpdir(), "mullion-claude-plugin-cache-"));
      try {
        process.env.CLAUDE_CONFIG_DIR = configDir;
        process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = pluginCacheDir;
        expect(resolveClaudePluginCacheDir()).toBe(pluginCacheDir);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
        rmSync(pluginCacheDir, { recursive: true, force: true });
      }
    });
  });
});
