import path from "node:path";

// Pure, testable mapping functions for the shared hook forwarder (issue
// #174). Deliberately plain JavaScript, not TypeScript — see forwarder.mjs's
// header comment for why the whole forwarder is .mjs. Split out from
// forwarder.mjs itself (the thin stdin/socket/stdout shim) so vitest can
// exercise every agent dialect's mapping logic directly, in-process, without
// spawning a real subprocess or socket — see the plan's "Testability of the
// forwarder" note (CI's coverage-fail-under: 80 gate would otherwise be hard
// to satisfy for a file that's only ever invoked as a subprocess).
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
  if (payload?.notification_type === "idle_prompt") {
    return { kind: "progress", phase: "done" };
  }
  const body = typeof payload?.message === "string" ? payload.message : "";
  return { kind: "notification", title: "Claude Code", body };
}

export function mapClaudeCodeStop(payload) {
  const result = { kind: "progress", phase: "done" };
  if (payload && typeof payload.last_assistant_message === "string") {
    result.lastAssistantMessage = payload.last_assistant_message;
  }
  if (payload && Array.isArray(payload.background_tasks)) {
    result.backgroundTasks = payload.background_tasks;
  }
  return result;
}

export function mapClaudeCodePostToolUse(payload) {
  const toolName = payload?.tool_name;
  if (typeof toolName !== "string") return null;

  // Check for git worktree add before checking the file-tools set — a Bash
  // command that creates a worktree is interesting even though Bash is not
  // a file-editing tool.
  const worktreeAddResult = detectWorktreeAdd(payload);
  if (worktreeAddResult) return worktreeAddResult;

  // A plain `git checkout`/`git switch` also changes this session's
  // effective branch, even in a shared (non-worktree) checkout.
  const checkoutResult = detectGitCheckout(payload);
  if (checkoutResult) return checkoutResult;

  if (!CLAUDE_CODE_FILE_TOOLS.has(toolName)) {
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
  return { kind: "file_change", path: filePath, action: "modify" };
}

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

export function mapClaudeCodeExitPlanMode(payload) {
  const input = payload?.tool_input;
  const plan = typeof input?.plan === "string" ? input.plan : "";
  const result = { kind: "plan_ready", plan };
  if (typeof input?.plan_file_path === "string") {
    result.filePath = input.plan_file_path;
  }
  return result;
}

export function mapClaudeCodeSessionStart(payload) {
  const result = { kind: "session_start" };
  if (payload && typeof payload.source === "string") {
    result.source = payload.source;
  }
  return result;
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
  if (tokens.length < 4 || tokens[0] !== "git" || tokens[1] !== "worktree" || tokens[2] !== "add") {
    return null;
  }

  let branch = null;
  let worktree = null;

  for (let i = 3; i < tokens.length; i++) {
    const tok = tokens[i].replace(/^["']|["']$/g, "");
    if (tok === "-b" || tok === "-B") {
      branch = tokens[i + 1]?.replace(/^["']|["']$/g, "") ?? null;
      i++;
      continue;
    }
    if (tok === "--reason") {
      i++;
      continue;
    }
    if (tok.startsWith("-")) continue;
    worktree = tok;
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

  if (toolName !== "Bash" && toolName !== "run_command") return null;

  const parsed = parseWorktreeAddCommand(command);
  if (!parsed) return null;

  return { kind: "git_branch", branch: parsed.branch, worktree: parsed.worktree };
}

/** Issue: sidebar worktree detection — parses a `git checkout`/`git switch`
 * command string and returns `{ branch }` when it unambiguously switches the
 * checked-out branch, or `null` otherwise (this repo's own working tree is
 * shared across sessions, so a plain checkout — not just `git worktree add`
 * — is what most sessions actually use to change branch).
 *
 * Recognizes `git switch <name>` (with or without `-c`/`-C`) and
 * `git checkout -b|-B <name>`/`git checkout <name>` — but deliberately backs
 * off (`null`) for anything that could be a file restore rather than a
 * branch switch: a `--` pathspec separator, or more than one positional
 * argument after `checkout` (e.g. `git checkout <ref> <path>` or
 * `git checkout -- <file>`). This is a string-level heuristic, not a real
 * git invocation — a bare `git checkout <ref>` that happens to be a
 * detached commit-ish rather than a branch name is reported as if it were
 * one; that's the same "best-effort, never throw" posture as
 * `parseWorktreeAddCommand`. */
function parseGitCheckoutCommand(command) {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 3 || tokens[0] !== "git") return null;
  const sub = tokens[1];
  if (sub !== "checkout" && sub !== "switch") return null;

  const rest = tokens.slice(2);
  if (rest.includes("--")) return null;

  let branch = null;
  let sawBranchFlag = false;
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i].replace(/^["']|["']$/g, "");
    if (
      (sub === "checkout" && (tok === "-b" || tok === "-B")) ||
      (sub === "switch" && (tok === "-c" || tok === "-C"))
    ) {
      sawBranchFlag = true;
      branch = rest[i + 1]?.replace(/^["']|["']$/g, "") ?? null;
      i++;
      continue;
    }
    if (tok.startsWith("-")) continue;
    positionals.push(tok);
  }

  if (sawBranchFlag) {
    return branch && branch.length > 0 ? { branch } : null;
  }
  // No -b/-B/-c/-C: ambiguous unless there's exactly one positional (a bare
  // ref/branch name) — more than one usually means a file-restore form
  // (`checkout <ref> <path>`), and zero means nothing to report. `git
  // switch` never takes a file argument, so a single positional there is
  // always a branch.
  if (positionals.length !== 1) return null;
  const candidate = positionals[0];
  if (sub === "switch") return { branch: candidate };
  // Bare `git checkout <arg>` is git's own famously overloaded form — the
  // same syntax restores a file from the index/a ref instead of switching
  // branches (`git checkout .`, `git checkout package.json`). Without
  // running git ourselves there's no way to know which one `<arg>` is, so
  // reject the shapes that are almost certainly a file/pathspec rather than
  // a branch name: current/parent dir, glob pathspecs, and extension-bearing
  // filenames. A bare extensionless filename (e.g. `git checkout Makefile`)
  // still slips through unrecognized — a known limit of this string-level
  // heuristic, same "best-effort, never throw" posture as
  // `parseWorktreeAddCommand`.
  if (candidate === "." || candidate === "..") return null;
  if (/[*?[\]]/.test(candidate)) return null;
  if (/\.\w+$/.test(candidate)) return null;
  return { branch: candidate };
}

/** Issue: sidebar worktree detection — parses a PostToolUse payload for a
 * Bash tool call and detects `git checkout`/`git switch` branch changes.
 * Returns a `git_branch` hook message (no `worktree`, since this is a
 * same-directory branch switch) or `null`. Shared by Claude Code and Codex. */
export function detectGitCheckout(payload) {
  const toolName = payload?.tool_name;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return null;

  if (toolName !== "Bash" && toolName !== "run_command") return null;

  const parsed = parseGitCheckoutCommand(command);
  if (!parsed) return null;

  return { kind: "git_branch", branch: parsed.branch };
}

export function mapClaudeCodePermissionRequest(payload) {
  const tool = typeof payload?.tool_name === "string" ? payload.tool_name : "a tool";
  const summary = summarizeToolCall(payload);
  return { kind: "permission_request", tool, summary };
}

export function mapClaudeCodeStopFailure(payload) {
  const error = payload && typeof payload.error === "string" ? payload.error : "unknown";
  const result = { kind: "stop_failure", error };
  if (payload && typeof payload.error_details === "string") {
    result.errorDetails = payload.error_details;
  }
  return result;
}

export function mapClaudeCodePostToolUseFailure(payload) {
  const tool = typeof payload?.tool_name === "string" ? payload.tool_name : "a tool";
  const error = payload && typeof payload.error === "string" ? payload.error : "unknown";
  const summary = summarizeToolCall(payload);
  return { kind: "tool_failure", tool, error, summary };
}

export function mapClaudeCodeSessionEnd(payload) {
  const reason = payload && typeof payload.reason === "string" ? payload.reason : "other";
  return { kind: "session_end", reason };
}

export function mapClaudeCodeEvent(kind, payload) {
  switch (kind) {
    case "Notification":
      return mapClaudeCodeNotification(payload);
    case "Stop":
      return mapClaudeCodeStop(payload);
    case "PostToolUse":
      return mapClaudeCodePostToolUse(payload);
    case "PreToolUse":
      if (payload?.tool_name === "ExitPlanMode") {
        return mapClaudeCodeExitPlanMode(payload);
      }
      return mapClaudeCodePreToolUse(payload);
    case "SessionStart":
      return mapClaudeCodeSessionStart(payload);
    case "CwdChanged":
      return mapClaudeCodeCwdChanged(payload);
    case "PermissionRequest":
      return mapClaudeCodePermissionRequest(payload);
    case "StopFailure":
      return mapClaudeCodeStopFailure(payload);
    case "PostToolUseFailure":
      return mapClaudeCodePostToolUseFailure(payload);
    case "SessionEnd":
      return mapClaudeCodeSessionEnd(payload);
    default:
      return null;
  }
}

const APPLY_PATCH_HEADER_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$/gm;
const APPLY_PATCH_ACTION_BY_VERB = { Update: "modify", Add: "create", Delete: "delete" };

export function mapCodexStop() {
  return { kind: "progress", phase: "done" };
}

export function mapCodexSessionStart(payload) {
  const source = typeof payload?.source === "string" ? payload.source : undefined;
  return source ? { kind: "session_start", source } : { kind: "session_start" };
}

export function mapCodexSessionEnd(payload) {
  const reason = typeof payload?.reason === "string" ? payload.reason : "other";
  return { kind: "session_end", reason };
}

export function mapCodexPermissionRequest(payload) {
  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : "a tool";
  const input = payload?.tool_input;
  const detail =
    typeof input?.command === "string"
      ? input.command
      : typeof input?.file_path === "string"
        ? input.file_path
        : null;
  const summary = detail && detail.length > 0 ? detail : toolName;
  return { kind: "permission_request", tool: toolName, summary };
}

export function mapCodexUserPromptSubmit(payload) {
  const body = typeof payload?.prompt === "string" ? payload.prompt : "";
  return { kind: "notification", title: "Codex", body };
}

export function mapCodexPostToolUse(payload) {
  // Issue: sidebar worktree detection — Bash tool calls may contain
  // `git worktree add` or a plain `git checkout`/`git switch`, either
  // mapped to `git_branch`. Also forward the common `cwd` field from the
  // hook inputs.
  if (payload?.tool_name === "Bash") {
    const branchMsg = detectWorktreeAdd(payload) ?? detectGitCheckout(payload);
    const result = [];
    if (branchMsg) result.push(branchMsg);
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

export function mapCodexEvent(kind, payload) {
  switch (kind) {
    case "Stop":
      return mapCodexStop();
    case "SessionStart":
      return mapCodexSessionStart(payload);
    case "SessionEnd":
      return mapCodexSessionEnd(payload);
    case "PermissionRequest":
      return mapCodexPermissionRequest(payload);
    case "UserPromptSubmit":
      return mapCodexUserPromptSubmit(payload);
    case "PostToolUse":
      return mapCodexPostToolUse(payload);
    default:
      return null;
  }
}

export function mapAgyPreToolUse(payload) {
  const toolCall = payload?.toolCall;
  if (toolCall?.name !== "run_command") return null;
  const commandLine = toolCall?.args?.CommandLine;
  const cwd = toolCall?.args?.Cwd;

  const result = [];
  if (typeof commandLine === "string" && commandLine.length > 0) {
    const parsed = parseWorktreeAddCommand(commandLine);
    if (parsed) {
      result.push({ kind: "git_branch", branch: parsed.branch, worktree: parsed.worktree });
    }
  }
  if (typeof cwd === "string" && cwd.length > 0) {
    result.push({ kind: "cwd_changed", cwd });
  }
  return result.length > 0 ? result : null;
}

export function mapAgyEvent(kind, payload) {
  switch (kind) {
    case "Stop": {
      const messages = [{ kind: "progress", phase: "done" }];
      const reason =
        typeof payload?.terminationReason === "string" ? payload.terminationReason : null;
      if (reason === "error") {
        messages.push({
          kind: "stop_failure",
          error: typeof payload?.error === "string" ? payload.error : "",
          terminationReason: reason,
          fullyIdle: payload?.fullyIdle === true,
        });
      }
      return messages;
    }
    case "PreToolUse": {
      const agyMessages = mapAgyPreToolUse(payload);
      // If git branch/cwd messages exist, append a review_gate for the
      // blocking gate flow. If no git/cwd messages, return just the gate.
      const tc = payload?.toolCall;
      const commandLine =
        tc?.name === "run_command" && typeof tc?.args?.CommandLine === "string"
          ? tc.args.CommandLine
          : null;
      if (!commandLine) return agyMessages;
      const gateMsg = {
        kind: "review_gate",
        state: "waiting",
        prompt: `run_command: ${
          commandLine.length > 200 ? `${commandLine.slice(0, 200)}…` : commandLine
        }`,
      };
      if (Array.isArray(agyMessages)) {
        agyMessages.push(gateMsg);
        return agyMessages;
      }
      return [gateMsg];
    }
    case "PostToolUse": {
      const tc = payload?.toolCall;
      if (!tc || typeof tc.name !== "string") return null;
      if (
        tc.name !== "write_to_file" &&
        tc.name !== "replace_file_content" &&
        tc.name !== "multi_replace_file_content"
      )
        return null;
      const args = tc.args || {};
      const filePath =
        typeof args.TargetFile === "string"
          ? args.TargetFile
          : typeof args.FilePath === "string"
            ? args.FilePath
            : null;
      if (!filePath) return null;
      return { kind: "file_change", path: filePath, action: "modify" };
    }
    default:
      return null;
  }
}

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

export function formatAgyGateDecision(decision, reason) {
  return {
    decision: decision === "approved" ? "allow" : "deny",
    ...(reason ? { reason } : {}),
  };
}

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
    case "agy":
      return formatAgyGateDecision(decision, reason);
    default:
      console.error(
        `forwarder: no gate dialect registered for agent "${agent}" — this should be unreachable`,
      );
      return { decision: decision === "approved" ? "approved" : "denied" };
  }
}

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
