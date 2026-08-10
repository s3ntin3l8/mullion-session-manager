import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { agyAdapter, __testing } from "../../../src/services/hook-adapters/agy.js";

const { mergeAgyHooks, mergeAgyMcpConfig, mergeAgyTrustedWorkspace, MULLION_HOOK_NAME } = __testing;

describe("agyAdapter.matches (issue #253)", () => {
  it("matches a bare agy invocation", () => {
    expect(agyAdapter.matches("agy")).toBe(true);
  });

  it("matches agy with trailing arguments", () => {
    expect(agyAdapter.matches("agy --continue")).toBe(true);
  });

  it("matches a path-qualified agy", () => {
    expect(agyAdapter.matches("/usr/local/bin/agy")).toBe(true);
  });

  it("does not match a different program", () => {
    expect(agyAdapter.matches("bash")).toBe(false);
  });

  it("does not match agy as a substring of another program name", () => {
    expect(agyAdapter.matches("agy-wrapper")).toBe(false);
  });
});

describe("agyAdapter.prepareLaunch (issue #253)", () => {
  const ctx = {
    sessionId: "1",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "tok",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    reviewGateEnabled: false,
    injectAgentGuide: false,
  };

  it("returns only a managedInstall — no argv edit, no ephemeral files/env", () => {
    const plan = agyAdapter.prepareLaunch(ctx);
    expect(typeof plan.managedInstall).toBe("function");
    expect(plan.commandTransform).toBeUndefined();
    expect(plan.settingsFiles).toBeUndefined();
    expect(plan.envAdditions).toBeUndefined();
  });
});

