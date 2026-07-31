// Derives ONE rich session status from the two axes PRs #300/#301's hook
// layer already track separately, plus the DB's own liveness intent:
//
//   - liveness: the DB row's own `status` column ("active"/"killed"/
//     "exited") merged with whether PtyManager's in-memory map currently
//     sees the process alive — see CLAUDE.md's "non-obvious model" note: the
//     DB row records intent (has this been explicitly killed?), live process
//     state lives only in PtyManager's map, and callers merge the two rather
//     than trusting either alone.
//   - agent activity: SessionInfo's hook-derived state (permissionState,
//     planState, gateState, promoteState, errorState, the newer compact/
//     subagent/elicitation fields, the `finished` latch, and the
//     byte-heuristic `attention` flag as the lowest-confidence fallback).
//
// Pure, no I/O — same testability posture as attention-detect.ts. Called at
// the route layer, where the two axes are already merged (see
// routes/sessions.ts's withLiveInfo/buildLiveInfo), NOT inside
// PtyManager.toInfo(): the Session class has no notion of the DB's kill/exit
// intent, only of whether its own in-memory ptyProcess handle is alive right
// now — deriving the FULL status needs both.
//
// The backend derives; the frontend only presents (see
// frontend/src/sessionStatus.ts's STATUS_PRESENTATION table) — this is what
// stops the twelve-and-growing parallel status enums the pre-existing code
// already had from growing a thirteenth ad-hoc precedence chain on the
// frontend.

import type { SessionInfo } from "./pty-manager.js";

export type SessionStatus =
  | "exited" // process gone (DB says killed/exited, or PtyManager has no live handle)
  | "awaiting_permission" // a tool-permission dialog is blocking the agent
  | "awaiting_plan" // an ExitPlanMode plan is ready for human review
  | "awaiting_review_gate" // Mullion's own blocking PreToolUse gate is waiting
  | "awaiting_promote" // a worktree-isolation promote request is waiting
  | "awaiting_question" // the agent's `question` tool is blocking on a user decision
  | "awaiting_elicitation" // an MCP server is asking the human for input
  | "api_error" // turn ended on an API error (StopFailure hook)
  | "tool_failure" // a tool call failed and the agent has since stalled (PostToolUseFailure hook)
  | "finished" // the agent's turn is over; process alive, your move
  | "needs_input" // byte-heuristic attention (bell/notification/title/silence) — a guess
  | "compacting" // context compaction is running
  | "subagent" // one or more subagents are running
  | "background" // outstanding backgroundTasks (bash/MCP/agent) the Stop hook reported (issue #428)
  | "working"
  | "idle";

export type SessionSeverity =
  "gone" | "failed" | "blocked" | "done" | "waiting" | "busy" | "dormant";

// Assigning this object literal directly to a `Record<SessionStatus, ...>`-
// typed const makes it exhaustive at the type level, same technique
// routes/sessions.ts's `LiveInfoKey`/`buildLiveInfo` use: a `SessionStatus`
// added above without a matching entry here fails `make typecheck` instead
// of leaving a status with an undefined severity at runtime.
const SEVERITY_BY_STATUS: Record<SessionStatus, SessionSeverity> = {
  exited: "gone",
  awaiting_permission: "blocked",
  awaiting_plan: "blocked",
  awaiting_review_gate: "blocked",
  awaiting_promote: "blocked",
  awaiting_question: "blocked",
  awaiting_elicitation: "blocked",
  api_error: "failed",
  tool_failure: "failed",
  finished: "done",
  needs_input: "waiting",
  compacting: "busy",
  subagent: "busy",
  background: "busy",
  working: "busy",
  idle: "dormant",
};

// Severities that mean "put this in front of the user" — drives the tab-
// title/favicon badge count and the notification-surface's default gate
// (see the plan doc's §1/§3.2). Deliberately does NOT include "busy": a
// session that's merely working, compacting, or running a subagent isn't
// waiting on anyone.
const ATTENTION_SEVERITIES = new Set<SessionSeverity>(["failed", "blocked", "done", "waiting"]);

export interface DerivedSessionStatus {
  status: SessionStatus;
  severity: SessionSeverity;
  /** A short, human-facing detail string (error category, exit reason,
   * subagent count, the byte-signal kind that triggered `needs_input`, ...),
   * or null when the status needs none. */
  detail: string | null;
  attentionRequired: boolean;
}

