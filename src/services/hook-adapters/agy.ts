import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";
import { resolveMcpServerPath, shellQuote } from "./shared.js";
import { ensureForwarderShim, forwarderHookCommand } from "./forwarder-shim.js";
import { installBundleSkills, uninstallBundleSkills } from "./mullion-bundle.js";

// agy (Antigravity CLI) adapter (issue #253). Verified against the
// installed `agy` CLI's own bundled documentation during this PR (the
// `agy-customizations` skill's `docs/hooks.md`, ground truth rather than
// the plan's earlier guesswork):
//
// - Config location: a global `hooks.json` under `~/.gemini/config/`
//   (confirmed via the same customization-root convention agy's own
//   `plugins.json`/`skills.json` use, at `~/.gemini/config/plugins/` — the
//   plan's guess of `~/.gemini/antigravity-cli/hooks.json` was wrong).
// - Schema: DIFFERENT from Claude Code/Codex — top-level keys are
//   arbitrary HOOK NAMES (not a `"hooks"` wrapper), each mapping directly
//   to its event arrays; `Stop`/`PreInvocation`/`PostInvocation` are FLAT
//   arrays of handler objects, while `PreToolUse`/`PostToolUse` use the
//   Claude-Code-style `{matcher, hooks: [...]}` grouped form.
// - No documented hook-trust gate (unlike Codex) — a managed merge here
//   auto-fires with no interactive step required.
// - Separate from all of the above: an interactive WORKSPACE-trust prompt
//   ("Do you trust the contents of this project?") that fires on every
//   never-before-seen cwd, gated by `~/.gemini/antigravity-cli/settings.json`'s
//   `trustedWorkspaces` array — verified NOT suppressed by
//   `--dangerously-skip-permissions`. See mergeAgyTrustedWorkspace below.
//
// `Stop`, `PreToolUse` (run_command — observational worktree/branch
// detection only; issue #264 removed the blocking review_gate this used to
// also emit, since agy has no PermissionRequest-equivalent hook to answer a
// permission prompt through), and `PostToolUse` (file tools,
// best-effort — agy's documented PostToolUse payload doesn't include tool
// info, so the forwarder only produces output when the undocumented
// toolCall field happens to be present) are registered. `Stop` is enriched
// to extract `terminationReason`/`error`/`fullyIdle` for error detection.
//
// Every hook command here runs via `sh -c` as a child of the `agy`
// process (per its own docs) — env-var inheritance down to that
// subprocess is assumed, not verified live (same accepted risk as Codex's
// adapter); if agy's hook subprocess doesn't inherit
// $MULLION_HOOK_SOCKET/$MULLION_HOOK_TOKEN/$MULLION_FORWARDER_PATH/
// $MULLION_FORWARDER_NODE, the forwarder-shim.ts shim just prints its
// fail-open JSON and exits 0 (safe failure mode, not a security or
// correctness bug — see that file's header for the full design).
//
// The commands below reference a FIXED, host-stable shim script
// (forwarderHookCommand(), forwarder-shim.ts), never `ctx.forwarderPath`
// directly — `~/.gemini/config/hooks.json` is a host-global file shared by
// every Mullion instance on this host, so it can never embed a
// checkout-specific path (a dev worktree's forwarder path would dangle the
// moment that worktree is removed, breaking agy hooks for every session on
// the host, not just this repo's). Each session's OWN real forwarder is
// resolved by the shim at run time from env vars launch-plan.ts injects
// per-session.

const AGY_COMMAND_RE = /^(?:\S*\/)?agy(?:\s|$)/;
const MULLION_HOOK_NAME = "mullion-hook-forwarder";

