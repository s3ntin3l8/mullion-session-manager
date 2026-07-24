import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";
import { resolveMcpServerPath } from "./shared.js";

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
//
// `Stop`, `PreToolUse` (run_command gate), and `PostToolUse` (file tools,
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
      // forwarder checks for git worktree add detection and cwd tracking
      // AND emits a blocking review_gate for human approval.
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
    },
  };

  mkdirSync(path.dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify(merged, null, 2)}\n`);
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
    },
  };
}

export const agyAdapter: HookAgentAdapter = {
  name: "agy",
  matches: (command) => AGY_COMMAND_RE.test(command.trim()),
  prepareLaunch,
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
  MULLION_HOOK_NAME,
};
