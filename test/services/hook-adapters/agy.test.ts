import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { agyAdapter, __testing } from "../../../src/services/hook-adapters/agy.js";

const { mergeAgyHooks, mergeAgyMcpConfig, MULLION_HOOK_NAME } = __testing;

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

  it("includes session_end for SessionEnd events", () => {
    expect(agyAdapter.emits).toContain("session_end");
  });
});

describe("mergeAgyHooks SessionStart/SessionEnd (issue #321)", () => {
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

  it("registers SessionEnd hook with the forwarder", () => {
    mergeAgyHooks(ctx(), hooksPath);

    const written = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(written[MULLION_HOOK_NAME].SessionEnd).toBeDefined();
    expect(written[MULLION_HOOK_NAME].SessionEnd).toHaveLength(1);
    expect(written[MULLION_HOOK_NAME].SessionEnd[0].type).toBe("command");
    expect(written[MULLION_HOOK_NAME].SessionEnd[0].command).toContain("agy SessionEnd");
  });
});
