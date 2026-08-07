import os from "node:os";
import path from "node:path";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";
import { resolveMcpServerPath, shellQuote } from "./shared.js";

// Issue #470 — Claude Code's own bundle (2.1.220, verified statically by
// locating `Akl()`/`fn()` and their callers in the installed binary) resolves
// its ENTIRE user-scope config tree off `CLAUDE_CONFIG_DIR`, falling back to
// `~/.claude` only when that's unset — the exact same bug class #470 fixed
// for opencode's `resolveOpenCodeConfigHome()`. agent-rules.ts, skills.ts, and
// claude-code-skills.ts all read/write paths under this root; every one of
// them must go through this resolver rather than hardcoding `~/.claude`, or a
// `CLAUDE_CONFIG_DIR` host silently reads/writes a file Claude Code never
// touches.
//
// `||`, not Claude Code's own `??`: Claude Code resolves `CLAUDE_CONFIG_DIR=""`
// to the empty string, making every subsequent join cwd-relative — mirroring
// that exactly would have Mullion write into whatever directory the server
// process happens to be running in. Treat empty as unset instead, matching
// `resolveCodexHome()`'s existing `||` in codex.ts.
//
// `.normalize("NFC")` is kept because Claude Code itself applies it — the
// point of this resolver is a byte-identical path to the agent's own, and
// skills.ts merges discovery rows by exact path string.
export function resolveClaudeConfigDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")).normalize("NFC");
}

