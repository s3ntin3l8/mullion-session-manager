/**
 * mcode (MiniMax Code) hook adapter.
 *
 * mcode is the `@minimax-ai/code` CLI (`mcode` on PATH). Unlike Claude Code
 * and Codex — which take a `--settings`/`--config` file that declares their
 * hooks — mcode **retired standalone user hooks**: custom hooks must belong
 * to a PLUGIN (mcode's own error text says so verbatim: "Standalone user
 * hooks are no longer supported. Custom hooks belong to Plugins."). A plugin
 * is a directory under `<dataDir>/plugins/`, and mcode reads the
 * **Claude Code plugin format** from it: `.claude-plugin/plugin.json` plus
 * `hooks/hooks.json` (default path) declaring Claude Code's event names
 * (`SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`,
 * `UserPromptSubmit`, `SessionEnd`, …).
 *
 * That format is exactly what Mullion's shared forwarder already speaks, so
 * the event→hook-protocol mapping is reused from forwarder-core.mjs rather
 * than reinvented (see `mapMcodeEvent` there).
 *
 * ## Why a plugin at all, and where it lives
 *
 * The plugin directory is HOST-GLOBAL (`<dataDir>/plugins/` — the real
 * `~/.minimax/plugins/`), so it must contain NO per-session data: two Mullion
 * sessions on the same host share it, and so does the user's own mcode. The
 * plugin therefore contains only a fixed command line pointing at a
 * host-stable shim script (see src/hooks/mcode-hook-shim.sh), exactly the
 * discipline forwarder-shim.ts already documents for agy/Codex.
 *
 * ## Why the shim exists at all
 *
 * mcode runs a plugin hook as a child process whose environment is a strict
 * WHITELIST (PATH, HOME, LANG, TERM, SHELL, USER, TMPDIR, TEMP, TMP,
 * PATHEXT, SystemRoot, ComSpec, USERPROFILE, HOMEDRIVE, HOMEPATH, APPDATA,
 * LOCALAPPDATA, plus *_PLUGIN_ROOT / *_PROJECT_DIR). `MULLION_HOOK_SOCKET`,
 * `MULLION_HOOK_TOKEN` and `MULLION_FORWARDER_PATH` are all DROPPED, so the
 * forwarder cannot find Mullion's hook socket the way it does for the other
 * agents. The shim closes that gap: Mullion writes this session's socket +
 * token + forwarder path to a per-session JSON file, and the shim finds it
 * through TMPDIR — the one per-session channel mcode's whitelist preserves.
 *
 * That file lives under the session's EFFECTIVE temp dir: the per-session
 * `<sessionsDir>/<id>.tmp` that launch-plan.ts allocates and exports as
 * TMPDIR/TEMP/TMP, or the caller's own TMPDIR when they supplied one (in
 * which case launch-plan.ts allocates no per-session temp dir at all — hence
 * ctx.tmpDir carrying the real value rather than the adapter guessing).
 * Either way nothing per-session is ever written into the host-global plugin.
 *
 * ## skip-permissions
 *
 * mcode's TUI has no `--permission` flag (verified empirically: "error:
 * unknown option '--permission'"), and `permissionMode` lives in
 * `<dataDir>/config.yaml` — HOST-GLOBAL, and the user's own file, which this
 * adapter must never mutate. Relocating the whole data dir per session via
 * MINIMAX_DATA_DIR was tried and DOES NOT WORK: mcode's OAuth record is
 * host-bound, so a relocated data dir cannot authenticate ("mcode exec
 * failed: Sign in to MiniMax to use Agent features"), and mcode additionally
 * refuses symlinked plugin roots and migration dirs.
 *
 * So skip-permissions is implemented where it is naturally per-session:
 * mcode asks permission through its `PermissionRequest` plugin hook, and
 * Mullion answers over the existing hook socket. With skip-permissions ON,
 * Mullion's hook server answers "allow" instead of raising a review gate; with
 * it OFF, the normal gate applies. This is per-session by construction (the
 * hook round trip is scoped to the session's own socket + token) and never
 * touches the user's global config.
 *
 * Verified in mcode 0.6.12's own code: a PermissionRequest hook result of
 * `{"decision":"allow"}` (or a CLAUDE-format
 * `hookSpecificOutput.decision.behavior === "allow"`) is honoured as an
 * approval — see mcode's own `lA`/`mxn`/`hxn` helpers and the
 * `"PermissionRequest"?{decision:"allow"` branch.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookAdapterContext, HookLaunchPlan } from "./types.js";
import type { HookMessageKind } from "../hook-protocol.js";
import { SHELL_METACHARACTERS_RE, shellQuote, buildModelFlag, resolveHooksDir } from "./shared.js";

/** The adapter's stable id — also the `<agent>` argv the shared forwarder
 * receives, so forwarder-core.mjs can dispatch to `mapMcodeEvent`. */
