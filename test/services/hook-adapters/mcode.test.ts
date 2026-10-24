import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  mcodeAdapter,
  MCODE_PLUGIN_MARKER_NAME,
  MCODE_PERMISSION_PLUGIN_DIR_NAME,
  MCODE_MIN_VERSION_FOR_CODEX_PLUGIN,
  __testing,
  mcodeSupportsCodexPlugin,
  buildMcodeHooksJson,
  buildMcodePermissionHooksJson,
  buildMcodePluginManifest,
  buildMcodePermissionPluginManifest,
  buildMcodeHookHandoff,
  installMcodePlugin,
  removeMcodePlugin,
  matchesMcodeCommand,
  resolveMcodePluginDir,
  resolveMcodePermissionPluginDir,
  resolveMcodeShimPath,
  resolveMcodeGlobalSkillsDir,
} from "../../../src/services/hook-adapters/mcode.js";

const ctx = {
  sessionId: "sess-1",
  sessionsDir: "/tmp/mullion-sessions",
  // The session's EFFECTIVE temp dir (launch-plan.ts's per-session
  // `<sessionsDir>/<id>.tmp` by default). The hook handoff file lives here,
  // because TMPDIR is the only per-session channel mcode's hook child env
  // preserves.
  tmpDir: "/tmp/mullion-sessions/sess-1.tmp",
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
  // `prepareLaunch` installs the plugin SYNCHRONOUSLY, into the HOST-GLOBAL
  // plugin directory, and the install also sweeps stale manifest directories
  // out of the dirs it owns. So EVERY call in this describe would otherwise
  // rewrite the developer's real ~/.minimax/plugins — and, before the
  // ownership marker existed, could have removed a manifest directory out
  // from under a user-authored plugin of the same name. The whole describe is
  // therefore pointed at a temp data dir and a temp HOME.
  const originalDataDir = process.env.MINIMAX_DATA_DIR;
  const originalHome = process.env.HOME;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcode-prepare-launch-"));
    process.env.MINIMAX_DATA_DIR = tmp;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
    else process.env.MINIMAX_DATA_DIR = originalDataDir;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("writes the per-session hook handoff file under the session's temp dir", () => {
    const plan = mcodeAdapter.prepareLaunch(ctx);
    expect(plan.settingsFiles).toHaveLength(1);
    const file = plan.settingsFiles![0];
    // Under the session's EFFECTIVE temp dir — TMPDIR survives mcode's hook
    // env whitelist, and it is the only channel the shim has.
    expect(file.path).toBe(path.join("/tmp/mullion-sessions", "sess-1.tmp", "mullion-hook.json"));
  });

  it("writes the handoff file under the caller's own TMPDIR when one was supplied", () => {
    // launch-plan.ts honours a caller-supplied TMPDIR/TEMP/TMP and then
    // allocates NO per-session temp dir, so the effective temp dir is the
    // caller's — the handoff file must follow it, or the shim would look
    // in the wrong place and fail open (no hooks at all).
    const plan = mcodeAdapter.prepareLaunch({ ...ctx, tmpDir: "/caller/tmp" });
    expect(plan.settingsFiles![0].path).toBe(path.join("/caller/tmp", "mullion-hook.json"));
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
    expect(plan.commandTransform!("mcode --model other/model")).toBe("mcode --model other/model");
  });

  it("leaves the command alone when no model resolved", () => {
    const plan = mcodeAdapter.prepareLaunch(ctx);
    expect(plan.commandTransform!("mcode")).toBe("mcode");
  });

  it("does not add a second model flag when the command already has one", () => {
    const plan = mcodeAdapter.prepareLaunch({ ...ctx, model: "minimax/MiniMax-M3" });
    expect(plan.commandTransform!("mcode --model other/model")).toBe("mcode --model other/model");
  });

  it("installs the host-global plugin synchronously (mcode scans plugins at startup)", () => {
    // mcode scans its plugin directory ONCE at startup, so the plugin must
    // already exist by the time the process launches — a fire-and-forget
    // managedInstall would race that scan and the session would come up
    // with no hooks at all.
    //
    const plan = mcodeAdapter.prepareLaunch(ctx);
    expect(plan.managedInstall).toBeUndefined();
    // It landed in the temp dir this describe is pointed at, not in the real
    // one — and BOTH plugin directories are there (the Claude-format one and
    // the CODEX-format PermissionRequest one).
    expect(existsSync(path.join(tmp, "plugins", "mullion", ".mullion-managed"))).toBe(true);
    expect(existsSync(path.join(tmp, "plugins", "mullion-permission", ".mullion-managed"))).toBe(
      true,
    );
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
  const json = buildMcodeHooksJson("/host/shim.sh");
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

  it("does NOT declare PermissionRequest — it moved to the CODEX-format plugin", () => {
    // Issue #1814. PermissionRequest has to be registered SOMEWHERE, but in
    // the Claude format mcode only applies an "allow" when the prompt is
    // auto-approval-eligible — which a safety-classified command (rm -rf) is
    // not — so mcode still showed its own dialog. The CODEX format applies
    // the allow unconditionally. Registering it in BOTH would raise the gate
    // twice.
    expect(parsed.hooks.PermissionRequest).toBeUndefined();
  });

  it("gives every hook a timeout in SECONDS, at mcode's 10-second ceiling", () => {
    // mcode's own hook schema documents `timeout` as seconds, and its
    // conversion caps a declared timeout at 10s — a value OUTSIDE 1..10 is
    // treated as raw MILLISECONDS, so writing 300 would mean 300ms.
    for (const entries of Object.values(parsed.hooks) as { hooks: { timeout: number }[] }[][]) {
      for (const entry of entries) {
        const timeout = entry.hooks[0].timeout;
        expect(Number.isInteger(timeout)).toBe(true);
        expect(timeout).toBeGreaterThanOrEqual(1);
        expect(timeout).toBeLessThanOrEqual(10);
      }
    }
  });

  it("invokes the shim directly — NOT through node", () => {
    // The shim is a POSIX shell script with a `#!/bin/sh` shebang, and mcode
    // runs the command through `sh -c`, so the shell executes it via its
    // shebang. Prefixing the command with node asks node to load a `.sh`
    // file, which dies with ERR_UNKNOWN_FILE_EXTENSION — silently
    // disabling every hook (Hermes review, PR #1793). The shim resolves
    // node itself at run time from the handoff file's `nodePath`.
    const command = parsed.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain("/host/shim.sh");
    expect(command).toContain("mcode");
    expect(command).not.toContain("node");
    expect(command.startsWith('"/host/shim.sh" ')).toBe(true);
  });

  it("passes the hook EVENT name as the forwarder's second argument", () => {
    // The forwarder is invoked as `<agent> <kind>` and it silently drops the
    // whole hook when either argv is missing (forwarder.mjs's own `kind`
    // guard). A command that carried only the agent name would therefore
    // turn EVERY mcode hook into a no-op — so each entry's command must end
    // with its own event name.
    for (const [event, entries] of Object.entries(parsed.hooks) as [
      string,
      { hooks: { command: string }[] }[],
    ][]) {
      for (const entry of entries) {
        expect(entry.hooks[0].command).toBe(`"/host/shim.sh" mcode ${event}`);
      }
    }
  });

  it("matches the file-editing tools for PostToolUse", () => {
    const postToolUse = parsed.hooks.PostToolUse;
    const matchers = postToolUse.map((entry: { matcher?: string }) => entry.matcher);
    expect(matchers).toContain("Write|Edit|MultiEdit|NotebookEdit");
    expect(matchers).toContain("Bash");
  });

  it("is byte-identical across calls (no per-session data in the plugin)", () => {
    expect(buildMcodeHooksJson("/host/shim.sh")).toBe(json);
  });
});

describe("buildMcodePermissionHooksJson — the CODEX-format plugin (issue #1814)", () => {
  const json = buildMcodePermissionHooksJson("/host/shim.sh");
  const parsed = JSON.parse(json);

  it("declares PermissionRequest and NOTHING else", () => {
    // One event, one plugin. Every other event stays in the Claude-format
    // plugin, whose tool vocabulary and matcher semantics Mullion's mapping
    // is written against.
    expect(Object.keys(parsed.hooks)).toEqual(["PermissionRequest"]);
  });

  it("registers the PermissionRequest hook — it IS the skip-permissions channel", () => {
    // Without this registration mcode's permission prompts never reach
    // Mullion, so skip-permissions would silently do nothing and no review
    // gate would ever open for an mcode session.
    const permissionRequest = parsed.hooks.PermissionRequest;
    expect(permissionRequest).toBeDefined();
    expect(permissionRequest).toHaveLength(1);
    expect(permissionRequest[0].hooks[0].command).toContain("mcode PermissionRequest");
  });

  it("carries no matcher", () => {
    // mcode's CODEX dialect matches a matcher string EXACTLY against the
    // tool name (no regex), and PermissionRequest must fire for whatever
    // tool needs a decision — so it carries none.
    expect(permissionRequestMatcher(parsed)).toBeUndefined();
  });

  it("gives the hook a timeout in SECONDS, at mcode's 10-second ceiling", () => {
    const timeout = parsed.hooks.PermissionRequest[0].hooks[0].timeout;
    expect(Number.isInteger(timeout)).toBe(true);
    expect(timeout).toBeGreaterThanOrEqual(1);
    expect(timeout).toBeLessThanOrEqual(10);
  });

  it("invokes the shim directly, with the event name as the forwarder's second argument", () => {
    const command = parsed.hooks.PermissionRequest[0].hooks[0].command;
    expect(command).toBe('"/host/shim.sh" mcode PermissionRequest');
    expect(command).not.toContain("node");
  });

  it("uses only the hook fields the CODEX dialect accepts", () => {
    // mcode's CODEX loader rejects `args`, `shell`, `if`, `async` and
    // `asyncRewake` on a hook entry as HOOK_HANDLER_UNSUPPORTED, and a
    // matcher must match ^[A-Za-z0-9_|]+$. Mullion uses none of the rejected
    // fields, and no matcher at all.
    const entry = parsed.hooks.PermissionRequest[0].hooks[0];
    expect(Object.keys(entry).sort()).toEqual(["command", "timeout", "type"]);
    expect(entry.type).toBe("command");
  });

  it("is byte-identical across calls (no per-session data in the plugin)", () => {
    expect(buildMcodePermissionHooksJson("/host/shim.sh")).toBe(json);
  });
});

/** The matcher of the single PermissionRequest entry, or undefined. */
function permissionRequestMatcher(parsed: {
  hooks: Record<string, Array<{ matcher?: string }>>;
}): string | undefined {
  return parsed.hooks.PermissionRequest[0].matcher;
}

describe("buildMcodePluginManifest", () => {
  it("declares the plugin name mcode requires", () => {
    const manifest = JSON.parse(buildMcodePluginManifest());
    expect(manifest.name).toBe("mullion");
  });
});

describe("the CODEX-format plugin's mcode version floor", () => {
  afterEach(() => {
    __testing.setMcodeVersion(undefined);
  });

  it("compares dotted numeric versions", () => {
    expect(__testing.compareVersions("0.6.12", "0.6.12")).toBe(0);
    expect(__testing.compareVersions("0.6.11", "0.6.12")).toBeLessThan(0);
    expect(__testing.compareVersions("0.6.13", "0.6.12")).toBeGreaterThan(0);
    expect(__testing.compareVersions("0.7.0", "0.6.12")).toBeGreaterThan(0);
    expect(__testing.compareVersions("1.0.0", "0.6.12")).toBeGreaterThan(0);
  });

  it("parses the version out of whatever mcode --version printed", () => {
    // mcode prints just "0.6.13", but a wrapper may print a profile line
    // first, and the version may carry a prefix. An output with no version
    // in it is UNKNOWN, not a guess.
    expect(__testing.parseMcodeVersion("0.6.13\n")).toBe("0.6.13");
    expect(__testing.parseMcodeVersion("v0.6.13")).toBe("0.6.13");
    expect(__testing.parseMcodeVersion("mcode 0.6.13")).toBe("0.6.13");
    expect(__testing.parseMcodeVersion("profile: work\nmcode 0.6.13")).toBe("0.6.13");
    expect(__testing.parseMcodeVersion("")).toBeNull();
    expect(__testing.parseMcodeVersion("unknown")).toBeNull();
  });

  it("supports the CODEX format from mcode 0.6.12 on", () => {
    // 0.6.12 is the floor because the CODEX plugin format AND the
    // format-aware auto-approval mapping are both present in 0.6.12's own
    // bundle — verified by reading its chunks, not just 0.6.13's.
    __testing.setMcodeVersion(MCODE_MIN_VERSION_FOR_CODEX_PLUGIN);
    expect(mcodeSupportsCodexPlugin()).toBe(true);
    __testing.setMcodeVersion("0.6.13");
    expect(mcodeSupportsCodexPlugin()).toBe(true);
  });

  it("does NOT support it below the floor", () => {
    // Below the floor the CODEX plugin is not loaded at all, and since the
    // Claude-format plugin no longer carries PermissionRequest, the hook
    // would be registered nowhere — so the install warns instead of failing
    // silently.
    __testing.setMcodeVersion("0.6.11");
    expect(mcodeSupportsCodexPlugin()).toBe(false);
  });

  it("treats an unknown version as supported", () => {
    // The only way the version is unknown is that `mcode --version` could not
    // be run — which in practice means mcode is not on PATH, and then there
    // is no mcode session to hook.
    __testing.setMcodeVersion(null);
    expect(mcodeSupportsCodexPlugin()).toBe(true);
  });
});

describe("buildMcodePermissionPluginManifest", () => {
  it("declares the plugin name mcode requires", () => {
    const manifest = JSON.parse(buildMcodePermissionPluginManifest());
    expect(manifest.name).toBe(MCODE_PERMISSION_PLUGIN_DIR_NAME);
  });

  it("carries no `agents` key — the CODEX loader rejects one", () => {
    const manifest = JSON.parse(buildMcodePermissionPluginManifest());
    expect(manifest.agents).toBeUndefined();
  });
});

/** Directory entries, tolerating a missing directory. */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

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

      // Issue #1814 — the CODEX-format plugin lives in its OWN directory,
      // carrying only PermissionRequest.
      const permissionDir = resolveMcodePermissionPluginDir();
      expect(existsSync(path.join(permissionDir, ".codex-plugin", "plugin.json"))).toBe(true);
      expect(existsSync(path.join(permissionDir, "hooks", "hooks.json"))).toBe(true);
      expect(existsSync(path.join(permissionDir, ".mullion-managed"))).toBe(true);
      // ...and it must NOT carry a Claude- or MiniMax-format manifest: mcode
      // picks the format by which manifest is present (MINIMAX > CLAUDE >
      // CODEX), so a leftover would silently load it as CLAUDE — the format
      // that cannot suppress mcode's own dialog.
      expect(existsSync(path.join(permissionDir, ".claude-plugin"))).toBe(false);
      expect(existsSync(path.join(permissionDir, ".minimax-plugin"))).toBe(false);

      // The plugin must carry no per-session data.
      const hooks = readFileSync(path.join(pluginDir, "hooks", "hooks.json"), "utf8");
      expect(hooks).not.toContain(ctx.hookToken);
      expect(hooks).not.toContain(ctx.hookSocketPath);
      const permissionHooks = readFileSync(path.join(permissionDir, "hooks", "hooks.json"), "utf8");
      expect(permissionHooks).not.toContain(ctx.hookToken);
      expect(permissionHooks).not.toContain(ctx.hookSocketPath);

      removeMcodePlugin();
      expect(existsSync(pluginDir)).toBe(false);
      expect(existsSync(permissionDir)).toBe(false);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  it("drops a stale Claude-format manifest from the CODEX plugin directory", () => {
    // The upgrade path from the pre-#1814 layout: a directory that used to
    // carry the Claude-format manifest and now carries the CODEX one must not
    // keep both, or mcode would load the plugin as CLAUDE (higher priority)
    // and the whole fix would silently do nothing.
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcode-plugin-test-"));
    process.env.MINIMAX_DATA_DIR = tmp;
    const realHome = process.env.HOME;
    process.env.HOME = tmp;

    try {
      const permissionDir = resolveMcodePermissionPluginDir();
      mkdirSync(path.join(permissionDir, ".claude-plugin"), { recursive: true });
      writeFileSync(
        path.join(permissionDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "mullion-permission" }),
      );
      // Pretend the directory is ours — the marker is what makes it ours.
      writeFileSync(
        path.join(permissionDir, MCODE_PLUGIN_MARKER_NAME),
        "This directory is managed by Mullion (hook-adapters/mcode.ts). Remove it with `mullion` uninstall.\n",
      );

      installMcodePlugin();

      expect(existsSync(path.join(permissionDir, ".claude-plugin"))).toBe(false);
      expect(existsSync(path.join(permissionDir, ".codex-plugin", "plugin.json"))).toBe(true);
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

  it("refreshes a shim left over from an older build, but not one the user replaced", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcode-plugin-test-"));
    process.env.MINIMAX_DATA_DIR = tmp;
    const realHome = process.env.HOME;
    process.env.HOME = tmp;

    try {
      installMcodePlugin();
      const shimPath = resolveMcodeShimPath();

      // A stale shim from an older build (ours, but out of date) must be
      // refreshed — the plugin's hooks.json is rewritten on every install, so
      // a stale shim would keep running old logic against a fresh plugin.
      writeFileSync(shimPath, "# mcode hook shim — STALE OLD VERSION\n", { mode: 0o755 });
      installMcodePlugin();
      expect(readFileSync(shimPath, "utf8")).toContain("HANDOFF_FILE");

      // A shim the user wrote themselves carries no marker, so it is left
      // exactly as it was.
      const userShim = "#!/bin/sh\n# my own hook script\nexit 0\n";
      writeFileSync(shimPath, userShim, { mode: 0o755 });
      installMcodePlugin();
      expect(readFileSync(shimPath, "utf8")).toBe(userShim);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  it("writes every plugin file atomically (a new inode, never an in-place truncate)", () => {
    // All three plugin files go through the atomic writer (sibling `.tmp` +
    // rename), because mcode scans its plugin dir ONCE at startup — a
    // half-written hooks.json would silently load a plugin with no hooks.
    //
    // The observable difference between an atomic write and a plain
    // `writeFileSync` is the INODE: a rename installs a NEW file (new inode),
    // while a plain write truncates the existing one in place (same inode).
    // Asserting the inode changes therefore pins the atomic path without
    // reaching into the implementation.
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcode-plugin-test-"));
    process.env.MINIMAX_DATA_DIR = tmp;
    const realHome = process.env.HOME;
    process.env.HOME = tmp;

    try {
      installMcodePlugin();
      const pluginDir = resolveMcodePluginDir();
      const files = [
        path.join(pluginDir, ".claude-plugin", "plugin.json"),
        path.join(pluginDir, "hooks", "hooks.json"),
        path.join(pluginDir, MCODE_PLUGIN_MARKER_NAME),
      ];

      const before = files.map((file) => statSync(file).ino);
      installMcodePlugin();
      const after = files.map((file) => statSync(file).ino);

      for (const [index, file] of files.entries()) {
        expect(after[index], `${file} was written in place, not atomically`).not.toBe(
          before[index],
        );
        // And it is complete: a truncated write would not parse.
        if (file.endsWith(".json")) {
          expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
        }
      }

      // No scratch files survive the rename.
      const leftovers = [
        ...listDir(path.join(pluginDir, ".claude-plugin")),
        ...listDir(path.join(pluginDir, "hooks")),
        ...listDir(pluginDir),
      ].filter((name) => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
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

  it("does not clobber a user-authored plugin of the same name on INSTALL", () => {
    // Removal already refused to touch an unmarked plugin dir; install must
    // be symmetric, or every mcode launch would overwrite the user's own
    // plugin named `mullion` (Hermes review, PR #1793).
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcode-plugin-test-"));
    process.env.MINIMAX_DATA_DIR = tmp;
    const realHome = process.env.HOME;
    process.env.HOME = tmp;

    try {
      const pluginDir = resolveMcodePluginDir();
      mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
      const userManifest = JSON.stringify({ name: "mullion", description: "user's own" });
      writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), userManifest);

      installMcodePlugin();

      // Untouched: no Mullion manifest, no hooks.json, no ownership marker.
      expect(readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")).toBe(
        userManifest,
      );
      expect(existsSync(path.join(pluginDir, "hooks", "hooks.json"))).toBe(false);
      expect(existsSync(path.join(pluginDir, MCODE_PLUGIN_MARKER_NAME))).toBe(false);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  it("does not clobber a user-authored CODEX plugin of the same name on INSTALL", () => {
    // Issue #1814 — the refusal rule applies to the CODEX-format plugin
    // directory too. Any of mcode's three manifest formats marks the
    // directory as "a plugin called mullion-permission", so a user's own
    // plugin of that name is left alone.
    tmp = mkdtempSync(path.join(os.tmpdir(), "mcode-plugin-test-"));
    process.env.MINIMAX_DATA_DIR = tmp;
    const realHome = process.env.HOME;
    process.env.HOME = tmp;

    try {
      const permissionDir = resolveMcodePermissionPluginDir();
      mkdirSync(path.join(permissionDir, ".codex-plugin"), { recursive: true });
      const userManifest = JSON.stringify({
        name: "mullion-permission",
        description: "user's own",
      });
      writeFileSync(path.join(permissionDir, ".codex-plugin", "plugin.json"), userManifest);

      installMcodePlugin();

      expect(readFileSync(path.join(permissionDir, ".codex-plugin", "plugin.json"), "utf8")).toBe(
        userManifest,
      );
      expect(existsSync(path.join(permissionDir, "hooks", "hooks.json"))).toBe(false);
      expect(existsSync(path.join(permissionDir, MCODE_PLUGIN_MARKER_NAME))).toBe(false);
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

describe("resolveMcodePluginDir — the data dir override", () => {
  const saved = {
    minimax: process.env.MINIMAX_DATA_DIR,
    mavis: process.env.MAVIS_DATA_DIR,
    profile: process.env.PROFILE,
    mcodeProfile: process.env.MCODE_PROFILE,
    mavisProfile: process.env.MAVIS_PROFILE,
    home: process.env.HOME,
  };

  afterEach(() => {
    for (const [key, value] of [
      ["MINIMAX_DATA_DIR", saved.minimax],
      ["MAVIS_DATA_DIR", saved.mavis],
      ["PROFILE", saved.profile],
      ["MCODE_PROFILE", saved.mcodeProfile],
      ["MAVIS_PROFILE", saved.mavisProfile],
      ["HOME", saved.home],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("honours mcode's own MINIMAX_DATA_DIR", () => {
    process.env.MINIMAX_DATA_DIR = "/tmp/mcode-own";
    delete process.env.MAVIS_DATA_DIR;
    expect(resolveMcodePluginDir()).toBe(path.join("/tmp/mcode-own", "plugins", "mullion"));
  });

  // Issue #1814 — the CODEX-format plugin resolves the same way, and lands
  // in its OWN directory (mcode picks the plugin format by which manifest
  // file a directory carries, so the two must not share one).
  it("resolves the CODEX-format plugin into its own directory", () => {
    process.env.MINIMAX_DATA_DIR = "/tmp/mcode-own";
    delete process.env.MAVIS_DATA_DIR;
    expect(resolveMcodePermissionPluginDir()).toBe(
      path.join("/tmp/mcode-own", "plugins", MCODE_PERMISSION_PLUGIN_DIR_NAME),
    );
    expect(resolveMcodePermissionPluginDir()).not.toBe(resolveMcodePluginDir());
  });

  it("honours mcode's legacy MAVIS_DATA_DIR alias", () => {
    // Both appear together in mcode's own runtime env allowlist, so this one
    // IS mcode's — unlike the generic PROFILE below.
    delete process.env.MINIMAX_DATA_DIR;
    process.env.MAVIS_DATA_DIR = "/tmp/mcode-legacy";
    expect(resolveMcodePluginDir()).toBe(path.join("/tmp/mcode-legacy", "plugins", "mullion"));
  });

  it("does NOT honour the generic PROFILE env var", () => {
    // PROFILE belongs to the EMBEDDED CLAUDE CODE CLI inside mcode's bundle
    // (`chunk-X3PES5WL.js`), not to mcode: mcode's own CLI has no
    // `--profile` flag. Honouring it would redirect the plugin to
    // `~/.minimax-<x>/plugins`, where mcode never looks — hooks silently
    // off, and files written to a junk dir (Hermes review, PR #1793).
    delete process.env.MINIMAX_DATA_DIR;
    delete process.env.MAVIS_DATA_DIR;
    process.env.PROFILE = "somebody-elses-profile";
    process.env.HOME = "/tmp/fake-home";
    expect(resolveMcodePluginDir()).toBe(
      path.join("/tmp/fake-home", ".minimax", "plugins", "mullion"),
    );
  });

  it("does NOT honour a MCODE_PROFILE that mcode itself does not define", () => {
    // No such variable exists in mcode 0.6.12's source — only
    // MINIMAX_DATA_DIR / MAVIS_DATA_DIR / MAVIS_PROFILE.
    delete process.env.MINIMAX_DATA_DIR;
    delete process.env.MAVIS_DATA_DIR;
    process.env.MCODE_PROFILE = "ghost";
    process.env.HOME = "/tmp/fake-home";
    expect(resolveMcodePluginDir()).toBe(
      path.join("/tmp/fake-home", ".minimax", "plugins", "mullion"),
    );
  });
});
