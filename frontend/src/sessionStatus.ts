// Rich statuses (issue: extend surfaced session statuses) — the ONE
// presentation table every status-rendering surface (Sidebar.tsx's status
// dot, kanban.ts's column, PaneTab.tsx's badge, the tab-title/favicon badge,
// desktop notifications) looks up into, instead of each re-implementing its
// own precedence chain against the raw live fields. The backend
// (src/services/session-status.ts) already derived `session.sessionStatus`/
// `sessionStatusSeverity`/`sessionStatusDetail` — this file is presentation
// ONLY, never re-derivation.
//
// Declaring this as a plain `Record<SessionStatus, StatusPresentation>`
// (rather than building it up conditionally) means TypeScript's missing/
// excess-property check on the object literal enforces exhaustiveness: a
// new `SessionStatus` member added to api.ts without a row here fails
// `npm run typecheck`, the same "add to the union, and something forgot to
// update" pairing routes/sessions.ts's `LiveInfoKey` and session-status.ts's
// `SEVERITY_BY_STATUS` already use.
import type { SessionSeverity, SessionStatus } from "./api.js";

export interface StatusPresentation {
  /** Human-facing label — always shown alongside the dot/badge below, never
   * color alone. */
  label: string;
  /** Shared suffix for BOTH `.session-dot-<tone>` and
   * `.session-status-label <tone>` (styles.css) — several statuses in the
   * same severity tier deliberately share one tone (and hence one dot style/
   * label color); the label text above is what tells them apart within that
   * tier. Not named after the SessionStatus itself, since more than one
   * status maps to the same tone. */
  tone: "exited" | "error" | "permission" | "plan" | "finished" | "attention" | "working" | "idle";
  /** CSS custom property carrying this status's colour — for surfaces that
   * can't just apply a `.session-dot-<tone>` class wholesale (the tab-title/
   * favicon badge canvas, e.g.). Same value the matching CSS rule uses;
   * kept here too so non-DOM consumers (the canvas badge) don't need to
   * read computed style back out of a throwaway element. */
  colorToken: string;
  /** Whether `session.sessionStatusDetail` (a reason/exit-code/error-type/
   * subagent-count string) reads naturally appended to `label` as
   * "label: detail" — true for exited/error/subagent, false for
   * needs_input (whose detail is a raw attention-signal-kind string like
   * "bell"/"silence", not something to show verbatim) and every status that
   * never carries one. */
  showDetail: boolean;
  /** Whether a desktop notification is ON by default for a transition INTO
   * this status. `finished` fires once per turn — by far the highest-
   * frequency notifiable status in the system — so it defaults OFF; every
   * other blocked/failed/waiting status defaults ON. See the Settings
   * per-status override this seeds (NotificationSettings). */
  defaultNotify: boolean;
}

export const STATUS_PRESENTATION: Record<SessionStatus, StatusPresentation> = {
  exited: {
    label: "exited",
    tone: "exited",
    colorToken: "--dim",
    showDetail: true,
    defaultNotify: false,
  },
  api_error: {
    label: "API error",
    tone: "error",
    colorToken: "--r",
    showDetail: true,
    defaultNotify: true,
  },
  tool_failure: {
    label: "Tool failure",
    tone: "error",
    colorToken: "--r",
    showDetail: true,
    defaultNotify: true,
  },
  awaiting_permission: {
    label: "Needs permission",
    tone: "permission",
    colorToken: "--p",
    showDetail: false,
    defaultNotify: true,
  },
  awaiting_plan: {
    label: "Plan ready",
    tone: "plan",
    colorToken: "--o",
    showDetail: false,
    defaultNotify: true,
  },
  // Same tone as awaiting_permission — all five are "the agent is blocked
  // pending a human decision" (severity: blocked); the label is what tells
  // them apart, not the color.
  awaiting_review_gate: {
    label: "Needs review",
    tone: "permission",
    colorToken: "--p",
    showDetail: false,
    defaultNotify: true,
  },
  awaiting_promote: {
    label: "Promote pending",
    tone: "permission",
    colorToken: "--p",
    showDetail: false,
    defaultNotify: true,
  },
  awaiting_question: {
    label: "Needs answer",
    tone: "permission",
    colorToken: "--p",
    showDetail: false,
    defaultNotify: true,
  },
  awaiting_elicitation: {
    label: "Needs input (MCP)",
    tone: "permission",
    colorToken: "--p",
    showDetail: false,
    defaultNotify: true,
  },
  finished: {
    label: "Finished",
    tone: "finished",
    colorToken: "--c",
    showDetail: false,
    // See defaultNotify's own doc comment above — deliberately OFF.
    defaultNotify: false,
  },
  needs_input: {
    label: "Needs input",
    tone: "attention",
    colorToken: "--ring",
    // The raw attention-signal-kind string ("bell"/"silence"/"titleIdle"/...)
    // isn't a user-facing word — see eventDescriptions.ts for the mapping
    // that already exists for these in the event feed; this row doesn't
    // duplicate it.
    showDetail: false,
    defaultNotify: true,
  },
  compacting: {
    label: "Compacting",
    tone: "working",
    colorToken: "--g",
    showDetail: false,
    defaultNotify: false,
  },
  subagent: {
    label: "Subagent",
    tone: "working",
    colorToken: "--g",
    showDetail: true,
    defaultNotify: false,
  },
  // Issue #428 — Claude Code's Stop/SubagentStop-reported `backgroundTasks`
  // still outstanding (a background Bash job, MCP-backed task, or background
  // subagent — outranked by `subagent` above when it's specifically that).
  background: {
    label: "Background",
    tone: "working",
    colorToken: "--g",
    showDetail: true,
    defaultNotify: false,
  },
  working: {
    // Title Case, matching every other label in this table (and
    // PaneTab.tsx's pre-existing "Working"/"Idle" badge text) — Sidebar.tsx
    // used to render these two specifically in lowercase; unified here
    // rather than kept as the one inconsistent pair.
    label: "Working",
    tone: "working",
    colorToken: "--g",
    showDetail: false,
    defaultNotify: false,
  },
  idle: {
    label: "Idle",
    tone: "idle",
    colorToken: "--dim",
    showDetail: false,
    defaultNotify: false,
  },
};