export const MCODE_ADAPTER_NAME = "mcode";

/** The plugin directory name mcode discovers under `<dataDir>/plugins/`.
 * Host-global and shared with the user's own mcode — hence the marker file
 * and the "no per-session data inside" rule documented in the header. */
export const MCODE_PLUGIN_DIR_NAME = "mullion";

/** Marker file written into the plugin dir so Mullion can tell "this plugin
 * is ours, safe to remove" from "the user put their own plugin here". Same
 * ownership-record idea as mullion-bundle.ts's INSTALLED_MARKER_NAME. */
export const MCODE_PLUGIN_MARKER_NAME = ".mullion-managed";

/** The marker file's contents. Compared verbatim before a removal, so a
 * user-authored file with the same name is never deleted. */
export const MCODE_PLUGIN_MARKER_CONTENT =
  "This directory is managed by Mullion (hook-adapters/mcode.ts). Remove it with `mullion` uninstall.\n";

/** mcode's own default data dir, relative to $HOME. mcode resolves
 * `<dataDir>` from `~/.minimax` (+ an optional profile suffix) — see its
 * `qa()`/`Ge()` helpers. We resolve the same way so the plugin lands where
 * mcode actually looks for it. */
function resolveMcodeDataDir(): string {
  const profile = process.env.MCODE_PROFILE?.trim() || process.env.PROFILE?.trim();
  const base = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim();
  if (base) return base;
  const home = os.homedir();
  return profile ? path.join(home, `.minimax-${profile}`) : path.join(home, ".minimax");
}

/** Absolute path of mcode's local plugin directory (`<dataDir>/plugins`). */
export function resolveMcodePluginsDir(): string {
  return path.join(resolveMcodeDataDir(), "plugins");
}

/**
 * mcode's own user-level skills root: `<dataDir>/skills`.
 *
 * mcode reads several skill roots (verified in mcode 0.6.12's own source):
 * the mcode-native `<dataDir>/skills` and `<dataDir>/agents/<agent>/skills`,
 * PLUS Claude Code's `~/.claude/skills`, Codex's `~/.codex/skills` and the
 * shared `~/.agents/skills` — but those three are opt-in behind mcode's
 * `skills.external.enabled` setting, whereas `<dataDir>/skills` is always
 * scanned. So the mcode-native root is the one root Mullion can install
 * into unconditionally and know mcode will read.
 */
export function resolveMcodeGlobalSkillsDir(): string {
  return path.join(resolveMcodeDataDir(), "skills");
}

/** Absolute path of the plugin directory Mullion owns inside it. */
export function resolveMcodePluginDir(): string {
  return path.join(resolveMcodePluginsDir(), MCODE_PLUGIN_DIR_NAME);
}

/** Host-stable location of the mcode hook shim script. Deliberately
 * homedir-anchored and NOT under the checkout, so a `git worktree remove`
 * can never leave a dangling path behind — the same discipline
 * forwarder-shim.ts documents for its own script. */
export function resolveMcodeShimPath(): string {
  return path.join(os.homedir(), ".mullion", "hooks", "mcode-hook-shim.sh");
}

/** Where this repo's copy of the shim lives (dev vs packaged), mirroring
 * shared.ts's resolveForwarderShimSourcePath() — the SAME dev/prod
 * resolution the rest of the hook plumbing uses, so the installed shim is
 * always the one that matches the running instance's build. */
export function resolveMcodeShimSourcePath(): string {
  return path.join(resolveHooksDir(), "mcode-hook-shim.sh");
}

/**
 * Conservative program-token match, same posture as the other adapters: the
 * command must be a simple invocation of a program literally named `mcode`
 * (optionally with a path), with no shell metacharacters anywhere in it —
 * because this adapter rewrites the command line to append flags.
 */
