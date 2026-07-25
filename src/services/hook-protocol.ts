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
  lastAssistantMessage?: string;
  backgroundTasks?: BackgroundTask[];
}

export interface BackgroundTask {
  id: string;
  type: string;
  status: string;
  description: string;
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

/** Follow-up to #275 (gap #2) — sent by opencode-plugin.js when opencode's
 * own `permission.replied` event fires, resolving a permission prompt that
 * previously produced a `notification` message (mapped from
 * `permission.updated` — see opencode-plugin.js's mapOpenCodeEvent). Needed
 * because gap #3's OUTPUT_IMMUNE_KINDS hardening means a confirmed
 * `hookNotification` no longer clears on the tool call's own PTY output —
 * the common case (a human answers in the opencode TUI) is still caught by
 * write()'s own genuine-keystroke detection, but an AUTO-APPROVED permission
 * (no keystroke at all) needs this explicit resolution instead, same
 * reasoning as `review_gate`'s approved/denied states resolving a
 * `reviewGate` confirmation. Carries no fields of its own — unlike
 * `review_gate`, there's no separate "state" to track here (opencode's
 * plugin only ever forwards this once the permission is truly settled), so
 * Session.emitHookEvent's handling is an unconditional
 * clearIfConfirmedKind("hookNotification"), gated the same way every other
 * resolution message is. */
export interface NotificationResolvedHookMessage {
  kind: "notification_resolved";
}

/** Sent by the forwarder when Claude Code's `SessionStart` hook fires (see
 * claude-code.ts's adapter and forwarder-core.mjs's mapClaudeCodeEvent) —
 * asks whether a seed prompt was stashed for this session id (issue #271's
 * promote flow stashes one for the NEW session it creates). Unlike
 * `promote_request`, this is answered immediately, not queued — see
 * hooks.ts's handling. */
export interface SessionStartHookMessage {
  kind: "session_start";
  source?: string;
}

export interface PermissionRequestHookMessage {
  kind: "permission_request";
  tool: string;
  summary: string;
}

export interface StopFailureHookMessage {
  kind: "stop_failure";
  error: string;
  errorDetails?: string;
}

export interface ToolFailureHookMessage {
  kind: "tool_failure";
  tool: string;
  error: string;
  summary?: string;
}

export interface SessionEndHookMessage {
  kind: "session_end";
  reason: string;
}

export interface PlanReadyHookMessage {
  kind: "plan_ready";
  plan: string;
  filePath?: string;
  summary?: string;
}

/** Issue: sidebar worktree detection — sent by any agent's hook forwarder
 * when the agent reports a branch change (opencode's `vcs.branch.updated`,
 * or a Bash/run_command PostToolUse/PreToolUse intercept detecting
 * `git worktree add` or a plain `git checkout`/`git switch`). `worktree` is
 * the absolute path to the worktree when the branch lives in one, or absent
 * when the agent just switched branches in the main checkout.
 *
 * Important framing for `branch` when there's no `worktree`: this is the
 * branch *this session's own agent last told us it moved to* — a
 * self-reported intent latched by PtyManager into `liveBranch`, not a live
 * read of the repo. For every agent except opencode (whose VCS awareness
 * is independent of any single tool call), the forwarder only observes git
 * commands the agent itself issues as a tracked tool call; a human typing
 * `git checkout` directly into the shared PTY, or any git activity outside
 * that tool-call surface, never produces this message. That's inherent to
 * the hook-based design, not a bug to fix by polling the directory instead
 * — in a genuinely shared (non-worktree) checkout there is only one real
 * HEAD, so "this session's branch" is necessarily a label of intent, not a
 * git fact every session could independently observe. */
export interface GitBranchHookMessage {
  kind: "git_branch";
  branch: string;
  worktree?: string;
}

/** Issue: sidebar worktree detection — sent by agents whose hooks provide
 * the current working directory explicitly (Claude Code's `CwdChanged` event,
 * agy's `PreToolUse(run_command)` with `toolCall.args.Cwd`, Codex's common
 * `cwd` field). Mirrors the OSC 7 `liveCwd` channel but from the structured
 * hook protocol instead of PTY parsing. */
export interface CwdChangedHookMessage {
  kind: "cwd_changed";
  cwd: string;
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
  | NotificationResolvedHookMessage
  | PermissionRequestHookMessage
  | StopFailureHookMessage
  | ToolFailureHookMessage
  | SessionEndHookMessage
  | PlanReadyHookMessage
  | GitBranchHookMessage
  | CwdChangedHookMessage
  | UnknownHookMessage;

export type ParseHookMessageResult =
  { ok: true; message: HookMessage } | { ok: false; error: string };

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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
  const result: ProgressHookMessage = { kind: "progress", phase };
  if (payload.lastAssistantMessage !== undefined) {
    if (!isString(payload.lastAssistantMessage)) {
      return {
        ok: false,
        error: "progress requires 'lastAssistantMessage' to be a string when present",
      };
    }
    result.lastAssistantMessage = payload.lastAssistantMessage;
  }
  if (payload.backgroundTasks !== undefined) {
    if (!isArray(payload.backgroundTasks)) {
      return {
        ok: false,
        error: "progress requires 'backgroundTasks' to be an array when present",
      };
    }
    result.backgroundTasks = payload.backgroundTasks as BackgroundTask[];
  }
  return { ok: true, message: result };
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

function validatePermissionRequest(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.tool)) {
    return { ok: false, error: "permission_request requires a string 'tool' field" };
  }
  if (!isString(payload.summary)) {
    return { ok: false, error: "permission_request requires a string 'summary' field" };
  }
  return {
    ok: true,
    message: { kind: "permission_request", tool: payload.tool, summary: payload.summary },
  };
}