// Claude Code's plugin cache dir has its own, narrower override
// (`CLAUDE_CODE_PLUGIN_CACHE_DIR`) ahead of the config dir — verified in the
// same bundle (`BL()`), used for `installed_plugins.json` (skills.ts's
// `listInstalledClaudePluginDirs`). Fixing only CLAUDE_CONFIG_DIR here would
// leave that file resolving to the wrong place on a host that sets the
// plugin-cache override but not (or differently from) the config dir.
export function resolveClaudePluginCacheDir(): string {
  return process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || path.join(resolveClaudeConfigDir(), "plugins");
}

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
 * pure, no I/O — see the file header for why the blocking PreToolUse (Bash)
 * gate is absent by default. The new observational hooks (PermissionRequest,
 * StopFailure, PostToolUseFailure, SessionEnd, ExitPlanMode PreToolUse) are
 * always registered — they are fire-and-forget, never block, and carry no
 * per-call spawn overhead beyond a short-lived forwarder process. */
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
      //
      // Deliberately unconditional, not gated behind "only if a seed might
      // be pending": at the moment this config is generated (spawn time),
      // there is no way to know that yet — a promote's stashSeed() call
      // only happens after the NEW session's spawn has already returned
      // (see routes/sessions.ts's promote handler), so the seed can't be
      // known in advance and baked into a conditional hook registration.
      // The round trip itself is a single local Unix-socket message pair
      // (hooks.ts answers synchronously from an in-memory map lookup, no
      // network/disk I/O) — negligible cost per session start, and any
      // failure (missing env, a timeout) already fails safe to an empty
      // additionalContext, the same fail-safe posture as every other hook
      // in this file.
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
          // File-editing tools — the forwarder maps these to a `file_change`
          // message (see forwarder-core's mapClaudeCodePostToolUse), plus
          // (fix: status-clearing-semantics) a `tool_done` alongside it.
          matcher: "Write|Edit|MultiEdit|NotebookEdit",
          ...hookEntry(execPath, forwarderPath, "PostToolUse"),
        },
        {
          // Issue: sidebar worktree detection — Bash tool calls carry
          // tool_input.command, which the forwarder checks for `git worktree
          // add` to detect worktree creation and report the new branch. Also
          // the one tool whose PostToolUse doubles as a `tool_done` release
          // signal for a permission dialog it itself raised (fix:
          // status-clearing-semantics).
          matcher: "Bash",
          ...hookEntry(execPath, forwarderPath, "PostToolUse"),
        },
        {
          // Fix: status-clearing-semantics — the remaining tools that can
          // actually raise a permission/plan dialog: AskUserQuestion (the
          // reported case — answering it left the badge stuck until turn
          // end), WebFetch/WebSearch (permission-gated), ExitPlanMode (plan
          // accept/reject — this adapter also registers a PreToolUse hook
          // for it below, purely observational; whether Claude Code ALSO
          // fires PostToolUse for it — making this matcher entry the first
          // real release path for `planState` — is unverified: check live,
          // and drop this from the matcher list if it doesn't fire), and any
          // MCP tool (`mcp__<server>__<tool>`, permission-gated by default).
          // Read/Grep/Glob/Task/TodoWrite are deliberately NOT matched here —
          // none of them can prompt, so there's nothing to release and no
          // reason to pay a forwarder spawn on every one of them.
          matcher: "AskUserQuestion|WebFetch|WebSearch|ExitPlanMode|mcp__.*",
          ...hookEntry(execPath, forwarderPath, "PostToolUse"),
        },
      ],
      // PermissionRequest fires deterministically when Claude shows a
      // permission dialog — a definitive "needs user input" signal for the
      // attention state machine. Fire-and-forget: never blocks the tool call.
      PermissionRequest: [hookEntry(execPath, forwarderPath, "PermissionRequest")],
      // StopFailure fires on API errors (rate_limit, max_output_tokens, etc.)
      // — gives visibility into abnormal turn endings. Fire-and-forget.
      StopFailure: [hookEntry(execPath, forwarderPath, "StopFailure")],
      // PostToolUseFailure fires when a tool call itself fails. Observational
      // only — distinguishes "Claude hit an error" from "Claude is working."
      PostToolUseFailure: [hookEntry(execPath, forwarderPath, "PostToolUseFailure")],
      // SessionEnd fires deterministically with a reason (clear/resume/logout)
      // when the session terminates. Matches Claude Code's short 1.5s default.
      SessionEnd: [
        hookEntry(execPath, forwarderPath, "SessionEnd", SESSION_END_HOOK_TIMEOUT_SECONDS),
      ],
      // PreToolUse ExitPlanMode is purely observational (never blocks): the
      // forwarder maps it to `plan_ready` (not `review_gate`), so it uses
      // the fire-and-forget socket path — Claude Code proceeds normally
      // while Mullion observes the plan content.
      PreToolUse: [
        {
          matcher: "ExitPlanMode",
          ...hookEntry(execPath, forwarderPath, "PreToolUse"),
        },
        // The blocking Bash review gate below — omitted entirely unless
        // includeReviewGate is true; see this file's header comment for
        // why it defaults off.
        ...(includeReviewGate
          ? [
              {
                matcher: "Bash",
                ...hookEntry(execPath, forwarderPath, "PreToolUse", GATE_HOOK_TIMEOUT_SECONDS),
              },
            ]
          : []),
      ],
      // Issue: extend surfaced session statuses — UserPromptSubmit is the one
      // deterministic "a new turn just started" signal (fires once per human
      // prompt, before Claude processes it), mapped to `turn_start`. No
      // matcher support for this event, so it always fires unconditionally.
      UserPromptSubmit: [hookEntry(execPath, forwarderPath, "UserPromptSubmit")],
      // PreCompact/PostCompact bracket a context-compaction run — mapped to
      // `compact: { state: "started" | "finished" }`. Both fire-and-forget,
      // observational only.
      PreCompact: [hookEntry(execPath, forwarderPath, "PreCompact")],
      PostCompact: [hookEntry(execPath, forwarderPath, "PostCompact")],
      // SubagentStart/SubagentStop bracket a subagent's lifetime — mapped to
      // `subagent: { state: "started" | "finished" }`. More than one can be
      // in flight at once (Session.emitHookEvent tracks a running count, not
      // a boolean).
      SubagentStart: [hookEntry(execPath, forwarderPath, "SubagentStart")],
      SubagentStop: [hookEntry(execPath, forwarderPath, "SubagentStop")],
      // PermissionDenied fires when a tool call is denied by the auto mode
      // classifier — a possible EXTRA release path for a pending
      // permission_request (see mapClaudeCodePermissionDenied's doc comment
      // in forwarder-core.mjs for why it's never the only one relied on).
      PermissionDenied: [hookEntry(execPath, forwarderPath, "PermissionDenied")],
      // Elicitation/ElicitationResult bracket an MCP server asking the human
      // a question mid-tool-call — mapped to
      // `elicitation: { state: "started" | "finished" }`, the same
      // "explicit, discrete, needs-the-user-now" tier as PermissionRequest/
      // ExitPlanMode above.
      Elicitation: [hookEntry(execPath, forwarderPath, "Elicitation")],
      ElicitationResult: [hookEntry(execPath, forwarderPath, "ElicitationResult")],
    },
  };
}

