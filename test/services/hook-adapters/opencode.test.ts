import { describe, it, expect } from "vitest";
import { openCodeAdapter } from "../../../src/services/hook-adapters/opencode.js";
import { sessionAgentGuidePath } from "../../../src/services/agent-guide.js";

describe("openCodeAdapter.matches (issue #175)", () => {
  it("matches a bare opencode invocation", () => {
    expect(openCodeAdapter.matches("opencode")).toBe(true);
  });

  it("matches opencode with trailing arguments", () => {
    expect(openCodeAdapter.matches("opencode --continue")).toBe(true);
  });

  it("matches a path-qualified opencode", () => {
    expect(openCodeAdapter.matches("/usr/local/bin/opencode")).toBe(true);
  });

  it("does not match a different program", () => {
    expect(openCodeAdapter.matches("bash")).toBe(false);
  });

  it("does not match opencode as a substring of another program name", () => {
    expect(openCodeAdapter.matches("opencode-wrapper")).toBe(false);
  });

  it("tolerates leading/trailing whitespace around a simple invocation", () => {
    expect(openCodeAdapter.matches("  opencode  ")).toBe(true);
  });
});

describe("openCodeAdapter.prepareLaunch (issue #175)", () => {
  // injectAgentGuide: false here — the plugin-file/OPENCODE_CONFIG_DIR
  // mechanics under test in this describe block are independent of the
  // agent-guide injection added in issue #437c; that gate has its own
  // describe block below so these assertions don't also need to account for
  // OPENCODE_CONFIG_CONTENT.
  const ctx = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    reviewGateEnabled: false,
    injectAgentGuide: false,
  };

  it("writes the plugin file under a per-session ephemeral plugins/ subdirectory", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.settingsFiles).toHaveLength(1);
    expect(plan.settingsFiles?.[0].path).toBe(
      "/tmp/mullion-sessions/42.opencode-config/plugins/mullion-hook-emitter.js",
    );
    expect(plan.settingsFiles?.[0].contents).toContain("MullionHookEmitter");
  });

  it("points OPENCODE_CONFIG_DIR at the same ephemeral directory", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.envAdditions).toEqual({
      OPENCODE_CONFIG_DIR: "/tmp/mullion-sessions/42.opencode-config",
    });
  });

  it("never rewrites the command — OPENCODE_CONFIG_DIR is env-only", () => {
    const plan = openCodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform).toBeUndefined();
    expect(plan.managedInstall).toBeUndefined();
  });
});

describe("openCodeAdapter.prepareLaunch — agent-guide injection (issue #437c)", () => {
  const baseCtx = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/path/forwarder.mjs",
    reviewGateEnabled: false,
  };

  // `vitest run` has process.cwd() at the repo root, same as
  // agent-guide.test.ts relies on — docs/agent-guide.md genuinely exists,
  // so agentGuideSourceExists() is true here with no mock needed.
  it("points OPENCODE_CONFIG_CONTENT's instructions at this session's own guide file when the setting is on", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: true });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeDefined();
    expect(JSON.parse(plan.envAdditions!.OPENCODE_CONFIG_CONTENT)).toEqual({
      instructions: [sessionAgentGuidePath("/tmp/mullion-sessions", "42")],
    });
  });

  it("still sets OPENCODE_CONFIG_DIR alongside OPENCODE_CONFIG_CONTENT", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: true });
    expect(plan.envAdditions?.OPENCODE_CONFIG_DIR).toBe("/tmp/mullion-sessions/42.opencode-config");
  });

  it("omits OPENCODE_CONFIG_CONTENT entirely when the setting is off — mirrors hooks.ts gating the pointer, not the on-disk write, for every other agent", () => {
    const plan = openCodeAdapter.prepareLaunch({ ...baseCtx, injectAgentGuide: false });
    expect(plan.envAdditions).toEqual({
      OPENCODE_CONFIG_DIR: "/tmp/mullion-sessions/42.opencode-config",
    });
    expect(plan.envAdditions?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});

describe("OPENCODE_EMITS (issue #321)", () => {
  it("includes compact for session.compacting events", () => {
    expect(openCodeAdapter.emits).toContain("compact");
  });

  it("includes subagent for session.subagent events", () => {
    expect(openCodeAdapter.emits).toContain("subagent");
  });
});
