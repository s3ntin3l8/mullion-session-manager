import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexAdapter } from "../../../src/services/hook-adapters/codex.js";

describe("codexAdapter.matches (issue #252)", () => {
  it("matches a bare codex invocation", () => {
    expect(codexAdapter.matches("codex")).toBe(true);
  });

  it("matches codex with trailing arguments", () => {
    expect(codexAdapter.matches("codex --continue")).toBe(true);
  });

  it("matches a path-qualified codex", () => {
    expect(codexAdapter.matches("/usr/local/bin/codex")).toBe(true);
  });

  it("does not match a different program", () => {
    expect(codexAdapter.matches("bash")).toBe(false);
  });

  it("does not match codex as a substring of another program name", () => {
    expect(codexAdapter.matches("codex-wrapper")).toBe(false);
  });
});

describe("codexAdapter.prepareLaunch / managed hooks.json merge (issue #252)", () => {
  let codexHome: string;
  const originalCodexHome = process.env.CODEX_HOME;

  const ctx = () => ({
    sessionId: "1",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "tok",
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    reviewGateEnabled: false,
  });

  beforeEach(() => {
    codexHome = mkdtempSync(path.join(os.tmpdir(), "mullion-codex-home-"));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  function readHooks() {
    return JSON.parse(readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
  }

  it("creates hooks.json with Stop and PostToolUse groups when none exists", async () => {
    const plan = codexAdapter.prepareLaunch(ctx());
    await plan.managedInstall?.();

    const written = readHooks();
    expect(written.hooks.Stop).toHaveLength(1);
    expect(written.hooks.PostToolUse).toHaveLength(1);
    expect(written.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(written.hooks.Stop[0].hooks[0].command).toContain("/abs/install/hooks/forwarder.mjs");
    expect(written.hooks.Stop[0].hooks[0].command).toContain("codex Stop");
  });

  it("preserves unrelated hook groups the user already configured", async () => {
    writeFileSync(
      path.join(codexHome, "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "./my-own-script.sh" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "./greet.sh" }] }],
        },
      }),
    );

    const plan = codexAdapter.prepareLaunch(ctx());
    await plan.managedInstall?.();

    const written = readHooks();
    expect(written.hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "./greet.sh" }] },
    ]);
    expect(written.hooks.Stop).toHaveLength(2);
    expect(
      written.hooks.Stop.some(
        (g: { hooks: Array<{ command: string }> }) => g.hooks[0].command === "./my-own-script.sh",
      ),
    ).toBe(true);
    expect(
      written.hooks.Stop.some((g: { hooks: Array<{ command: string }> }) =>
        g.hooks[0].command.includes("forwarder.mjs"),
      ),
    ).toBe(true);
  });

  it("is idempotent — re-running replaces only its own group, not duplicating it", async () => {
    const plan = codexAdapter.prepareLaunch(ctx());
    await plan.managedInstall?.();
    await plan.managedInstall?.();

    const written = readHooks();
    expect(written.hooks.Stop).toHaveLength(1);
    expect(written.hooks.PostToolUse).toHaveLength(1);
  });

  it("bails without writing when the existing hooks.json is malformed JSON", async () => {
    writeFileSync(path.join(codexHome, "hooks.json"), "not json at all");

    const plan = codexAdapter.prepareLaunch(ctx());
    await expect(plan.managedInstall?.()).rejects.toThrow(/cannot parse/);

    expect(readFileSync(path.join(codexHome, "hooks.json"), "utf8")).toBe("not json at all");
  });

  it("never rewrites the command — Codex needs no argv edit", () => {
    const plan = codexAdapter.prepareLaunch(ctx());
    expect(plan.commandTransform).toBeUndefined();
    expect(plan.settingsFiles).toBeUndefined();
    expect(plan.envAdditions).toBeUndefined();
  });
});
