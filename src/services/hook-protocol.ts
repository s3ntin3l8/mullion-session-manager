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

export interface PromoteRequestHookMessage {
  kind: "promote_request";
  summary: string;
  suggestedBaseRef?: string;
}

export interface NotificationResolvedHookMessage {
  kind: "notification_resolved";
}

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
  const result: ToolFailureHookMessage = {
    kind: "tool_failure",
    tool: payload.tool,
    error: payload.error,
  };
  if (isString(payload.summary)) {
    result.summary = payload.summary;
  }
  return { ok: true, message: result };
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
    default:
      return { ok: true, message: payload as UnknownHookMessage };
  }
}
