// Phase 2's structured hook message protocol (issue #173) — the JSON shape
// an agent writes, one object per line, on a hook connection AFTER its
// handshake has been accepted (see src/plugins/hooks.ts). Defined once here,
// as a pure parser with no I/O, so the socket listener and its own test
// suite exercise exactly the same validation rules rather than two
// possibly-drifting copies.
//
// `kind` is deliberately open-ended: a `kind` this file hasn't been taught
// about yet is accepted verbatim (UnknownHookMessage), not rejected — this
// is what lets a future agent/protocol version add new kinds without an
// older Mullion (or a stricter validator) treating them as malformed. Only
// a message with no usable `kind` at all, or a *recognized* kind whose
// payload doesn't match its required shape, is a parse error.

export interface NotificationHookMessage {
  kind: "notification";
  title: string;
  body: string;
}

export interface ProgressHookMessage {
  kind: "progress";
  phase: "thinking" | "generating" | "done";
}

export interface FileChangeHookMessage {
  kind: "file_change";
  path: string;
  action: "modify" | "create" | "delete";
}

export interface ReviewGateHookMessage {
  kind: "review_gate";
  state: "waiting" | "approved" | "denied";
  prompt: string;
}

export interface ForkHookMessage {
  kind: "fork";
  childPid: number;
}

export interface JoinHookMessage {
  kind: "join";
  childPid: number;
}

/** Issue #271, option 2 — a model-invoked "start work" request (sent by the
 * `promote_to_worktree` MCP tool, not by a lifecycle hook — see
 * src/mcp/server.mjs). Keeps its connection open, mirroring `review_gate`'s
 * `state: "waiting"` — the model is blocked until a human resolves it
 * (POST /api/sessions/:id/promote or .../promote/decline), by design: the
 * whole point of this action is deterministic isolation, not a fire-and-
 * forget nudge the model could race past. */
export interface PromoteRequestHookMessage {
  kind: "promote_request";
  /** The model-authored seed/summary for the new worktree session. */
  summary: string;
  /** A base ref the model suggests (e.g. its own current branch) — the
   * human-facing base-ref picker defaults to this when present, but the
   * human's own choice in POST /api/sessions/:id/promote is authoritative. */
  suggestedBaseRef?: string;
}

/** Sent by the forwarder when Claude Code's `SessionStart` hook fires (see
 * claude-code.ts's adapter and forwarder-core.mjs's mapClaudeCodeEvent) —
 * asks whether a seed prompt was stashed for this session id (issue #271's
 * promote flow stashes one for the NEW session it creates). Unlike
 * `promote_request`, this is answered immediately, not queued — see
 * hooks.ts's handling. */
export interface SessionStartHookMessage {
  kind: "session_start";
}

/** A `kind` this file hasn't been taught yet — accepted, not rejected, per
 * the protocol's extensibility rule above. Carries whatever fields the
 * sender included, verbatim, alongside the (string) kind. */
export interface UnknownHookMessage {
  kind: string;
  [key: string]: unknown;
}

export type HookMessage =
  | NotificationHookMessage
  | ProgressHookMessage
  | FileChangeHookMessage
  | ReviewGateHookMessage
  | ForkHookMessage
  | JoinHookMessage
  | PromoteRequestHookMessage
  | SessionStartHookMessage
  | UnknownHookMessage;

export type ParseHookMessageResult =
  { ok: true; message: HookMessage } | { ok: false; error: string };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateNotification(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.title) || !isString(payload.body)) {
    return { ok: false, error: "notification requires string 'title' and 'body' fields" };
  }
  return { ok: true, message: { kind: "notification", title: payload.title, body: payload.body } };
}

function validateProgress(payload: Record<string, unknown>): ParseHookMessageResult {
  const phase = payload.phase;
  if (phase !== "thinking" && phase !== "generating" && phase !== "done") {
    return { ok: false, error: "progress requires 'phase' to be thinking|generating|done" };
  }
  return { ok: true, message: { kind: "progress", phase } };
}

function validateFileChange(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.path)) {
    return { ok: false, error: "file_change requires a string 'path' field" };
  }
  const action = payload.action;
  if (action !== "modify" && action !== "create" && action !== "delete") {
    return { ok: false, error: "file_change requires 'action' to be modify|create|delete" };
  }
  return { ok: true, message: { kind: "file_change", path: payload.path, action } };
}

function validateReviewGate(payload: Record<string, unknown>): ParseHookMessageResult {
  const state = payload.state;
  if (state !== "waiting" && state !== "approved" && state !== "denied") {
    return { ok: false, error: "review_gate requires 'state' to be waiting|approved|denied" };
  }
  if (!isString(payload.prompt)) {
    return { ok: false, error: "review_gate requires a string 'prompt' field" };
  }
  return { ok: true, message: { kind: "review_gate", state, prompt: payload.prompt } };
}

function validateForkOrJoin(
  kind: "fork" | "join",
  payload: Record<string, unknown>,
): ParseHookMessageResult {
  if (!isFiniteNumber(payload.childPid)) {
    return { ok: false, error: `${kind} requires a numeric 'childPid' field` };
  }
  return { ok: true, message: { kind, childPid: payload.childPid } };
}

function validatePromoteRequest(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.summary)) {
    return { ok: false, error: "promote_request requires a string 'summary' field" };
  }
  const suggestedBaseRef = isString(payload.suggestedBaseRef)
    ? payload.suggestedBaseRef
    : undefined;
  return {
    ok: true,
    message: { kind: "promote_request", summary: payload.summary, suggestedBaseRef },
  };
}

/**
 * Parses and validates one hook protocol line (a single JSON object, already
 * newline-stripped by the caller — see src/plugins/hooks.ts's line reader).
 * Never throws: every failure mode — invalid JSON, a non-object payload, a
 * missing/non-string `kind`, or a recognized kind with a malformed payload —
 * returns `{ ok: false, error }` instead. A recognized kind's payload is
 * narrowed to its specific message type; an unrecognized kind passes through
 * verbatim as `UnknownHookMessage` (see the file-level doc comment).
 */
export function parseHookMessage(line: string): ParseHookMessageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: "malformed JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "message must be a JSON object" };
  }
  const payload = parsed as Record<string, unknown>;

  const kind = payload.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    return { ok: false, error: "message must have a non-empty string 'kind' field" };
  }

  switch (kind) {
    case "notification":
      return validateNotification(payload);
    case "progress":
      return validateProgress(payload);
    case "file_change":
      return validateFileChange(payload);
    case "review_gate":
      return validateReviewGate(payload);
    case "fork":
      return validateForkOrJoin("fork", payload);
    case "join":
      return validateForkOrJoin("join", payload);
    case "promote_request":
      return validatePromoteRequest(payload);
    case "session_start":
      return { ok: true, message: { kind: "session_start" } };
    default:
      // Extensible: a future/unrecognized kind is accepted verbatim rather
      // than rejected — see the file-level doc comment.
      return { ok: true, message: payload as UnknownHookMessage };
  }
}
