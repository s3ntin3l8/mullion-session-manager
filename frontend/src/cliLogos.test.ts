import { describe, it, expect } from "vitest";
import { resolveAgentLogo, resolveLauncherLogo } from "./cliLogos.js";
import type { Launcher } from "./api.js";

const DARK = "dark" as const;

describe("resolveAgentLogo", () => {
  it("resolves a bare known binary name", () => {
    expect(resolveAgentLogo("claude", DARK)).toBeTruthy();
    expect(resolveAgentLogo("opencode", DARK)).toBeTruthy();
  });

  it("resolves a command string with arguments", () => {
    expect(resolveAgentLogo("claude code", DARK)).toBe(resolveAgentLogo("claude", DARK));
    expect(resolveAgentLogo("opencode --model deepseek", DARK)).toBe(
      resolveAgentLogo("opencode", DARK),
    );
  });

  it("resolves a command string with a full path", () => {
    expect(resolveAgentLogo("/usr/bin/claude", DARK)).toBe(resolveAgentLogo("claude", DARK));
    expect(resolveAgentLogo("/home/user/.local/bin/opencode --flag", DARK)).toBe(
      resolveAgentLogo("opencode", DARK),
    );
  });

  it("returns null for an unknown binary", () => {
    expect(resolveAgentLogo("custom-tool", DARK)).toBeNull();
  });

  it("returns null for a shell command", () => {
    expect(resolveAgentLogo("bash", DARK)).toBeNull();
    expect(resolveAgentLogo("zsh", DARK)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(resolveAgentLogo("", DARK)).toBeNull();
  });
});

describe("resolveLauncherLogo", () => {
  function makeLauncher(overrides: Partial<Launcher>): Launcher {
    return {
      id: "agent:claude",
      title: "Claude Code",
      command: "claude",
      kind: "agent",
      ...overrides,
    };
  }

  it("resolves a detected agent launcher by id", () => {
    const launcher = makeLauncher({ id: "agent:claude" });
    expect(resolveLauncherLogo(launcher, DARK)).toBeTruthy();
  });

  it("returns null for a shell launcher", () => {
    const launcher = makeLauncher({ id: "shell:bash", kind: "shell" });
    expect(resolveLauncherLogo(launcher, DARK)).toBeNull();
  });

  it("returns null for an npm-script launcher", () => {
    const launcher = makeLauncher({
      id: "npm:test",
      kind: "npm-script",
    });
    expect(resolveLauncherLogo(launcher, DARK)).toBeNull();
  });

  it("uses launcher.icon when present", () => {
    const launcher = makeLauncher({ icon: "claude-ai" });
    expect(resolveLauncherLogo(launcher, DARK)).toBeTruthy();
  });
});
