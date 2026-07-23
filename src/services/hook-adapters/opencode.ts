import path from "node:path";
import { readFileSync } from "node:fs";
import { resolveOpenCodePluginPath } from "./shared.js";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";

// OpenCode adapter (issue #175). Unlike Claude Code/Codex/agy, OpenCode has
// no shell-command hooks at all — only a JS/TS plugin API (auto-discovered
// from a `plugins/` subdirectory it scans, not referenced by argv or by the
// config file's own `plugin` array, which is npm-package names only). This
// adapter never touches the command line: it writes the shared plugin file
// (src/hooks/opencode-plugin.js) into a per-session, ENTIRELY EPHEMERAL
// scratch directory and points `OPENCODE_CONFIG_DIR` at it.
//
// Verified against the installed OpenCode CLI + its own `@opencode-ai/*`
// package type definitions during this PR (the plan flagged this as an
// open question to confirm empirically): `OPENCODE_CONFIG_DIR` relocates
// OpenCode's own `.opencode`-shaped search (agents/commands/modes/plugins)
// to an arbitrary directory, loaded ADDITIVELY alongside the user's real
// global/project config — not in place of it. That makes this adapter fully
// ephemeral, same posture as Claude Code's `--settings` file: no write to
// `~/.config/opencode` or a project's `.opencode/` at all, and nothing to
// clean up afterward (the scratch directory lives under the sessions dir,
// same lifecycle as everything else there).
//
// Only non-blocking events are forwarded by the plugin (session.idle,
// file.edited) — see opencode-plugin.js's own header comment for why its
// real gating hook, `permission.ask`, is deliberately not wired up yet
// (issue #178, same reasoning as Claude Code's deferred PreToolUse).

const OPENCODE_COMMAND_RE = /^(?:\S*\/)?opencode(?:\s|$)/;

function prepareLaunch(ctx: HookAdapterContext): HookLaunchPlan {
  const configDir = path.join(ctx.sessionsDir, `${ctx.sessionId}.opencode-config`);
  const pluginPath = path.join(configDir, "plugins", "mullion-hook-emitter.js");
  const pluginSource = readFileSync(resolveOpenCodePluginPath(), "utf8");
  return {
    settingsFiles: [{ path: pluginPath, contents: pluginSource }],
    envAdditions: { OPENCODE_CONFIG_DIR: configDir },
  };
}

export const openCodeAdapter: HookAgentAdapter = {
  name: "opencode",
  // No commandTransform here, so — unlike Claude Code — there's no risk of
  // misattaching a rewritten argv to the wrong part of a chained command;
  // OPENCODE_CONFIG_DIR is just an env var, harmless to set even for a
  // shell that runs other programs before/after `opencode`. A plain
  // anchored program-token match is enough.
  matches: (command) => OPENCODE_COMMAND_RE.test(command.trim()),
  prepareLaunch,
};
