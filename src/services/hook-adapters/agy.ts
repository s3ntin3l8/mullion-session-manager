import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";
import { resolveMcpServerPath, shellQuote } from "./shared.js";

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
// `Stop`, `PreToolUse` (run_command gate — blocking only when
// `MULLION_REVIEW_GATE_ENABLED=true`, see forwarder.mjs's gate filtering
// at issue #264), and `PostToolUse` (file tools,
// best-effort — agy's documented PostToolUse payload doesn't include tool
// info, so the forwarder only produces output when the undocumented
// toolCall field happens to be present) are registered. `Stop` is enriched
// to extract `terminationReason`/`error`/`fullyIdle` for error detection.
//
// Every hook command here runs via `sh -c` as a child of the `agy`
// process (per its own docs) — env-var inheritance down to that
// subprocess is assumed, not verified live (same accepted risk as Codex's
// adapter); if agy's hook subprocess doesn't inherit
// $MULLION_HOOK_SOCKET/$MULLION_HOOK_TOKEN, the forwarder just silently
// no-ops (safe failure mode, not a security or correctness bug).

const AGY_COMMAND_RE = /^(?:\S*\/)?agy(?:\s|$)/;
const MULLION_HOOK_NAME = "mullion-hook-forwarder";

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
  let existing: AgyHooksFile = {};
  try {
    existing = JSON.parse(readFileSync(hooksPath, "utf8")) as AgyHooksFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Same posture as codex.ts: a file we can't parse is a file we must
      // not blindly overwrite.
      throw new Error(`cannot parse existing ${hooksPath}, leaving it untouched`, { cause: err });
    }
  }

  const execPath = process.execPath;
  const fwd = ctx.forwarderPath;
  const merged: AgyHooksFile = {
    ...existing,
    [MULLION_HOOK_NAME]: {
      Stop: [
        {
          type: "command",
          command: `${JSON.stringify(execPath)} ${JSON.stringify(fwd)} agy Stop`,
          // agy's Stop has no documented timeout; 10s is generous for a
          // local socket round trip.
          timeout: 10,
        },
      ],
      // Issue: sidebar worktree detection — PreToolUse for run_command
      // carries toolCall.args.CommandLine and toolCall.args.Cwd, which the
      // forwarder checks for git worktree add detection and cwd tracking.
      // The forwarder also emits a blocking review_gate for human approval,
      // but only when MULLION_REVIEW_GATE_ENABLED=true (issue #264) —
      // without it, review_gate messages are stripped and only observational
      // messages (git_branch, cwd_changed) reach the socket.
      PreToolUse: [
        {
          matcher: "run_command",
          hooks: [
            {
              type: "command",
              command: `${JSON.stringify(execPath)} ${JSON.stringify(fwd)} agy PreToolUse`,
              // agy's PreToolUse gate needs time for a human decision,
              // matching the same reasoning as Claude Code's
              // GATE_HOOK_TIMEOUT_SECONDS. agy's own PreToolUse default
              // timeout is 30s (per its docs); 300s gives Mullion's own
              // server-side timeout (290s) room to decide before agy's
              // own timeout fires.
              timeout: 300,
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
              command: `${JSON.stringify(execPath)} ${JSON.stringify(fwd)} agy PostToolUse`,
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
          command: `${JSON.stringify(execPath)} ${JSON.stringify(fwd)} agy SessionStart`,
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
  let existing: AgySettingsFile = {};
  try {
    existing = JSON.parse(readFileSync(settingsPath, "utf8")) as AgySettingsFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Same posture as mergeAgyHooks/mergeAgyMcpConfig above: a file we
      // can't parse is a file we must not blindly overwrite.
      throw new Error(`cannot parse existing ${settingsPath}, leaving it untouched`, {
        cause: err,
      });
    }
  }
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

  let existing: AgyMcpConfigFile = {};
  try {
    existing = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as AgyMcpConfigFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`cannot parse existing ${mcpConfigPath}, leaving it untouched`, {
        cause: err,
      });
    }
  }

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
    managedInstall: async () => {
      mergeAgyHooks(ctx);
      mergeAgyMcpConfig(ctx);
      // Gated on skipPermissions, not unconditional — see
      // mergeAgyTrustedWorkspace's own doc comment above for why that's
      // the right gate (the same flag that already suppresses agy's
      // tool-permission prompts). ctx.cwd is optional on the shared
      // interface (only this adapter reads it); skip silently if it's
      // somehow absent rather than pre-trusting nothing meaningful.
      if (ctx.skipPermissions && ctx.cwd) {
        mergeAgyTrustedWorkspace(ctx.cwd);
      }
    },
  };
}

// Issue #321 — verified hook surface for agy: mergeAgyHooks registers
// Stop, PreToolUse (run_command), PostToolUse (write_to_file/replace_file_content/
// multi_replace_file_content), and SessionStart — each invoking the shared
// forwarder with an agy-native event kind (see forwarder-core.mjs's
// mapAgyEvent). Excludes `review_gate` deliberately — mapAgyEvent's PreToolUse
// case always constructs one, but forwarder.mjs strips it before sending unless
// MULLION_REVIEW_GATE_ENABLED is set (same runtime-flag-gated reasoning
// CLAUDE_CODE_EMITS documents for its own review_gate exclusion).
// PermissionRequest and compaction/subagent/elicitation events were checked
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
