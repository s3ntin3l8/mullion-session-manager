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
// Only non-blocking events are forwarded by the plugin — see
// opencode-plugin.js's own header comment for why its real gating hook,
// `permission.ask`, is deliberately not wired up yet (issue #178, same
// reasoning as Claude Code's deferred PreToolUse). Stale as of an earlier
// revision of this comment: the plugin now forwards eight event types
// (session.idle, file.edited, permission.updated, permission.replied,
// session.error, tui.toast.show, session.status, vcs.branch.updated), not
// just the original two — see OPENCODE_EMITS below and
// opencode-plugin.js's mapOpenCodeEvent for the authoritative, tested
// mapping.

const OPENCODE_COMMAND_RE = /^(?:\S*\/)?opencode(?:\s|$)/;

// Issue: extend surfaced session statuses — the hook-protocol `kind`s
// opencode-plugin.js's mapOpenCodeEvent can ever produce from the plugin
// event-bus types it currently handles, plus `promote_request` from the
// plugin's own `promote_to_worktree` tool (opencode-plugin.js:308-352,
// analogous to Claude Code's MCP-tool-sourced promote_request — see
// CLAUDE_CODE_EMITS's doc comment in claude-code.ts for the same caveat: no
// mechanical mapper to parity-test this one against). Unlike the other three
// adapters, this list is verified against opencode-plugin.js's own test
// suite (opencode-plugin.test.ts) rather than forwarder-core.test.ts — see
// that file's own parity test asserting mapOpenCodeEvent's output stays
// inside this set. No compaction/subagent equivalents included — OpenCode's
// experimental.session.compacting hook and subagent/parentID tracking exist
// upstream but aren't wired into this plugin yet (a documented follow-up,
// not asserted here).
export const OPENCODE_EMITS = [
  "progress",
  "file_change",
  "permission_request",
  // Fix: status-clearing-semantics — was "notification_resolved", which
  // `permission.replied` used to (incorrectly) map to; see
  // opencode-plugin.js's own comment on that event.
  "permission_resolved",
  "tool_failure",
  "notification",
  "git_branch",
  "cwd_changed",
  "promote_request",
  // Issue #321 — wire compaction events from opencode's session.compacting
  "compact",
  // Issue #321 — wire subagent events from opencode's session.subagent
  "subagent",
] as const;

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
  emits: OPENCODE_EMITS,
};
