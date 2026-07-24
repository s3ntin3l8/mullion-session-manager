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

/** Maps one agy (Antigravity CLI) hook event to a hook-protocol message.
 * Only `Stop` is wired up (issue #253) — `PostToolUse` is deliberately
 * omitted, unlike every other agent's dialect: agy's own hook
 * documentation doesn't show a tool-name/args field anywhere in its
 * PostToolUse payload example, so there's no verified field to extract a
 * file path from (see agy.ts's own header comment). */
export function mapAgyEvent(kind) {
  switch (kind) {
    case "Stop":
      return { kind: "progress", phase: "done" };
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
      return mapAgyEvent(kind);
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