// Exercises the merge logic directly against a scratch path via the
// `__testing` export, rather than the real default `~/.gemini/config/
// hooks.json` — agy has no documented env var to relocate its config
// directory the way Codex's CODEX_HOME does, so this is the only way to
// test the merge without ever touching the real developer/CI-runner's own
// Antigravity config.
describe("mergeAgyHooks (issue #253)", () => {
  let dir: string;
  let hooksPath: string;

  const ctx = () => ({
    sessionId: "1",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "tok",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    reviewGateEnabled: false,
    injectAgentGuide: false,
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-agy-config-"));
    hooksPath = path.join(dir, "nested", "hooks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readHooks() {
    return JSON.parse(readFileSync(hooksPath, "utf8"));
  }

  it("creates hooks.json with Stop, PreToolUse, and PostToolUse groups", () => {
    mergeAgyHooks(ctx(), hooksPath);

    const written = readHooks();
    // Stop group
    expect(written[MULLION_HOOK_NAME].Stop).toEqual([
      {
        type: "command",
        command: expect.stringContaining("/abs/install/hooks/forwarder.mjs"),
        timeout: 10,
      },
    ]);
    expect(written[MULLION_HOOK_NAME].Stop[0].command).toContain("agy Stop");

    // PreToolUse group for run_command (worktree detection + review gate)
    expect(written[MULLION_HOOK_NAME].PreToolUse).toHaveLength(1);
    expect(written[MULLION_HOOK_NAME].PreToolUse[0].matcher).toBe("run_command");
    expect(written[MULLION_HOOK_NAME].PreToolUse[0].hooks[0].command).toContain("agy PreToolUse");
    expect(written[MULLION_HOOK_NAME].PreToolUse[0].hooks[0].timeout).toBe(300);

    // PostToolUse group for file-change tools (best-effort)
    expect(written[MULLION_HOOK_NAME].PostToolUse).toHaveLength(1);
    expect(written[MULLION_HOOK_NAME].PostToolUse[0].matcher).toBe(
      "write_to_file|replace_file_content|multi_replace_file_content",
    );
    expect(written[MULLION_HOOK_NAME].PostToolUse[0].hooks[0].command).toContain("agy PostToolUse");
  });

  it("preserves unrelated hook names the user already configured", () => {
    const flatPath = path.join(dir, "hooks.json");
    writeFileSync(
      flatPath,
      JSON.stringify({
        "my-own-hook": { Stop: [{ type: "command", command: "./my-script.sh" }] },
      }),
    );

    mergeAgyHooks(ctx(), flatPath);

    const written = JSON.parse(readFileSync(flatPath, "utf8"));
    expect(written["my-own-hook"]).toEqual({
      Stop: [{ type: "command", command: "./my-script.sh" }],
    });
    expect(written[MULLION_HOOK_NAME]).toBeDefined();
  });

  it("is idempotent — re-running replaces only its own key", () => {
    mergeAgyHooks(ctx(), hooksPath);
    mergeAgyHooks(ctx(), hooksPath);

    const written = readHooks();
    expect(Object.keys(written)).toEqual([MULLION_HOOK_NAME]);
    expect(written[MULLION_HOOK_NAME].Stop).toHaveLength(1);
    expect(written[MULLION_HOOK_NAME].PreToolUse).toHaveLength(1);
    expect(written[MULLION_HOOK_NAME].PostToolUse).toHaveLength(1);
  });

  it("bails without writing when the existing hooks.json is malformed JSON", () => {
    const flatPath = path.join(dir, "hooks.json");
    writeFileSync(flatPath, "not json at all");

    expect(() => mergeAgyHooks(ctx(), flatPath)).toThrow(/cannot parse/);
    expect(readFileSync(flatPath, "utf8")).toBe("not json at all");
  });
});

// agy's own folder-trust prompt ("Do you trust the contents of this
// project?") is verified NOT suppressed by --dangerously-skip-permissions —
// see agy.ts's own doc comment above mergeAgyTrustedWorkspace. Exercised
// against a scratch settings.json, same posture as mergeAgyHooks above,
// never the real ~/.gemini/antigravity-cli/settings.json.
describe("mergeAgyTrustedWorkspace", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-agy-trust-"));
    settingsPath = path.join(dir, "nested", "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates settings.json (including missing parent dirs) with the cwd trusted", () => {
    mergeAgyTrustedWorkspace(
      "/home/bjoern/projects/foo/.mullion-worktrees/mullion-task-1",
      settingsPath,
    );

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.trustedWorkspaces).toEqual([
      "/home/bjoern/projects/foo/.mullion-worktrees/mullion-task-1",
    ]);
  });

  it("appends to, rather than replaces, an existing trustedWorkspaces list", () => {
    const flatPath = path.join(dir, "settings.json");
    writeFileSync(flatPath, JSON.stringify({ trustedWorkspaces: ["/home/bjoern/projects/foo"] }));

    mergeAgyTrustedWorkspace(
      "/home/bjoern/projects/foo/.mullion-worktrees/mullion-task-1",
      flatPath,
    );

    const written = JSON.parse(readFileSync(flatPath, "utf8"));
    expect(written.trustedWorkspaces).toEqual([
      "/home/bjoern/projects/foo",
      "/home/bjoern/projects/foo/.mullion-worktrees/mullion-task-1",
    ]);
  });

  it("preserves unrelated settings keys (agentMode, permissions, etc.)", () => {
    const flatPath = path.join(dir, "settings.json");
    writeFileSync(
      flatPath,
      JSON.stringify({
        agentMode: "plan",
        permissions: { allow: ["command(git)"] },
        trustedWorkspaces: ["/home/bjoern"],
      }),
    );

    mergeAgyTrustedWorkspace("/home/bjoern/projects/foo", flatPath);

    const written = JSON.parse(readFileSync(flatPath, "utf8"));
    expect(written.agentMode).toBe("plan");
    expect(written.permissions).toEqual({ allow: ["command(git)"] });
  });

  it("is idempotent — re-running with an already-trusted cwd doesn't duplicate the entry", () => {
    mergeAgyTrustedWorkspace("/home/bjoern/projects/foo", settingsPath);
    mergeAgyTrustedWorkspace("/home/bjoern/projects/foo", settingsPath);

    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.trustedWorkspaces).toEqual(["/home/bjoern/projects/foo"]);
  });

  it("bails without writing when the existing settings.json is malformed JSON", () => {
    const flatPath = path.join(dir, "settings.json");
    writeFileSync(flatPath, "not json at all");

    expect(() => mergeAgyTrustedWorkspace("/home/bjoern/projects/foo", flatPath)).toThrow(
      /cannot parse/,
    );
    expect(readFileSync(flatPath, "utf8")).toBe("not json at all");
  });

  // Hermes review, PR #573 — valid JSON with a wrong-shaped
  // trustedWorkspaces is a different failure mode than unparseable JSON:
  // a string would otherwise spread into individual characters (silent
  // corruption of the user's real settings.json); an object would throw
  // on `.includes` deeper in the function with a less clear error.
  it("bails without writing when trustedWorkspaces is a string, not an array", () => {
    const flatPath = path.join(dir, "settings.json");
    writeFileSync(flatPath, JSON.stringify({ trustedWorkspaces: "/home/bjoern" }));

    expect(() => mergeAgyTrustedWorkspace("/home/bjoern/projects/foo", flatPath)).toThrow(
      /trustedWorkspaces is not an array/,
    );
    const written = JSON.parse(readFileSync(flatPath, "utf8"));
    expect(written.trustedWorkspaces).toBe("/home/bjoern");
  });

  it("bails without writing when trustedWorkspaces is an object, not an array", () => {
    const flatPath = path.join(dir, "settings.json");
    writeFileSync(flatPath, JSON.stringify({ trustedWorkspaces: { foo: "bar" } }));

    expect(() => mergeAgyTrustedWorkspace("/home/bjoern/projects/foo", flatPath)).toThrow(
      /trustedWorkspaces is not an array/,
    );
    const written = JSON.parse(readFileSync(flatPath, "utf8"));
    expect(written.trustedWorkspaces).toEqual({ foo: "bar" });
  });

  // Hermes review, PR #573 — ctx.cwd reaches mergeAgyTrustedWorkspace with
  // no path.resolve applied upstream (pty-manager.ts's `this.cwd`); a
  // relative path must still match what agy itself would store.
  it("normalizes a relative cwd to an absolute path before storing it", () => {
    const flatPath = path.join(dir, "settings.json");
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      mergeAgyTrustedWorkspace("relative/worktree", flatPath);
    } finally {
      process.chdir(originalCwd);
    }

    const written = JSON.parse(readFileSync(flatPath, "utf8"));
    expect(written.trustedWorkspaces).toEqual([path.join(dir, "relative/worktree")]);
  });
});

