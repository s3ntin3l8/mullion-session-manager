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

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookAdapterContext, HookLaunchPlan } from "./types.js";
import type { HookMessageKind } from "../hook-protocol.js";
import { SHELL_METACHARACTERS_RE, shellQuote, buildModelFlag, resolveHooksDir } from "./shared.js";
import { runLoginShell } from "../login-shell.js";

/** The adapter's stable id — also the `<agent>` argv the shared forwarder
 * receives, so forwarder-core.mjs can dispatch to `mapMcodeEvent`. */
export const MCODE_ADAPTER_NAME = "mcode";

/** The plugin directory name mcode discovers under `<dataDir>/plugins/`.
 * Host-global and shared with the user's own mcode — hence the marker file
 * and the "no per-session data inside" rule documented in the header. */
export const MCODE_PLUGIN_DIR_NAME = "mullion";

/** Issue #1814 — the SECOND plugin directory, in mcode's CODEX plugin format.
 *
 * mcode's hook-result parser is PLUGIN-FORMAT-AWARE, and that is what decides
 * whether Mullion's answer to a `PermissionRequest` is actually applied:
 *
 * ```js
 * // mcode 0.6.13, chunks/chunk-7ONY7WH4.js — TMn()
 * let i = n.sourceFormat;
 * if (s.behavior === "allow") return … {
 *   ...e,
 *   permissionDecision: "allow",
 *   permissionAutoApproval: i === "CODEX" ? "any_prompt" : "ordinary_only",
 *   … };
 * ```
 *
 * and the gate that consumes it:
 *
 * ```js
 * function pur(e, t) {
 *   return e.behavior !== "allow" ? false
 *     : e.autoApproval === "any_prompt" ? true
 *     : e.autoApproval === "ordinary_only" && t.hookAutoApprovalEligible === true;
 * }
 * ```
 *
 * `sourceFormat` comes from WHICH MANIFEST the plugin carries (mcode 0.6.13,
 * `chunks/chunk-H6JEREKX.js`): `.minimax-plugin/plugin.json` → `MINIMAX`,
 * `.claude-plugin/plugin.json` → `CLAUDE`, `.codex-plugin/plugin.json` →
 * `CODEX`. The first two both yield `ordinary_only`, which mcode only
 * auto-applies when `hookAutoApprovalEligible` is true — and that is FALSE for
 * a matched permission rule or any safety category other than
 * `noMatchingPermissionRule` (e.g. `dangerousRemoval`). That is why, under
 * skip-permissions, Mullion's gate resolved to `"approved"` while mcode STILL
 * showed its own `◆ Approval required` dialog.
 *
 * Only the CODEX format yields `any_prompt` — an unconditional allow, so
 * mcode never asks. (The alternatives were checked and ruled out: answering
 * `PreToolUse` with an allow hits the same eligibility gate; `permissionMode:
 * bypassPermissions` lives in the host-global `config.yaml` that Mullion must
 * never mutate, and the TUI's and ACP's setters WRITE that file; and
 * `mcode exec --permission full` is process-local but `exec` has no
 * interactive permission capability at all.)
 *
 * WHY A SECOND DIRECTORY rather than converting the whole plugin: the CODEX
 * dialect renames mcode's tool vocabulary (its file-edit tool surfaces as
 * `apply_patch` rather than `Write`/`Edit`), and it matches `matcher` strings
 * EXACTLY instead of by regex. Converting everything would silently break
 * Mullion's `file_change` / `git_branch` / `todo` / `plan_ready` detection,
 * which are written against the Claude dialect. So the split is surgical:
 * the Claude-format plugin keeps every event EXCEPT `PermissionRequest`, and
 * this CODEX-format plugin carries `PermissionRequest` alone.
 *
 * The two directories MUST be separate: mcode picks the format by which
 * manifest file exists in a directory, with MINIMAX > CLAUDE > CODEX priority,
 * so a directory holding both a `.claude-plugin/` and a `.codex-plugin/` would
 * be loaded as CLAUDE and the whole point would be lost. */
export const MCODE_PERMISSION_PLUGIN_DIR_NAME = "mullion-permission";

