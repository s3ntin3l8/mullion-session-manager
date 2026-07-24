import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";
import { resolveMcpServerPath } from "./shared.js";

const CLAUDE_COMMAND_RE = /^(?:\S*\/)?claude(?:\s|$)/;
const SHELL_METACHARACTERS_RE = /[;&|<>]/;

const GATE_HOOK_TIMEOUT_SECONDS = 300;
const SESSION_END_HOOK_TIMEOUT_SECONDS = 2;

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
        timeout: timeoutSeconds,
      },
    ],
  };
}

export function buildClaudeHookSettings(
  forwarderPath: string,
  execPath: string = process.execPath,
  includeReviewGate: boolean = false,
) {
  return {
    hooks: {
      Notification: [hookEntry(execPath, forwarderPath, "Notification")],
      Stop: [hookEntry(execPath, forwarderPath, "Stop")],
      SessionStart: [hookEntry(execPath, forwarderPath, "SessionStart")],
      CwdChanged: [
        // Issue: sidebar worktree detection — fires on every `cd` inside
        // Claude Code's Bash tool. Provides old_cwd and new_cwd via the
        // forwarder's mapClaudeCodeCwdChanged, mapped to a `cwd_changed`
        // hook message so Mullion's liveCwd tracking stays in sync with
        // where Claude is actually working.
        hookEntry(execPath, forwarderPath, "CwdChanged"),
      ],
      PostToolUse: [
        {
          matcher: "Write|Edit|MultiEdit|NotebookEdit",
          ...hookEntry(execPath, forwarderPath, "PostToolUse"),
        },
        {
          // Issue: sidebar worktree detection — Bash tool calls carry
          // tool_input.command, which the forwarder checks for `git worktree
          // add` to detect worktree creation and report the new branch.
          matcher: "Bash",
          ...hookEntry(execPath, forwarderPath, "PostToolUse"),
        },
      ],
      PermissionRequest: [hookEntry(execPath, forwarderPath, "PermissionRequest")],
      StopFailure: [hookEntry(execPath, forwarderPath, "StopFailure")],
      PostToolUseFailure: [hookEntry(execPath, forwarderPath, "PostToolUseFailure")],
      SessionEnd: [
        hookEntry(execPath, forwarderPath, "SessionEnd", SESSION_END_HOOK_TIMEOUT_SECONDS),
      ],
      PreToolUse: [
        {
          matcher: "ExitPlanMode",
          ...hookEntry(execPath, forwarderPath, "PreToolUse"),
        },
        ...(includeReviewGate
          ? [
              {
                matcher: "Bash",
                ...hookEntry(execPath, forwarderPath, "PreToolUse", GATE_HOOK_TIMEOUT_SECONDS),
              },
            ]
          : []),
      ],
    },
  };
}

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