export function matchesMcodeCommand(command: string): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_METACHARACTERS_RE.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return false;
  const program = tokens[0];
  const base = path.basename(program);
  if (base !== "mcode") return false;
  // A bare `mcode` or `/usr/local/bin/mcode` — but not `mcodefoo` or
  // `my-mcode` (basename equality already rejects those) and not a bare
  // `mcode` that is actually a directory or a different binary.
  return program === base || program.endsWith(`/${base}`);
}

/** The hook event names mcode's plugin hook format understands, mapped from
 * the Claude Code vocabulary Mullion's forwarder already speaks. */
export const MCODE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
] as const;

/** Builds the plugin's `hooks/hooks.json` contents. The command line is
 * FIXED — it carries no per-session data, because the plugin directory is
 * host-global. The per-session socket/token/forwarder path travels in the
 * handoff file the shim reads at run time.
 *
 * Exported for tests. Pure, no I/O. */
export function buildMcodeHooksJson(shimPath: string, execPath: string = process.execPath): string {
  // The forwarder is invoked as `<agent> <kind>` (see forwarder.mjs's own
  // header) — `kind` is the hook EVENT name, and it is NOT optional: the
  // forwarder bails out (silently, no message) when either argv is missing.
  // So every entry's command carries its own event name, exactly like
  // claude-code.ts's hookEntry does.
  const entry = (event: string, matcher?: string, timeout = 10) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command" as const,
        command: `${JSON.stringify(execPath)} ${JSON.stringify(shimPath)} ${MCODE_ADAPTER_NAME} ${event}`,
        // Timeout in SECONDS (mcode's own hook schema says so).
        //
        // mcode clamps a DECLARED timeout to at most 10 seconds: its own
        // conversion turns an integer 1..10 into `seconds * 1000` capped at
        // 10000ms, and treats anything outside that range as raw MILLISECONDS
        // (so `timeout: 300` would mean 300ms, not 300s). 10 is therefore the
        // only value that buys the maximum wait — writing 300 would make it
        // dramatically SHORTER.
        //
        // Fire-and-forget notifications use that 10s ceiling too: nothing
        // downstream waits on them, so the timeout only exists to stop a
        // wedged forwarder lingering.
        timeout,
      },
    ],
  });

  const hooks: Record<string, unknown[]> = {
    SessionStart: [entry("SessionStart")],
    UserPromptSubmit: [entry("UserPromptSubmit")],
    PreToolUse: [entry("PreToolUse")],
    PostToolUse: [
      // File-editing tools → file_change (the forwarder maps these).
      {
        matcher: "Write|Edit|MultiEdit|NotebookEdit",
        ...entry("PostToolUse"),
      },
      // Bash → git_branch detection, same as Claude Code's own split.
      {
        matcher: "Bash",
        ...entry("PostToolUse"),
      },
    ],
    // PermissionRequest is the BLOCKING hook: it is the whole reason
    // skip-permissions works for mcode (Mullion answers "allow" over the hook
    // socket instead of mcode showing its own permission dialog), and it is
    // also what carries a real review gate when skip-permissions is OFF.
    //
    // It MUST be registered — without it mcode's permission prompts never
    // reach Mullion at all, and skip-permissions would silently do nothing.
    // No matcher: PermissionRequest only fires for the tool call that
    // actually needs a decision, whatever tool that is.
    //
    // The 10s ceiling is mcode's own limit (see above), which is why the
    // skip-permissions path resolves it in milliseconds — Mullion's gate
    // server auto-approves immediately — while a HUMAN approval that takes
    // longer than mcode's hook budget falls back to mcode's own native
    // permission prompt (a timeout is an "ask", never a denial, in mcode's
    // own hook-result handling).
    PermissionRequest: [entry("PermissionRequest")],
    Stop: [entry("Stop")],
    // SessionEnd gets a short timeout: mcode itself budgets only a few
    // seconds for it (its own per-event budget), and it is fire-and-forget.
    SessionEnd: [entry("SessionEnd", undefined, 2)],
  };

  return JSON.stringify({ hooks }, null, 2);
}

/** The plugin manifest's contents. mcode's Claude-format plugin loader
 * requires a `name`; `description`/`author` are conventional. */
export function buildMcodePluginManifest(): string {
  return JSON.stringify(
    {
      name: MCODE_PLUGIN_DIR_NAME,
      description: "Mullion's session hooks for mcode (MiniMax Code).",
      author: { name: "Mullion" },
    },
    null,
    2,
  );
}

