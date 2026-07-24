import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { agyAdapter, __testing } from "../../../src/services/hook-adapters/agy.js";

const { mergeAgyHooks, MULLION_HOOK_NAME } = __testing;

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
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    reviewGateEnabled: false,
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
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    reviewGateEnabled: false,
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

  it("creates hooks.json (including missing parent dirs) with a flat Stop array", () => {
    mergeAgyHooks(ctx(), hooksPath);

    const written = readHooks();
    expect(written[MULLION_HOOK_NAME].Stop).toEqual([
      {
        type: "command",
        command: expect.stringContaining("/abs/install/hooks/forwarder.mjs"),
        timeout: 10,
      },
    ]);
    expect(written[MULLION_HOOK_NAME].Stop[0].command).toContain("agy Stop");
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
  });

  it("bails without writing when the existing hooks.json is malformed JSON", () => {
    const flatPath = path.join(dir, "hooks.json");
    writeFileSync(flatPath, "not json at all");

    expect(() => mergeAgyHooks(ctx(), flatPath)).toThrow(/cannot parse/);
    expect(readFileSync(flatPath, "utf8")).toBe("not json at all");
  });
});
