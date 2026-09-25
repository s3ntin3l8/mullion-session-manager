import { describe, it, expect } from "vitest";
import { claudeCodeAdapter } from "../../../src/services/hook-adapters/claude-code.js";
import { codexAdapter } from "../../../src/services/hook-adapters/codex.js";
import { agyAdapter } from "../../../src/services/hook-adapters/agy.js";
import { buildModelFlag } from "../../../src/services/hook-adapters/shared.js";
import { commandModelCli } from "../../../src/services/hook-adapters/index.js";
import type { HookAdapterContext } from "../../../src/services/hook-adapters/types.js";

function ctx(model?: string): HookAdapterContext {
  return {
    sessionId: "7",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "tok",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    injectAgentGuide: false,
    model,
  };
}

describe("buildModelFlag", () => {
  it("returns empty without a model", () => {
    expect(buildModelFlag("claude", undefined)).toBe("");
  });
  it("single-quotes the model", () => {
    expect(buildModelFlag("claude", "sonnet")).toBe(" --model 'sonnet'");
    expect(buildModelFlag("claude", "a'b")).toBe(` --model 'a'\\''b'`);
  });
  it("defers to an explicit --model / --model= on the command", () => {
    expect(buildModelFlag("claude --model opus", "sonnet")).toBe("");
    expect(buildModelFlag("claude --model=opus", "sonnet")).toBe("");
  });
  it("defers to -m only when a short flag is declared", () => {
    expect(buildModelFlag("codex -m o3", "gpt-5", "-m")).toBe("");
    expect(buildModelFlag("codex -m o3", "gpt-5")).toBe(" --model 'gpt-5'");
  });
});

describe("model injection per adapter", () => {
  it("claude-code appends --model", () => {
    const out = claudeCodeAdapter.prepareLaunch(ctx("opus")).commandTransform?.("claude");
    expect(out).toMatch(/ --model 'opus'$/);
  });
  it("claude-code adds no --model without a model", () => {
    const out = claudeCodeAdapter.prepareLaunch(ctx()).commandTransform?.("claude");
    expect(out).not.toContain("--model");
  });
  it("codex appends --model", () => {
    const out = codexAdapter.prepareLaunch(ctx("gpt-5")).commandTransform?.("codex");
    expect(out).toMatch(/ --model 'gpt-5'$/);
  });
  it("codex respects an existing -m", () => {
    const out = codexAdapter.prepareLaunch(ctx("gpt-5")).commandTransform?.("codex -m o3");
    expect(out).not.toContain("--model");
  });
  it("agy appends --model when a model resolved", () => {
    const out = agyAdapter.prepareLaunch(ctx("gemini-3")).commandTransform?.("agy");
    expect(out).toBe("agy --model 'gemini-3'");
  });
  it("agy has no commandTransform without a model", () => {
    expect(agyAdapter.prepareLaunch(ctx()).commandTransform).toBeUndefined();
  });
  it("agy leaves a chained command untouched", () => {
    expect(agyAdapter.prepareLaunch(ctx("m")).commandTransform?.("agy && ls")).toBe("agy && ls");
  });
});

describe("commandModelCli", () => {
  it("classifies each CLI and rejects others", () => {
    expect(commandModelCli("claude")).toBe("claude-code");
    expect(commandModelCli("codex")).toBe("codex");
    expect(commandModelCli("agy")).toBe("agy");
    expect(commandModelCli("opencode")).toBeNull();
    expect(commandModelCli("bash")).toBeNull();
  });
});
