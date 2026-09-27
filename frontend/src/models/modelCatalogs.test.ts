// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { commandHasModelFlag, commandModelCli } from "./modelCatalogs.js";

describe("commandModelCli", () => {
  it("identifies the model-capable CLIs by their bare binary name", () => {
    expect(commandModelCli("claude")).toBe("claude-code");
    expect(commandModelCli("codex")).toBe("codex");
    expect(commandModelCli("agy")).toBe("agy");
    expect(commandModelCli("opencode")).toBe("opencode");
  });

  it("strips a leading path and trailing args, same as commandToBinary", () => {
    expect(commandModelCli("/usr/bin/codex -m x")).toBe("codex");
    expect(commandModelCli("claude --dangerously-skip-permissions")).toBe("claude-code");
    expect(commandModelCli("opencode run")).toBe("opencode");
  });

  it("returns null for a command with no known model-capable CLI", () => {
    expect(commandModelCli("bash")).toBeNull();
    expect(commandModelCli("npm run build")).toBeNull();
    expect(commandModelCli("gemini")).toBeNull();
  });
});

describe("commandHasModelFlag", () => {
  it("detects an existing --model flag for claude-code/agy/opencode", () => {
    expect(commandHasModelFlag("claude --model opus", "claude-code")).toBe(true);
    expect(commandHasModelFlag("claude --model=opus", "claude-code")).toBe(true);
    expect(commandHasModelFlag("agy --model gemini-3", "agy")).toBe(true);
    expect(commandHasModelFlag("claude", "claude-code")).toBe(false);
  });

  it("also detects codex's short -m flag", () => {
    expect(commandHasModelFlag("codex -m gpt-6-sol", "codex")).toBe(true);
    expect(commandHasModelFlag("codex --model gpt-6-sol", "codex")).toBe(true);
    expect(commandHasModelFlag("codex", "codex")).toBe(false);
    // -m is codex-specific — claude-code doesn't get a false positive on it.
    expect(commandHasModelFlag("claude -m", "claude-code")).toBe(false);
  });

  it("is always false for opencode, which never reads --model out of the command line", () => {
    expect(commandHasModelFlag("opencode --model anthropic/claude-sonnet-4-5", "opencode")).toBe(
      false,
    );
  });
});
