// Pure, testable mapping functions for the shared hook forwarder (issue
// #174). Deliberately plain JavaScript, not TypeScript — see forwarder.mjs's
// header comment for why the whole forwarder is .mjs. Split out from
// forwarder.mjs itself (the thin stdin/socket/stdout shim) so vitest can
// exercise every agent dialect's mapping logic directly, in-process, without
// spawning a real subprocess or socket — see the plan's "Testability of the
// forwarder" note (CI's coverage-fail-under: 80 gate would otherwise be hard
// to satisfy for a file that's only ever invoked as a subprocess).

import path from "node:path";
//
// Each `map<Agent><Kind>` function takes that hook's raw stdin payload
// (already JSON-parsed) and returns a hook-protocol message object, an
// ARRAY of them (a single hook invocation that touches several files — see
// mapCodexPostToolUse below), or `null`/`[]` if this particular event
// doesn't map to anything worth sending (e.g. a PostToolUse call for a tool
// that isn't a file edit). See src/services/hook-protocol.ts for the wire
// shape each message must match.

// Tools whose PostToolUse payload maps to a `file_change` message — kept in
// sync with claude-code.ts's PostToolUse hook `matcher`, which already
// restricts Claude Code to invoking this forwarder only for these tools;
// checked again here defensively in case a hand-edited settings file (or a
// future Claude Code version) ever calls through without that matcher.
const CLAUDE_CODE_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function mapClaudeCodeNotification(payload) {
  const body = typeof payload?.message === "string" ? payload.message : "";
  return { kind: "notification", title: "Claude Code", body };
}

export function mapClaudeCodeStop() {
  return { kind: "progress", phase: "done" };
}

export function mapClaudeCodePostToolUse(payload) {
  const toolName = payload?.tool_name;
  // Issue: sidebar worktree detection — Bash tool calls may contain
  // `git worktree add`, which the forwarder maps to a `git_branch` message.
  if (toolName === "Bash") {
    return detectWorktreeAdd(payload);
  }
  if (typeof toolName !== "string" || !CLAUDE_CODE_FILE_TOOLS.has(toolName)) {
    return null;
  }
  const input = payload?.tool_input;
  const filePath =
    typeof input?.file_path === "string"
      ? input.file_path
      : typeof input?.notebook_path === "string"
        ? input.notebook_path
        : null;
  if (filePath === null || filePath.length === 0) {
    return null;
  }
  // Claude Code's PostToolUse payload doesn't reliably distinguish a
  // brand-new file from an overwrite of an existing one, so this is a
  // best-effort default rather than an authoritative diff — "modify" covers
  // the common case. The sidebar's file-change display (issue #177) treats
  // this as a hint. A precise create/modify/delete distinction would need
  // Mullion to stat the path itself, which is out of scope here.
  return { kind: "file_change", path: filePath, action: "modify" };
}

// The longest a review-gate prompt summary is allowed to be before
// truncating (issue #178) — `tool_input.command` for a Bash call can be an
// arbitrarily long script; the prompt only needs to be enough for a human to
// recognize what they're approving, not a full transcript (the sidebar/event
// feed already show the actual command elsewhere once the tool runs).
const GATE_PROMPT_MAX_CHARS = 200;

function summarizeToolCall(payload) {
  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : "a tool";
  const input = payload?.tool_input;
  const detail =
    typeof input?.command === "string"
      ? input.command
      : typeof input?.file_path === "string"
        ? input.file_path
        : null;
  if (detail === null || detail.length === 0) return toolName;
  const truncated =
    detail.length > GATE_PROMPT_MAX_CHARS ? `${detail.slice(0, GATE_PROMPT_MAX_CHARS)}…` : detail;
  return `${toolName}: ${truncated}`;
}

export function mapClaudeCodePreToolUse(payload) {
  return { kind: "review_gate", state: "waiting", prompt: summarizeToolCall(payload) };
}

// Issue #271 — fires on every SessionStart source (startup/resume/clear/
// fork; no `matcher` is registered — see claude-code.ts), so this always
// maps to the same bare message: the actual "is there a seed for THIS
// session id" lookup happens server-side (hooks.ts's consumeSeed), not from
// anything in the hook's own payload.
export function mapClaudeCodeSessionStart() {
  return { kind: "session_start" };
}