/** The oldest mcode whose CODEX plugin format — and the format-aware
 * auto-approval mapping that makes it useful — is present.
 *
 * Verified by reading mcode's OWN bundle, not just 0.6.13: 0.6.12 already
 * has `".codex-plugin/plugin.json"` in its plugin loader, the same
 * `sourceFormat` → `permissionAutoApproval: "any_prompt"` mapping, and the
 * same `any_prompt`-is-unconditional gate. So the floor is 0.6.12 — the
 * version Mullion's mcode support was already live-verified against.
 *
 * Below the floor the CODEX plugin is not loaded at all, and `PermissionRequest`
 * would be registered NOWHERE (the Claude-format plugin deliberately no longer
 * carries it — see MCODE_PERMISSION_PLUGIN_DIR_NAME) — so skip-permissions
 * would silently stop working. That is why the install checks the host's
 * version and says so out loud. */
export const MCODE_MIN_VERSION_FOR_CODEX_PLUGIN = "0.6.12";

/** The host's mcode version, resolved ONCE per process. `null` when it
 * cannot be determined — e.g. mcode is not installed, in which case there is
 * no mcode session to hook anyway. */
let mcodeVersionPromise: Promise<string | null> | undefined;

/** A forced version, for the tests only. `undefined` means "resolve it". */
let mcodeVersionOverride: string | null | undefined;

/**
 * Extracts mcode's version from a `--version` output.
 *
 * The LAST triple wins, not the first: the probe runs in a login shell, and
 * a profile (nvm, direnv, a motd…) can print its own versions to stdout
 * BEFORE mcode's line — so `"nvm v0.39.7\nmcode 0.6.9"` must read `0.6.9`,
 * not `0.39.7`. (The same rule, and the same reason, is in opencode's own
 * `parseOpencodeVersion`.) An output with no version in it is reported as
 * unknown rather than guessed at.
 */
export function parseMcodeVersion(output: string): string | null {
  return [...output.matchAll(/(\d+)\.(\d+)\.(\d+)/g)].at(-1)?.[0] ?? null;
}

