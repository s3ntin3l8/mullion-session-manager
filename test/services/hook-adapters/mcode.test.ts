import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  mcodeAdapter,
  buildMcodeHooksJson,
  buildMcodePluginManifest,
  buildMcodeHookHandoff,
  installMcodePlugin,
  removeMcodePlugin,
  matchesMcodeCommand,
  resolveMcodePluginDir,
  resolveMcodeShimPath,
  resolveMcodeGlobalSkillsDir,
  MCODE_HOOK_FILE_ENV,
} from "../../../src/services/hook-adapters/mcode.js";

const ctx = {
  sessionId: "sess-1",
  sessionsDir: "/tmp/mullion-sessions",
  hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
  hookToken: "tok-abc",
  controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
  forwarderPath: "/abs/install/hooks/forwarder.mjs",
  injectAgentGuide: false,
  injectProjectBriefing: false,
  injectMullionBundle: false,
};

describe("mcodeAdapter.matches", () => {
  it("matches a bare mcode invocation", () => {
    expect(mcodeAdapter.matches("mcode")).toBe(true);
  });

  it("matches mcode with trailing arguments", () => {
    expect(mcodeAdapter.matches("mcode --continue")).toBe(true);
  });

  it("matches a path-qualified mcode", () => {
    expect(mcodeAdapter.matches("/usr/local/bin/mcode")).toBe(true);
  });

  it("does not match a different program", () => {
    expect(mcodeAdapter.matches("bash")).toBe(false);
  });

  it("does not match mcode as a substring of another program name", () => {
    expect(mcodeAdapter.matches("mcode-wrapper")).toBe(false);
    expect(mcodeAdapter.matches("my-mcode")).toBe(false);
    expect(mcodeAdapter.matches("mcodefoo")).toBe(false);
  });

  it("does not match a chained command (shell metacharacters)", () => {
    // A transform on a chained command could attach to the wrong part of the
    // chain — same posture as the other adapters' metacharacter guard.
    expect(mcodeAdapter.matches("mcode && rm -rf /")).toBe(false);
    expect(mcodeAdapter.matches("echo hi | mcode")).toBe(false);
  });

  it("exposes matchesMcodeCommand as the same pure predicate", () => {
    expect(matchesMcodeCommand("mcode")).toBe(true);
    expect(matchesMcodeCommand("bash")).toBe(false);
  });
});

describe("mcodeAdapter.emits", () => {
  it("declares only hook-protocol kinds mcode's plugin hooks can produce", () => {
    for (const kind of mcodeAdapter.emits) {
      expect(typeof kind).toBe("string");
    }
    // The kinds Claude Code's own adapter declares, minus the ones only a
    // blocking gate produces (mcode's PermissionRequest DOES produce a
    // review_gate, so it stays).
    expect(mcodeAdapter.emits).toContain("review_gate");
    expect(mcodeAdapter.emits).toContain("file_change");
    expect(mcodeAdapter.emits).toContain("progress");
  });
});

describe("mcodeAdapter.prepareLaunch", () => {
  it("writes the per-session hook handoff file and sets the env var", () => {
    const plan = mcodeAdapter.prepareLaunch(ctx);
    expect(plan.settingsFiles).toHaveLength(1);
    const file = plan.settingsFiles![0];
    // Under the session's own tmp dir — TMPDIR survives mcode's hook env
    // whitelist, which is how the shim finds this file.
    expect(file.path).toBe(path.join("/tmp/mullion-sessions", "sess-1.tmp", "mullion-hook.json"));
    expect(plan.envAdditions?.[MCODE_HOOK_FILE_ENV]).toBe(file.path);
  });

  it("puts the socket, token and forwarder path in the handoff file", () => {
    const plan = mcodeAdapter.prepareLaunch(ctx);
    const handoff = JSON.parse(plan.settingsFiles![0].contents);
    expect(handoff.socket).toBe(ctx.hookSocketPath);
    expect(handoff.token).toBe(ctx.hookToken);
    expect(handoff.forwarderPath).toBe(ctx.forwarderPath);
    expect(typeof handoff.nodePath).toBe("string");
  });

  it("appends the model flag, and recognizes a pre-existing -m as already set", () => {
    // mcode accepts BOTH spellings — its own --help lists
    // "-m, --model <provider/model>" — so buildModelFlag emits `--model`
    // (the shared form) while the "-m" shortFlag argument makes its
    // skip-if-already-present check recognize a command that already
    // carries `-m`.
    const plan = mcodeAdapter.prepareLaunch({ ...ctx, model: "minimax/MiniMax-M3" });
    expect(typeof plan.commandTransform).toBe("function");
    expect(plan.commandTransform!("mcode")).toBe("mcode --model 'minimax/MiniMax-M3'");
    expect(plan.commandTransform!("mcode -m other/model")).toBe("mcode -m other/model");
    expect(plan.commandTransform!("mcode --model other/model")).toBe(
      "mcode --model other/model",
    );
  });

  it("leaves the command alone when no model resolved", () => {
    const plan = mcodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform!("mcode")).toBe("mcode");
  });

  it("does not add a second model flag when the command already has one", () => {
    const plan = mcodeAdapter.prepareLaunch({ ...ctx, model: "minimax/MiniMax-M3" });
    expect(plan.commandTransform!("mcode --model other/model")).toBe(
      "mcode --model other/model",
    );
  });

  it("installs the host-global plugin synchronously (mcode scans plugins at startup)", () => {
    // mcode scans its plugin directory ONCE at startup, so the plugin must
    // already exist by the time the process launches — a fire-and-forget
    // managedInstall would race that scan and the session would come up
    // with no hooks at all.
    const plan = mcodeAdapter.prepareLaunch(ctx);
    expect(plan.managedInstall).toBeUndefined();
  });
});