/** Appends `session.sessionStatusDetail` to a status's label as "label:
 * detail" when that status's own `showDetail` says the detail string reads
 * naturally there (see StatusPresentation.showDetail's doc comment), else
 * just the bare label. The one bit of per-session (not per-status)
 * formatting logic — kept here, next to the table it reads, rather than
 * duplicated in each of Sidebar.tsx/PaneTab.tsx/kanban card rendering. */
export function formatStatusLabel(presentation: StatusPresentation, detail: string | null): string {
  if (presentation.showDetail && detail) {
    return `${presentation.label}: ${detail}`;
  }
  return presentation.label;
}

// Maps each SessionStatus to the HookMessageKind value(s) required in an
// agent's `emits` array for that status to be reachable. Statuses with empty
// arrays are always reachable (derived from byte-heuristic PTY analysis,
// Mullion's own gate logic, or other non-hook sources — never wrong to show).
// Verified against src/services/agent-detect.ts's HOOK_ADAPTER_EMITS_BY_BIN
// table: the keys here are HookMessageKind values each adapter actually emits.
const EMITS_REQUIREMENTS: Record<SessionStatus, readonly string[]> = {
  exited: [],
  needs_input: [],
  working: [],
  idle: [],
  api_error: ["stop_failure"],
  tool_failure: ["tool_failure"],
  awaiting_permission: ["permission_request"],
  awaiting_plan: ["plan_ready"],
  // awaiting_review_gate is Mullion-driven (the blocking PreToolUse gate),
  // not agent-hook-driven — no HookMessageKind maps to it, so it's always
  // reachable regardless of the agent's emits.
  awaiting_review_gate: [],
  awaiting_promote: ["promote_request"],
  awaiting_question: ["question"],
  awaiting_elicitation: ["elicitation"],
  finished: ["progress"],
  compacting: ["compact"],
  subagent: ["subagent"],
  // Issue #428 — `backgroundTasks` rides on the "progress" hook (Stop's own
  // field), same closest-honest-mapping posture `finished` above already
  // uses — no HookMessageKind means "reports background tasks" specifically.
  background: ["progress"],
};

/**
 * Whether the given session status is reachable for an agent with the given
 * `emits` array. A status with no required emits is always reachable
 * (byte-heuristic / Mullion-driven). Otherwise, ALL required emits must be
 * present in the array.
 */
export function isStatusReachable(status: SessionStatus, emits: readonly string[]): boolean {
  const required = EMITS_REQUIREMENTS[status];
  if (required.length === 0) return true;
  return required.every((emit) => emits.includes(emit));
}

// Which row/card-level tint a session's severity gets — the row-level
// counterpart to STATUS_PRESENTATION's per-status dot/label tone above.
// `busy`/`dormant` get no special tint (working/idle sessions look like any
// other row); `done` gets its own "finished" tint (issue #331 — a session
// that completed successfully is not one that needs attention), and every
// other severity gets one of the pre-existing treatments.
export function rowClassNameForSeverity(
  severity: SessionSeverity,
): "" | "status-attention" | "status-exited" | "status-finished" {
  switch (severity) {
    case "gone":
      return "status-exited";
    case "failed":
    case "blocked":
    case "waiting":
      return "status-attention";
    case "done":
      return "status-finished";
    case "busy":
    case "dormant":
      return "";
  }
}
