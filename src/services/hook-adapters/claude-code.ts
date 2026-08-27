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

// Claude Code adapter (issue #174, gate hook added in issue #178, rescoped by
// issue #264). Registers Notification/Stop/PostToolUse (mapped by the
// forwarder to hook-protocol `notification`/`progress:done`/`file_change`
// messages — see src/hooks/forwarder.mjs) plus PermissionRequest, ALL
// unconditionally.
//
// PermissionRequest is now also the blocking permission-approval channel
// (issue #264), not just an observational notification — see
// forwarder-core.mjs's mapClaudeCodePermissionRequest. This replaced an
// earlier PreToolUse/Bash gate (issue #178) that defaulted off and stayed
// off in every real deployment: PreToolUse/Bash fires on EVERY Bash call,
// including ones already auto-approved by the user's own allowlist, so
// registering it unconditionally stalled every single Bash call for up to
// hooks.ts's own GATE_TIMEOUT_MS (290s) before its server-side timeout
// failed it closed (denied) — the opposite of the "autonomous dashboard"
// value prop this app exists for.
//
// PermissionRequest doesn't have that problem: confirmed live against
// installed Claude Code 2.1.220 (real interactive session) that it fires
// deterministically, and ONLY, when Claude Code is about to show an actual
// permission dialog — never for an allowlisted/auto-approved tool call. That
// makes it safe to register unconditionally with a long timeout: an
// unanswered request now falls through to Claude Code's own native prompt
// (confirmed live — a bare `{}` reply, see formatClaudeCodeGateDecision in
// forwarder-core.mjs), not a denial, so an unattended session degrades to
// exactly today's behavior rather than stalling. No `matcher` is needed
// either — PermissionRequest already only fires for the tool call that
// actually needs a decision, whatever tool that is (not narrowed to Bash the
// way the old gate was).
//
// Verified against Claude Code's own documented hooks JSON contract AND a
// live firing this session (both `allow` and `deny` decisions, plus the
// bare-`{}` fall-through) — see forwarder-core.mjs's
// mapClaudeCodePermissionRequest/formatClaudeCodeGateDecision.
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

// Issue #264 — a blocking permission decision needs long enough for an
// actual human to notice the amber review indicator and click
// Approve/Deny, not just enough to stop a wedged process (see the
// fire-and-forget hooks' timeout: 10 below). Claude Code's own default
// PermissionRequest hook timeout is confirmed live (installed 2.1.220) to be
// 600s; 300s here stays comfortably under that so Mullion's own server-side
// timeout (hooks.ts's GATE_TIMEOUT_MS, 290s) controls the fall-through
// instead of leaving it to Claude Code's own expiry behavior.
const PERMISSION_REQUEST_TIMEOUT_SECONDS = 300;
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
        // a blocking decision, so nothing downstream is waiting on this —
        // the timeout only exists to stop a wedged forwarder process from
        // lingering forever. (PermissionRequest's own call site below
        // overrides this with the much longer
        // PERMISSION_REQUEST_TIMEOUT_SECONDS.)
        timeout: timeoutSeconds,
      },
    ],
  };
}

/** Exported for tests. Builds the Claude Code `--settings` JSON contents —
 * pure, no I/O — see the file header for why PermissionRequest (the
 * permission-approval channel, issue #264) is registered unconditionally
 * rather than behind a flag the way the PreToolUse/Bash gate it replaced
 * was. Every hook here is registered regardless of any runtime flag; only
 * their timeouts differ (fire-and-forget hooks get a short one, purely to
 * stop a wedged forwarder process from lingering — PermissionRequest gets
 * PERMISSION_REQUEST_TIMEOUT_SECONDS instead, long enough for a human
 * decision). */
export function buildClaudeHookSettings(
  forwarderPath: string,
  execPath: string = process.execPath,
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
      // attention state machine, AND (issue #264) the blocking
      // permission-approval channel: the forwarder keeps this connection
      // open and waits for a human decision (or falls through to Claude
      // Code's own dialog if nobody answers in time — see
      // forwarder-core.mjs's mapClaudeCodePermissionRequest). Needs the long
      // timeout, not the fire-and-forget default.
      PermissionRequest: [
        hookEntry(execPath, forwarderPath, "PermissionRequest", PERMISSION_REQUEST_TIMEOUT_SECONDS),
      ],
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
      // forwarder maps it to `plan_ready`, so it uses the fire-and-forget
      // socket path — Claude Code proceeds normally while Mullion observes
      // the plan content. This is the only PreToolUse matcher registered —
      // the blocking Bash gate that used to live here (issue #178) was
      // replaced by PermissionRequest-based approval above (issue #264):
      // PreToolUse/Bash fired on every Bash call, including allowlisted
      // ones, which is why it needed a default-off flag and PermissionRequest
      // doesn't.
      PreToolUse: [
        {
          matcher: "ExitPlanMode",
          ...hookEntry(execPath, forwarderPath, "PreToolUse"),
        },
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
// Keeps `permission_request` (issue #264 rescope didn't remove it, just
// narrowed it): PermissionRequest now maps to `review_gate` for every tool
// EXCEPT ExitPlanMode, which stays on the old fire-and-forget
// `permission_request` shape — see mapClaudeCodePermissionRequest's own
// ExitPlanMode branch for why (hook-handlers.ts's plan_ready/permission_request
// dedup, PR #675, only runs for that message kind; routing it through
// review_gate instead would silently block every plan-mode approval on a
// gate nobody asked to answer). Includes `review_gate` for the first time as
// of that same rescope: unlike the old PreToolUse/Bash gate (only ever
// registered behind a launch-time flag this static list couldn't reflect —
// see the removed `includeReviewGate` param), PermissionRequest's non-
// ExitPlanMode path is unconditional, so `review_gate` really is always
// reachable now, not just possibly so.
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
  "review_gate",
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
  // Fix: AskUserQuestion mislabelled — forwarder-core.mjs's
  // mapClaudeCodePermissionRequest now remaps AskUserQuestion's
  // PermissionRequest hook to `question` instead of `permission_request`,
  // so this agent can actually reach `awaiting_question`. Without this
  // entry, EMITS_REQUIREMENTS (frontend/src/sessionStatus.ts) would treat
  // that status as unreachable for claude-code and render its dot
  // `.estimated`.
  "question",
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
  const settings = buildClaudeHookSettings(ctx.forwarderPath, process.execPath);
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