// Issue: extend surfaced session statuses — the hook-protocol `kind`s this
// adapter's registered hooks can ever produce (see forwarder-core.mjs's
// mapClaudeCodeEvent for the full mapping). Exposed via GET /api/agents
// (hook-adapters/index.ts's `emits` capability map) so the frontend never
// offers a status legend entry/filter this agent can't reach. A parity test
// (forwarder-core.test.ts) asserts every registered event's mapping output
// stays inside this set.
//
// Excludes `review_gate` deliberately: it's registered only when
// `includeReviewGate` is true (see this file's header comment), a
// launch-time flag `emits` — a static, per-adapter capability list — has no
// way to reflect. Listed here anyway would over-promise a status most
// launches never actually register.
//
// Includes `promote_request` even though it does NOT come from hooks.json
// at all — it's sent by the `promote_to_worktree` MCP tool this adapter's
// prepareLaunch() also always registers (buildClaudeMcpConfig, unconditional
// for every claude-code launch — see src/mcp/server.mjs). The
// forwarder-core.test.ts parity test below can only exercise the
// hooks.json-sourced kinds (there's no equivalent "given this MCP tool call,
// what kind comes out" mapper to test against) — this entry is a deliberate,
// documented exception to that mechanical check, not a gap in it.
export const CLAUDE_CODE_EMITS = [
  "notification",
  "progress",
  "file_change",
  "session_start",
  "cwd_changed",
  "permission_request",
  "tool_done",
  "stop_failure",
  "tool_failure",
  "session_end",
  "plan_ready",
  "git_branch",
  "turn_start",
  "compact",
  "subagent",
  "permission_resolved",
  "elicitation",
  "promote_request",
] as const;

export function buildClaudeMcpConfig(
  mcpServerPath: string,
  hookSocketPath: string,
  hookToken: string,
  controlSocketPath: string,
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
          // #134 part 2 — the control-socket transport MullionClient's new
          // session/project/preview tools use (src/mcp/client.mjs). Deliberately
          // NOT paired with MULLION_AUTH_TOKEN here: this config file is written
          // to disk under sessionsDir, readable by the very agent it's spawned
          // for, so only the SESSION-scoped hook token goes in it — the same
          // credential already used for the hook socket. That token also
          // authenticates the control socket at session scope (see
          // src/plugins/control-socket.ts's handshake), so the full-scope-only
          // ops the new tools call correctly 403 for an in-session agent rather
          // than silently escalating it to the operator's own credential.
          MULLION_SOCKET_PATH: controlSocketPath,
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
  const mcpConfig = buildClaudeMcpConfig(
    resolveMcpServerPath(),
    ctx.hookSocketPath,
    ctx.hookToken,
    ctx.controlSocketPath,
  );
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
  emits: CLAUDE_CODE_EMITS,
  // `claude [options] [prompt]` — interactive is the default (only `-p`
  // opts into print/non-interactive mode), and the prompt is a plain
  // trailing positional, so this is safe to append after commandTransform's
  // own `--settings`/`--mcp-config` flags and after the skip-permissions
  // flag (pty-manager.ts). Verified against `claude --help` on a live host.
  //
  // Hermes review, PR #538 — a task title/prompt starting with `-` (e.g.
  // "- fix X") would otherwise be parsed as an unknown OPTION, not a
  // positional, and claude exits before its first turn
  // (`error: unknown option '-x hello'`, verified live). The `--`
  // end-of-options marker closes that: everything after it is forced
  // positional, verified live to make an otherwise-rejected leading-hyphen
  // prompt work (`claude -p -- '-x hello'` succeeds where `claude -p '-x
  // hello'` doesn't).
  initialPromptArgs: (prompt) => `-- ${shellQuote(prompt)}`,
};
