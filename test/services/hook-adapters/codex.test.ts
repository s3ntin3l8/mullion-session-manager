import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  codexAdapter,
  resolveCodexAgentsSkillsDir,
  buildCodexMcpFlags,
} from "../../../src/services/hook-adapters/codex.js";
import { forwarderHookCommand } from "../../../src/services/hook-adapters/forwarder-shim.js";
import {
  resolveMcpServerPath,
  escapeTomlBasicString,
} from "../../../src/services/hook-adapters/shared.js";

// Issue #880 (revised after Hermes review, PR #930) — pins
// buildCodexMcpFlags' exact TOML/argv output shape, with only the glue
// text (`-c `, `mcp_servers.mullion.command=`, `env_vars=[...]`)
// hand-written — not derived from the function under test. The
// commandTransform test below computes its own expectation by calling
// buildCodexMcpFlags again, which only proves prepareLaunch forwards the
// builder's output unmodified; it would stay green even if the builder's
// own shape drifted (e.g. reverting to an inline `env={...}` table
// carrying an actual secret VALUE — the exact regression Hermes caught:
// the first revision of this function put the hook token's value inline
// in argv, which stayed readable in this session's own long-lived
// `/proc/<pid>/cmdline` for the whole session, not just the spawn instant.
// `env_vars` forwards three CONSTANT, non-secret NAME strings instead —
// this test asserts no secret VALUE ever appears in the flags string, not
// just that the three names do).
describe("buildCodexMcpFlags (issue #880)", () => {
  it("builds two shell-quoted -c overrides using env_vars name-forwarding, not an inline env table", () => {
    const flags = buildCodexMcpFlags("/srv.mjs", "/usr/bin/node");
    expect(flags).toBe(
      [
        `-c 'mcp_servers.mullion.command="/usr/bin/node"'`,
        `-c 'mcp_servers.mullion.args=["/srv.mjs"]'`,
        `-c 'mcp_servers.mullion.env_vars=["MULLION_HOOK_SOCKET", "MULLION_HOOK_TOKEN", "MULLION_SOCKET_PATH"]'`,
      ].join(" "),
    );
  });

  it("escapes a mcpServerPath containing a double quote and a backslash — a real install path is arbitrary text", () => {
    const path_ = '/opt/mull"ion\\dist/server.mjs';
    const flags = buildCodexMcpFlags(path_, "/usr/bin/node");
    const escaped = escapeTomlBasicString(path_);
    expect(escaped).not.toBe(path_);
    expect(flags).toContain(`args=["${escaped}"]`);
  });
});

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

  // Issue #880, correction after an initial wrong placement — codexAdapter
  // still matches a chained/piped/redirected command (unlike Claude Code):
  // its PRIMARY mechanism, mergeCodexHooks, writes a real host-level config
  // file and doesn't care what the launch command looks like. Only
  // commandTransform's MCP `-c` flags are metacharacter-gated — see that
  // describe block below.
  it("still matches a chained command starting with codex — hooks/bundle-skills don't depend on the argv shape", () => {
    expect(codexAdapter.matches("codex && npm test")).toBe(true);
  });

  it("still matches a piped command", () => {
    expect(codexAdapter.matches("codex | tee run.log")).toBe(true);
  });

  it("still matches a redirected command", () => {
    expect(codexAdapter.matches("codex > out.log")).toBe(true);
  });
});

