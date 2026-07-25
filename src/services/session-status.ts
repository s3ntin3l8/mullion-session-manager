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
  | "api_error" // turn ended on an API error (StopFailure hook)
  | "tool_failure" // a tool call failed (PostToolUseFailure hook)
  | "awaiting_permission" // a tool-permission dialog is blocking the agent
  | "awaiting_plan" // an ExitPlanMode plan is ready for human review
  | "awaiting_review_gate" // Mullion's own blocking PreToolUse gate is waiting
  | "awaiting_promote" // a worktree-isolation promote request is waiting
  | "awaiting_elicitation" // an MCP server is asking the human for input
  | "finished" // the agent's turn is over; process alive, your move
  | "needs_input" // byte-heuristic attention (bell/notification/title/silence) — a guess
  | "compacting" // context compaction is running
  | "subagent" // one or more subagents are running
  | "working"
  | "idle";

export type SessionSeverity =
  | "gone"
  | "failed"
  | "blocked"
  | "done"
  | "waiting"
  | "busy"
  | "dormant";

// Assigning this object literal directly to a `Record<SessionStatus, ...>`-
// typed const makes it exhaustive at the type level, same technique
// routes/sessions.ts's `LiveInfoKey`/`buildLiveInfo` use: a `SessionStatus`
// added above without a matching entry here fails `make typecheck` instead
// of leaving a status with an undefined severity at runtime.
const SEVERITY_BY_STATUS: Record<SessionStatus, SessionSeverity> = {
  exited: "gone",
  api_error: "failed",
  tool_failure: "failed",
  awaiting_permission: "blocked",
  awaiting_plan: "blocked",
  awaiting_review_gate: "blocked",
  awaiting_promote: "blocked",
  awaiting_elicitation: "blocked",
  finished: "done",
  needs_input: "waiting",
  compacting: "busy",
  subagent: "busy",
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

function make(status: SessionStatus, detail: string | null = null): DerivedSessionStatus {
  const severity = SEVERITY_BY_STATUS[status];
  return { status, severity, detail, attentionRequired: ATTENTION_SEVERITIES.has(severity) };
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
    | "errorState"
    | "errorDetail"
    | "endedReason"
    | "exitCode"
    | "compactState"
    | "subagentCount"
    | "lastTurnEndedAt"
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
    return make(
      "exited",
      info.endedReason ?? (info.exitCode !== null ? `exit code ${info.exitCode}` : null),
    );
  }

  // --- Agent-activity axis, in precedence order. ---
  if (info.errorState === "api_error") return make("api_error", info.errorDetail);
  if (info.errorState === "tool_failure") return make("tool_failure", info.errorDetail);
  if (info.permissionState === "pending") return make("awaiting_permission");
  if (info.planState === "pending") return make("awaiting_plan");
  if (info.gateState === "waiting") return make("awaiting_review_gate");
  if (info.promoteState === "pending") return make("awaiting_promote");
  if (info.elicitationState === "pending") return make("awaiting_elicitation");
  // `finished` — the latched "turn complete, process alive" state (see
  // pty-manager.ts's `lastTurnEndedAt` doc comment for why this must be a
  // latch rather than a read off the attention machine's output-clearable
  // `attentionKind === "agentIdle"`). Deliberately outranks `needs_input`:
  // it's hook-confirmed, the byte heuristic below is a guess.
  if (info.lastTurnEndedAt !== null) return make("finished");
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
  if (info.activity === "working") return make("working");
  return make("idle");
}