/**
 * The per-session handoff file's contents: the socket path, the handshake
 * token, and the forwarder path (+ the node binary to run it with). Read by
 * the shim, which re-exports them as the MULLION_* env vars the forwarder
 * expects.
 *
 * Exported for tests. Pure, no I/O.
 */
export function buildMcodeHookHandoff(
  ctx: HookAdapterContext,
  forwarderPath: string,
  nodePath: string = process.execPath,
): string {
  return JSON.stringify(
    {
      socket: ctx.hookSocketPath,
      token: ctx.hookToken,
      forwarderPath,
      nodePath,
    },
    null,
    2,
  );
}

/** The marker that identifies the installed shim as Mullion's own. The shim
 * is written from this repo's copy, and its header carries this string — so a
 * shim a user wrote themselves is never overwritten or deleted. */
const MCODE_SHIM_MARKER = "mcode hook shim";

/** True when the file at `shimPath` is still Mullion's own shim (as opposed to
 * one the user replaced with their own script). */
function isMullionMcodeShim(shimPath: string): boolean {
  try {
    if (!existsSync(shimPath)) return false;
    return readFileSync(shimPath, "utf8").includes(MCODE_SHIM_MARKER);
  } catch {
    return false;
  }
}

/**
 * Installs (or refreshes) the host-global plugin + the host-stable shim.
 *
 * Idempotent by construction: the plugin's contents are derived only from
 * constants, so re-running this writes byte-identical files. The marker
 * file records that Mullion owns the directory, so cleanup can remove it
 * without touching a user-authored plugin of the same name.
 */
export function installMcodePlugin(): void {
  const pluginDir = resolveMcodePluginDir();
  const shimPath = resolveMcodeShimPath();
  const shimSource = resolveMcodeShimSourcePath();

  // The shim first: the plugin's command line references it by path, so a
  // half-installed plugin would point at a missing script.
  //
  // It is REFRESHED, not just written when absent: the plugin's hooks.json is
  // rewritten on every install, so a shim left over from an older build would
  // otherwise keep running stale logic against a fresh plugin. A shim the
  // user replaced with their own script is left alone (we only overwrite one
  // that still carries our header marker).
  mkdirSync(path.dirname(shimPath), { recursive: true, mode: 0o755 });
  if (!existsSync(shimPath) || isMullionMcodeShim(shimPath)) {
    writeFileSync(shimPath, readFileSync(shimSource, "utf8"), { mode: 0o755 });
    chmodSync(shimPath, 0o755);
  }

  mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true, mode: 0o755 });
  mkdirSync(path.join(pluginDir, "hooks"), { recursive: true, mode: 0o755 });

  writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), buildMcodePluginManifest(), {
    mode: 0o644,
  });
  writeFileSync(path.join(pluginDir, "hooks", "hooks.json"), buildMcodeHooksJson(shimPath), {
    mode: 0o644,
  });
  writeFileSync(path.join(pluginDir, MCODE_PLUGIN_MARKER_NAME), MCODE_PLUGIN_MARKER_CONTENT, {
    mode: 0o644,
  });
}

/**
 * Removes the host-global plugin directory and shim, but ONLY if they still
 * carry Mullion's ownership marker. A user who replaced either with their
 * own content keeps it.
 */
export function removeMcodePlugin(): void {
  const pluginDir = resolveMcodePluginDir();
  const marker = path.join(pluginDir, MCODE_PLUGIN_MARKER_NAME);
  if (existsSync(marker)) {
    try {
      if (readFileSync(marker, "utf8") === MCODE_PLUGIN_MARKER_CONTENT) {
        // rm -rf via node: no shell, no glob surprises.
        rmSync(pluginDir, { recursive: true, force: true });
      }
    } catch {
      // A failed removal must never break an uninstall.
    }
  }

  const shimPath = resolveMcodeShimPath();
  try {
    if (isMullionMcodeShim(shimPath)) {
      rmSync(shimPath, { force: true });
    }
  } catch {
    // Same posture as above.
  }
}

/**
 * The hook-protocol kinds this agent can ever produce. Mirrors the Claude
 * Code set (mcode's plugin hook dialect IS Claude Code's), minus the
 * conditionally-registered blocking review gate — the gate itself is a
 * `review_gate` kind, which IS always reachable here because
 * PermissionRequest is always registered.
 */