describe("codexAdapter.prepareLaunch / managed hooks.json merge (issue #252)", () => {
  let codexHome: string;
  let homeDir: string;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;

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
    // mergeCodexHooks now also installs the forwarder shim at a fixed
    // os.homedir()-derived location (forwarder-shim.ts) — HOME must be
    // redirected here too, or a test run writes into the real developer/
    // CI-runner's own ~/.mullion.
    homeDir = mkdtempSync(path.join(os.tmpdir(), "mullion-codex-fakehome-"));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
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
    // Issue #264 — the blocking permission-approval channel needs the long
    // timeout, not the fire-and-forget default every other hook here uses.
    expect(written.hooks.PermissionRequest[0].hooks[0].timeout).toBe(300);
    // The concurrent-gates investigation: this is the only affordance a
    // gate parked behind an already-pending one has in the terminal, so it
    // must point the user at Mullion rather than repeat the generic
    // "safe to remove" message every other hook group uses.
    expect(written.hooks.PermissionRequest[0].hooks[0].statusMessage).toBe(
      "Mullion is holding this approval — open Mullion and Approve/Deny it there (see docs/agent-hooks.md)",
    );
    expect(written.hooks.Stop[0].hooks[0].timeout).toBe(10);
    expect(written.hooks.Stop[0].hooks[0].statusMessage).toBe(
      "Mullion agent-hook forwarder — safe to remove, see docs/agent-hooks.md",
    );
    expect(written.hooks.UserPromptSubmit).toHaveLength(1);
    expect(written.hooks.PostToolUse).toHaveLength(2);
    expect(written.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(written.hooks.PostToolUse[1].matcher).toBe("Bash");
    expect(written.hooks.Stop[0].hooks[0].command).toBe(forwarderHookCommand("codex", "Stop"));

    // Issue: extend surfaced session statuses (Codex parity) — all four
    // fire-and-forget, observational only, default 10s timeout.
    expect(written.hooks.PreCompact).toHaveLength(1);
    expect(written.hooks.PreCompact[0].hooks[0].timeout).toBe(10);
    expect(written.hooks.PreCompact[0].hooks[0].command).toContain("codex PreCompact");
    expect(written.hooks.PostCompact).toHaveLength(1);
    expect(written.hooks.PostCompact[0].hooks[0].command).toContain("codex PostCompact");
    expect(written.hooks.SubagentStart).toHaveLength(1);
    expect(written.hooks.SubagentStart[0].hooks[0].command).toContain("codex SubagentStart");
    expect(written.hooks.SubagentStop).toHaveLength(1);
    expect(written.hooks.SubagentStop[0].hooks[0].command).toContain("codex SubagentStop");
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
      written.hooks.Stop.some(
        (g: { hooks: Array<{ command: string }> }) =>
          g.hooks[0].command === forwarderHookCommand("codex", "Stop"),
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
    expect(written.hooks.PreCompact).toHaveLength(1);
    expect(written.hooks.PostCompact).toHaveLength(1);
    expect(written.hooks.SubagentStart).toHaveLength(1);
    expect(written.hooks.SubagentStop).toHaveLength(1);
  });

  it("bails without writing when the existing hooks.json is malformed JSON", async () => {
    writeFileSync(path.join(codexHome, "hooks.json"), "not json at all");

    const plan = codexAdapter.prepareLaunch(ctx());
    await expect(plan.managedInstall?.()).rejects.toThrow(/cannot parse/);

    expect(readFileSync(path.join(codexHome, "hooks.json"), "utf8")).toBe("not json at all");
  });

  it("does not emit settingsFiles or envAdditions", () => {
    const plan = codexAdapter.prepareLaunch(ctx());
    expect(plan.settingsFiles).toBeUndefined();
    expect(plan.envAdditions).toBeUndefined();
  });

  // Issue #906 + issue #880, merged after a rebase conflict — both PRs
  // independently added a `commandTransform` to this same adapter
  // (--add-dir .git for sandbox escalations, and the MCP `-c` flags below),
  // combined into one function since only one may exist per adapter. See
  // codex.ts's own comment on the combined function for why --add-dir .git
  // is unconditional (safe on any command shape) while the MCP flags are
  // metacharacter-gated.
  describe("commandTransform (issue #906 + issue #880)", () => {
    const mcpFlags = () => buildCodexMcpFlags(resolveMcpServerPath());

    it("appends --add-dir .git, then the MCP -c flags, to the command", () => {
      const plan = codexAdapter.prepareLaunch(ctx());
      expect(plan.commandTransform).toBeDefined();
      expect(plan.commandTransform!("codex --sandbox workspace-write")).toBe(
        `codex --sandbox workspace-write --add-dir .git ${mcpFlags()}`,
      );
    });

    // Hermes review, PR #930 — no session-specific secret value (the
    // ctx() fixture's hookToken/hookSocketPath/controlSocketPath) may ever
    // appear in the transformed command string; only the constant env var
    // NAMES do, via env_vars.
    it("appends --add-dir .git and the MCP flags to a simple codex command, with no secret value in the result", () => {
      const plan = codexAdapter.prepareLaunch(ctx());
      const transformed = plan.commandTransform!("codex");
      expect(transformed).toBe(`codex --add-dir .git ${mcpFlags()}`);
      const c = ctx();
      expect(transformed).not.toContain(c.hookToken);
      expect(transformed).not.toContain(c.hookSocketPath);
      expect(transformed).not.toContain(c.controlSocketPath);
    });

    it("appends --add-dir .git alongside other flags", () => {
      const plan = codexAdapter.prepareLaunch(ctx());
      expect(plan.commandTransform!("codex -m o3 --sandbox workspace-write")).toBe(
        `codex -m o3 --sandbox workspace-write --add-dir .git ${mcpFlags()}`,
      );
    });

    it("appends --add-dir .git to a path-qualified codex command", () => {
      const plan = codexAdapter.prepareLaunch(ctx());
      expect(plan.commandTransform!("/usr/local/bin/codex -s workspace-write")).toBe(
        `/usr/local/bin/codex -s workspace-write --add-dir .git ${mcpFlags()}`,
      );
    });

    it("does not double-append --add-dir .git when already present", () => {
      const plan = codexAdapter.prepareLaunch(ctx());
      expect(plan.commandTransform!("codex --add-dir .git")).toBe(
        `codex --add-dir .git ${mcpFlags()}`,
      );
    });

    it("does not double-append when --add-dir .git appears mid-command", () => {
      const plan = codexAdapter.prepareLaunch(ctx());
      expect(plan.commandTransform!("codex --add-dir .git -m o3")).toBe(
        `codex --add-dir .git -m o3 ${mcpFlags()}`,
      );
    });

    // Issue #880, correction after an initial wrong placement — the
    // metacharacter guard lives in commandTransform, not matches(): a
    // chained command still matches this adapter (see the matches()
    // describe block above) and still gets hooks.json via managedInstall.
    // --add-dir .git is unconditional (safe on any command shape, per
    // codex.ts's own comment) and IS still appended even here; only the
    // MCP `-c` flags are skipped, since appending them to one piece of a
    // chain/pipe/redirect could attach them to the wrong command entirely.
    it("still appends --add-dir .git to a chained/piped/redirected command, but omits the MCP flags", () => {
      const plan = codexAdapter.prepareLaunch(ctx());
      expect(plan.commandTransform!("codex && npm test")).toBe("codex && npm test --add-dir .git");
      expect(plan.commandTransform!("echo hi | codex")).toBe("echo hi | codex --add-dir .git");
      expect(plan.commandTransform!("codex > out.log")).toBe("codex > out.log --add-dir .git");
    });
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
          PreCompact: [staleGroup("PreCompact")],
          PostCompact: [staleGroup("PostCompact")],
          SubagentStart: [staleGroup("SubagentStart")],
          SubagentStop: [staleGroup("SubagentStop")],
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
      ["PreCompact", 1],
      ["PostCompact", 1],
      ["SubagentStart", 1],
      ["SubagentStop", 1],
    ] as const) {
      expect(written.hooks[event]).toHaveLength(expectedLength);
    }
    const currentForwarderCommand = (kind: string) => forwarderHookCommand("codex", kind);
    for (const [event, kind] of [
      ["SessionStart", "SessionStart"],
      ["SessionEnd", "SessionEnd"],
      ["PermissionRequest", "PermissionRequest"],
      ["UserPromptSubmit", "UserPromptSubmit"],
      ["PreCompact", "PreCompact"],
      ["PostCompact", "PostCompact"],
      ["SubagentStart", "SubagentStart"],
      ["SubagentStop", "SubagentStop"],
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

  it("installs the Mullion tooling bundle under ~/.agents/skills when injectMullionBundle is on", async () => {
    const plan = codexAdapter.prepareLaunch({ ...ctx(), injectMullionBundle: true });
    await plan.managedInstall?.();

    const installedSkillPath = path.join(
      resolveCodexAgentsSkillsDir(),
      "mullion-mullion-host",
      "SKILL.md",
    );
    expect(existsSync(installedSkillPath)).toBe(true);
    expect(readFileSync(installedSkillPath, "utf8")).toContain("mullion-host");
  });

  it("does not install the bundle when injectMullionBundle is off", async () => {
    const plan = codexAdapter.prepareLaunch({ ...ctx(), injectMullionBundle: false });
    await plan.managedInstall?.();

    expect(existsSync(path.join(resolveCodexAgentsSkillsDir(), "mullion-mullion-host"))).toBe(
      false,
    );
  });

  it("removes a previously-installed bundle skill once injectMullionBundle is turned off", async () => {
    await codexAdapter.prepareLaunch({ ...ctx(), injectMullionBundle: true }).managedInstall?.();
    const skillDir = path.join(resolveCodexAgentsSkillsDir(), "mullion-mullion-host");
    expect(existsSync(skillDir)).toBe(true);

    await codexAdapter.prepareLaunch({ ...ctx(), injectMullionBundle: false }).managedInstall?.();
    expect(existsSync(skillDir)).toBe(false);
  });

  it("never removes a skill it didn't install, even one that happens to live alongside its own", async () => {
    const skillsDir = resolveCodexAgentsSkillsDir();
    const userSkillPath = path.join(skillsDir, "my-own-skill", "SKILL.md");
    mkdirSync(path.dirname(userSkillPath), { recursive: true });
    writeFileSync(userSkillPath, "---\nname: my-own-skill\ndescription: mine\n---\n");

    await codexAdapter.prepareLaunch({ ...ctx(), injectMullionBundle: false }).managedInstall?.();

    expect(existsSync(userSkillPath)).toBe(true);
  });

  it("never removes a user's own mullion-prefixed skill — ownership marker, not just the prefix, decides", async () => {
    const skillsDir = resolveCodexAgentsSkillsDir();
    const lookalikePath = path.join(skillsDir, "mullion-helper", "SKILL.md");
    mkdirSync(path.dirname(lookalikePath), { recursive: true });
    writeFileSync(lookalikePath, "not mine to touch");

    await codexAdapter.prepareLaunch({ ...ctx(), injectMullionBundle: false }).managedInstall?.();

    expect(existsSync(lookalikePath)).toBe(true);
  });

  it("a bundle-skill install failure never skips mergeCodexHooks — the step that actually matters", async () => {
    // A file where the skills dir needs to be makes mkdirSync inside
    // installBundleSkills throw ENOTDIR — the per-step try/catch (same
    // shape as agy.ts's managedInstall) must still let mergeCodexHooks run.
    const skillsDir = resolveCodexAgentsSkillsDir();
    writeFileSync(path.dirname(skillsDir), "", { flag: "wx" });

    const plan = codexAdapter.prepareLaunch({ ...ctx(), injectMullionBundle: true });
    await expect(plan.managedInstall?.()).rejects.toThrow();

    expect(readHooks().hooks.Stop).toHaveLength(1);
  });
});