function validateStopFailure(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.error)) {
    return { ok: false, error: "stop_failure requires a string 'error' field" };
  }
  const result: StopFailureHookMessage = { kind: "stop_failure", error: payload.error };
  if (isString(payload.errorDetails)) {
    result.errorDetails = payload.errorDetails;
  }
  return { ok: true, message: result };
}

function validateToolFailure(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.tool)) {
    return { ok: false, error: "tool_failure requires a string 'tool' field" };
  }
  if (!isString(payload.error)) {
    return { ok: false, error: "tool_failure requires a string 'error' field" };
  }
  if (payload.summary !== undefined && !isString(payload.summary)) {
    return { ok: false, error: "tool_failure requires 'summary' to be a string when present" };
  }
  return {
    ok: true,
    message: {
      kind: "tool_failure",
      tool: payload.tool,
      error: payload.error,
      ...(isString(payload.summary) ? { summary: payload.summary } : {}),
    },
  };
}

function validateSessionEnd(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.reason)) {
    return { ok: false, error: "session_end requires a string 'reason' field" };
  }
  return { ok: true, message: { kind: "session_end", reason: payload.reason } };
}

function validatePlanReady(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.plan)) {
    return { ok: false, error: "plan_ready requires a string 'plan' field" };
  }
  if (payload.filePath !== undefined && !isString(payload.filePath)) {
    return { ok: false, error: "plan_ready requires 'filePath' to be a string when present" };
  }
  if (payload.summary !== undefined && !isString(payload.summary)) {
    return { ok: false, error: "plan_ready requires 'summary' to be a string when present" };
  }
  return {
    ok: true,
    message: {
      kind: "plan_ready",
      plan: payload.plan,
      ...(isString(payload.filePath) ? { filePath: payload.filePath } : {}),
      ...(isString(payload.summary) ? { summary: payload.summary } : {}),
    },
  };
}

function validateGitBranch(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.branch) || payload.branch.length === 0) {
    return { ok: false, error: "git_branch requires a non-empty string 'branch' field" };
  }
  const worktree =
    isString(payload.worktree) && payload.worktree.length > 0 ? payload.worktree : undefined;
  return { ok: true, message: { kind: "git_branch", branch: payload.branch, worktree } };
}

function validateCwdChanged(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.cwd) || payload.cwd.length === 0) {
    return { ok: false, error: "cwd_changed requires a non-empty string 'cwd' field" };
  }
  return { ok: true, message: { kind: "cwd_changed", cwd: payload.cwd } };
}

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
    case "session_start": {
      if (payload.source !== undefined && !isString(payload.source)) {
        return { ok: false, error: "session_start requires 'source' to be a string when present" };
      }
      const result: SessionStartHookMessage = { kind: "session_start" };
      if (isString(payload.source)) {
        result.source = payload.source;
      }
      return { ok: true, message: result };
    }
    case "notification_resolved":
      return { ok: true, message: { kind: "notification_resolved" } };
    case "permission_request":
      return validatePermissionRequest(payload);
    case "stop_failure":
      return validateStopFailure(payload);
    case "tool_failure":
      return validateToolFailure(payload);
    case "session_end":
      return validateSessionEnd(payload);
    case "plan_ready":
      return validatePlanReady(payload);
    case "git_branch":
      return validateGitBranch(payload);
    case "cwd_changed":
      return validateCwdChanged(payload);
    default:
      return { ok: true, message: payload as UnknownHookMessage };
  }
}
