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

export function mapCodexPostToolUse(payload) {
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
    case "PostToolUse":
      return mapCodexPostToolUse(payload);
    default:
      return null;
  }
}

export function mapAgyEvent(kind) {
  switch (kind) {
    case "Stop":
      return { kind: "progress", phase: "done" };
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
      return mapAgyEvent(kind);
    default:
      return null;
  }
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