/** Splits a dotted version into its numeric parts. */
export function versionTuple(version: string): [number, number, number] {
  const [a = 0, b = 0, c = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return [a, b, c];
}

/**
 * A user-facing warning when `version` is older than
 * MCODE_MIN_VERSION_FOR_CODEX_PLUGIN, else null (including for a
 * null/unparseable version — never warn on doubt).
 *
 * Below the floor mcode does not load the CODEX plugin at all, and since the
 * Claude-format plugin no longer carries `PermissionRequest`, the hook would
 * be registered NOWHERE — so skip-permissions would silently stop working.
 */
export function mcodeVersionWarning(version: string | null): string | null {
  if (!version) return null;
  const have = versionTuple(version);
  const min = versionTuple(MCODE_MIN_VERSION_FOR_CODEX_PLUGIN);
  for (let i = 0; i < 3; i++) {
    if (have[i] > min[i]) return null;
    if (have[i] < min[i]) {
      return `mcode ${version} is too old: Mullion needs mcode ${MCODE_MIN_VERSION_FOR_CODEX_PLUGIN} or newer, or PermissionRequest cannot be registered and skip-permissions will not work for mcode sessions on this host. Update with \`mcode update\`.`;
    }
  }
  return null;
}

/**
 * Resolves the host's mcode version.
 *
 * It runs in a LOGIN shell, not with the server's own PATH: a spawned
 * session's shell is a login shell, so it sees the PATH the user's profile
 * builds (nvm, direnv, Homebrew…), while the Mullion server runs under
 * systemd --user with a minimal PATH (the shipped units set none). Asking the
 * server's PATH would report "not installed" for an mcode every session runs
 * perfectly well — the same "fails open, silently" shape this check exists
 * to prevent. (This is the repo's own invariant, from `agent-detect.ts`'s
 * probe.)
 *
 * It is asynchronous because the install runs inside `prepareLaunch`, on the
 * session-start path, and a login-shell probe costs ~300ms — too long to
 * block the server's event loop for. The promise is cached, so the probe
 * happens at most once per Mullion process.
 */
function resolveMcodeVersionAsync(): Promise<string | null> {
  if (mcodeVersionOverride !== undefined) return Promise.resolve(mcodeVersionOverride);
  if (!mcodeVersionPromise) {
    mcodeVersionPromise = runLoginShell("mcode --version")
      .then((out) => parseMcodeVersion(out ?? ""))
      .catch(() => null);
  }
  return mcodeVersionPromise;
}

/** Test seams for the version floor. */
export const __testing = {
  versionTuple,
  parseMcodeVersion,
  /** Forces the detected mcode version. `undefined` restores detection. */
  setMcodeVersion(version: string | null | undefined): void {
    mcodeVersionOverride = version;
    mcodeVersionPromise = undefined;
  },
};

/** Marker file written into the plugin dir so Mullion can tell "this plugin
 * is ours, safe to remove" from "the user put their own plugin here". Same
 * ownership-record idea as mullion-bundle.ts's INSTALLED_MARKER_NAME. */
export const MCODE_PLUGIN_MARKER_NAME = ".mullion-managed";

/** The marker file's contents. Compared verbatim before a removal, so a
 * user-authored file with the same name is never deleted. */
export const MCODE_PLUGIN_MARKER_CONTENT =
  "This directory is managed by Mullion (hook-adapters/mcode.ts). Remove it with `mullion` uninstall.\n";

/** mcode's own default data dir, relative to $HOME. mcode resolves
 * `<dataDir>` from its own config (falling back to `~/.minimax`) — see its
 * `cir()` helper, which pairs `config.dataDir` with
 * `join(homeDir, ".minimax")`. We resolve the same way so the plugin lands
 * where mcode actually looks for it.
 *
 * ONLY mcode's own overrides are honoured (Hermes review, PR #1793):
 * `MINIMAX_DATA_DIR`, and its legacy alias `MAVIS_DATA_DIR` — both appear
 * together in mcode's own runtime env allowlist (`chunk-ZITT4GJK.js`).
 *
 * A GENERIC env var is deliberately NOT read here. `PROFILE` in particular
 * looks plausible but belongs to the **embedded Claude Code CLI** inside
 * mcode's bundle (`chunk-X3PES5WL.js`: `wr("profile") ?? _r("PROFILE")`),
 * NOT to mcode — mcode's own CLI has no `--profile` flag at all (verified
 * against `mcode --help` 0.6.12). Honouring it would redirect the plugin to
 * `~/.minimax-<x>/plugins`, where mcode — launched without that profile —
 * never looks: hooks silently off, plus files written to a junk dir.
 * `MCODE_PROFILE` is not honoured either: no such variable exists in mcode
 * 0.6.12's own source. `MAVIS_PROFILE` is mcode's own, but it only appears
 * in mcode's env-propagation allowlist, never in the CLI's data-dir
 * resolution, so honouring it would risk the same silent miss. */
export function resolveMcodeDataDir(): string {
  const base = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim();
  if (base) return base;
  return path.join(os.homedir(), ".minimax");
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

/** Issue #1814 — the CODEX-format plugin directory that carries
 * `PermissionRequest`. See MCODE_PERMISSION_PLUGIN_DIR_NAME for why it is a
 * second directory and not a reformat of the first. */
export function resolveMcodePermissionPluginDir(): string {
  return path.join(resolveMcodePluginsDir(), MCODE_PERMISSION_PLUGIN_DIR_NAME);
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

/** One hook entry for a mcode plugin's `hooks/hooks.json`.
 *
 * The command line is FIXED — it carries no per-session data, because the
 * plugin directory is host-global. The per-session socket/token/forwarder path
 * travels in the handoff file the shim reads at run time.
 *
 * Exported for tests. Pure, no I/O. */
function mcodeHookEntry(
  shimPath: string,
  event: string,
  matcher?: string,
  timeout = 10,
): { matcher?: string; hooks: Array<{ type: "command"; command: string; timeout: number }> } {
  // The forwarder is invoked as `<agent> <kind>` (see forwarder.mjs's own
  // header) — `kind` is the hook EVENT name, and it is NOT optional: the
  // forwarder bails out (silently, no message) when either argv is missing.
  // So every entry's command carries its own event name, exactly like
  // claude-code.ts's hookEntry does.
  //
  // The command invokes the SHIM directly — NOT `node <shim>`. The shim is a
  // POSIX shell script with a `#!/bin/sh` shebang, and mcode runs the command
  // through `sh -c`, so the shell executes it via its shebang. Prefixing it
  // with node would ask node to load a `.sh` file and die with
  // ERR_UNKNOWN_FILE_EXTENSION — which would silently disable every hook
  // (Hermes review, PR #1793). The shim resolves node ITSELF at run time
  // (the handoff file's `nodePath`, falling back to PATH), so nothing is
  // lost by not naming node here.
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command" as const,
        command: `${JSON.stringify(shimPath)} ${MCODE_ADAPTER_NAME} ${event}`,
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
  };
}

/** Builds the CLAUDE-format plugin's `hooks/hooks.json` contents.
 *
 * Issue #1814 — `PermissionRequest` is NOT here: it moved to the CODEX-format
 * plugin (see MCODE_PERMISSION_PLUGIN_DIR_NAME), which is the only format
 * whose "allow" mcode applies unconditionally. Every other event stays in this
 * plugin, in the Claude dialect, because that is the dialect mcode's tool
 * names and matchers are written against.
 *
 * Exported for tests. Pure, no I/O. */
export function buildMcodeHooksJson(shimPath: string): string {
  const hooks: Record<string, unknown[]> = {
    SessionStart: [mcodeHookEntry(shimPath, "SessionStart")],
    UserPromptSubmit: [mcodeHookEntry(shimPath, "UserPromptSubmit")],
    PreToolUse: [mcodeHookEntry(shimPath, "PreToolUse")],
    PostToolUse: [
      // File-editing tools → file_change (the forwarder maps these).
      {
        matcher: "Write|Edit|MultiEdit|NotebookEdit",
        ...mcodeHookEntry(shimPath, "PostToolUse"),
      },
      // Bash → git_branch detection, same as Claude Code's own split.
      {
        matcher: "Bash",
        ...mcodeHookEntry(shimPath, "PostToolUse"),
      },
    ],
    Stop: [mcodeHookEntry(shimPath, "Stop")],
    // SessionEnd gets a short timeout: mcode itself budgets only a few
    // seconds for it (its own per-event budget), and it is fire-and-forget.
    SessionEnd: [mcodeHookEntry(shimPath, "SessionEnd", undefined, 2)],
  };

  return JSON.stringify({ hooks }, null, 2);
}

/** Builds the CODEX-format plugin's `hooks/hooks.json` contents — the
 * `PermissionRequest` hook and nothing else.
 *
 * Issue #1814. `PermissionRequest` is the BLOCKING hook: it is the whole
 * reason skip-permissions works for mcode (Mullion answers "allow" over the
 * hook socket instead of mcode showing its own permission dialog), and it is
 * also what carries a real review gate when skip-permissions is OFF.
 *
 * It MUST be registered — without it mcode's permission prompts never reach
 * Mullion at all, and skip-permissions would silently do nothing. No matcher:
 * PermissionRequest only fires for the tool call that actually needs a
 * decision, whatever tool that is.
 *
 * The reply is UNCHANGED from the Claude dialect — mcode's CODEX parser reads
 * the same `{ hookSpecificOutput: { hookEventName, decision } }` shape — but
 * the FORMAT it is delivered through is what makes mcode apply the allow
 * unconditionally instead of only for auto-approval-eligible prompts.
 *
 * The 10s ceiling is mcode's own limit (see mcodeHookEntry), which is why the
 * skip-permissions path resolves it in milliseconds — Mullion's gate server
 * auto-approves immediately — while a HUMAN approval that takes longer than
 * mcode's hook budget falls back to mcode's own native permission prompt (a
 * timeout is an "ask", never a denial, in mcode's own hook-result handling).
 *
 * Exported for tests. Pure, no I/O. */
export function buildMcodePermissionHooksJson(shimPath: string): string {
  const hooks: Record<string, unknown[]> = {
    PermissionRequest: [mcodeHookEntry(shimPath, "PermissionRequest")],
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

/** The CODEX-format plugin manifest's contents (issue #1814).
 *
 * The same JSON shape as the Claude-format manifest — mcode's compatible
 * loader requires a `name` and treats `description`/`author` as conventional.
 * It is written to `.codex-plugin/plugin.json` (NOT `.claude-plugin/`), which
 * is what makes mcode treat the plugin as `sourceFormat: "CODEX"` and hence
 * apply a `PermissionRequest` allow unconditionally.
 *
 * The CODEX loader additionally REJECTS a plugin manifest's `agents` key
 * (Claude-format only), so this manifest deliberately carries none. */
export function buildMcodePermissionPluginManifest(): string {
  return JSON.stringify(
    {
      name: MCODE_PERMISSION_PLUGIN_DIR_NAME,
      description: "Mullion's permission hook for mcode (MiniMax Code).",
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

/** Reads a file, returning its contents or null when it is missing or
 * unreadable. ONE read, no existence check first — an `existsSync` followed by
 * a `readFileSync` is a file-system race (the file can be swapped between the
 * two calls), which CodeQL flags as `js/file-system-race` (PR #1793). */
function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** True when the file at `shimPath` is still Mullion's own shim (as opposed to
 * one the user replaced with their own script). A missing file is NOT ours. */
function isMullionMcodeShim(shimPath: string): boolean {
  const contents = readFileOrNull(shimPath);
  return contents !== null && contents.includes(MCODE_SHIM_MARKER);
}

/** Monotonic counter for the scratch-file name, so two installs racing inside
 * ONE process cannot pick the same `<target>.<pid>.tmp` path. (Two separate
 * Mullion processes already differ by pid.) */
let atomicWriteCounter = 0;

/**
 * Writes `contents` to `targetPath` atomically: a sibling `<target>.<pid>.tmp`
 * file is written first and then renamed over the target, so a concurrent
 * reader can never observe a half-written file, and a reader can never see the
 * file missing between the two steps. Same directory, so the rename is
 * atomic. Mirrors forwarder-shim.ts's own `ensureForwarderShim` write.
 */
function writeFileAtomic(targetPath: string, contents: string, mode: number): void {
  atomicWriteCounter += 1;
  const tmpPath = `${targetPath}.${process.pid}.${atomicWriteCounter}.tmp`;
  try {
    writeFileSync(tmpPath, contents, { mode });
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, targetPath);
  } catch {
    // Best-effort scratch-file cleanup — a leftover `.<pid>.<n>.tmp` is
    // harmless (nothing ever reads it) and not worth failing the install over.
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw new Error(`failed to write ${targetPath}`);
  }
}

/** One plugin directory Mullion installs for mcode. */
interface McodePluginSpec {
  /** The plugin directory, under `<dataDir>/plugins/`. */
  dir: string;
  /** The manifest path, RELATIVE to the plugin dir. Which manifest file
   * exists is what tells mcode which format the plugin is in. */
  manifestRelPath: string;
  /** The manifest's contents. */
  manifest: string;
  /** The `hooks/hooks.json` contents. */
  hooks: string;
}

/** The manifest directories mcode recognises, in its own detection priority
 * order (MINIMAX > CLAUDE > CODEX). Only ONE of them may exist in a plugin
 * directory: the first one present wins, so a leftover of a higher-priority
 * format would silently change the plugin's dialect. */
const MCODE_MANIFEST_DIRS = [".minimax-plugin", ".claude-plugin", ".codex-plugin"];

/** The two plugin directories Mullion installs (issue #1814): the
 * Claude-format one carrying every event except `PermissionRequest`, and the
 * CODEX-format one carrying `PermissionRequest` alone. */
function mcodePluginSpecs(): McodePluginSpec[] {
  const shimPath = resolveMcodeShimPath();
  return [
    {
      dir: resolveMcodePluginDir(),
      manifestRelPath: path.join(".claude-plugin", "plugin.json"),
      manifest: buildMcodePluginManifest(),
      hooks: buildMcodeHooksJson(shimPath),
    },
    {
      dir: resolveMcodePermissionPluginDir(),
      manifestRelPath: path.join(".codex-plugin", "plugin.json"),
      manifest: buildMcodePermissionPluginManifest(),
      hooks: buildMcodePermissionHooksJson(shimPath),
    },
  ];
}

/**
 * Installs (or refreshes) ONE plugin directory.
 *
 * REFUSES to write into a plugin directory that exists but carries no
 * ownership marker (Hermes review, PR #1793): that directory belongs to the
 * user, and clobbering it would destroy their own plugin of the same name.
 * Removal already had this rule; install now has it too, so the two are
 * symmetric. When that happens the plugin is simply NOT installed — the
 * session comes up without hooks (hooks are a pure enhancement) and the
 * user keeps their own plugin.
 */
function installMcodePluginDir(spec: McodePluginSpec): void {
  // Ownership check BEFORE any write: a plugin directory that exists without
  // our marker is the user's own, and must not be touched. ANY of mcode's
  // three manifest formats counts — a directory holding only a
  // `.codex-plugin/plugin.json` is just as much "a user plugin called
  // mullion" as one holding the Claude-format manifest.
  const markerPath = path.join(spec.dir, MCODE_PLUGIN_MARKER_NAME);
  const existingMarker = readFileOrNull(markerPath);
  if (existingMarker !== null && existingMarker !== MCODE_PLUGIN_MARKER_CONTENT) {
    console.error(
      `mcode hook adapter: refusing to install into ${spec.dir} — it exists but is not marked as Mullion-managed (a user-authored plugin of the same name?). Leaving it untouched.`,
    );
    return;
  }
  if (
    existingMarker === null &&
    MCODE_MANIFEST_DIRS.some(
      (name) => readFileOrNull(path.join(spec.dir, name, "plugin.json")) !== null,
    )
  ) {
    console.error(
      `mcode hook adapter: refusing to install into ${spec.dir} — it exists but is not marked as Mullion-managed (a user-authored plugin of the same name?). Leaving it untouched.`,
    );
    return;
  }

  // From here on the directory is Mullion's (either it carries our marker, or
  // it did not exist at all). Drop any manifest directory that is NOT this
  // plugin's own: mcode picks the format by which manifest file is present,
  // in MINIMAX > CLAUDE > CODEX priority, so a leftover of another format
  // would silently change the plugin's dialect. This is also the migration
  // an upgrade from the pre-#1814 layout needs — the CODEX plugin's
  // directory must not keep a `.claude-plugin/` around, or mcode would load
  // it as CLAUDE and the whole point of the second plugin would be lost.
  for (const name of MCODE_MANIFEST_DIRS) {
    if (path.join(name, "plugin.json") === spec.manifestRelPath) continue;
    try {
      rmSync(path.join(spec.dir, name), { recursive: true, force: true });
    } catch {
      // Best-effort: a stale manifest directory that cannot be removed would
      // change this plugin's dialect, so it is reported rather than ignored.
      console.error(
        `mcode hook adapter: could not remove the stale ${name} directory from ${spec.dir} — mcode may load this plugin in the wrong format.`,
      );
    }
  }

  mkdirSync(path.dirname(path.join(spec.dir, spec.manifestRelPath)), {
    recursive: true,
    mode: 0o755,
  });
  mkdirSync(path.join(spec.dir, "hooks"), { recursive: true, mode: 0o755 });

  // All three go through the ATOMIC writer, not a plain writeFileSync
  // (Hermes review, PR #1793 — the last open suggestion). mcode scans its
  // plugin directory ONCE at startup, so a half-written hooks.json is exactly
  // the failure the atomic shim write prevents: two Mullion sessions
  // starting mcode at the same moment (Task Master workers) could otherwise
  // expose a truncated hooks.json to the second mcode's scan, and mcode
  // would load a plugin with no hooks and no error.
  writeFileAtomic(path.join(spec.dir, spec.manifestRelPath), spec.manifest, 0o644);
  writeFileAtomic(path.join(spec.dir, "hooks", "hooks.json"), spec.hooks, 0o644);
  writeFileAtomic(
    path.join(spec.dir, MCODE_PLUGIN_MARKER_NAME),
    MCODE_PLUGIN_MARKER_CONTENT,
    0o644,
  );
}

/**
 * Installs (or refreshes) the host-global plugins + the host-stable shim.
 *
 * Idempotent by construction: the plugin's contents are derived only from
 * constants, so re-running this writes byte-identical files. The marker
 * file records that Mullion owns the directory, so cleanup can remove it
 * without touching a user-authored plugin of the same name.
 *
 * TWO plugin directories are installed (issue #1814) — the Claude-format one
 * and the CODEX-format `PermissionRequest` one. They are independent: a
 * refusal to install one (an unmarked user directory of that name) leaves the
 * other one installed.
 */
export function installMcodePlugin(): void {
  const shimPath = resolveMcodeShimPath();
  const shimSource = resolveMcodeShimSourcePath();

  // The CODEX-format plugin is what makes mcode apply Mullion's "allow". On an
  // mcode older than the floor, that plugin is not loaded at all — and since
  // the Claude-format plugin deliberately no longer carries
  // `PermissionRequest`, the hook would be registered NOWHERE and
  // skip-permissions would silently stop working. Say so, loudly, instead.
  void resolveMcodeVersionAsync()
    .then((version) => {
      const warning = mcodeVersionWarning(version);
      if (warning) console.error(`mcode hook adapter: ${warning}`);
    })
    .catch(() => {
      // Best-effort by nature: a failed probe must never break an install.
    });

  // The shim first: the plugin's command line references it by path, so a
  // half-installed plugin would point at a missing script.
  //
  // It is REFRESHED, not just written when absent: the plugin's hooks.json is
  // rewritten on every install, so a shim left over from an older build would
  // otherwise keep running stale logic against a fresh plugin. A shim the
  // user replaced with their own script is left alone (we only overwrite one
  // that still carries our header marker).
  mkdirSync(path.dirname(shimPath), { recursive: true, mode: 0o755 });
  const existingShim = readFileOrNull(shimPath);
  if (existingShim === null || existingShim.includes(MCODE_SHIM_MARKER)) {
    writeFileAtomic(shimPath, readFileSync(shimSource, "utf8"), 0o755);
  }

  for (const spec of mcodePluginSpecs()) {
    installMcodePluginDir(spec);
  }
}

/**
 * Removes the host-global plugin directories and shim, but ONLY if they still
 * carry Mullion's ownership marker. A user who replaced either with their
 * own content keeps it.
 */
export function removeMcodePlugin(): void {
  for (const spec of mcodePluginSpecs()) {
    const marker = path.join(spec.dir, MCODE_PLUGIN_MARKER_NAME);
    // ONE read, no existence check first — see readFileOrNull's own note (an
    // existsSync-then-read pair is a file-system race; CodeQL flags it).
    const markerContents = readFileOrNull(marker);
    if (markerContents === MCODE_PLUGIN_MARKER_CONTENT) {
      try {
        // rm -rf via node: no shell, no glob surprises.
        rmSync(spec.dir, { recursive: true, force: true });
      } catch {
        // A failed removal must never break an uninstall.
      }
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
 * The hook-protocol kinds this agent can ever produce.
 *
 * Derived from the events the plugins ACTUALLY register — the Claude-format
 * plugin's (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop,
 * SessionEnd) plus the CODEX-format plugin's (PermissionRequest, issue
 * #1814) — mapped through the Claude Code dialect. `emits` feeds pty-manager's
 * `hookEmits` and `HOOK_ADAPTER_EMITS_BY_BIN`, i.e. it is what the frontend
 * offers as reachable for an mcode session, so it must not claim kinds this
 * adapter cannot produce (Hermes review, PR #1793).
 *
 * NOT claimed, because the events that produce them are not registered:
 * `notification` (needs `Notification`), `compact` (needs `PreCompact` /
 * `PostCompact`), `cwd_changed` (needs `CwdChanged` — mcode's mapping is
 * the core Claude mapper, which does not piggyback a `cwd_changed` onto
 * every event the way `mapClaudeCodeEvent` does), `tool_failure` (needs
 * `PostToolUseFailure`), `stop_failure` (needs `StopFailure`), `subagent`
 * (needs `SubagentStart` / `SubagentStop`).
 */
export const MCODE_EMITS: readonly HookMessageKind[] = [
  // SessionStart → session_start.
  "session_start",
  // UserPromptSubmit → turn_start.
  "turn_start",
  // PreToolUse on ExitPlanMode → plan_ready.
  "plan_ready",
  // PostToolUse → tool_done, plus file_change for the file-editing tools and
  // git_branch for the Bash matcher.
  "tool_done",
  "file_change",
  // The Bash matcher on PostToolUse carries the worktree/branch detection
  // the Claude Code adapter also gets — mapClaudeCodePostToolUse turns a
  // `git worktree add` / `git checkout` Bash call into a git_branch message.
  "git_branch",
  // PermissionRequest → review_gate (the blocking gate), permission_request
  // (the ExitPlanMode carve-out) and question (AskUserQuestion).
  "review_gate",
  "permission_request",
  "question",
  // Stop → progress (done).
  "progress",
  // SessionEnd → session_end.
  "session_end",
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