export const MCODE_EMITS: readonly HookMessageKind[] = [
  "notification",
  "progress",
  "file_change",
  "review_gate",
  "permission_request",
  "session_start",
  "session_end",
  "turn_start",
  "tool_done",
  "cwd_changed",
  "compact",
  // The Bash matcher on PostToolUse carries the worktree/branch detection
  // the Claude Code adapter also gets — mapClaudeCodePostToolUse turns a
  // `git worktree add` / `git checkout` Bash call into a git_branch message.
  "git_branch",
];

export const mcodeAdapter = {
  name: MCODE_ADAPTER_NAME,

  matches(command: string): boolean {
    return matchesMcodeCommand(command);
  },

  emits: MCODE_EMITS,

  prepareLaunch(ctx: HookAdapterContext): HookLaunchPlan {
    const forwarderPath = ctx.forwarderPath;

    // The per-session hook-handoff file. It MUST live at exactly the path
    // the session's TMPDIR points at: mcode runs a plugin hook as a child
    // process whose environment is a strict WHITELIST, and TMPDIR survives
    // it while arbitrary MULLION_* vars do NOT. So the shim can only find the
    // file under $TMPDIR, and ctx.tmpDir is the session's EFFECTIVE temp
    // dir — the per-session `<sessionsDir>/<id>.tmp` by default, or the
    // caller's own TMPDIR when they supplied one (in which case
    // launch-plan.ts allocates no per-session temp dir at all).
    const effectiveTmpDir = ctx.tmpDir ?? path.join(ctx.sessionsDir, `${ctx.sessionId}.tmp`);
    const hookFilePath = path.join(effectiveTmpDir, "mullion-hook.json");
    const handoff = buildMcodeHookHandoff(ctx, forwarderPath);

    // The plugin install happens HERE, synchronously, rather than through the
    // `managedInstall` seam below.
    //
    // `managedInstall` is deliberately fire-and-forget (see
    // hook-adapters/index.ts's applyHookAdapters), which is fine for agy and
    // Codex — they re-read their hook config when a hook FIRES, well after
    // startup. mcode does not: it SCANS its plugin directory once at startup
    // (its own `scanLocalPackages()`, over `join(dataDir, "plugins")`), so a
    // plugin written a tick too late is simply not seen by that launch — the
    // session would come up with no hooks at all and silently fall back to
    // the byte heuristics. The write is small and idempotent (a few files,
    // byte-identical every time), so doing it inline is cheap and removes
    // the race entirely.
    //
    // A failure here must not prevent the session from spawning (hooks are a
    // pure enhancement), so it is caught and the launch continues without
    // hooks — the same defensive posture applyHookAdapters itself takes.
    try {
      installMcodePlugin();
    } catch (err) {
      // Logged rather than swallowed silently: the session still starts, but
      // it will have no hook events.
      console.error("mcode hook adapter: failed to install the mcode plugin", err);
    }

    return {
      settingsFiles: [{ path: hookFilePath, contents: handoff }],
      // mcode's model flag is `-m <provider/model>` (verified against
      // mcode 0.6.12's own `--help`), so the flag is appended the way
      // codex's is — buildModelFlag's shortFlag argument. Without this,
      // a session's chosen model would never reach mcode.
      commandTransform: (command: string) =>
        `${command}${buildModelFlag(command, ctx.model, "-m")}`,
    };
  },

  /**
   * mcode's TUI takes the initial prompt as a positional argument
   * (`mcode [prompt]`, per its own `--help`: "prompt — task to execute in
   * the interactive TUI"). Shell-quoted, same posture as the other adapters.
   */
  initialPromptArgs(prompt: string): string {
    return shellQuote(prompt);
  },

  /**
   * mcode can reopen an existing session by id (`mcode --session <id>`).
   * The id is mcode's own `mvs_<32 hex>` session id.
   */
  resumeSessionArgs(agentSessionId: string): string {
    return `--session ${JSON.stringify(agentSessionId)}`;
  },

  /**
   * mcode's own sub-agent primitive — its plugin/agent definitions under
   * `<dataDir>/agents/<name>/`. Named here so Task Master's worker prompt
   * tells the agent the right word for "run a cheaper sub-agent".
   */
  delegationHint:
    "You may decompose this task and delegate the mechanical parts to a cheaper sub-agent via mcode's own sub-agent mechanism (an agent defined under the mcode data directory's agents/), naming the sub-agent and the model it should use.",
} as const;

export default mcodeAdapter;