/** Issue: sidebar worktree detection — maps Claude Code's CwdChanged event
 * to a `cwd_changed` hook message so Mullion can track where Claude is
 * actually working. */
export function mapClaudeCodeCwdChanged(payload) {
  const newCwd = typeof payload?.new_cwd === "string" ? payload.new_cwd : null;
  if (newCwd === null || newCwd.length === 0) return null;
  return { kind: "cwd_changed", cwd: newCwd };
}

/** Issue: sidebar worktree detection — parses a `git worktree add` command
 * string and returns `{ branch, worktree }` when matched, or `null` for a
 * command that isn't a worktree creation. Handles short flags (`-b`, `-f`),
 * long flags (`--force`, `--guess-remote`), value-taking flags (`-b`, `-B`,
 * `--reason`), and a trailing `<commit-ish>` positional argument (the branch
 * checked out in the new worktree when no `-b`/`-B` flag is given). Strips
 * surrounding quotes from each token to tolerate shell-quoted arguments.
 * Extracted as a shared helper so both `detectWorktreeAdd` and
 * `mapAgyPreToolUse` use the same parsing logic. */
function parseWorktreeAddCommand(command) {
  const tokens = command.trim().split(/\s+/);
  // Expect: git worktree add [flags...] <path> [<commit-ish>]
  if (tokens.length < 4 || tokens[0] !== "git" || tokens[1] !== "worktree" || tokens[2] !== "add") {
    return null;
  }

  let branch = null;
  let worktree = null;

  for (let i = 3; i < tokens.length; i++) {
    const tok = tokens[i].replace(/^["']|["']$/g, "");
    // Flags that take a value: consume their argument.
    if (tok === "-b" || tok === "-B") {
      branch = tokens[i + 1]?.replace(/^["']|["']$/g, "") ?? null;
      i++;
      continue;
    }
    if (tok === "--reason") {
      i++; // consume the reason string
      continue;
    }
    // Boolean flags: -f, --force, --detach, etc.
    if (tok.startsWith("-")) continue;
    // First non-flag token is the worktree path.
    worktree = tok;
    // When no -b/-B flag was given, a trailing positional arg after the path
    // is the commit-ish checked out in the new worktree — use it as branch.
    if (i + 1 < tokens.length && branch === null) {
      branch = tokens[i + 1].replace(/^["']|["']$/g, "");
    }
    break;
  }

  if (!worktree) return null;
  const resolvedBranch = branch ?? path.basename(worktree);
  return { branch: resolvedBranch, worktree };
}

/** Issue: sidebar worktree detection — parses a PostToolUse payload for a
 * Bash tool call and detects `git worktree add` commands. Returns a
 * `git_branch` hook message when a worktree creation was detected, or `null`
 * otherwise. Shared by Claude Code and Codex. */
export function detectWorktreeAdd(payload) {
  const toolName = payload?.tool_name;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return null;

  // Only check Bash/running_command tools for git worktree operations.
  if (toolName !== "Bash" && toolName !== "run_command") return null;

  const parsed = parseWorktreeAddCommand(command);
  if (!parsed) return null;

  return { kind: "git_branch", branch: parsed.branch, worktree: parsed.worktree };
}

/** Maps one Claude Code hook event to a hook-protocol message, or `null` if
 * this event/kind combination doesn't produce one. */
export function mapClaudeCodeEvent(kind, payload) {
  switch (kind) {
    case "Notification":
      return mapClaudeCodeNotification(payload);
    case "Stop":
      return mapClaudeCodeStop();
    case "PostToolUse":
      return mapClaudeCodePostToolUse(payload);
    case "PreToolUse":
      return mapClaudeCodePreToolUse(payload);
    case "SessionStart":
      return mapClaudeCodeSessionStart();
    case "CwdChanged":
      return mapClaudeCodeCwdChanged(payload);
    default:
      return null;
  }
}

// Codex's own file-editing tool — confirmed against Codex's hook
// documentation (issue #252): `matcher` values "apply_patch", "Edit", or
// "Write" all select it, but `tool_input` always reports `tool_name:
// "apply_patch"` regardless, with the actual patch text in
// `tool_input.command` (OpenAI's well-known apply_patch mini-DSL: one or
// more `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete
// File: <path>` header lines, each optionally followed by a diff body). A
// single apply_patch call can touch several files at once, hence this
// returns an array. NOT verified against a real live Codex hook firing in
// this PR (see issue #252's tracking notes) — Codex's own hook-trust gate
// means a freshly-generated hook is never auto-trusted, so no CI or local
// run here could safely trigger a real one without a live model turn.
// Deliberately defensive: any header line that doesn't match the known
// three-verb format is simply skipped, never throws.
const APPLY_PATCH_HEADER_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$/gm;
const APPLY_PATCH_ACTION_BY_VERB = { Update: "modify", Add: "create", Delete: "delete" };

export function mapCodexStop() {
  return { kind: "progress", phase: "done" };
}

export function mapCodexPostToolUse(payload) {
  // Issue: sidebar worktree detection — Bash tool calls may contain
  // `git worktree add`, mapped to `git_branch`. Also forward the common
  // `cwd` field as a `cwd_changed` message when the working directory is
  // reported via the hook's common input fields.
  if (payload?.tool_name === "Bash") {
    const branchMsg = detectWorktreeAdd(payload);
    const result = [];
    if (branchMsg) result.push(branchMsg);
    // Codex's PostToolUse includes `cwd` in common input fields — forward
    // it so Mullion's liveCwd stays in sync.
    if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
      result.push({ kind: "cwd_changed", cwd: payload.cwd });
    }
    return result;
  }
  if (payload?.tool_name !== "apply_patch") {
    return [];
  }
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) {
    return [];
  }
  const messages = [];
  for (const match of command.matchAll(APPLY_PATCH_HEADER_RE)) {
    const [, verb, rawPath] = match;
    const path = rawPath.trim();
    if (path.length === 0) continue;
    messages.push({ kind: "file_change", path, action: APPLY_PATCH_ACTION_BY_VERB[verb] });
  }
  return messages;
}

/** Maps one Codex hook event to hook-protocol message(s). Codex has no
 * "Notification" event at all (confirmed against its hook documentation) —
 * only Stop and PostToolUse are wired up; see codex.ts's own header comment
 * for why PreToolUse/PermissionRequest (gating) are deliberately absent. */
export function mapCodexEvent(kind, payload) {
  switch (kind) {
    case "Stop":
      return mapCodexStop();
    case "PostToolUse":
      return mapCodexPostToolUse(payload);
    default:
      return null;
  }
}

/** Issue: sidebar worktree detection — maps agy's PreToolUse event for the
 * `run_command` tool. agy's PostToolUse is opaque (no tool name/args), but
 * PreToolUse carries `toolCall.args.CommandLine` (the command) AND
 * `toolCall.args.Cwd` (the working directory), making it the right event
 * for both worktree creation detection and cwd tracking. */
export function mapAgyPreToolUse(payload) {
  const toolCall = payload?.toolCall;
  if (toolCall?.name !== "run_command") return null;
  const commandLine = toolCall?.args?.CommandLine;
  const cwd = toolCall?.args?.Cwd;

  const result = [];

  // Detect git worktree add in the proposed command — uses the shared
  // parseWorktreeAddCommand helper so the regex stays in one place.
  if (typeof commandLine === "string" && commandLine.length > 0) {
    const parsed = parseWorktreeAddCommand(commandLine);
    if (parsed) {
      result.push({ kind: "git_branch", branch: parsed.branch, worktree: parsed.worktree });
    }
  }

  // Track the working directory from the Cwd arg.
  if (typeof cwd === "string" && cwd.length > 0) {
    result.push({ kind: "cwd_changed", cwd });
  }

  return result.length > 0 ? result : null;
}

/** Maps one agy (Antigravity CLI) hook event to a hook-protocol message.
 * Only `Stop` is wired up (issue #253) — `PostToolUse` is deliberately
 * omitted, unlike every other agent's dialect: agy's own hook
 * documentation doesn't show a tool-name/args field anywhere in its
 * PostToolUse payload example, so there's no verified field to extract a
 * file path from (see agy.ts's own header comment).
 *
 * Issue: sidebar worktree detection — PreToolUse is also wired now for
 * `run_command` detection of git worktree operations and cwd tracking. */
export function mapAgyEvent(kind, payload) {
  switch (kind) {
    case "Stop":
      return { kind: "progress", phase: "done" };
    case "PreToolUse":
      return mapAgyPreToolUse(payload);
    default:
      return null;
  }
}

/** Top-level dialect dispatch, keyed by the `<agent>` argv the adapter's
 * generated hook command passes (see claude-code.ts's `hookEntry`). */
export function buildForwarderMessage(agent, kind, payload) {
  switch (agent) {
    case "claude-code":
      return mapClaudeCodeEvent(kind, payload ?? {});
    case "codex":
      return mapCodexEvent(kind, payload ?? {});
    case "agy":
      return mapAgyEvent(kind, payload ?? {});
    default:
      return null;
  }
}

// Issue #178 — the decision-formatting half of the review gate: once
// runGate() (forwarder.mjs) has a real `{decision, reason}` from Mullion
// (or its own fail-closed default), this turns it into whatever JSON shape
// the target agent's PreToolUse-equivalent hook expects on stdout. Only
// Claude Code has a real gate dialect wired up (issue #174/#178) — Codex and
// agy deliberately do NOT register a PreToolUse hook at all (see codex.ts's
// and agy.ts's own header comments for why: Codex's hook-trust gate and
// agy's undocumented/likely-fail-open decision contract are both real
// hazards, not yet safe to wire up as a real safety control — see the
// tracking issue referenced there), so `buildForwarderMessage` never
// produces a `review_gate` message for them and this function's default
// branch is unreachable in practice today; it's still fail-closed rather
// than silent, in case that ever changes without this file being updated.
export function formatClaudeCodeGateDecision(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision === "approved" ? "allow" : "deny",
      permissionDecisionReason:
        reason ?? (decision === "approved" ? "Approved via Mullion" : "Denied via Mullion"),
    },
  };
}

export function formatGateDecision(agent, decision, reason) {
  switch (agent) {
    case "claude-code":
      return formatClaudeCodeGateDecision(decision, reason);
    default:
      // No other agent has a real gate dialect yet — see this function's
      // own doc comment. Genuinely unreachable today, but if it ever is
      // reached, print to stderr (never stdout — that's reserved for the
      // decision JSON itself) so it's visible rather than silently wrong.
      // Uses the same "denied"/"approved" vocabulary as every other
      // Mullion-internal decision value in this codebase (hook-protocol.ts,
      // hooks.ts, the REST endpoint) — deliberately NOT Claude Code's own
      // "deny"/"allow" field values (formatClaudeCodeGateDecision above),
      // since a future agent's own gate dialect almost certainly expects a
      // different shape entirely and shouldn't be steered toward Claude
      // Code's by this fallback's accidental resemblance to it.
      console.error(
        `forwarder: no gate dialect registered for agent "${agent}" — this should be unreachable`,
      );
      return { decision: decision === "approved" ? "approved" : "denied" };
  }
}

// Issue #271 — the SessionStart analog of formatGateDecision: once
// runSessionStart() (forwarder.mjs) has a seed string (possibly empty —
// "nothing was stashed for this session"), this turns it into whatever JSON
// shape the target agent's SessionStart hook expects on stdout. Only Claude
// Code has a documented `hookSpecificOutput.additionalContext` contract
// (verified against code.claude.com/docs/en/hooks.md) — no other adapter
// registers a SessionStart hook at all (see claude-code.ts), so this
// function's default branch is unreachable in practice today; kept
// fail-safe (empty object, never throws) rather than assuming that stays
// true.
export function formatClaudeCodeSessionStartOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

export function formatSessionStartOutput(agent, additionalContext) {
  switch (agent) {
    case "claude-code":
      return formatClaudeCodeSessionStartOutput(additionalContext);
    default:
      return {};
  }
}

/** Parses a hook's raw stdin — a single JSON object, per every agent's own
 * hook contract. Never throws: anything that isn't a JSON object (malformed,
 * an array, a scalar) parses to `null`, treated by the caller the same as
 * "no usable payload" rather than crashing the forwarder mid-hook. */
export function parseHookStdin(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}
