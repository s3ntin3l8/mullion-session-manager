import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";

// Claude Code adapter (issue #174, gate hook added in issue #178). Registers
// three hooks unconditionally: Notification, Stop, PostToolUse (mapped by the
// forwarder to hook-protocol `notification`/`progress:done`/`file_change`
// messages — see src/hooks/forwarder.mjs) — plus a fourth, PreToolUse (the
// blocking review gate), ONLY when `ctx.reviewGateEnabled` is true (mirrors
// app.config.MULLION_REVIEW_GATE_ENABLED, default OFF — see env.ts).
//
// The gate defaults off because an unattended/autonomous session has nobody
// to click Approve/Deny: registering PreToolUse unconditionally stalls every
// single Bash call for up to GATE_HOOK_TIMEOUT_SECONDS before hooks.ts's
// server-side timeout fails it closed (denied) — the opposite of the
// "autonomous dashboard" value prop this app exists for. (An earlier version
// of this adapter did register it unconditionally — see git history around
// issue #178 — which is exactly the hazard this flag exists to avoid.)
//
// When enabled, PreToolUse is gated to `matcher: "Bash"` ONLY — deliberately
// narrower than "every tool call": Bash is the one tool whose blast radius
// (arbitrary shell execution) makes a human-in-the-loop pause worth pausing
// for; file edits stay fire-and-forget via the existing PostToolUse
// observational hook. Making the gated tool set configurable is a natural
// follow-up, not built here.
//
// Verified against Claude Code's own documented hooks JSON contract
// (PreToolUse's `hookSpecificOutput.permissionDecision` shape — see
// forwarder-core.mjs's mapClaudeCodePreToolUse/formatClaudeCodeGateDecision)
// — NOT verified against a live PreToolUse hook actually firing end-to-end
// in this PR (same "no live agent turn available in this sandbox" gap as
// PR6/PR7's own dialects); the forwarder-side round-trip is covered by
// forwarder.test.ts's fake-socket-server gating tests instead.
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

// Issue #178 — a blocking gate needs long enough for an actual human to
// notice the amber review indicator and click Approve/Deny, not just enough
// to stop a wedged process (see the fire-and-forget hooks' timeout: 10
// below). Claude Code's own default PreToolUse hook timeout is confirmed
// (see the plan's PR9 timeout note) to be 600s and to fail CLOSED (block,
// not silently allow) on expiry — 300s here stays comfortably under that so
// Mullion's own server-side timeout (hooks.ts's GATE_TIMEOUT_MS) controls
// the fail-closed decision instead of leaving it to Claude Code's own,
// less-informative expiry behavior.
const GATE_HOOK_TIMEOUT_SECONDS = 300;

function hookEntry(
  execPath: string,
  forwarderPath: string,
  kind: string,
  timeoutSeconds: number = 10,
) {
  return {
    hooks: [
      {
        type: "command" as const,
        command: `${JSON.stringify(execPath)} ${JSON.stringify(forwarderPath)} claude-code ${kind}`,
        // Generous but bounded: these are fire-and-forget notifications, not
        // gates, so nothing downstream is waiting on this — the timeout only
        // exists to stop a wedged forwarder process from lingering forever.
        // (PreToolUse's own call site below overrides this with the much
        // longer GATE_HOOK_TIMEOUT_SECONDS.)
        timeout: timeoutSeconds,
      },
    ],
  };
}

/** Exported for tests. Builds the Claude Code `--settings` JSON contents —
 * pure, no I/O — see the file header for why PreToolUse is absent. */
export function buildClaudeHookSettings(
  forwarderPath: string,
  execPath: string = process.execPath,
  // Default false, mirroring HookAdapterContext.reviewGateEnabled's own
  // default-off posture (see env.ts's MULLION_REVIEW_GATE_ENABLED) — the
  // blocking PreToolUse gate is opt-in, never registered unless a caller
  // explicitly asks for it.
  includeReviewGate: boolean = false,
) {
  return {
    hooks: {
      Notification: [hookEntry(execPath, forwarderPath, "Notification")],
      Stop: [hookEntry(execPath, forwarderPath, "Stop")],
      // Issue #271 — no `matcher`, so this fires on every source
      // (startup/resume/clear/fork): the forwarder's own round trip
      // (runSessionStart) always resolves to a completely ordinary empty
      // string unless POST /api/sessions/:id/promote actually stashed a
      // seed for THIS session id (see hooks.ts's "session_start" handling)
      // — there's no per-source distinction worth narrowing this to.
      SessionStart: [hookEntry(execPath, forwarderPath, "SessionStart")],
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
      // Omitted entirely unless includeReviewGate is true — an autonomous
      // session has nobody to click Approve/Deny, so registering this by
      // default stalls every Bash call until hooks.ts's server-side timeout
      // fails it closed (denied). See this file's header comment and
      // env.ts's MULLION_REVIEW_GATE_ENABLED for the full reasoning.
      ...(includeReviewGate
        ? {
            PreToolUse: [
              {
                // Bash only — see this file's header comment for why.
                matcher: "Bash",
                ...hookEntry(execPath, forwarderPath, "PreToolUse", GATE_HOOK_TIMEOUT_SECONDS),
              },
            ],
          }
        : {}),
    },
  };
}

// Issue #271 — resolves src/mcp/server.mjs's absolute path the same
// dev/prod-parity way resolveForwarderPath() (shared.ts) does: relative to
// THIS module's own location, since `mcp/` (like `hooks/`) is plain JS
// copied verbatim into dist/ rather than compiled (see server.mjs's own
// header comment).
function resolveMcpServerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "mcp", "server.mjs");
}

/** Exported for tests. Builds the `--mcp-config` JSON contents registering
 * `mullion` (issue #271's `promote_to_worktree` tool, the seed of issue
 * #134's eventual `mullion mcp` CLI surface). `env` is set explicitly here
 * rather than relied on to inherit from the parent process — Claude Code's
 * own inheritance behavior for `--mcp-config`-launched servers isn't
 * verified, and MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN are load-bearing for
 * every tool call this server makes, so an unverified assumption here would
 * silently break the whole feature rather than fail loudly. */
export function buildClaudeMcpConfig(
  mcpServerPath: string,
  hookSocketPath: string,
  hookToken: string,
  execPath: string = process.execPath,
) {
  return {
    mcpServers: {
      mullion: {
        type: "stdio",
        command: execPath,
        args: [mcpServerPath],
        env: {
          MULLION_HOOK_SOCKET: hookSocketPath,
          MULLION_HOOK_TOKEN: hookToken,
        },
      },
    },
  };
}

function prepareLaunch(ctx: HookAdapterContext): HookLaunchPlan {
  const settingsPath = path.join(ctx.sessionsDir, `${ctx.sessionId}.hooks.json`);
  const settings = buildClaudeHookSettings(
    ctx.forwarderPath,
    process.execPath,
    ctx.reviewGateEnabled,
  );
  const mcpConfigPath = path.join(ctx.sessionsDir, `${ctx.sessionId}.mcp.json`);
  const mcpConfig = buildClaudeMcpConfig(resolveMcpServerPath(), ctx.hookSocketPath, ctx.hookToken);
  return {
    settingsFiles: [
      { path: settingsPath, contents: JSON.stringify(settings, null, 2) },
      { path: mcpConfigPath, contents: JSON.stringify(mcpConfig, null, 2) },
    ],
    commandTransform: (command) =>
      `${command} --settings ${JSON.stringify(settingsPath)} --mcp-config ${JSON.stringify(mcpConfigPath)}`,
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