describe("mcodeAdapter.initialPromptArgs / resumeSessionArgs", () => {
  it("shell-quotes the initial prompt", () => {
    const args = mcodeAdapter.initialPromptArgs!("fix 'the' bug; rm -rf /");
    expect(args.startsWith("'")).toBe(true);
    expect(args.endsWith("'")).toBe(true);
    // The embedded single quote is escaped the POSIX way.
    expect(args).toContain("'\\''");
  });

  it("passes a session id as --session", () => {
    expect(mcodeAdapter.resumeSessionArgs!("mvs_abc")).toBe('--session "mvs_abc"');
  });
});

describe("buildMcodeHooksJson", () => {
  const json = buildMcodeHooksJson("/host/shim.sh", "/usr/bin/node");
  const parsed = JSON.parse(json);

  it("declares the Claude Code event names Mullion consumes", () => {
    expect(Object.keys(parsed.hooks)).toEqual(
      expect.arrayContaining([
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SessionEnd",
      ]),
    );
  });

  it("invokes the shim with the mcode agent name", () => {
    const command = parsed.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain("/host/shim.sh");
    expect(command).toContain("mcode");
    expect(command).toContain("/usr/bin/node");
  });

  it("matches the file-editing tools for PostToolUse", () => {
    const postToolUse = parsed.hooks.PostToolUse;
    const matchers = postToolUse.map((entry: { matcher?: string }) => entry.matcher);
    expect(matchers).toContain("Write|Edit|MultiEdit|NotebookEdit");
    expect(matchers).toContain("Bash");
  });

  it("is byte-identical across calls (no per-session data in the plugin)", () => {
    expect(buildMcodeHooksJson("/host/shim.sh", "/usr/bin/node")).toBe(json);
  });
});

describe("buildMcodePluginManifest", () => {
  it("declares the plugin name mcode requires", () => {
    const manifest = JSON.parse(buildMcodePluginManifest());
    expect(manifest.name).toBe("mullion");
  });
});

describe("buildMcodeHookHandoff", () => {
  it("serializes the connection details as JSON", () => {
    const handoff = JSON.parse(buildMcodeHookHandoff(ctx, "/fwd.mjs", "/usr/bin/node"));
    expect(handoff).toEqual({
      socket: ctx.hookSocketPath,
      token: ctx.hookToken,
      forwarderPath: "/fwd.mjs",
      nodePath: "/usr/bin/node",
    });
  });
});

describe("install/remove the host-global plugin", () => {
  const originalDataDir = process.env.MINIMAX_DATA_DIR;
  let tmp: string;

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
    else process.env.MINIMAX_DATA_DIR = originalDataDir;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the plugin, hooks.json and ownership marker, and removes them again", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcode-plugin-test-"));
    process.env.MINIMAX_DATA_DIR = tmp;
    // The shim lives at a host-stable path; point HOME at the temp dir so
    // the test never touches the developer's real ~/.mullion.
    const realHome = process.env.HOME;
    process.env.HOME = tmp;

    try {
      installMcodePlugin();

      const pluginDir = resolveMcodePluginDir();
      expect(existsSync(path.join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
      expect(existsSync(path.join(pluginDir, "hooks", "hooks.json"))).toBe(true);
      expect(existsSync(path.join(pluginDir, ".mullion-managed"))).toBe(true);
      expect(existsSync(resolveMcodeShimPath())).toBe(true);

      // The plugin must carry no per-session data.
      const hooks = readFileSync(path.join(pluginDir, "hooks", "hooks.json"), "utf8");
      expect(hooks).not.toContain(ctx.hookToken);
      expect(hooks).not.toContain(ctx.hookSocketPath);

      removeMcodePlugin();
      expect(existsSync(pluginDir)).toBe(false);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  it("is idempotent — a second install writes identical content", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcode-plugin-test-"));
    process.env.MINIMAX_DATA_DIR = tmp;
    const realHome = process.env.HOME;
    process.env.HOME = tmp;

    try {
      installMcodePlugin();
      const pluginDir = resolveMcodePluginDir();
      const hooksPath = path.join(pluginDir, "hooks", "hooks.json");
      const first = readFileSync(hooksPath, "utf8");
      installMcodePlugin();
      expect(readFileSync(hooksPath, "utf8")).toBe(first);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  it("leaves a user-authored plugin of the same name alone", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcode-plugin-test-"));
    process.env.MINIMAX_DATA_DIR = tmp;
    const realHome = process.env.HOME;
    process.env.HOME = tmp;

    try {
      const pluginDir = resolveMcodePluginDir();
      mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
      writeFileSync(
        path.join(pluginDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "mullion", description: "user's own" }),
      );

      removeMcodePlugin();

      // No ownership marker => not ours => untouched.
      expect(existsSync(path.join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });
});

describe("resolveMcodeGlobalSkillsDir", () => {
  it("resolves under the mcode data dir", () => {
    const original = process.env.MINIMAX_DATA_DIR;
    process.env.MINIMAX_DATA_DIR = "/tmp/mcode-data";
    try {
      expect(resolveMcodeGlobalSkillsDir()).toBe(path.join("/tmp/mcode-data", "skills"));
    } finally {
      if (original === undefined) delete process.env.MINIMAX_DATA_DIR;
      else process.env.MINIMAX_DATA_DIR = original;
    }
  });
});
