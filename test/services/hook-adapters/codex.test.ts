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
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    injectAgentGuide: false,
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

  it("creates hooks.json with all hook groups when none exists", async () => {
    const plan = codexAdapter.prepareLaunch(ctx());
    await plan.managedInstall?.();

    const written = readHooks();
    expect(written.hooks.Stop).toHaveLength(1);
    expect(written.hooks.SessionStart).toHaveLength(1);
    expect(written.hooks.SessionEnd).toHaveLength(1);
    expect(written.hooks.PermissionRequest).toHaveLength(1);
    expect(written.hooks.UserPromptSubmit).toHaveLength(1);
    expect(written.hooks.PostToolUse).toHaveLength(2);
    expect(written.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(written.hooks.PostToolUse[1].matcher).toBe("Bash");
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
    expect(written.hooks.SessionStart).toHaveLength(2);
    expect(
      written.hooks.SessionStart?.some(
        (g: { hooks: Array<{ command: string }> }) => g.hooks[0].command === "./greet.sh",
      ),
    ).toBe(true);
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
    expect(written.hooks.SessionStart).toHaveLength(1);
    expect(written.hooks.SessionEnd).toHaveLength(1);
    expect(written.hooks.PermissionRequest).toHaveLength(1);
    expect(written.hooks.UserPromptSubmit).toHaveLength(1);
    expect(written.hooks.PostToolUse).toHaveLength(2);
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

  it("prunes a stale group from a previous release, not just the current forwarder path (issue #460)", async () => {
    const staleForwarderPath = "/opt/mullion/releases/0.2.1/dist/hooks/forwarder.mjs";
    const staleGroup = (kind: string, matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [
        {
          type: "command",
          command: `"/opt/mullion/releases/0.2.1/node" ${JSON.stringify(staleForwarderPath)} codex ${kind}`,
          statusMessage: "Mullion agent-hook forwarder — safe to remove, see docs/agent-hooks.md",
          timeout: 10,
        },
      ],
    });
    // Hermes review, PR #464 — a user-authored group that merely MENTIONS
    // "forwarder.mjs" (but isn't shaped like a Mullion-written command: no
    // quoted-forwarder-path-then-" codex <Kind>" tail) must survive the
    // prune. Without this fixture, a discriminator weakened to a bare
    // `includes("forwarder.mjs")` check would still pass every other
    // assertion in this test.
    const userForwarderMention =
      '"/usr/bin/node" "/home/user/scripts/forwarder.mjs" --watch --verbose';
    writeFileSync(
      path.join(codexHome, "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            staleGroup("Stop"),
            { hooks: [{ type: "command", command: "./my-own-script.sh" }] },
            { hooks: [{ type: "command", command: userForwarderMention }] },
          ],
          SessionStart: [staleGroup("SessionStart")],
          SessionEnd: [staleGroup("SessionEnd")],
          PermissionRequest: [staleGroup("PermissionRequest")],
          UserPromptSubmit: [staleGroup("UserPromptSubmit")],
          PostToolUse: [
            staleGroup("PostToolUse", "apply_patch"),
            staleGroup("PostToolUse", "Bash"),
          ],
        },
      }),
    );

    const plan = codexAdapter.prepareLaunch(ctx());
    await plan.managedInstall?.();

    const written = readHooks();
    // Exactly one Mullion group per event afterward, pointing at the
    // CURRENT forwarder path — the stale-release group is gone, not merely
    // supplemented — except Stop, whose two non-Mullion fixtures (checked
    // explicitly below) push its count to 3.
    for (const [event, expectedLength] of [
      ["Stop", 3],
      ["SessionStart", 1],
      ["SessionEnd", 1],
      ["PermissionRequest", 1],
      ["UserPromptSubmit", 1],
      ["PostToolUse", 2],
    ] as const) {
      expect(written.hooks[event]).toHaveLength(expectedLength);
    }
    const currentForwarderCommand = (kind: string) =>
      `"${process.execPath}" "/abs/install/hooks/forwarder.mjs" codex ${kind}`;
    for (const [event, kind] of [
      ["SessionStart", "SessionStart"],
      ["SessionEnd", "SessionEnd"],
      ["PermissionRequest", "PermissionRequest"],
      ["UserPromptSubmit", "UserPromptSubmit"],
    ] as const) {
      expect(written.hooks[event][0].hooks[0].command).toBe(currentForwarderCommand(kind));
    }
    // Stop: exactly the current Mullion group plus both untouched
    // user-authored fixtures — nothing stale, nothing dropped.
    const stopCommands = written.hooks.Stop.map(
      (g: { hooks: Array<{ command: string }> }) => g.hooks[0].command,
    );
    expect(stopCommands).toEqual(
      expect.arrayContaining([
        currentForwarderCommand("Stop"),
        "./my-own-script.sh",
        userForwarderMention,
      ]),
    );
    expect(stopCommands).toHaveLength(3);
    expect(stopCommands).not.toContain(staleForwarderPath);
  });
});