// A tab badge / sidebar row is a glanceable label, not a log line — a
// `detail` sourced from `summarizeToolCall` (sized for the review-gate
// prompt, GATE_PROMPT_MAX_CHARS) could otherwise be an entire shell
// pipeline's worth of text, which both overflows the sidebar layout and
// defeats the point of a short status. The untruncated string still reaches
// the timeline event this same hook handler emits (pty-manager.ts's
// tool_failure/stop_failure cases) — that's where the full detail belongs.
const STATUS_DETAIL_MAX_CHARS = 48;

function truncateDetail(detail: string | null): string | null {
  if (detail === null || detail.length <= STATUS_DETAIL_MAX_CHARS) return detail;
  return `${detail.slice(0, STATUS_DETAIL_MAX_CHARS)}…`;
}

function make(status: SessionStatus, detail: string | null = null): DerivedSessionStatus {
  const severity = SEVERITY_BY_STATUS[status];
  return {
    status,
    severity,
    detail: truncateDetail(detail),
    attentionRequired: ATTENTION_SEVERITIES.has(severity),
  };
}

// Combines both when present rather than picking one — a session that
// crashed with a reason AND an exit code should show both, not silently
// drop the exit code just because a reason string also happened to be
// available (Hermes review, PR #316).
function formatExitedDetail(endedReason: string | null, exitCode: number | null): string | null {
  if (endedReason && exitCode !== null) return `${endedReason} (exit code ${exitCode})`;
  if (endedReason) return endedReason;
  if (exitCode !== null) return `exit code ${exitCode}`;
  return null;
}

export interface DeriveSessionStatusInput {
  /** The DB row's own `status` column — records intent, not live process
   * state. See this module's header comment and CLAUDE.md. */
  dbStatus: "active" | "killed" | "exited";
  info: Pick<
    SessionInfo,
    | "activity"
    | "attention"
    | "attentionKind"
    | "permissionState"
    | "planState"
    | "gateState"
    | "promoteState"
    | "elicitationState"
    | "questionState"
    | "errorState"
    | "errorDetail"
    | "endedReason"
    | "exitCode"
    | "compactState"
    | "subagentCount"
    | "lastTurnEndedAt"
    | "outstandingBackgroundTasks"
  >;
}

/**
 * The single derivation point for a session's rich status. Precedence is the
 * `SessionStatus` union's own declaration order above (top-first) — every
 * "the agent is blocked pending a human decision" state outranks the
 * softer, guessed `needs_input`, which itself outranks the busy/idle
 * fallbacks. See the plan doc's "Precedence, release paths, staleness" table
 * for the release rule that clears each of these on the caller side
 * (pty-manager.ts's emitHookEvent/write()).
 */
