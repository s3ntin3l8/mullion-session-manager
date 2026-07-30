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
  /** Free-text detail for the current phase (e.g. retry context). */
  detail?: string;
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
  /** Phase 5 (Track A) — present when this change happened inside a
   * subagent. Claude Code's PostToolUse carries agent_id/agent_type on every
   * hook fired during a SubagentStart/SubagentStop-bracketed tool call
   * (verified empirically against a live subagent invocation, not just the
   * docs); a main-agent-caused change never carries these. Lets the
   * subagent registry attribute the change to the subagent that made it,
   * rather than just the parent session. */
  agentId?: string;
  agentType?: string;
}

export interface ReviewGateHookMessage {
  kind: "review_gate";
  state: "waiting" | "approved" | "denied";
  prompt: string;
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

/** Follow-up to #275 (gap #2) — originally sent by opencode-plugin.js when
 * opencode's own `permission.replied` event fired. Fix: status-clearing-
 * semantics moved that mapping to `permission_resolved` instead (matching
 * what `permission.updated` actually raises — `permission_request`, not a
 * generic `notification`; the old mapping here cleared the wrong attention
 * kind and never released `permissionState` at all), leaving this kind with
 * **no current producer** anywhere in the tree. Kept — not dead code to
 * prune — as the documented resolver for a genuine `hookNotification` that's
 * been auto-resolved with no keystroke of its own; issue #321 (wiring
 * opencode's/agy's remaining hook surfaces) may give it one again.
 *
 * Below: the ORIGINAL rationale, still accurate for what this kind is FOR,
 * just not for what currently sends it. Resolves a permission prompt that
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

/** Fix: status-clearing-semantics — sent when a tool call finishes, tagged
 * with the tool's own name. Claude Code has no "permission granted" hook (a
 * denied call fires PermissionDenied; an allowed one fires nothing), so a
 * completed tool is the only forward-progress evidence that a pending
 * `permission_request`/`plan_ready` for THAT tool has actually been
 * resolved. Deliberately its own kind rather than a new `progress` phase:
 * `progress` is also where opencode's `session.status: busy` lands (an
 * in-flight-TURN signal, not "this specific tool finished"), and conflating
 * the two would release a still-open dialog the instant an unrelated
 * parallel tool call completes — see Session.emitHookEvent's "tool_done"
 * case for the tool-matched release this exists to drive. */
export interface ToolDoneHookMessage {
  kind: "tool_done";
  tool: string;
}

export interface StopFailureHookMessage {
  kind: "stop_failure";
  error: string;
  errorDetails?: string;
  /** Rich statuses (issue: extend surfaced session statuses) — a coarse
   * category for the failure (e.g. Claude Code's `rate_limit`, `overloaded`,
   * `max_output_tokens`, `authentication_failed`, ...), when the forwarder's
   * adapter can classify it. Distinct from `errorDetails` (free-text detail):
   * this is the short, stable label session-status.ts's deriveSessionStatus
   * surfaces as the status's `detail`. Falls back to `errorDetails` when
   * absent — see pty-manager.ts's "stop_failure" emitHookEvent case. */
  errorType?: string;
}

export interface ToolFailureHookMessage {
  kind: "tool_failure";
  tool: string;
  error: string;
  summary?: string;
  /** Phase 5 (Track A) — see FileChangeHookMessage's doc comment; same
   * agent-attribution envelope, since PostToolUseFailure carries the same
   * agent_id/agent_type when it fires inside a subagent. */
  agentId?: string;
  agentType?: string;
}

export interface SessionEndHookMessage {
  kind: "session_end";
  reason: string;
  /** Rich statuses — the process's real exit code, when the adapter can
   * report one (e.g. Claude Code's SessionEnd payload). Absent for agents
   * whose hook doesn't carry it. */
  exitCode?: number;
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

/** Issue: extend surfaced session statuses — sent when an agent begins
 * processing a genuinely new user turn (Claude Code's `UserPromptSubmit`,
 * remapped from the generic `notification` it produced before this — see
 * forwarder-core.mjs's mapCodexUserPromptSubmit/mapClaudeCodeEvent). The
 * one deterministic "a new turn has started" signal: distinguishes it from
 * `progress: { phase: "generating" }`, which fires only once the agent's own
 * loop is already under way, one step later than the human's own submit
 * action. Session.emitHookEvent uses this to release every `awaiting_*`
 * state and the `finished` latch — the same release Session.write()'s own
 * genuine-keystroke check already provides for `finished`, but authoritative
 * (deterministic, not a keystroke heuristic) and additionally covering
 * `elicitationState`. */
export interface TurnStartHookMessage {
  kind: "turn_start";
}

/** Issue: extend surfaced session statuses — Claude Code's PreCompact/
 * PostCompact hook pair. `trigger` (manual vs auto) is carried through
 * unchanged for the event feed/timeline; not consulted by the attention/
 * status machinery, which only cares about the started/finished edge. */
export interface CompactHookMessage {
  kind: "compact";
  state: "started" | "finished";
  trigger?: "manual" | "auto";
}

/** Issue: extend surfaced session statuses — Claude Code's SubagentStart/
 * SubagentStop hook pair. Session.emitHookEvent increments/decrements a
 * running count rather than tracking a single boolean, since more than one
 * subagent can be in flight at once.
 *
 * Phase 5 (Track A) added `agentId`/`summary`: `agentId` (Claude Code's
 * `agent_id`) correlates a started/finished pair without relying on
 * ordering alone, once more than one subagent can be in flight; `summary`
 * (SubagentStop's `last_assistant_message`) is the subagent's final text,
 * absent on the start message. */
export interface SubagentHookMessage {
  kind: "subagent";
  state: "started" | "finished";
  agentType?: string;
  agentId?: string;
  summary?: string;
}

/** Issue: extend surfaced session statuses — Claude Code's Elicitation/
 * ElicitationResult hook pair, fired when an MCP server asks the human a
 * question mid-tool-call. Same "explicit, discrete, needs-the-user-now"
 * shape as `permission_request`/`plan_ready`, just for an MCP server's own
 * elicitation protocol rather than Claude Code's built-in permission/plan
 * flows. */
export interface ElicitationHookMessage {
  kind: "elicitation";
  state: "started" | "finished";
  server?: string;
}

/** OpenCode v2 question events — opencode's `question` tool fires these
 *  when the model asks the user a multiple-choice question. Same "explicit,
 *  discrete, needs-the-user-now" shape as `permission_request`/`plan_ready`,
 *  just for the agent's own question mechanism rather than its MCP-server
 *  elicitation flow. */
export interface QuestionHookMessage {
  kind: "question";
  state: "started" | "finished";
  /** The first question's short label (max 30 chars), for sidebar display. */
  header?: string;
  /** The first question's full text. */
  summary?: string;
  /** The tool call this question is blocking, if known — enables future
   *  Mullion-side question resolution (similar to the promote flow). */
  tool?: { messageID: string; callID: string };
}

/** OpenCode v2 todo events — opencode fires `todo.updated` when the model's
 *  structured task list changes (the todowrite tool). Each event carries one
 *  todo item's new state. Forwarded for the timeline feed; no session-status
 *  impact. */
export interface TodoHookMessage {
  kind: "todo";
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

/** OpenCode v2 session diff events — opencode fires `session.diff` at turn end
 *  with per-file change summaries (file path, additions, deletions, patch).
 *  Forwarded for the timeline feed; no session-status impact. */
export interface SessionDiffHookMessage {
  kind: "session_diff";
  files: Array<{
    file: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
}

/** Issue: extend surfaced session statuses — Claude Code's PermissionDenied
 * hook, fired "when a tool call is denied by the auto mode classifier." NOT
 * asserted as the sole release path for a pending `permission_request` (see
 * the plan doc: PermissionDenied can fire with no preceding
 * PermissionRequest at all) — Session.emitHookEvent treats it as a possible
 * extra release, never the only one. Carries no fields of its own; unlike
 * `review_gate`'s approved/denied, there is no separate outcome to track
 * here, mirroring `notification_resolved`'s "nothing left to distinguish"
 * shape. */
export interface PermissionResolvedHookMessage {
  kind: "permission_resolved";
}

/** Issue: extend surfaced session statuses — sent when Claude Code's
 * ExitPlanMode tool call itself resolves (the plan was accepted or
 * rejected), releasing a pending `plan_ready`. Distinct from
 * `notification_resolved`/`permission_resolved`'s "no fields" shape only
 * because a future revision may want to carry the outcome; not needed yet,
 * so kept minimal like its siblings. */
export interface PlanResolvedHookMessage {
  kind: "plan_resolved";
}

export interface BrowserActionHookMessage {
  kind: "browser_action";
  action: string;
  url?: string;
  wait_until?: "load" | "domcontentloaded" | "networkidle" | "commit";
  selector?: string;
  ref?: string;
  value?: string | string[];
  script?: string;
  x?: number;
  y?: number;
  text?: string;
  by?: "text" | "role" | "label" | "placeholder" | "testid";
  name?: string;
  limit?: number;
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
  | PromoteRequestHookMessage
  | SessionStartHookMessage
  | NotificationResolvedHookMessage
  | PermissionRequestHookMessage
  | ToolDoneHookMessage
  | StopFailureHookMessage
  | ToolFailureHookMessage
  | SessionEndHookMessage
  | PlanReadyHookMessage
  | GitBranchHookMessage
  | CwdChangedHookMessage
  | TurnStartHookMessage
  | CompactHookMessage
  | SubagentHookMessage
  | ElicitationHookMessage
  | QuestionHookMessage
  | TodoHookMessage
  | SessionDiffHookMessage
  | PermissionResolvedHookMessage
  | PlanResolvedHookMessage
  | BrowserActionHookMessage
  | UnknownHookMessage;

// Every KNOWN (non-`UnknownHookMessage`) `kind` literal, listed by hand
// rather than derived from `HookMessage["kind"]` — that expression widens to
// plain `string` (UnknownHookMessage's `kind: string` member absorbs every
// literal alongside it into the union), losing exactly the literal-type
// information this is for. Used by hook-adapters/types.ts's
// `HookAgentAdapter.emits` — each adapter declares which of these its own
// hooks can actually produce, letting the frontend hide legend
// entries/filters for a status a given agent can never reach (issue: extend
// surfaced session statuses' capability map) and a parity test
// (forwarder-core.test.ts) assert every registered hook event's mapping
// output stays inside that declared set.
export type HookMessageKind =
  | "notification"
  | "progress"
  | "file_change"
  | "review_gate"
  | "promote_request"
  | "session_start"
  | "notification_resolved"
  | "permission_request"
  | "tool_done"
  | "stop_failure"
  | "tool_failure"
  | "session_end"
  | "plan_ready"
  | "git_branch"
  | "cwd_changed"
  | "turn_start"
  | "compact"
  | "subagent"
  | "elicitation"
  | "question"
  | "todo"
  | "session_diff"
  | "permission_resolved"
  | "plan_resolved"
  | "browser_action";

export type ParseHookMessageResult =
  { ok: true; message: HookMessage } | { ok: false; error: string };

function isString(value: unknown): value is string {
  return typeof value === "string";
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
  if (payload.detail !== undefined) {
    if (!isString(payload.detail)) {
      return {
        ok: false,
        error: "progress requires 'detail' to be a string when present",
      };
    }
    result.detail = payload.detail;
  }
  return { ok: true, message: result };
}

const MAX_AGENT_FIELD_LEN = 128;

function isValidAgentField(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= MAX_AGENT_FIELD_LEN;
}

/** Phase 5 (Track A) — the optional agent-attribution envelope shared by the
 * handful of kinds a subagent can actually produce (`file_change`,
 * `tool_failure`, `subagent`). Bounded-length, unlike most other free-text
 * fields in this file, since these are meant to be short identifiers rather
 * than prose.
 *
 * A malformed value (wrong type, empty, oversized) is silently DROPPED
 * rather than failing the whole message — the same posture
 * `StopFailureHookMessage`'s `errorDetails`/`errorType` already use, and the
 * only safe one for optional metadata on a channel the roadmap's Security &
 * trust decision explicitly documents as untrusted input: any subprocess
 * inheriting the hook token could send a forged/malformed `agentId`, and
 * that must not be able to take down an otherwise-legitimate
 * `subagentCount`-affecting message with it (Hermes-adjacent review finding,
 * PR #414 — the earlier fail-the-whole-message version had exactly that
 * failure mode). */
function parseAgentEnvelope(payload: Record<string, unknown>): {
  agentId?: string;
  agentType?: string;
} {
  const envelope: { agentId?: string; agentType?: string } = {};
  if (isValidAgentField(payload.agentId)) envelope.agentId = payload.agentId;
  if (isValidAgentField(payload.agentType)) envelope.agentType = payload.agentType;
  return envelope;
}

function validateFileChange(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.path)) {
    return { ok: false, error: "file_change requires a string 'path' field" };
  }
  const action = payload.action;
  if (action !== "modify" && action !== "create" && action !== "delete") {
    return { ok: false, error: "file_change requires 'action' to be modify|create|delete" };
  }
  return {
    ok: true,
    message: { kind: "file_change", path: payload.path, action, ...parseAgentEnvelope(payload) },
  };
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

function validateToolDone(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.tool)) {
    return { ok: false, error: "tool_done requires a string 'tool' field" };
  }
  return { ok: true, message: { kind: "tool_done", tool: payload.tool } };
}

function validateStopFailure(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.error)) {
    return { ok: false, error: "stop_failure requires a string 'error' field" };
  }
  const result: StopFailureHookMessage = { kind: "stop_failure", error: payload.error };
  if (isString(payload.errorDetails)) {
    result.errorDetails = payload.errorDetails;
  }
  if (isString(payload.errorType)) {
    result.errorType = payload.errorType;
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
      ...parseAgentEnvelope(payload),
    },
  };
}

