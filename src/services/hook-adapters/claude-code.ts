import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";

// Claude Code adapter (issue #174) — the first concrete HookAgentAdapter.
// Registers three NON-blocking hooks only: Notification, Stop, PostToolUse
// (mapped by the forwarder to hook-protocol `notification`/`progress:done`/
// `file_change` messages — see src/hooks/forwarder.mjs). `PreToolUse` (the
// blocking review-gate hook) is DELIBERATELY NOT registered here: there is
// no endpoint yet to ever answer it (that ships in PR9, issue #178), and
// registering a blocking hook with nothing to resolve it would hang every
// real tool call up to Claude Code's own hook timeout. See this PR's
// description for the full reasoning.
//
// Verified this session (see the plan's Context section): Claude Code has no
// env-var hook-config mechanism, so `--settings <file>` is the only way to
// inject hooks without writing into `~/.claude` or the target repo. That
// makes this adapter's `commandTransform` the ONE deliberate, narrow
// exception to CLAUDE.md's "the backend never parses a shell command line"
// invariant — scoped to appending one flag, and only once `matches()` has
// confirmed this is an unchained, literal `claude ...` invocation.

// Anchored at the start of the trimmed command, optionally path-qualified
// (`/usr/local/bin/claude`), followed by a space or end-of-string — same
// conservative "no partial/substring match" posture as agent-detect.ts's
// KNOWN_AGENTS probing. Combined with the shell-metacharacter check below,
// this is deliberately narrower than "the command contains claude somewhere"
// so `--settings` is only ever appended to a simple, unchained invocation.
const CLAUDE_COMMAND_RE = /^(?:\S*\/)?claude(?:\s|$)/;
// Any of these anywhere in the command means it's not a simple invocation
// (a pipeline, a chain, redirection, or a second command) — appending
// `--settings <path>` to the raw string in that case could attach the flag
// to the wrong part of the chain instead of to `claude` itself.
const SHELL_METACHARACTERS_RE = /[;&|<>]/;

function hookEntry(execPath: string, forwarderPath: string, kind: string) {
  return {
    hooks: [
      {
        type: "command" as const,
        command: `${JSON.stringify(execPath)} ${JSON.stringify(forwarderPath)} claude-code ${kind}`,
        // Generous but bounded: these are fire-and-forget notifications, not
        // gates, so nothing downstream is waiting on this — the timeout only
        // exists to stop a wedged forwarder process from lingering forever.
        timeout: 10,
      },
    ],
  };
}

/** Exported for tests. Builds the Claude Code `--settings` JSON contents —
 * pure, no I/O — see the file header for why PreToolUse is absent. */
export function buildClaudeHookSettings(
  forwarderPath: string,
  execPath: string = process.execPath,
) {
  return {
    hooks: {
      Notification: [hookEntry(execPath, forwarderPath, "Notification")],
      Stop: [hookEntry(execPath, forwarderPath, "Stop")],
      PostToolUse: [
        {
          // Restricted to the file-editing tools — the only ones the
          // forwarder maps to a `file_change` message (see forwarder-core's
          // mapPostToolUse). Other tools still run without a hook attached
          // at all, cheaper than invoking the forwarder just to no-op.
          matcher: "Write|Edit|MultiEdit|NotebookEdit",
          ...hookEntry(execPath, forwarderPath, "PostToolUse"),
        },
      ],
    },
  };
}

function prepareLaunch(ctx: HookAdapterContext): HookLaunchPlan {
  const settingsPath = path.join(ctx.sessionsDir, `${ctx.sessionId}.hooks.json`);
  const settings = buildClaudeHookSettings(ctx.forwarderPath);
  return {
    settingsFiles: [{ path: settingsPath, contents: JSON.stringify(settings, null, 2) }],
    commandTransform: (command) => `${command} --settings ${JSON.stringify(settingsPath)}`,
  };
}

export const claudeCodeAdapter: HookAgentAdapter = {
  name: "claude-code",
  matches: (command) => {
    const trimmed = command.trim();
    return CLAUDE_COMMAND_RE.test(trimmed) && !SHELL_METACHARACTERS_RE.test(trimmed);
  },
  prepareLaunch,
};