describe("mergeAgyMcpConfig (issue #253, issue #271)", () => {
  let dir: string;
  let mcpConfigPath: string;

  const ctx = () => ({
    sessionId: "1",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "tok",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    reviewGateEnabled: false,
    injectAgentGuide: false,
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-agy-mcp-"));
    mcpConfigPath = path.join(dir, "nested", "mcp_config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readMcpConfig() {
    return JSON.parse(readFileSync(mcpConfigPath, "utf8"));
  }

  it("creates mcp_config.json (including missing parent dirs) with a mullion stdio entry", () => {
    mergeAgyMcpConfig(ctx(), mcpConfigPath);

    const written = readMcpConfig();
    expect(written.mcpServers.mullion).toEqual({
      type: "stdio",
      command: expect.any(String),
      args: [expect.stringContaining("server.mjs")],
      env: {
        MULLION_HOOK_SOCKET: "/tmp/mullion-sessions/hooks.sock",
        MULLION_HOOK_TOKEN: "tok",
        MULLION_SOCKET_PATH: "/tmp/mullion-sessions/mullion.sock",
      },
    });
  });

  it("preserves existing non-Mullion MCP servers", () => {
    const flatPath = path.join(dir, "mcp_config.json");
    writeFileSync(
      flatPath,
      JSON.stringify({
        mcpServers: {
          "github-mcp": {
            type: "stdio",
            command: "/usr/bin/npx",
            args: ["@github/mcp"],
          },
        },
      }),
    );

    mergeAgyMcpConfig(ctx(), flatPath);

    const written = JSON.parse(readFileSync(flatPath, "utf8"));
    expect(written.mcpServers["github-mcp"]).toBeDefined();
    expect(written.mcpServers.mullion).toBeDefined();
  });

  it("is idempotent — re-running replaces only the mullion entry, preserving other servers", () => {
    const flatPath = path.join(dir, "mcp_config.json");
    writeFileSync(
      flatPath,
      JSON.stringify({
        mcpServers: {
          "github-mcp": {
            type: "stdio",
            command: "/usr/bin/npx",
            args: ["@github/mcp"],
          },
        },
      }),
    );

    mergeAgyMcpConfig(ctx(), flatPath);
    mergeAgyMcpConfig(ctx(), flatPath, "/usr/local/bin/node");

    const written = JSON.parse(readFileSync(flatPath, "utf8"));
    expect(written.mcpServers["github-mcp"]).toBeDefined();
    expect(written.mcpServers.mullion.command).toBe("/usr/local/bin/node");
    expect(Object.keys(written.mcpServers).sort()).toEqual(["github-mcp", "mullion"]);
  });

  it("bails without writing when the existing mcp_config.json is malformed JSON", () => {
    const flatPath = path.join(dir, "mcp_config.json");
    writeFileSync(flatPath, "not json at all");

    expect(() => mergeAgyMcpConfig(ctx(), flatPath)).toThrow(/cannot parse/);
    expect(readFileSync(flatPath, "utf8")).toBe("not json at all");
  });

  it("handles a file that exists but has no mcpServers key", () => {
    const flatPath = path.join(dir, "mcp_config.json");
    writeFileSync(flatPath, JSON.stringify({ someOtherKey: true }));

    mergeAgyMcpConfig(ctx(), flatPath);

    const written = JSON.parse(readFileSync(flatPath, "utf8"));
    expect(written.mcpServers.mullion).toBeDefined();
    expect(written.someOtherKey).toBe(true);
  });
});

describe("AGY_EMITS (issue #321)", () => {
  it("includes session_start for SessionStart events", () => {
    expect(agyAdapter.emits).toContain("session_start");
  });

  it("does not include session_end — a registered SessionEnd hook never fires (issue #461)", () => {
    expect(agyAdapter.emits).not.toContain("session_end");
  });
});

describe("mergeAgyHooks SessionStart (issue #321)", () => {
  let dir: string;
  let hooksPath: string;

  const ctx = () => ({
    sessionId: "1",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "tok",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    reviewGateEnabled: false,
    injectAgentGuide: false,
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-agy-session-hooks-"));
    hooksPath = path.join(dir, "hooks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers SessionStart hook with the forwarder", () => {
    mergeAgyHooks(ctx(), hooksPath);

    const written = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(written[MULLION_HOOK_NAME].SessionStart).toBeDefined();
    expect(written[MULLION_HOOK_NAME].SessionStart).toHaveLength(1);
    expect(written[MULLION_HOOK_NAME].SessionStart[0].type).toBe("command");
    expect(written[MULLION_HOOK_NAME].SessionStart[0].command).toContain("agy SessionStart");
  });

  it("does not register a SessionEnd hook — it never fires, verified empirically (issue #461)", () => {
    mergeAgyHooks(ctx(), hooksPath);

    const written = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(written[MULLION_HOOK_NAME].SessionEnd).toBeUndefined();
  });
});