function validateSessionEnd(payload: Record<string, unknown>): ParseHookMessageResult {
  if (!isString(payload.reason)) {
    return { ok: false, error: "session_end requires a string 'reason' field" };
  }
  // Unix exit codes are integers 0-255 — Number.isInteger rejects a stray
  // float like 1.5 rather than silently accepting and forwarding it
  // (Hermes review, PR #316).
  if (payload.exitCode !== undefined && !Number.isInteger(payload.exitCode)) {
    return { ok: false, error: "session_end requires 'exitCode' to be an integer when present" };
  }
  return {
    ok: true,
    message: {
      kind: "session_end",
      reason: payload.reason,
      ...(Number.isInteger(payload.exitCode) ? { exitCode: payload.exitCode as number } : {}),
    },
  };
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

function validateStartedFinished(
  kind: "compact" | "subagent" | "elicitation" | "question",
  payload: Record<string, unknown>,
): ParseHookMessageResult {
  const state = payload.state;
  if (state !== "started" && state !== "finished") {
    return { ok: false, error: `${kind} requires 'state' to be started|finished` };
  }
  return { ok: true, message: { kind, state } as HookMessage };
}

function validateCompact(payload: Record<string, unknown>): ParseHookMessageResult {
  const base = validateStartedFinished("compact", payload);
  if (!base.ok) return base;
  const result = base.message as CompactHookMessage;
  if (payload.trigger !== undefined && payload.trigger !== "manual" && payload.trigger !== "auto") {
    return { ok: false, error: "compact requires 'trigger' to be manual|auto when present" };
  }
  if (payload.trigger === "manual" || payload.trigger === "auto") {
    result.trigger = payload.trigger;
  }
  return { ok: true, message: result };
}

function validateSubagent(payload: Record<string, unknown>): ParseHookMessageResult {
  const base = validateStartedFinished("subagent", payload);
  if (!base.ok) return base;
  const result = base.message as SubagentHookMessage;
  const envelope = parseAgentEnvelope(payload);
  if (envelope.agentType !== undefined) result.agentType = envelope.agentType;
  if (envelope.agentId !== undefined) result.agentId = envelope.agentId;
  if (payload.summary !== undefined) {
    if (!isString(payload.summary)) {
      return { ok: false, error: "subagent requires 'summary' to be a string when present" };
    }
    result.summary = payload.summary;
  }
  return { ok: true, message: result };
}

function validateElicitation(payload: Record<string, unknown>): ParseHookMessageResult {
  const base = validateStartedFinished("elicitation", payload);
  if (!base.ok) return base;
  const result = base.message as ElicitationHookMessage;
  if (payload.server !== undefined && !isString(payload.server)) {
    return { ok: false, error: "elicitation requires 'server' to be a string when present" };
  }
  if (isString(payload.server)) {
    result.server = payload.server;
  }
  return { ok: true, message: result };
}

function validateQuestion(payload: Record<string, unknown>): ParseHookMessageResult {
  const base = validateStartedFinished("question", payload);
  if (!base.ok) return base;
  const result = base.message as QuestionHookMessage;
  const header = payload.header;
  if (header !== undefined && !isString(header)) {
    return { ok: false, error: "question requires 'header' to be a string when present" };
  }
  if (isString(header)) {
    result.header = header;
  }
  const summary = payload.summary;
  if (summary !== undefined && !isString(summary)) {
    return { ok: false, error: "question requires 'summary' to be a string when present" };
  }
  if (isString(summary)) {
    result.summary = summary;
  }
  const tool = payload.tool;
  if (tool !== undefined) {
    if (typeof tool !== "object" || tool === null) {
      return {
        ok: false,
        error: "question requires 'tool' to be { messageID, callID } when present",
      };
    }
    const t = tool as Record<string, unknown>;
    if (typeof t.messageID !== "string" || typeof t.callID !== "string") {
      return {
        ok: false,
        error: "question requires 'tool' to be { messageID, callID } when present",
      };
    }
    result.tool = { messageID: t.messageID, callID: t.callID };
  }
  return { ok: true, message: result };
}

function validateTodo(payload: Record<string, unknown>): ParseHookMessageResult {
  const content = payload.content;
  const status = payload.status;
  const priority = payload.priority;
  if (!isString(content)) {
    return { ok: false, error: "todo requires a string 'content' field" };
  }
  if (!isString(status) || !["pending", "in_progress", "completed", "cancelled"].includes(status)) {
    return {
      ok: false,
      error: "todo requires 'status' to be pending|in_progress|completed|cancelled",
    };
  }
  if (priority !== undefined && !isString(priority)) {
    return { ok: false, error: "todo requires 'priority' to be a string when present" };
  }
  return {
    ok: true,
    message: {
      kind: "todo",
      content,
      status: status as TodoHookMessage["status"],
      priority:
        isString(priority) && ["high", "medium", "low"].includes(priority)
          ? (priority as TodoHookMessage["priority"])
          : "medium",
    },
  };
}

function validateSessionDiff(payload: Record<string, unknown>): ParseHookMessageResult {
  const files = payload.files;
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: "session_diff requires a non-empty array 'files' field" };
  }
  const validated = (files as unknown[])
    .map((f) => {
      if (typeof f !== "object" || f === null) return null;
      const entry = f as Record<string, unknown>;
      if (typeof entry.file !== "string" || entry.file.length === 0) return null;
      return {
        file: entry.file,
        additions: typeof entry.additions === "number" ? entry.additions : 0,
        deletions: typeof entry.deletions === "number" ? entry.deletions : 0,
        ...(typeof entry.patch === "string" && entry.patch.length > 0
          ? { patch: entry.patch }
          : {}),
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);
  if (validated.length === 0) {
    return {
      ok: false,
      error: "session_diff requires at least one valid file entry with a non-empty 'file' string",
    };
  }
  return { ok: true, message: { kind: "session_diff", files: validated } };
}

// Exported so a parity test (test/services/hook-protocol.test.ts) can assert
// this stays in lockstep with the other three action-list sources —
// agentActionSchema's action enum (src/routes/browser-automation.ts),
// BROWSER_ACTIONS (src/cli/core.mjs), and the use_browser tool's enum
// (src/mcp/tools.mjs) — in the same spirit as the tripwire HookMessageKind
// uses above (see forwarder-core.test.ts), though that one is a
// one-directional emits-parity check rather than a set-equality assertion.
export const KNOWN_BROWSER_ACTIONS = new Set([
  "navigate",
  "click",
  "press",
  "type",
  "select",
  "check",
  "uncheck",
  "wait",
  "dialog",
  "hover",
  "scroll",
  "get",
  "console",
  "errors",
  "find",
  "fill",
  "snapshot",
  "eval",
  "screenshot",
]);

function validateBrowserAction(payload: Record<string, unknown>): ParseHookMessageResult {
  if (payload.action === undefined || typeof payload.action !== "string") {
    return { ok: false, error: "browser_action requires a string 'action' field" };
  }
  if (!KNOWN_BROWSER_ACTIONS.has(payload.action)) {
    return { ok: false, error: `unknown browser_action: ${payload.action}` };
  }
  return { ok: true, message: { kind: "browser_action", ...payload } as HookMessage };
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
    case "tool_done":
      return validateToolDone(payload);
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
    case "turn_start":
      return { ok: true, message: { kind: "turn_start" } };
    case "compact":
      return validateCompact(payload);
    case "subagent":
      return validateSubagent(payload);
    case "elicitation":
      return validateElicitation(payload);
    case "question":
      return validateQuestion(payload);
    case "todo":
      return validateTodo(payload);
    case "session_diff":
      return validateSessionDiff(payload);
    case "permission_resolved":
      return { ok: true, message: { kind: "permission_resolved" } };
    case "plan_resolved":
      return { ok: true, message: { kind: "plan_resolved" } };
    case "browser_action":
      return validateBrowserAction(payload);
    default:
      return { ok: true, message: payload as UnknownHookMessage };
  }
}