export function deriveSessionStatus({
  dbStatus,
  info,
}: DeriveSessionStatusInput): DerivedSessionStatus {
  // --- Liveness axis wins outright: dbStatus is the DB row's own recorded
  // INTENT (has this been explicitly killed, or did the reconciler catch it
  // exiting on its own?), and a gone process outranks every agent-activity
  // signal, hook-derived or not — a stale "awaiting_permission" from a
  // session that has since crashed or been killed shouldn't outrank
  // "exited". Unifies Sidebar.tsx's and kanban.ts's previously-inconsistent
  // handling of "killed" (kanban.ts's columnForSession treated it as
  // exited; Sidebar.tsx's own status-dot precedence checked only
  // `status === "exited"` and fell through to activity-based rendering for
  // "killed" — one of the "twelve enums disagreeing" gaps this module
  // exists to close).
  //
  // Deliberately does NOT also fall back to `!info.alive` here, even though
  // `info.alive` is the live PtyManager map's own signal of whether this
  // process is currently tracking the session: `dbStatus: "active"` +
  // `alive: false` is the ordinary, ambiguous "not (re)attached in THIS
  // process yet" case — e.g. every single session immediately after a
  // backend restart/redeploy, before the terminal WS reattaches or the 30s
  // reconciler sweep runs (see CLAUDE.md's "routes merge the two rather than
  // trusting the DB column alone"). Treating that as "exited" would flash
  // every session on the board as gone on every restart — a real regression,
  // not a fix. Sessions in that ambiguous state instead fall through to the
  // agent-activity checks below with their idle/no-signal defaults, same
  // behavior as before this module existed.
  if (dbStatus === "killed" || dbStatus === "exited") {
    return make("exited", formatExitedDetail(info.endedReason, info.exitCode));
  }

  // --- Agent-activity axis, in precedence order. ---
  //
  // The five `awaiting_*` checks run BEFORE the error checks below: all five
  // are live, unambiguous "a human needs to make a decision right now"
  // states, and none of them get an automatic release path the way
  // `tool_failure` does (see that check's own comment) — outranking a
  // possibly-stale error is the only way a real pending prompt doesn't get
  // hidden behind it.
  if (info.permissionState === "pending") return make("awaiting_permission");
  if (info.planState === "pending") return make("awaiting_plan");
  if (info.gateState === "waiting") return make("awaiting_review_gate");
  if (info.promoteState === "pending") return make("awaiting_promote");
  if (info.questionState === "pending") return make("awaiting_question");
  if (info.elicitationState === "pending") return make("awaiting_elicitation");
  if (info.errorState === "api_error") return make("api_error", info.errorDetail);
  // `tool_failure` only becomes the session's status once the agent has
  // stalled (`activity !== "working"`) — a failed tool call the agent is
  // still actively recovering from (retrying, trying another approach,
  // wrapping up the turn) isn't a session-level state, it's a transient blip
  // that already reached the timeline/bell via the `tool_failure` event
  // pty-manager.ts's emitHookEvent emits alongside setting this field. Only
  // when nothing has advanced since (activity has decayed to idle) does a
  // tool failure actually mean something is stuck. `api_error` above gets no
  // such gate: `stop_failure` means the turn already ended ON that error, so
  // there's no "still working" case to distinguish it from.
  if (info.errorState === "tool_failure" && info.activity !== "working") {
    return make("tool_failure", info.errorDetail);
  }
  // Issue #428 — `backgroundTasks` reported by the Stop/SubagentStop hook,
  // filtered to non-terminal entries (background-tasks.ts's own predicate,
  // already applied by pty-manager.ts's toInfo()). Read once here: gates
  // `finished` below AND, if still outstanding once every axis above it has
  // been checked, becomes the `background` status itself.
  const outstandingBackgroundTasks = info.outstandingBackgroundTasks.length;
  // `finished` — the latched "turn complete, process alive" state (see
  // pty-manager.ts's `lastTurnEndedAt` doc comment for why this must be a
  // latch rather than a read off the attention machine's output-clearable
  // `attentionKind === "agentIdle"`). Deliberately outranks `needs_input`:
  // it's hook-confirmed, the byte heuristic below is a guess. Gated on
  // `outstandingBackgroundTasks === 0`: the Stop hook fired (lastTurnEndedAt
  // is an honest signal of that — see pty-manager.ts's emitHookEvent, which
  // latches it unconditionally), but a background `Agent`/`Task` call from
  // this same turn that hasn't returned yet means the turn isn't really
  // "your move" — see `background` below, which is where this falls through
  // to instead.
  if (info.lastTurnEndedAt !== null && outstandingBackgroundTasks === 0) {
    return make("finished");
  }
  if (info.attention) {
    // Byte-heuristic attention (bell/notification/titleIdle/altScreenExit/
    // silence) reaching here means none of the hook-confirmed states above
    // applied — either a genuinely hookless session, or (rarely) a stale
    // immune `attentionKind` that outlived its own dedicated state field
    // (see attention-detect.ts's OUTPUT_IMMUNE_KINDS) — "needs_input" is a
    // reasonable label either way. `detail` carries the raw signal kind for
    // callers that want a more specific label (see eventDescriptions.ts's
    // existing per-kind strings).
    return make("needs_input", info.attentionKind);
  }
  if (info.compactState === "compacting") return make("compacting");
  if (info.subagentCount > 0) return make("subagent", `${info.subagentCount} running`);
  // Issue #428 — outranked by `subagent`: a Task-tool subagent already has
  // its own more specific status; this is for everything else
  // `backgroundTasks` can report (a background Bash job, an MCP-backed
  // task, or a background subagent claude-code-mcp/OpenCode style hasn't
  // separately reported via the "subagent" hook).
  if (outstandingBackgroundTasks > 0) {
    return make(
      "background",
      `${outstandingBackgroundTasks} task${outstandingBackgroundTasks === 1 ? "" : "s"}`,
    );
  }
  if (info.activity === "working") return make("working");
  return make("idle");
}