/**
 * Reads and parses one of agy's own config files (`hooks.json`,
 * `mcp_config.json`, `settings.json`), tolerating three cases the same way:
 * the file doesn't exist yet (ENOENT), and — the case this helper exists
 * for — the file exists but is **empty or whitespace-only**. agy itself
 * creates zero-byte config files ahead of ever writing real content into
 * them (`~/.gemini/config/mcp_config.json` was observed 0 bytes, created by
 * agy itself, well before any managed install ever touched it), and
 * `JSON.parse("")` throws a `SyntaxError` with no `code` property at all —
 * which used to fall straight through the ENOENT-only guard every one of
 * these three merge functions used to have inline, and abort with "cannot
 * parse". Task Master trial 220921 / PR #743's incident traces to exactly
 * this: `mergeAgyMcpConfig` threw on that empty file, `managedInstall` ran
 * its three steps fail-fast in sequence, and `mergeAgyTrustedWorkspace` —
 * downstream of the throw — never ran, leaving an unattended review agent
 * blocked on agy's own interactive "Do you trust this folder?" prompt for
 * its whole lifetime. An empty file has no content to preserve, so both
 * "missing" and "empty" return `{}`, same as always.
 *
 * Genuinely unparseable NON-empty content still throws — "a file we can't
 * parse is a file we must not blindly overwrite" is the right posture for
 * garbage, just not for a file with nothing in it yet.
 */
function readAgyJsonConfig<T>(configPath: string): T {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {} as T;
    throw err;
  }
  if (raw.trim().length === 0) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // Same posture as before this helper existed: a file we can't parse is
    // a file we must not blindly overwrite.
    throw new Error(`cannot parse existing ${configPath}, leaving it untouched`, { cause: err });
  }
}

interface AgyHandler {
  type?: string;
  command?: unknown;
  [key: string]: unknown;
}

interface AgyHooksFile {
  [hookName: string]: { Stop?: AgyHandler[]; [key: string]: unknown } | unknown;
}

function resolveAgyHooksPath(): string {
  return path.join(os.homedir(), ".gemini", "config", "hooks.json");
}

