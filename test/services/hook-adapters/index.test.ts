import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyHookAdapters } from "../../../src/services/hook-adapters/index.js";

describe("applyHookAdapters (issue #174)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // best-effort, only needed for the read-only-dir test below
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function ctx(overrides: Partial<Parameters<typeof applyHookAdapters>[1]> = {}) {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-hook-adapters-"));
    return {
      sessionId: "1",
      sessionsDir: dir,
      hookSocketPath: path.join(dir, "hooks.sock"),
      hookToken: "tok",
      forwarderPath: "/abs/forwarder.mjs",
      reviewGateEnabled: false,
      ...overrides,
    };
  }

  it("returns the command unchanged with no env additions for a non-matching command", () => {
    const result = applyHookAdapters("bash", ctx());
    expect(result).toEqual({ command: "bash", envAdditions: {}, matched: false });
  });

  it("rewrites the command and writes a settings file for a matching (claude) command", () => {
    const c = ctx();
    const result = applyHookAdapters("claude", c);
    expect(result.command).toBe(
      `claude --settings ${JSON.stringify(path.join(c.sessionsDir, "1.hooks.json"))}`,
    );
    expect(result.envAdditions).toEqual({});
    expect(result.matched).toBe(true);
    expect(existsSync(path.join(c.sessionsDir, "1.hooks.json"))).toBe(true);
    const written = JSON.parse(readFileSync(path.join(c.sessionsDir, "1.hooks.json"), "utf8"));
    expect(written.hooks.Notification).toBeDefined();
  });

  it("does not register the blocking PreToolUse gate by default (MULLION_REVIEW_GATE_ENABLED=false)", () => {
    const c = ctx();
    applyHookAdapters("claude", c);
    const written = JSON.parse(readFileSync(path.join(c.sessionsDir, "1.hooks.json"), "utf8"));
    expect(written.hooks.PreToolUse).toBeUndefined();
  });

  it("registers PreToolUse when reviewGateEnabled is true", () => {
    const c = ctx({ reviewGateEnabled: true });
    applyHookAdapters("claude", c);
    const written = JSON.parse(readFileSync(path.join(c.sessionsDir, "1.hooks.json"), "utf8"));
    expect(written.hooks.PreToolUse).toBeDefined();
  });

  it("writes the settings file with 0600 permissions", () => {
    const c = ctx();
    applyHookAdapters("claude", c);
    const mode = statSync(path.join(c.sessionsDir, "1.hooks.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("falls back to the unmodified command and logs when the settings write fails", () => {
    const c = ctx();
    // mkdirSync's `recursive: true` (added for issue #175's nested
    // <id>.opencode-config/plugins/ path) means a merely-nonexistent
    // directory no longer fails — it gets created. A genuinely unwritable
    // parent (chmod 0o500, restored in afterEach) is what actually forces
    // the write to fail now.
    chmodSync(c.sessionsDir, 0o500);
    const errors: unknown[] = [];
    const result = applyHookAdapters("claude", c, { error: (obj) => errors.push(obj) });
    expect(result).toEqual({ command: "claude", envAdditions: {}, matched: false });
    expect(errors).toHaveLength(1);
  });

  describe("OpenCode adapter (issue #175)", () => {
    it("writes the plugin file into a newly-created nested plugins/ directory and sets OPENCODE_CONFIG_DIR", () => {
      const c = ctx();
      const result = applyHookAdapters("opencode", c);
      const pluginPath = path.join(
        c.sessionsDir,
        "1.opencode-config",
        "plugins",
        "mullion-hook-emitter.js",
      );
      expect(existsSync(pluginPath)).toBe(true);
      expect(result).toEqual({
        command: "opencode",
        envAdditions: { OPENCODE_CONFIG_DIR: path.join(c.sessionsDir, "1.opencode-config") },
        matched: true,
      });
    });
  });
});
