import { describe, it, expect } from "vitest";
import { openCodeAdapter } from "../../../src/services/hook-adapters/opencode.js";

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
  const ctx = {
    sessionId: "42",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "token123",
    forwarderPath: "/abs/path/forwarder.mjs",
    reviewGateEnabled: false,
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