function mergeAgyHooks(ctx: HookAdapterContext, hooksPath = resolveAgyHooksPath()): void {
  // Issue: host-global hook config collision — installs the fixed, host-
  // stable forwarder shim BEFORE writing any command that references it,
  // so the config never points at a shim that isn't there yet. Guarded
  // independently: a failure here must not skip the hooks.json write below
  // (a shim install failure just means the emitted commands silently no-op
  // via the `|| printf` guard, exactly the safe degradation this whole
  // design exists to provide — never a reason to leave the OLD,
  // checkout-specific command in place). See forwarder-shim.ts's header.
  try {
    ensureForwarderShim();
  } catch (err) {
    console.error({ err }, "mergeAgyHooks: failed to install forwarder shim, continuing anyway");
  }

  const existing = readAgyJsonConfig<AgyHooksFile>(hooksPath);

  const merged: AgyHooksFile = {
    ...existing,
    [MULLION_HOOK_NAME]: {
      Stop: [
        {
          type: "command",
          command: forwarderHookCommand("agy", "Stop"),
          // agy's Stop has no documented timeout; 10s is generous for a
          // local socket round trip.
          timeout: 10,
        },
      ],
      // Issue: sidebar worktree detection — PreToolUse for run_command
      // carries toolCall.args.CommandLine and toolCall.args.Cwd, which the
      // forwarder checks for git worktree add detection and cwd tracking.
      // Purely observational (issue #264 removed the blocking review_gate
      // this used to also emit) — never blocks the tool call, so this needs
      // only enough time for an ordinary local socket round trip, not a
      // human-decision budget.
      PreToolUse: [
        {
          matcher: "run_command",
          hooks: [
            {
              type: "command",
              command: forwarderHookCommand("agy", "PreToolUse"),
              timeout: 10,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "write_to_file|replace_file_content|multi_replace_file_content",
          hooks: [
            {
              type: "command",
              command: forwarderHookCommand("agy", "PostToolUse"),
              // Fire-and-forget, not a gate — 10s is generous enough.
              timeout: 10,
            },
          ],
        },
      ],
      // SessionStart (issue #321) — fires forwarder on agent startup. No
      // SessionEnd counterpart: a registered SessionEnd hook never fires
      // (issue #461, verified empirically — see docs/agent-hooks.md's agy
      // section for the full narrative and forwarder-core.mjs's mapAgyEvent
      // for the corresponding mapper removal).
      SessionStart: [
        {
          type: "command",
          command: forwarderHookCommand("agy", "SessionStart"),
          timeout: 10,
        },
      ],
    },
  };

  mkdirSync(path.dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
}

// Folder-trust pre-approval — verified live against the installed `agy`
// binary: `--dangerously-skip-permissions` does NOT suppress agy's
// "Do you trust the contents of this project?" prompt, which is a
// SEPARATE gate from the tool-permission prompts that flag covers (per
// `agy --help`: "Auto-approve all tool permission requests" — nothing
// about folder trust). Every Task Master claim/retry creates a brand-new
// `.mullion-worktrees/mullion-task-<id>` directory, so an unattended agy
// spawn would otherwise stall at this prompt forever with nobody to
// answer it. Confirmed live: pre-populating this file's
// `trustedWorkspaces` array with the session's cwd before launch makes
// agy skip the prompt entirely.
//
// Distinct file from mergeAgyHooks'/mergeAgyMcpConfig's
// `~/.gemini/config/*.json` — agy's own CLI writes workspace trust to
// `~/.gemini/antigravity-cli/settings.json` instead (confirmed by
// inspecting the file after manually accepting the prompt once).
function resolveAgyTrustedWorkspacesPath(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

interface AgySettingsFile {
  trustedWorkspaces?: string[];
  [key: string]: unknown;
}

function mergeAgyTrustedWorkspace(
  rawCwd: string,
  settingsPath = resolveAgyTrustedWorkspacesPath(),
): void {
  // Hermes review, PR #573 — ctx.cwd (pty-manager.ts's `this.cwd`) reaches
  // here verbatim, with no path.resolve applied upstream. Normalized here,
  // the one place that actually compares against what agy itself stored,
  // rather than trusting every future caller to pass an already-absolute,
  // non-symlinked path — a relative or symlinked cwd would otherwise never
  // match agy's own entry and the trust prompt would return.
  const cwd = path.resolve(rawCwd);
  const existing = readAgyJsonConfig<AgySettingsFile>(settingsPath);
  // Hermes review, PR #573 — the "parse-or-leave-untouched" posture above
  // only guards unparseable JSON, not valid JSON with a wrong-shaped
  // trustedWorkspaces. A hand-edited string would otherwise spread into
  // individual characters below; an object would throw on `.includes` and
  // reject managedInstall, which applyHookAdapters' catch-and-fallback
  // turns into a session launched with NO hook wiring at all. Same
  // "must not blindly proceed" posture as the unparseable-JSON guard above.
  if (existing.trustedWorkspaces !== undefined && !Array.isArray(existing.trustedWorkspaces)) {
    throw new Error(`${settingsPath}'s trustedWorkspaces is not an array, leaving it untouched`);
  }

  const trustedWorkspaces = existing.trustedWorkspaces ?? [];
  // Idempotent no-op rewrite when already trusted — this runs on every
  // matching launch (managedInstall has no "only once" concept), and a
  // long-lived worktree is reused across claim/retry/review spawns.
  if (trustedWorkspaces.includes(cwd)) return;

  const merged: AgySettingsFile = {
    ...existing,
    trustedWorkspaces: [...trustedWorkspaces, cwd],
  };

  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
}

function resolveAgyMcpConfigPath(): string {
  return path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
}

// agy's REAL global customization root, per its own bundled documentation
// (`agy-customizations/docs/json_configs.md`: "`~/.gemini/config/` globally")
// — the same root resolveAgyHooksPath/resolveAgyMcpConfigPath already write
// to. Verified this session (S6 spike, plan doc) that a skill placed at
// `~/.agents/skills` — the path skills.ts's own globalSkillDirs table
// listed for agy — is NEVER actually loaded by the installed agy binary
// (its strings only reference a workspace-relative `.agents/skills`); a
// skill placed here, at `~/.gemini/config/skills`, IS loaded. Now used
// directly by skills.ts's globalSkillDirs() (fixed in #888).
export function resolveAgyGlobalSkillsDir(): string {
  return path.join(os.homedir(), ".gemini", "config", "skills");
}

interface AgyMcpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function mergeAgyMcpConfig(
  ctx: HookAdapterContext,
  mcpConfigPath = resolveAgyMcpConfigPath(),
  execPath: string = process.execPath,
): void {
  const mcpServerPath = resolveMcpServerPath();

  const existing = readAgyJsonConfig<AgyMcpConfigFile>(mcpConfigPath);

  const existingServers = existing.mcpServers ? { ...existing.mcpServers } : {};
  delete existingServers.mullion;

  const merged: AgyMcpConfigFile = {
    ...existing,
    mcpServers: {
      ...existingServers,
      mullion: {
        type: "stdio",
        command: execPath,
        args: [mcpServerPath],
        env: {
          MULLION_HOOK_SOCKET: ctx.hookSocketPath,
          MULLION_HOOK_TOKEN: ctx.hookToken,
          // #134 part 2 — see buildClaudeMcpConfig's (claude-code.ts) matching
          // comment: session-scoped hook token doubles as the control-socket
          // credential too, so this deliberately never carries MULLION_AUTH_TOKEN.
          MULLION_SOCKET_PATH: ctx.controlSocketPath,
        },
      },
    },
  };

  mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
  writeFileSync(mcpConfigPath, `${JSON.stringify(merged, null, 2)}\n`);
}

function prepareLaunch(ctx: HookAdapterContext): HookLaunchPlan {
  return {
    // async, not a plain wrapper — see codex.ts's identical note: a
    // synchronous throw from mergeAgyHooks must become a rejected promise
    // here, not an exception out of this call itself.
    //
    // The three steps below are INDEPENDENTLY guarded and run in this
    // specific order — both fixes for the same incident (Task Master trial
    // 220921 / PR #743): the old version ran them fail-fast in sequence
    // (mergeAgyHooks, mergeAgyMcpConfig, THEN the trust gate), so one bad
    // config file — a 0-byte mcp_config.json, observed live — threw and
    // skipped every step after it. `applyHookAdapters` only logs the single
    // resulting rejection and swallows it (a broken hook-config write must
    // never prevent a session from spawning), so that was silent: the
    // trusted-workspace write never ran, and an unattended review agent sat
    // blocked on agy's own interactive "Do you trust this folder?" prompt —
    // NOT suppressed by --dangerously-skip-permissions, see
    // mergeAgyTrustedWorkspace's own doc comment — for its entire lifetime.
    //
    // mergeAgyTrustedWorkspace now runs FIRST: it's the one step whose
    // failure actually stalls an unattended session on a human. hooks.json/
    // mcp_config.json failing just means this session runs with reduced
    // integration (no forwarder events, no Mullion MCP tools) — degraded,
    // never blocking.
    managedInstall: async () => {
      const steps: Array<[string, () => void]> = [
        [
          "mergeAgyTrustedWorkspace",
          () => {
            // Gated on skipPermissions, not unconditional — see
            // mergeAgyTrustedWorkspace's own doc comment for why that's the
            // right gate (the same flag that already suppresses agy's
            // tool-permission prompts). ctx.cwd is optional on the shared
            // interface (only this adapter reads it); skip silently if it's
            // somehow absent rather than pre-trusting nothing meaningful.
            if (ctx.skipPermissions && ctx.cwd) mergeAgyTrustedWorkspace(ctx.cwd);
          },
        ],
        ["mergeAgyHooks", () => mergeAgyHooks(ctx)],
        ["mergeAgyMcpConfig", () => mergeAgyMcpConfig(ctx)],
        [
          "installBundleSkills",
          () => {
            const skillsDir = resolveAgyGlobalSkillsDir();
            if (ctx.injectMullionBundle) installBundleSkills(skillsDir);
            else uninstallBundleSkills(skillsDir);
          },
        ],
      ];
      let firstError: unknown;
      for (const [name, step] of steps) {
        try {
          step();
        } catch (err) {
          // Logged here, per-step — applyHookAdapters' own catch only ever
          // sees whichever error this function ultimately rethrows, so a
          // step that fails but isn't the one rethrown (see firstError
          // below) would otherwise vanish with no trace at all.
          console.error(`[agy] managedInstall step "${name}" failed:`, err);
          firstError ??= err;
        }
      }
      // Re-throw so applyHookAdapters' existing "managed install failed"
      // log line still fires too (dual logging is intentional — this loop's
      // per-step log is the only way to see steps 2/3 when step 1 also
      // failed, since only one rejection ever reaches that outer catch).
      if (firstError !== undefined) throw firstError;
    },
  };
}

// Issue #321 — verified hook surface for agy: mergeAgyHooks registers
// Stop, PreToolUse (run_command), PostToolUse (write_to_file/replace_file_content/
// multi_replace_file_content), and SessionStart — each invoking the shared
// forwarder with an agy-native event kind (see forwarder-core.mjs's
// mapAgyEvent). No `review_gate`: unlike Claude Code/Codex, agy has no
// PermissionRequest-equivalent hook to answer a permission prompt through
// (issue #264 removed the review_gate its PreToolUse used to emit — see
// mapAgyEvent's PreToolUse case). PermissionRequest and
// compaction/subagent/elicitation events were checked
// against the installed agy CLI's documented hook surface (the forwarder's own
// per-agent dialect mapAgyEvent in forwarder-core.mjs) and do not exist as of
// this writing — see mapAgyEvent's own switch for the authoritative list of
// handled event kinds.
//
// No `session_end` (issue #461, removed — previously listed alongside
// `session_start` under the same issue #321 banner above, which turned out
// to be wrong for this one event): SessionEnd is a registered-but-dead hook
// that never fires, verified empirically — see docs/agent-hooks.md's agy
// section for the full narrative. Nothing in this repo gated on `emits`
// containing `session_end` (grepped before removing), so this has no
// runtime effect beyond making the advertised surface honest.
const AGY_EMITS = [
  "progress",
  "stop_failure",
  "git_branch",
  "cwd_changed",
  "file_change",
  "session_start",
] as const;

export const agyAdapter: HookAgentAdapter = {
  name: "agy",
  matches: (command) => AGY_COMMAND_RE.test(command.trim()),
  prepareLaunch,
  emits: AGY_EMITS,
  // `-i <prompt>`/`--prompt-interactive` — "Run an initial prompt
  // interactively and continue the session." Unlike Claude Code/Codex this
  // is a flag+value, not a bare positional, so it's built as one unit here
  // rather than relying on the caller to know agy's own flag name.
  // Verified against `agy --help` on a live host.
  //
  // Hermes review, PR #538, and independent-review follow-up (same PR) —
  // the equals-sign form. Task Master always spawns agy bare (interactive
  // mode, no `-p`/`--print`; resolveAgentCommand only ever returns the bare
  // binary name), and in THAT mode the space-separated `-i <value>` form
  // already accepts a leading-hyphen value fine (verified live: `agy -i
  // "-x hello"` reaches the same `bubbletea: could not open TTY` failure as
  // a bare `agy` with no seed at all — i.e. it gets past flag parsing
  // either way). The failure this comment originally described (`flags
  // provided but not defined: -x hello`) only reproduces with `-p`/
  // `--print` added, a mode Task Master never uses. `-i=<value>` is kept
  // anyway — strictly more robust (immune to "next token looks like a
  // flag" regardless of mode) and does fix that print-mode case, which
  // could matter if agy is ever invoked non-interactively in the future —
  // but it's not fixing a bug in Task Master's actual spawn shape today.
  initialPromptArgs: (prompt) => `-i=${shellQuote(prompt)}`,
};

/** Exported for tests only — production always uses the real, default
 * `~/.gemini/config/hooks.json` and `~/.gemini/config/mcp_config.json` (agy
 * has no documented env var to relocate its config directory, unlike Codex's
 * `CODEX_HOME`). */
export const __testing = {
  mergeAgyHooks,
  resolveAgyHooksPath,
  mergeAgyMcpConfig,
  resolveAgyMcpConfigPath,
  mergeAgyTrustedWorkspace,
  resolveAgyTrustedWorkspacesPath,
  MULLION_HOOK_NAME,
};
