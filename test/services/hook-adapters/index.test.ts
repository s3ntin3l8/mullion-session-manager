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
      ...overrides,
    };
  }

  it("returns the command unchanged with no env additions for a non-matching command", () => {
    const result = applyHookAdapters("bash", ctx());
    expect(result).toEqual({ command: "bash", envAdditions: {} });
  });

  it("rewrites the command and writes a settings file for a matching (claude) command", () => {
    const c = ctx();
    const result = applyHookAdapters("claude", c);
    expect(result.command).toBe(
      `claude --settings ${JSON.stringify(path.join(c.sessionsDir, "1.hooks.json"))}`,
    );
    expect(result.envAdditions).toEqual({});
    expect(existsSync(path.join(c.sessionsDir, "1.hooks.json"))).toBe(true);
    const written = JSON.parse(readFileSync(path.join(c.sessionsDir, "1.hooks.json"), "utf8"));
    expect(written.hooks.Notification).toBeDefined();
  });

  it("writes the settings file with 0600 permissions", () => {
    const c = ctx();
    applyHookAdapters("claude", c);
    const mode = statSync(path.join(c.sessionsDir, "1.hooks.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("falls back to the unmodified command and logs when the settings write fails", () => {
    const c = ctx({ sessionsDir: path.join(dir, "does-not-exist") });
    const errors: unknown[] = [];
    const result = applyHookAdapters("claude", c, { error: (obj) => errors.push(obj) });
    expect(result).toEqual({ command: "claude", envAdditions: {} });
    expect(errors).toHaveLength(1);
  });
});
