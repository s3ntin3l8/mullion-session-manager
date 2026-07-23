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
// (already JSON-parsed) and returns a hook-protocol message object (see
// src/services/hook-protocol.ts for the wire shape these must match) or
// `null` if this particular event doesn't map to anything worth sending
// (e.g. a PostToolUse call for a tool that isn't a file edit).

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
    default:
      return null;
  }
}

/** Top-level dialect dispatch, keyed by the `<agent>` argv the adapter's
 * generated hook command passes (see claude-code.ts's `hookEntry`). Codex/agy
 * (follow-up PRs) add their own `case` here, reusing this same shim. */
export function buildForwarderMessage(agent, kind, payload) {
  switch (agent) {
    case "claude-code":
      return mapClaudeCodeEvent(kind, payload ?? {});
    default:
      return null;
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
