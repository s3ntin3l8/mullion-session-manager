import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";
import { timingSafeTokenMatch } from "./crypto-utils.js";
import { probeSocket } from "./unix-socket.js";

const APP_VERSION: string = (() => {
  try {
    const pj = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pj.version === "string" ? pj.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
import {
  detectAttentionSignals,
  classifyActivityFromTitle,
  detectAltScreenSwitch,
  applyMouseModeChanges,
  carryPartialEscape,
  detectCwdChange,
  carryPartialOsc,
  advanceAttention,
  INITIAL_MOUSE_TRACKING_STATE,
  INITIAL_ATTENTION_STATE,
  type MouseTrackingState,
  type AttentionMachineState,
  type AttentionSignalKind,
  type AttentionTransition,
} from "./attention-detect.js";
import { buildSessionEnv } from "./session-env.js";
import type {
  HookMessageKind,
  HookMessage,
  ToolDoneHookMessage,
  StopFailureHookMessage,
  ToolFailureHookMessage,
  SessionEndHookMessage,
  PlanReadyHookMessage,
  GitBranchHookMessage,
  CwdChangedHookMessage,
  CompactHookMessage,
  SubagentHookMessage,
  ElicitationHookMessage,
  QuestionHookMessage,
  TodoHookMessage,
  SessionDiffHookMessage,
  BackgroundTask,
} from "./hook-protocol.js";
import { filterOutstandingBackgroundTasks } from "./background-tasks.js";
import { getAdapterEmits } from "./hook-adapters/index.js";
import { detectDevServerPortForPlainSession } from "./dev-server-detect.js";
import { ScrollbackBuffer } from "./scrollback-buffer.js";
import { SessionStateFile, stateFilePath, type StoredSessionState } from "./session-state-file.js";
import { RedrawNudge } from "./redraw-nudge.js";
import type { CgroupProcess } from "./cgroup-inventory.js";
import {
  stopScope,
  isMasterAlive as isMasterAliveProcess,
  isMasterAliveBatch as isMasterAliveBatchProcess,
  listSessionProcesses as listSessionProcessesProcess,
} from "./session-process.js";
import { buildLaunchPlan } from "./launch-plan.js";
import { HOOK_HANDLERS, type SessionHookContext } from "./hook-handlers.js";
// Re-exported so existing importers (src/routes/agents.ts, this module's own
// tests) keep reaching these through pty-manager.js unchanged — PR 32 moved
// their actual definitions into launch-plan.ts, alongside buildLaunchPlan().
export { getSkipPermissionFlag, SKIP_PERMISSION_FLAGS } from "./launch-plan.js";
// NotificationEvent now physically lives in src/shared/types.ts
// (hand-mirrored 1:1 on the frontend — see frontend/src/api.ts's own
// re-export). Re-exported below so every existing backend importer of this
// module keeps working unchanged.
import type { NotificationEvent } from "../shared/types.js";

export type { NotificationEvent };

// Bridges browser terminals to real, host-persistent processes.
//
// Each Session owns exactly one node-pty child: a `dtach` attach-client. That
// client is dtach's *only* attaching process — dtach itself never sees more
// than one, which is what keeps it chrome-free and resize-clean (see the
// plan's persistence discussion). Any number of browser WebSocket connections
// may subscribe to that single child's data stream and write to it; the
// fan-out/fan-in across tabs happens here in the manager, not in dtach.
//
// The child is spawned once and kept alive for as long as this Node process
// runs, independent of how many browser tabs are attached — closing the last
// tab does NOT kill it. That means the common case (browser tab closes,
// reopens later, Node process never restarted) never needs a fresh dtach-level
// reattach at all: the scrollback ring buffer (Session's own ScrollbackBuffer,
// see scrollback-buffer.ts) is a continuous, gap-free record of everything the
// session produced while unwatched, so replaying it reconstructs the screen
// exactly. A fresh OS-level `dtach -a`
// attach (and the redraw-reliability question in Risk 1 of the plan) is only
// needed when this Node process itself restarts and the child is gone.
//
// The underlying dtach *master* (which actually owns the program) is a
// separate, untracked, fire-and-forget process bootstrapped once via `dtach
// -n` — see Session.spawn() for why conflating master and attach-client was
// Milestone 1's first real finding.

export interface CreateSessionOptions {
  id: string;
  cwd: string;
  /** Shell command line to run inside the session, e.g. "claude", "bash". */
  command: string;
  cols: number;
  rows: number;
  /** When true, append the agent's skip-permissions flag (e.g.
   * `--dangerously-skip-permissions`, `--auto`) so the CLI skips every
   * permission prompt — see getSkipPermissionFlag() for the per-agent
   * mapping. Default false. */
  skipPermissions?: boolean;
  /** Task Master (task-claim.ts/task-reconciler.ts) — a prompt to start the
   * agent's first turn with, delivered as argv via the matched hook
   * adapter's `initialPromptArgs` (hook-adapters/index.ts's
   * getAdapterInitialPromptArgs). A no-op for an agent with no such argv
   * form (e.g. OpenCode) — the session still spawns, just with no prompt
   * submitted, same as before this option existed. See Session.spawn()'s
   * own doc comment for why this can't be delivered via stashSeed's
   * SessionStart `additionalContext` for an unattended worker. */
  initialPrompt?: string;
  projectId?: number;
}

/** Phase 5 (Track A) — one subagent's identity and activity, built from the
 * agentId-bearing hook messages (see hook-protocol.ts's agent-attribution
 * envelope). Purely additive to `subagentCount`/`subagentCountAt` above,
 * never a replacement: not every adapter can supply an `agentId` (OpenCode's
 * `session.subagent` carries none), and a `.state.json` written before this
 * registry existed restores a bare count with no entries at all — either
 * case means `subagents` may legitimately be shorter than `subagentCount`,
 * which is "count known, detail unavailable," not an inconsistency. */
export interface SubagentInfo {
  agentId: string;
  agentType: string | null;
  startedAt: number;
  /** Set when a matching SubagentStop arrives, OR when the staleness sweep
   * (clearStaleBlockedIfOlderThan) force-finalizes this still-open entry
   * against its own `startedAt` — independent of subagentCount's own
   * staleness, which only zeroes the aggregate count and never touches
   * this field. That second (registry-side) case leaves `summary` null (no
   * final message was ever recorded), distinguishing a genuine finish from
   * a stale one. */
  endedAt: number | null;
  summary: string | null;
  fileChanges: number;
  toolFailures: number;
  /** Count of `fileChanges` + `toolFailures` attributed to this subagent —
   * NOT every hook message involving it (e.g. its own SubagentStart/Stop
   * aren't counted here). */
  eventCount: number;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  /** The shell's current working directory as last announced via an OSC 7
   * escape sequence (see attention-detect.ts's detectCwdChange), or null if
   * none has arrived yet — e.g. the shell doesn't have the injected
   * shell-integration hook, or hasn't drawn a prompt since this session was
   * created. Distinct from `cwd` above (the static spawn directory): a
   * session whose shell `cd`s into a git worktree after launch keeps `cwd`
   * pointing at the original directory forever, while `liveCwd` tracks where
   * the shell actually is now — see routes/projects.ts's
   * resolveSessionCwdTargets for why this matters (git status/branch must
   * reflect the worktree, not the spawn directory). */
  liveCwd: string | null;
  browserUrl: string | null;
  command: string;
  cols: number;
  rows: number;
  createdAt: number;
  alive: boolean;
  subscriberCount: number;
  /** Ms-epoch of the last PTY output, or null if none has arrived yet. */
  lastActivityAt: number | null;
  /** "working" if the terminal title says so, else if output has arrived
   * recently AND persisted for at least SUSTAIN_MS (so a single spawn-time
   * prompt-draw burst doesn't count) AND isn't closely following a user
   * keystroke (see USER_INPUT_ECHO_MS — keystroke echo shouldn't read as
   * work), else "idle" — a coarse heuristic, not a real "is the program
   * busy" signal. */
  activity: "working" | "idle";
  /** True once one of the attention signals in attention-detect.ts's state
   * machine (BEL, OSC 9/777 notification, a working->idle title transition,
   * an alt-screen exit, or sustained silence after a work streak) has been
   * CONFIRMED — i.e. survived its own per-kind debounce window uncontradicted
   * by further output — without being cleared since. See Session.attentionState
   * and advanceAttention() in attention-detect.ts for the full state machine
   * (issue #171/#98) this replaces the old ad-hoc ATTENTION_CLEAR_WINDOW_MS
   * check with. */
  attention: boolean;
  /** Ms-epoch this session was last confirmed as needing attention, or null
   * if never (or since cleared) — Session.attentionState.confirmedAt. */
  attentionAt: number | null;
  /** Payload of the most recent OSC 0/2 title-change sequence — consulted by
   * classifyActivityFromTitle() for a fast-path "working"/"idle" read on
   * agent CLIs that self-report their status in the title. */
  lastTitle: string | null;
  /** Minimal review gate (Phase 2, issue #178). "waiting" while a hook's
   * `review_gate` message is blocked on a real decision (see
   * Session.emitHookEvent/resolveGate below); "approved"/"denied" once
   * resolved (via POST /api/sessions/:id/review-gate or the hooks.ts
   * server-side timeout); "idle" if no gate has ever fired. In-memory only —
   * resets to "idle" across a restart, same as attention/activity above; see
   * the plan's "Persistence note" for why that's an accepted, explicit gap
   * for this minimal slice. */
  gateState: "idle" | "waiting" | "approved" | "denied";
  /** The most recent `review_gate` prompt while gateState is "waiting", else
   * null (cleared on resolution — see Session.resolveGate). */
  gatePrompt: string | null;
  /** Issue #320 — ms-epoch this session's gateState was last set to
   * "waiting", or null while idle. */
  gateAt: number | null;
  /** Issue #271, option 2 — "pending" while a model-invoked
   * `promote_request` is blocked waiting for a human decision (see
   * Session.emitHookEvent/resolvePromote below); "accepted"/"declined" once
   * resolved; "idle" if no promote request has ever fired. Same in-memory,
   * resets-on-restart posture as gateState above. */
  promoteState: "idle" | "pending" | "accepted" | "declined";
  /** The model-authored seed/summary from the most recent `promote_request`
   * while promoteState is "pending", else null. */
  promoteSummary: string | null;
  /** The base ref the model suggested alongside `promoteSummary`, if any. */
  promoteSuggestedBaseRef: string | null;
  /** Issue #320 — ms-epoch this session's promoteState was last set to
   * "pending", or null while idle. */
  promoteAt: number | null;
  /** Set to "pending" when a PermissionRequest hook fires — the agent is
   * blocked waiting for user permission to use a tool. Cleared when the
   * session's attention state confirms or clears. In-memory only. */
  permissionState: "idle" | "pending";
  /** Issue #320 — ms-epoch this session's permissionState was last set to
   * "pending", or null while idle. Used by the staleness sweep. */
  permissionAt: number | null;
  /** Set to "pending" when an ExitPlanMode PreToolUse hook fires — the
   * agent has a plan ready for human review. Cleared when the session's
   * attention state confirms or clears. In-memory only. */
  planState: "idle" | "pending";
  /** Issue #320 — ms-epoch this session's planState was last set to
   * "pending", or null while idle. */
  planAt: number | null;
  /** Non-null when a StopFailure hook fires (API error) or a
   * PostToolUseFailure hook fires (tool execution error). In-memory only. */
  errorState: "idle" | "api_error" | "tool_failure";
  /** Rich statuses — ms-epoch this session's `errorState` was last set to a
   * non-idle value, null while idle. Lets a staleness sweep (or a future
   * general one — see issue #320) expire an error nothing has cleared
   * because the resolving hook never fired. In-memory only, reset alongside
   * `errorState` everywhere that field is. */
  errorAt: number | null;
  /** Set when a SessionEnd hook fires — why the session terminated.
   * In-memory only. */
  endedReason: string | null;
  /** The process's real exit code, when the SessionEnd hook can report one
   * (see SessionEndHookMessage.exitCode in hook-protocol.ts) — null when
   * unavailable (the agent's adapter can't report one, or no SessionEnd has
   * fired yet). In-memory only. */
  exitCode: number | null;
  /** The latest branch reported by this session's git worktree add,
   * CwdChanged hook, or live branch tracking — null when unknown.
   * In-memory only. */
  liveBranch: string | null;
  /** Rich statuses (issue: extend surfaced session statuses) — which
   * attention-detect.ts signal kind is currently confirmed, or null when
   * `attention` is false. Mirrors `attentionState.confirmedKind` directly
   * (see toInfo()) rather than being tracked as its own field — same
   * "attentionAt IS attentionState.confirmedAt" posture that field's own doc
   * comment describes. Used to label WHY a session is `needs_input` (bell vs
   * silence vs title) — see session-status.ts's deriveSessionStatus. NOT used
   * to distinguish `finished` from `needs_input` — see `lastTurnEndedAt`
   * below for why that would be wrong. */
  attentionKind: AttentionSignalKind | null;
  /** Rich statuses — a short, stable label for the current `errorState`,
   * when the failing hook could supply one: a StopFailureHookMessage's
   * `errorType` (falling back to its free-text `errorDetails`) for
   * `api_error`, or the failing tool's name for `tool_failure`. Null when
   * `errorState` is "idle", or when the hook fired with none of these
   * fields. In-memory only. */
  errorDetail: string | null;
  /** The most recent Stop/progress hook's `lastAssistantMessage`, if the
   * adapter forwarded one — kept across turns (not cleared on the next
   * "thinking"/"generating" progress message) so a poll landing between
   * turns still has something to show. In-memory only. */
  lastAssistantMessage: string | null;
  /** Rich statuses — "compacting" while a PreCompact/PostCompact hook pair
   * is in flight (Claude Code only, so far — see hook-adapters/claude-code.ts).
   * In-memory only. */
  compactState: "idle" | "compacting";
  /** Issue #320 — ms-epoch this session's compactState was last set to
   * "compacting", or null while idle. */
  compactAt: number | null;
  /** Rich statuses — count of SubagentStart hooks not yet matched by a
   * SubagentStop (Claude Code only, so far). Zero when none are running.
   * In-memory only. */
  subagentCount: number;
  /** Issue #320 — ms-epoch this session's subagentCount was last updated
   * by a subagent start event while count > 0 (re-stamps on every
   * subsequent start, not just the initial 0 -> 1 transition), or null
   * while at zero. Used by the staleness sweep. */
  subagentCountAt: number | null;
  /** Phase 5 (Track A) — named subagents built from agentId-bearing hook
   * messages, chronological (oldest first). May be shorter than
   * `subagentCount` when an adapter can't supply identity — see
   * SubagentInfo's own doc comment. In-memory, persisted (trimmed) via
   * StoredStateFields like subagentCount. */
  subagents: SubagentInfo[];
  /** Rich statuses — "pending" while an MCP server's Elicitation hook is
   * blocked waiting on a human response (Claude Code only, so far).
   * In-memory only. */
  elicitationState: "idle" | "pending";
  /** The MCP server name from the most recent Elicitation hook while
   * elicitationState is "pending", else null. In-memory only. */
  elicitationServer: string | null;
  /** Issue #320 — ms-epoch this session's elicitationState was last set to
   * "pending", or null while idle. */
  elicitationAt: number | null;
  /** OpenCode v2 question events — set to "pending" when a `question.asked`
   * event arrives; cleared by `question.replied`/`question.rejected` or on
   * a new turn. Mirrors elicitationState's shape. In-memory only. */
  questionState: "idle" | "pending";
  /** The header from the first question (short label, max 30 chars), or null
   * while questionState is idle. In-memory only. */
  questionHeader: string | null;
  /** Issue #320 — ms-epoch this session's questionState was last set to
   * "pending", or null while idle. */
  questionAt: number | null;
  /** Rich statuses — ms-epoch this session's turn last ended (a hook
   * `progress` message with `phase: "done"`), latched until the NEXT turn
   * genuinely starts (a real human keystroke — see write()'s
   * isGenuineUserInput — or a `turn_start` hook once wired) or the session
   * exits. This is what distinguishes `finished` (turn over, process alive)
   * from `needs_input` (a byte-heuristic guess) — see session-status.ts's
   * deriveSessionStatus and its own doc comment for why this must be a
   * latch rather than read off attentionState.confirmedKind === "agentIdle"
   * (that field is output-clearable and would flicker: `agentIdle` is
   * deliberately NOT in attention-detect.ts's OUTPUT_IMMUNE_KINDS, since
   * it's the ONLY attention trigger opencode/codex/agy have). In-memory
   * only, reset on respawn. */
  lastTurnEndedAt: number | null;
  /** Issue #428 — the raw `backgroundTasks` list off the most recent
   * `progress`/`subagent` hook message that carried one (present-only
   * update: a message with no `backgroundTasks` field, e.g. Claude Code's
   * `idle_prompt` notification path, leaves this untouched rather than
   * wiping it — see emitHookEvent's "progress" case). Kept raw (not
   * pre-filtered) so it round-trips through StoredStateFields unchanged;
   * `outstandingBackgroundTasks` below is the filtered view callers
   * actually want. Cleared on `turn_start`, a genuine keystroke, and
   * respawn, same release paths as `lastTurnEndedAt`. In-memory only. */
  backgroundTasks: BackgroundTask[];
  /** Issue #428 — ms-epoch `backgroundTasks` was last updated while it
   * contained at least one outstanding (non-terminal-status) entry, or null
   * once none remain. Backend-internal TTL bookkeeping for the staleness
   * sweep (clearStaleBlockedIfOlderThan) — excluded from LiveInfoKey the
   * same way errorAt is. */
  backgroundTasksAt: number | null;
  /** Issue #428 — `backgroundTasks` filtered to only outstanding entries,
   * computed once here in toInfo() rather than re-derived by every caller
   * (deriveSessionStatus, the frontend's Row 6 chips) — keeps
   * "presentation only, never re-derivation" true for the frontend, which
   * has no import path to background-tasks.ts's own predicate (separate
   * npm workspace). */
  outstandingBackgroundTasks: BackgroundTask[];
  /** Issue #323: whether this session's state was restored from a
   * persisted state file (`<sessionsDir>/<id>.state.json`) on construction,
   * rather than starting from fresh idle defaults. False for a brand-new
   * session, or when the state file was missing or corrupt. Distinguishes
   * "we genuinely don't know the state" (restart recovered, waiting for
   * hooks) from "nothing pending" in the UI — see session-status.ts's
   * deriveSessionStatus. */
  stateRestored: boolean;
  /** Issue #323: whether the session was launched with a different version
   * of Mullion than is currently running. When true, the session's hook set
   * may be out of date (frozen at launch time), and the UI should show a
   * clock icon indicating it needs a restart to pick up new capabilities.
   * Derived by comparing the stored `launchedAtVersion` from the state file
   * against the current server version at construction time. */
  staleHooks: boolean;
  /** Issue #323: the value of `launchedAtVersion` stored in the state file
   * at construction time, or null when no state file was present. Lets the
   * frontend display the version the session was launched under. */
  restoredVersion: string | null;
  /** Rich statuses — the matched hook adapter's static `emits` capability list
   * for this session's launch command (empty for shells/unmatched). Computed
   * once at launch/reattach from the same adapter.matches() call that decides
   * whether to wire hooks. In-memory only — recomputed on every construction
   * from this.session.command, same posture as hooksActive. */
  hookEmits: readonly HookMessageKind[];
  /** Issue #404 — the port most recently detected in this (non-dock)
   * session's scrollback and not yet accepted or dismissed, or null when
   * nothing is currently pending. Set by PtyManager.sweepDevServerDetection
   * -> Session.detectDevServerPort; cleared by Session.acceptDevServerPort/
   * dismissDevServerPort. In-memory only, resets on restart — same posture
   * as gateState/promoteState above (see this file's other "resets on
   * restart" fields for why that's an accepted gap: a re-printed banner on
   * the next detection sweep just re-raises it). Keying UI action-button
   * visibility off this live field (not the immutable historical
   * `dev_server_detected` event payload) mirrors gateState's own role for
   * review_gate's GateActions in NotificationBell.tsx. */
  pendingDevServerPort: string | null;
}

type DataListener = (chunk: Buffer) => void;
type ExitListener = () => void;

// NotificationEvent (Phase 1's notification event model, issue #166) now
// physically lives in src/shared/types.ts — see that file for the full doc
// comment (the byte-driven "something happened" model, `seq`'s per-session
// keying, and each `kind`'s own rationale). Deliberately does NOT include a
// `working`/`idle` kind — see Session.onData's own comment on why activity
// stays poll-derived.

type EventListener = (event: NotificationEvent) => void;

// Cap on each session's own event ring buffer — mirrors ScrollbackBuffer's
// (scrollback-buffer.ts) FIFO-eviction shape but bounded by count rather than
// bytes, since events are small structured records, not raw terminal bytes.
const EVENTS_MAX = 100;

// Phase 5 (Track A) — cap on each session's subagent registry, same
// bounded-not-unbounded posture as EVENTS_MAX above. A runaway parent
// spawning far more subagents than this evicts its OLDEST FINISHED entry
// per new start (see recordSubagentStart) — a still-running entry is never
// evicted, so this is a soft cap under pathological load, not a hard one.
const MAX_TRACKED_SUBAGENTS = 50;

// B9 — WS->PTY backpressure (write()'s own doc comment has the full
// rationale). 4 MiB matches every other *_BACKPRESSURE_MAX_BUFFERED_BYTES
// constant in this codebase (terminal.ts, browser.ts, ws-pipe.ts,
// task-events.ts, events.ts) rather than inventing a new magnitude — the
// mechanism differs (there's no live "buffered bytes" signal to read from
// node-pty, only what this class tracks itself), but the threshold doesn't
// need to.
const WRITE_BACKPRESSURE_MAX_BYTES = 4 * 1024 * 1024;
// Window over which WRITE_BACKPRESSURE_MAX_BYTES resets. A real shell (or
// any program actually reading stdin) drains 4 MiB in well under a second
// under normal conditions, so this only ever engages against a program
// that's genuinely not reading its input at all.
const WRITE_BACKPRESSURE_WINDOW_MS = 1000;

// The two escape sequences synthesized as a scrollback-replay preamble (see
// Session.getScrollback()) — the modern alt-screen-buffer pair. Prepending
// one of these lets a fresh xterm.js land in the tracked TRUE screen mode
// rather than whatever mode the raw buffered bytes happen to leave it in.
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";

// Canonical enable sequences synthesized into the scrollback-replay preamble
// for tracked mouse-tracking state (see Session.mouseTracking and
// MouseTrackingState in attention-detect.ts) — same "always emit the modern
// form regardless of which variant the program actually used" rationale as
// ALT_SCREEN_ENTER/EXIT above. Only enable sequences are needed: when tracked
// state is the default (protocol "NONE" / encoding "DEFAULT"), nothing is
// appended to the preamble at all — see getScrollback().
const MOUSE_PROTOCOL_ENABLE: Record<Exclude<MouseTrackingState["protocol"], "NONE">, string> = {
  X10: "\x1b[?9h",
  VT200: "\x1b[?1000h",
  DRAG: "\x1b[?1002h",
  ANY: "\x1b[?1003h",
};
const MOUSE_ENCODING_ENABLE: Record<Exclude<MouseTrackingState["encoding"], "DEFAULT">, string> = {
  SGR: "\x1b[?1006h",
  SGR_PIXELS: "\x1b[?1016h",
};

// A session showing no output for this long is considered "idle" rather
// than "working" — a coarse, admittedly heuristic threshold (see the plan's
// WS-6: we plumb activity timing, we don't over-promise a precise
// "waiting for input" classifier). Fallback used when a caller doesn't pass
// its own threshold (mirrors DEFAULT_SETTINGS.notifications.idleThresholdSeconds
// in services/settings.ts); routes/sessions.ts passes the live,
// server-persisted value from Settings -> Notifications & status instead.
const IDLE_THRESHOLD_MS = 2_000;

// Issue #320 staleness sweep — PTY output within this window of a latch
// timestamp (e.g. gateAt, permissionAt) is treated as part of the same
// triggering event (the dialog render that follows the hook firing), not
// as evidence the agent is still progressing. Without this window, a
// dialog's own PTY render bumps lastActivityAt to >= the latch timestamp,
// permanently blocking the sweep for the exact "cleanly rendered prompt
// that never got answered" scenario this PR fixes.
//
// 2000 ms is long enough to absorb the dialog-rendering burst from any
// hook adapter (claude-code, codex, opencode, agy) but short enough that
// genuine new agent output — a real turn starting after the prompt —
// would arrive well past this window and correctly disqualify the sweep.
const BLOCKED_STALE_GRACE_MS = 2_000;

// A session that was genuinely working (a sustained activity streak — see
// SUSTAIN_MS below) and then falls silent for at least this long is the
// #98 "sustained silence after work" attention signal: quiet for long
// enough after real output that it's more likely waiting on the user than
// merely between status pings. Deliberately more generous than
// IDLE_THRESHOLD_MS/STREAK_GAP_MS (which classify the coarse working/idle
// poll field, expected to flip on ordinary short pauses) — this signal
// instead feeds attention-detect.ts's state machine (as the zero-threshold
// "silence" kind — see ATTENTION_CONFIRM_MS's own comment for why), so
// firing it too eagerly would turn every brief lull into a false "needs
// attention". Evaluated periodically by Session.tick(), never from onData
// directly — see ATTENTION_EVAL_INTERVAL_MS below for why this needs its
// own timer at all.
const SUSTAINED_SILENCE_MS = 10_000;

// Same idea as SUSTAINED_SILENCE_MS above, but the bound used for a
// `hooksActive && hooksProven` session instead — see Session.tick()'s doc
// comment. A hook agent's own Stop/session.idle hook is the normal,
// authoritative way its session's attention gets set, but that hook message
// travels over a separate process (the forwarder subprocess) and socket that
// can itself die or wedge AFTER having already proven itself once — a killed
// agent process, a crashed forwarder, a hook socket that drops — none of
// which stop this evaluator from running. Without SOME fallback, a session
// in that state would never surface attention at all, silently worse than
// the pre-`hooksActive` behavior this PR otherwise improves on. Deliberately
// much longer than SUSTAINED_SILENCE_MS (which a hook agent's own
// multi-chunk startup splash render can spuriously satisfy in ~1-2s, the
// false positive this PR fixes) — no legitimate startup render comes close
// to a full minute, so this bound only ever fires for a genuinely broken
// hook pipeline, not a slow splash. Follow-up to #275 (gap #1): a session
// that's merely `hooksActive` but never `hooksProven` (a pipeline that's
// never fired even ONCE — e.g. untrusted codex, see `hooksProven`'s field
// doc) does NOT get this bound at all; it uses SUSTAINED_SILENCE_MS instead,
// since there's no track record here to have "died or wedged" from.
const HOOK_FALLBACK_SILENCE_MS = 60_000;

// How often PtyManager's own attention-evaluator interval runs
// Session.tick() across every tracked session — the ONE new timer this PR
// (#171/#98) adds; see attention-detect.ts's "Attention state machine"
// comment for why PENDING_ATTENTION -> ATTENTION and the sustained-silence
// signal above are both fundamentally time-based (no byte arrives at the
// exact moment silence becomes "confirmed"), unlike every other signal in
// this file which is driven straight off onData. Mirrors the re-armable
// setInterval/.unref() shape src/plugins/pty.ts already uses for
// session-reconciler.ts's 30s exited-session sweep — kept comfortably below
// ATTENTION_CONFIRM_MS's shortest nonzero threshold (notification's 1s) so
// a confirmation is never meaningfully delayed past when it's actually due.
// Deliberately NOT gated behind MULLION_ROLE === "primary" the way the
// reconciler is (see src/plugins/pty.ts): this evaluator is pure in-memory
// state, no DB access, and PtyManager itself is constructed on an agent
// role too — gating it would silently strand every remote-agent session's
// pending/silent attention signals unconfirmed forever.
const ATTENTION_EVAL_INTERVAL_MS = 500;

// A gap of at least this long since the previous chunk starts a fresh
// activity streak — see the streak tracking in onData. Deliberately larger
// than IDLE_THRESHOLD_MS: a program that pings a status line every couple of
// seconds should still accrue a streak rather than have it reset on every
// chunk (which would leave `sustained` permanently false despite steady
// output). Kept below Settings -> Notifications & status's minimum
// configurable idle threshold (5s) so it doesn't itself mask a real idle
// gap at the tightest setting.
const STREAK_GAP_MS = 4_000;

// An activity streak must span at least this long before it counts as
// "working" rather than a single spawn-time prompt-draw burst.
const SUSTAIN_MS = 1_000;

// Output arriving within this window of a user keystroke is treated as echo
// or a redraw of that input, not autonomous work — see toInfo()'s timing
// fall-through (issue #97: a TUI's own keystroke echo kept accruing a
// "sustained" streak while the user was just typing at its prompt, reading as
// "working"). Deliberately short and NOT the settings-derived idle threshold
// (30s default): pressing Enter to submit a prompt is also a write(), and a
// 30s window would mask that much genuine agent output as idle immediately
// after submission. Kept close to SUSTAIN_MS's scale instead, so only the
// first moment after a keystroke/submit is suppressed.
//
// Known limitation: write() also carries a couple of automated
// terminal-protocol replies from the same browser->pty channel (OSC 10/11/12
// color-query responses and a theme-change OSC push in TerminalPane.tsx) —
// neither is a recurring per-write source, so the worst case is a rare,
// self-limiting false "idle" of at most this long right after one of those,
// not activity being masked indefinitely.
const USER_INPUT_ECHO_MS = 1_000;

// Follow-up to #275 (attention-hook hardening, gap #3): the same
// browser->pty write() channel USER_INPUT_ECHO_MS documents above also
// carries a handful of AUTOMATED terminal-protocol replies xterm.js sends on
// the program's behalf (not real human keystrokes) — see that comment's
// "Known limitation" for the enumerated set this mirrors. USER_INPUT_ECHO_MS
// itself tolerates these as a rare, self-limiting false "idle" because the
// cost of being wrong is small; isGenuineUserInput() below is held to a much
// stricter bar, because it gates the ONLY thing that can clear an
// OUTPUT_IMMUNE_KINDS-confirmed attention flag (a "needs permission"
// notification) via a real keystroke — a false positive here would silently
// dismiss a pending permission prompt the user never actually answered,
// exactly the bug this hardening pass fixes. Each regex matches one COMPLETE
// automated-reply shape; isGenuineUserInput() strips every match and treats
// a nonempty remainder as genuine. This is a denylist, not an allowlist of
// printable bytes, deliberately: Ctrl-C, Esc, arrow keys, and bracketed-paste
// content must all still count as a real decision.
// eslint-disable-next-line no-control-regex
const FOCUS_REPORT = /\x1b\[[IO]/g; // DECSET ?1004 focus in/out report
// eslint-disable-next-line no-control-regex
const X10_MOUSE_REPORT = /\x1b\[M[\s\S]{3}/g; // legacy X10 mouse report (3 fixed data bytes)
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_REPORT = /\x1b\[<\d+;\d+;\d+[Mm]/g; // SGR (?1006) mouse report
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_REPORT = /\x1b\[\d+;\d+R/g; // CPR
// eslint-disable-next-line no-control-regex
const DEVICE_ATTRIBUTES_REPLY = /\x1b\[>?\??[\d;]*c/g; // primary/secondary DA reply
// TerminalPane.tsx's OSC 10/11/12 color-query reply (the `rgb:` form) and its
// theme-toggle color SET push (the `#rrggbb` form) share this same OSC-ident
// shape — see that file's oscColorSubs handler and its settings-sync effect.
// eslint-disable-next-line no-control-regex
const OSC_COLOR_REPLY = /\x1b\](?:10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/g;
// TerminalPane.tsx's DEC "color scheme update" notification, bundled into the
// same write() as OSC_COLOR_REPLY's SET-push form on every theme toggle.
// eslint-disable-next-line no-control-regex
const COLOR_SCHEME_NOTIFICATION = /\x1b\[\?997;[12]n/g;

const AUTO_REPORT_SHAPES: ReadonlyArray<RegExp> = [
  FOCUS_REPORT,
  X10_MOUSE_REPORT,
  SGR_MOUSE_REPORT,
  CURSOR_POSITION_REPORT,
  DEVICE_ATTRIBUTES_REPLY,
  OSC_COLOR_REPLY,
  COLOR_SCHEME_NOTIFICATION,
];

/**
 * Strips every known automated terminal-protocol reply/push from `data` and
 * reports whether anything survives — see the block comment above for why
 * this must be a strict denylist rather than USER_INPUT_ECHO_MS's more
 * tolerant timing heuristic. Used only to gate Session.write()'s
 * authoritative "userInput" attention-clear signal (see below).
 */
function isGenuineUserInput(data: string): boolean {
  let remainder = data;
  for (const shape of AUTO_REPORT_SHAPES) {
    remainder = remainder.replace(shape, "");
  }
  return remainder.length > 0;
}

// A well-formed hook token is exactly what crypto.randomBytes(24).toString("hex")
// produces — 48 lowercase hex characters. Anything else in the token file
// (truncated write, corruption, a stray newline) is treated as absent
// rather than adopted, so a bad file can never downgrade this session's
// token to something weaker or malformed.
const HOOK_TOKEN_RE = /^[0-9a-f]{48}$/;

function hookTokenPath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.token`);
}

// A1 (audit finding): an actively-working agent's TUI rewrites its OSC
// title roughly once a second (elapsed-time counters, spinner frames), and
// prior to this fix every one of those ticks produced its own persisted +
// broadcast title_change event — measured at 93.6% of ALL session_events
// rows in production (160,767 of 171,793 over 9 days / 25 sessions). That
// flood evicted genuinely important events (permission_request,
// tool_failure) from the 100-slot ring buffer within about two minutes,
// bloated the DB, and drove a WS-broadcast + frontend re-render on every
// tick. TITLE_CHANGE_EVENT_DEBOUNCE_MS/_CEILING_MS below coalesce the
// title_change EVENT (ring buffer + DB persistence + WS broadcast) on a
// trailing-edge debounce, mirroring SessionStateFile.schedule()'s shape
// (session-state-file.ts) — see scheduleTitleChangeEvent()'s doc comment
// for the "detection stays live, persistence gets coalesced" split this
// relies on.
const TITLE_CHANGE_EVENT_DEBOUNCE_MS = 3_000;
// Ceiling mirrors SessionStateFile's own ceiling-timer role
// (session-state-file.ts's MAX_WRITE_DELAY_MS): forces an eventual
// title_change event even under CONTINUOUS title churn, which would
// otherwise keep resetting the trailing debounce forever and starve the
// event feed of any title_change at all for a session that never stops
// retitling.
const TITLE_CHANGE_EVENT_CEILING_MS = 15_000;

type StoredStateFields = Pick<
  SessionInfo,
  | "permissionState"
  | "planState"
  | "errorState"
  | "errorAt"
  | "errorDetail"
  | "gateState"
  | "gatePrompt"
  | "promoteState"
  | "promoteSummary"
  | "promoteSuggestedBaseRef"
  | "attentionKind"
  | "compactState"
  | "subagentCount"
  | "subagents"
  | "elicitationState"
  | "elicitationServer"
  | "questionState"
  | "questionHeader"
  | "questionAt"
  | "lastTurnEndedAt"
  | "lastAssistantMessage"
  | "backgroundTasks"
>;

// Issue: worktree/branch detection — a session's hookToken used to be
// minted fresh on every `Session` construction and never persisted, which
// is fine for a brand-new session but wrong for the getOrCreate() reattach
// path: a dtach master survives a Mullion process restart (that's the
// whole point of dtach + systemd --user scopes), but the *env* baked into
// it at spawn time does not change. A freshly restarted server minting a
// new in-memory token for the same session id left the still-running
// agent holding a token the new process would never accept again —
// silently killing every hook (branch, file-change, attention/status,
// promote) for that session's remaining lifetime. See this session's own
// plan doc for the live evidence (142 "unknown or invalid token" warnings
// after one restart).
//
// The fix: persist the token next to this session's other per-spawn files
// (`<id>.sock`, `<id>.hooks.json`, `<id>.mcp.json` — all already written
// under `sessionsDir` at 0o600) and always adopt whatever is on disk,
// unconditionally — including on a genuine respawn (stale socket, dead
// dtach master). Reusing an old token there is harmless: nothing else
// still holds it, and the alternative (trying to detect "was that token
// ever live") is a liveness check that can itself be wrong, for no
// benefit. Never throws: any read/write failure falls back to today's
// in-memory-only token, the same fail-safe posture as the rest of the
// hook path.
function loadOrCreateHookToken(sessionsDir: string, id: string): string {
  const tokenPath = hookTokenPath(sessionsDir, id);
  let fileExists = true;
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (HOOK_TOKEN_RE.test(existing)) return existing;
    // The file is there but malformed (truncated write, corruption) — fall
    // through to minting and OVERWRITE it below; a plain (non-exclusive)
    // write is correct here since we've already established there's
    // nothing valid on disk worth racing to preserve.
  } catch {
    // ENOENT (first spawn) or a read error — fall through to minting.
    fileExists = false;
  }
  const token = crypto.randomBytes(24).toString("hex");
  try {
    // Exclusive create only when nothing was there at all, so two
    // concurrent first-spawns for the same id can't silently clobber each
    // other's token; a known-malformed file is overwritten outright.
    writeFileSync(tokenPath, token, { mode: 0o600, flag: fileExists ? "w" : "wx" });
  } catch {
    // The exclusive create lost a race — another concurrent spawn for this
    // same id won and created the file first. Its token is just as valid
    // as the one just minted, so prefer reading it over silently diverging
    // from what's now on disk.
    try {
      const raced = readFileSync(tokenPath, "utf8").trim();
      if (HOOK_TOKEN_RE.test(raced)) return raced;
    } catch {
      // Fall through to the in-memory-only token below.
    }
  }
  return token;
}

export class Session {
  readonly id: string;
  // Numeric form of `id`, validated once at construction — see the
  // constructor's guard. Used by emitEvent() instead of re-parsing `id` on
  // every call.
  private readonly numericId: number;
  readonly cwd: string;
  readonly command: string;
  readonly socketPath: string;
  readonly createdAt: number;
  // Phase 2 (issue #172): a per-session, high-entropy secret disambiguating
  // this session's hook messages on the ONE shared hook socket every session
  // connects to (see PtyManager.hookSocketPath below) — hook authors aren't
  // meant to know or guess another session's token. Injected into this
  // session's own env (bootstrapMaster() below) at every spawn. Persisted
  // to `<sessionsDir>/<id>.token` (0o600, same directory and permissions as
  // this session's `.hooks.json`/`.mcp.json`) — see loadOrCreateHookToken()
  // above for why: the dtach master this token is handed to outlives this
  // Mullion process, so a fresh in-memory-only token minted after a restart
  // would never match what the still-running agent already has baked into
  // its env, permanently killing that session's hooks. The file's secrecy
  // (not its ephemerality) is what protects this token — same trust model
  // as those neighboring files. Not a defense against this session's own
  // children forging messages (they inherit it, same as any other env var)
  // — only against a *different* session on the same shared socket
  // impersonating this one.
  readonly hookToken: string;
  // The shared hook-socket path every session (and PtyManager's own
  // src/plugins/hooks.ts listener) uses — same value for every session in
  // this process, unlike hookToken above. Passed in from PtyManager rather
  // than derived locally so there's exactly one source of truth for it (see
  // PtyManager.hookSocketPath).
  readonly hookSocketPath: string;
  // The control socket path (Phase 4, #134) — same value for every session
  // in this process, same "passed in rather than derived locally" reasoning
  // as hookSocketPath above (see PtyManager.controlSocketPath). Injected
  // into this session's own env (bootstrapMaster() below) as
  // MULLION_SOCKET_PATH, alongside MULLION_SESSION_ID, so the `mullion` CLI
  // (src/cli/) run from inside this session can reach the control socket
  // and default its own session-targeting to this session with no flags.
  readonly controlSocketPath: string;
  // The manager-level sessions directory (SESSIONS_DIR) — needed here only
  // for applyShellIntegrationEnv's ZDOTDIR shim directory (bootstrapMaster
  // below); passed in the same way as hookSocketPath above rather than
  // re-derived, since PtyManager already resolved it once at its own
  // construction.
  private readonly sessionsDir: string;
  // Mirrors app.config.MULLION_REVIEW_GATE_ENABLED (default false), passed
  // down from PtyManager — see applyHookAdapters' ctx in bootstrapMaster()
  // below. Determines whether the Claude Code adapter registers the
  // blocking PreToolUse review gate for this session's launch.
  private readonly reviewGateEnabled: boolean;
  // Issue #437c — the live sessions.injectAgentGuide setting's value AT
  // THIS SESSION'S CREATION (PtyManager.getOrCreate calls
  // getInjectAgentGuide() fresh per session, then passes the resolved
  // boolean here — see that field's own doc comment on PtyManager for why
  // a spawn-time snapshot is the correct semantics here, unlike hooks.ts's
  // per-hook-fire live read for every other agent). Threaded into
  // applyHookAdapters' ctx in bootstrapMaster() below; the opencode adapter
  // is currently the only consumer.
  private readonly injectAgentGuide: boolean;
  private readonly skipPermissions: boolean;
  // Task Master's initial-turn prompt (see CreateSessionOptions.initialPrompt
  // above) — consumed once, in bootstrapMaster() below, to build finalCommand;
  // never persisted into `command`/`this.command`, so a later reattach or
  // respawn never re-submits it. Not cleared after use (nothing re-reads it
  // once bootstrapMaster() has run for this Session instance).
  private readonly initialPrompt: string | undefined;
  readonly projectId: number | null;

  private ptyProcess: IPty | null = null;
  private cols: number;
  private rows: number;
  // The byte-level ring buffer itself — see scrollback-buffer.ts's own header
  // comment for exactly what moved there vs. what stayed here (inAltScreen/
  // mouseTracking/detectCarry/cwdDetectCarry all stay on Session; only the
  // append/evict/read logic over raw chunks moved).
  private readonly scrollbackBuffer = new ScrollbackBuffer();
  // Tracked screen-mode truth, updated as output streams through onData (see
  // detectAltScreenSwitch). getScrollback() replays a preamble synthesized
  // from this rather than trusting the buffered bytes to be a self-balanced
  // enter/exit pair — the ring buffer's FIFO eviction can strand a dangling
  // exit (harmless: forces primary) but never a dangling enter (an enter is
  // always older than its matching exit), so raw-byte replay silently drifts
  // into staying in alt-screen — hiding the scrollbar — only in scenarios
  // where the true state actually is alt-screen. Tracking mode explicitly
  // instead of inferring it from stream balance is what makes replay correct
  // in both directions (see issue #83).
  private inAltScreen = false;
  // Tracked mouse-tracking-mode truth, the same deliberate way inAltScreen
  // above tracks screen mode — see MouseTrackingState's docstring in
  // attention-detect.ts for the full rationale (issue #93: a reconnecting
  // client whose fresh xterm.js never sees the program's original
  // mouse-enabling escape, because it aged out of the bounded scrollback
  // ring buffer, silently defaults to no tracking while the real process is
  // never told anything changed).
  private mouseTracking: MouseTrackingState = INITIAL_MOUSE_TRACKING_STATE;
  // Any unterminated escape-sequence prefix left dangling at the end of the
  // previous onData chunk (see carryPartialEscape's docstring) — prepended to
  // the next chunk before re-running detectAltScreenSwitch/
  // applyMouseModeChanges so a sequence split across a PTY read boundary is
  // still recognized. Detection-only: never used for scrollback or fan-out,
  // only for the copy fed to those two detectors.
  private detectCarry = "";
  // Same carry role as detectCarry above, but for the OSC-shaped (variable-
  // length path) sequences detectCwdChange scans for — see
  // carryPartialOsc's docstring for why OSC 7 needs its own carry logic
  // distinct from the CSI-shaped carryPartialEscape.
  private cwdDetectCarry = "";
  // The shell's last-announced cwd via OSC 7 — see SessionInfo.liveCwd's
  // docstring. `null` until the first OSC 7 sequence arrives (or forever, for
  // a shell without the injected integration hook).
  private _liveCwd: string | null = null;

  get liveCwd(): string | null {
    return this._liveCwd;
  }

  get liveBranch(): string | null {
    return this._liveBranch;
  }
  // Serializes this session's `file_change` git-ignore checks (issue:
  // sidebar worktree display's Part B) — each check is a real `git`
  // shell-out (git-ignore.ts's isPathGitIgnored), so chaining onto this
  // promise rather than firing each check independently keeps same-session
  // file_change events landing in `this.events` in the order they actually
  // arrived, even though emitHookEvent() itself stays synchronous for every
  // other message kind.
  private fileChangeQueue: Promise<void> = Promise.resolve();
  // Perf audit finding B8(3) — memoizes isPathGitIgnoredCached's
  // check-ignore results (both a directory-level "is this whole directory
  // excluded" answer and, for a directory that isn't, per-file answers —
  // see that function's own doc comment for why both levels are needed
  // for correctness, not just directory-level) for this session's whole
  // lifetime (cleared in kill() below, alongside this class's other
  // per-lifetime state). Real edits overwhelmingly cluster in a handful of
  // directories, so this eliminates the vast majority of redundant `git
  // check-ignore` subprocess spawns an agent's multi-file operation would
  // otherwise cause, one per changed file. Unbounded per session (not an
  // LRU) — a session realistically touches at most a few hundred distinct
  // directories/files over its lifetime, nowhere near a memory concern, and
  // it's fully discarded at kill() either way.
  private gitIgnoreDirCache = new Map<string, boolean>();
  // The redraw-nudge state machine itself (Milestone 1's Risk 1, hardened by
  // #107 — see redraw-nudge.ts's own header comment for why Claude's
  // Ink-based TUI needs a real dip/restore resize on attach, not just
  // dtach's `-r winch`).
  // `resize` and `getSize` are read/written live against this Session's own
  // ptyProcess/cols/rows (rather than captured once) — see RedrawNudgeHost's
  // docstring for why a real client resize landing mid-cycle must still be
  // respected. `suppressingOutput` is deliberately dual-purpose from onData's
  // side (two call sites below both check it) rather than two separate
  // flags with the same lifecycle, since both readings are really the same
  // fact — "this chunk is OUR synthesized repaint, not real program
  // content" — just applied to two different consumers:
  //  1. Scrollback capture: while set, onData still fans chunks out to live
  //     subscribers (a reconnecting client must see the repaint) but does not
  //     buffer them into scrollback, so repeated reconnect-triggered repaints
  //     don't evict real user output from the ring buffer.
  //  2. Attention: while set, onData does not feed a signal-less chunk to the
  //     attention state machine as `{type:"output"}` — a synthesized repaint
  //     is not the program resuming activity, so it must not be able to
  //     clear a confirmed attention flag (see the onData call site's own
  //     comment for why this matters — issue: opening a workspace tab must
  //     not silently dismiss a pending "needs permission" flag).
  // A future change to this flag's lifecycle (e.g. narrowing the window for
  // scrollback reasons alone) affects BOTH consumers — keep this comment and
  // both call sites in sync if that ever happens.
  private readonly redrawNudge = new RedrawNudge({
    resize: (cols, rows) => {
      this.ptyProcess?.resize(cols, rows);
    },
    getSize: () => ({ cols: this.cols, rows: this.rows }),
  });
  private dataListeners = new Set<DataListener>();
  private exitListeners = new Set<ExitListener>();
  private eventListeners = new Set<EventListener>();
  // This session's own notification-event ring buffer (issue #166) — same
  // FIFO-eviction shape as scrollback above, capped by count (EVENTS_MAX)
  // rather than bytes. `eventSeq` is monotonic per-session, never reset or
  // reused, so a client's read cursor (lastSeenSeq below) only ever needs to
  // compare against it, never worry about wraparound within a session's
  // lifetime.
  private events: NotificationEvent[] = [];
  private eventSeq = 0;
  // The read cursor for this session's event stream (issue #166's shared
  // read/unread primitive future PRs — 1.3's tab badges, 1.4's event feed —
  // both reuse): unread = events with seq > lastSeenSeq. Advanced only via
  // markEventsSeen(), driven by a client's "seen" WS message
  // (routes/events.ts). Starts at 0 so every event a session has ever
  // produced is initially unread.
  private lastSeenSeq = 0;
  private lastActivityAt: number | null = null;
  private activityStreakStart: number | null = null;
  // The attention state machine's own state (issue #171/#98) — see
  // advanceAttention() in attention-detect.ts. Replaces the old bare
  // `attentionAt: number | null` field entirely: `attentionState.confirmedAt`
  // IS this session's public attentionAt (see toInfo()), folded into the
  // machine's state so there's only ever one timestamp to keep in sync.
  private attentionState: AttentionMachineState = INITIAL_ATTENTION_STATE;
  // Minimal review gate (Phase 2, issue #178) — see SessionInfo.gateState's
  // doc comment for the state meanings. Set from emitHookEvent's
  // "review_gate" case and from resolveGate() below; read by toInfo().
  private gateState: "idle" | "waiting" | "approved" | "denied" = "idle";
  private gatePrompt: string | null = null;
  private gateAt: number | null = null;

  // Issue #271, option 2 — see SessionInfo.promoteState's doc comment. Set
  // from emitHookEvent's "promote_request" case and from resolvePromote()
  // below; read by toInfo().
  private promoteState: "idle" | "pending" | "accepted" | "declined" = "idle";
  private promoteSummary: string | null = null;
  private promoteSuggestedBaseRef: string | null = null;
  private promoteAt: number | null = null;
  private permissionState: "idle" | "pending" = "idle";
  private permissionAt: number | null = null;
  // Fix: status-clearing-semantics — the tool name from the permission_request
  // that set permissionState to "pending" (or null once resolved/never set).
  // Claude Code has no "permission granted" hook, so a completed tool call
  // (`tool_done`) is the only forward-progress evidence a pending permission
  // has actually resolved — but Claude Code runs tools in parallel, so an
  // unrelated already-permitted tool completing must NOT release a still-open
  // dialog for a different one. Matched by tool NAME, not a request id (the
  // hook payloads don't carry one) — see the "tool_done" case below for the
  // accepted residual edge this leaves (two same-named tools in one parallel
  // batch). Cleared everywhere permissionState resets to "idle", including by
  // the "tool_done" case itself once a release actually happens.
  private pendingPermissionTool: string | null = null;
  private planState: "idle" | "pending" = "idle";
  private planAt: number | null = null;
  private errorState: "idle" | "api_error" | "tool_failure" = "idle";
  private errorAt: number | null = null;
  private endedReason: string | null = null;
  private exitCode: number | null = null;
  private _liveBranch: string | null = null;
  // Rich statuses (issue: extend surfaced session statuses) — see each
  // field's own doc comment on SessionInfo above for what it means; toInfo()
  // reads these straight through (or, for attentionKind, off attentionState
  // directly — see that field's own doc comment for why).
  private errorDetail: string | null = null;
  private lastAssistantMessage: string | null = null;
  private compactState: "idle" | "compacting" = "idle";
  private compactAt: number | null = null;
  private subagentCount = 0;
  private subagentCountAt: number | null = null;
  // Phase 5 (Track A) — keyed by agentId. Purely additive to subagentCount
  // above (see SubagentInfo's doc comment for why they can legitimately
  // disagree in length).
  private subagents = new Map<string, SubagentInfo>();
  private elicitationState: "idle" | "pending" = "idle";
  private elicitationServer: string | null = null;
  private elicitationAt: number | null = null;
  // OpenCode v2 question events — see SessionInfo.questionState's doc comment.
  private questionState: "idle" | "pending" = "idle";
  private questionHeader: string | null = null;
  private questionAt: number | null = null;
  private lastTurnEndedAt: number | null = null;
  // Issue #428 — see SessionInfo.backgroundTasks/.backgroundTasksAt's own
  // doc comments.
  private backgroundTasks: BackgroundTask[] = [];
  private backgroundTasksAt: number | null = null;
  // Issue #428 — one-shot guard for resolveDeferredTurnEnd()'s `agentIdle`
  // ping (Hermes review, PR #453): without this, a repeated hook message
  // reporting the SAME already-drained (or already-empty) backgroundTasks
  // state — a late/reordered SubagentStop, or a second progress:done with
  // no new information — would call resolveDeferredTurnEnd() again while
  // lastTurnEndedAt is still latched, re-firing a duplicate "Finished" ping
  // for a turn that already got its one. Scoped to the CURRENT latch: reset
  // to false everywhere lastTurnEndedAt is freshly set OR cleared, so the
  // next genuine turn end gets its own single ping.
  private turnEndPingSent = false;
  // Issue #404 — the port most recently detected pending accept/dismiss; see
  // SessionInfo.pendingDevServerPort's own doc comment. In-memory only, same
  // resets-on-restart posture as gateState/promoteState above.
  private pendingDevServerPort: string | null = null;
  // Every port this session has EVER offered (whether the offer was
  // accepted, dismissed, or is still pending) — never removed from, so a
  // dev-server restart on the SAME port doesn't re-notify, and a dismissed
  // port stays suppressed for the rest of this session's in-process
  // lifetime. A new/different port (a restart that lands on a new port
  // because the original was in use) is a genuinely new (session, port)
  // pair and is still offered. Resets on restart, same posture as
  // pendingDevServerPort above — an accepted/dismissed port re-offering
  // once after a Mullion restart is a minor, accepted UX blip, not a
  // correctness bug (see this file's other "in-memory only" fields).
  private handledDevServerPorts = new Set<string>();
  // Last title-derived working/idle read (classifyActivityFromTitle), kept
  // ONLY to detect the #98 working->idle TRANSITION (a program that was
  // working just went idle — "ready for input") — distinct from `activity`
  // in toInfo(), which recomputes this from scratch on every poll and has
  // no memory of the previous read.
  private lastTitleActivity: "working" | "idle" | null = null;
  private lastTitle: string | null = null;
  // A1: debounced title_change EVENT emission bookkeeping (ring buffer/DB
  // persistence/WS broadcast) — deliberately separate from lastTitle/
  // lastTitleActivity above, which stay driven by the RAW, un-coalesced
  // signal on every tick so #98's working->idle detection timing is
  // completely unaffected. See scheduleTitleChangeEvent()'s doc comment.
  private titleChangeEventTimeout: ReturnType<typeof setTimeout> | null = null;
  private titleChangeEventCeilingTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingTitleChangeTitle: string | null = null;
  // Ms-epoch of the last write() call (user keystrokes, plus a couple of
  // automated terminal-protocol replies routed through the same browser->pty
  // channel — see USER_INPUT_ECHO_MS's docstring). Used by toInfo()'s timing
  // fall-through to tell keystroke echo apart from autonomous output.
  private lastUserInputAt: number | null = null;
  // B9 — WS->PTY backpressure. Bytes written to ptyProcess.write() within
  // the current WRITE_BACKPRESSURE_WINDOW_MS window; reset to 0 whenever a
  // write() call lands outside that window. See write()'s own doc comment
  // for why this exists (node-pty exposes no drain signal, unlike a WS
  // socket's own bufferedAmount).
  private pendingWriteBytes = 0;
  private writeWindowStartedAt = 0;
  // Log at most once per window (not once per dropped chunk) — a sustained
  // flood would otherwise spam a console.warn line, unfiltered by pino's
  // level machinery, at the frequency of every subsequent WS frame for as
  // long as the flood continues. Same rationale applyAttentionTransition
  // documents for suppressing PENDING_ATTENTION churn.
  private writeDropLogged = false;
  // Set once spawn() learns whether applyHookAdapters actually matched this
  // session's command to a real hook adapter (Claude Code/opencode/codex/agy)
  // — see AppliedHooks.matched's own docstring. Gates Session.tick()'s
  // byte-driven sustained-silence guess: a hook agent's own Stop/
  // session.idle hook (routed through emitHookEvent's "progress"/"done" case
  // into the `agentIdle` signal) is authoritative, so the byte guess — which
  // can't tell a real "went quiet after work" apart from this same agent's
  // own startup splash render — only runs for hookless sessions (plain
  // shells, unrecognized commands). NOTE: matching an adapter is necessary
  // but not sufficient for that authority to actually exist — see
  // `hooksProven` below, latched once the pipeline has delivered a message.
  private hooksActive = false;
  private hookEmits: readonly HookMessageKind[] = [];
  // Follow-up to #275 (gap #1): `hooksActive` alone means "a command matched
  // an adapter", NOT "this session's hook pipeline has ever actually
  // delivered a message" — those are different claims. Codex in particular
  // requires a one-time interactive `/hooks` trust grant before ANY hook it
  // registers fires at all (see hook-adapters/codex.ts); until that grant
  // exists, `hooksActive` is true but the pipeline is completely silent. A
  // fresh `hooksActive` session with `tick()` gated on `hooksActive` alone
  // would get neither the fast byte-driven guess (disabled because
  // `hooksActive`) NOR the hook's own signal (never arrives). `hooksProven`
  // is a monotonic per-session latch — still useful for other gates — but the
  // silence watchdog no longer requires it: any `hooksActive` session gets
  // the slow HOOK_FALLBACK_SILENCE_MS watchdog regardless of proof status.
  // This avoids the "needs input" cycle after Mullion restarts, where
  // `hooksProven` (in-memory only) is lost and the 10s fast bound fired
  // between every turn while waiting for the hook pipeline to re-prove
  // itself.
  private hooksProven = false;

  // Issue #323: state file persistence — tracks whether a state file was
  // successfully read and applied on construction.
  private stateRestored: boolean = false;
  // Issue #323: whether the session was launched with a different server
  // version (detected by comparing stored launchedAtVersion with current).
  private staleHooks: boolean = false;
  // Issue #323: the version stored in the state file at construction time.
  private restoredVersion: string | null = null;
  // Issue #323: debounced, atomic persistence for this session's
  // `<sessionsDir>/<id>.state.json` — see session-state-file.ts. Declared
  // without an initializer and assigned in the constructor body (unlike
  // scrollbackBuffer above, which needs no per-instance arguments): field
  // initializers run before the constructor body, so
  // `this.sessionsDir`/`this.id` would still be undefined at that point.
  private readonly stateFile: SessionStateFile<StoredStateFields>;

  constructor(opts: {
    id: string;
    cwd: string;
    command: string;
    socketPath: string;
    cols: number;
    rows: number;
    hookSocketPath: string;
    controlSocketPath: string;
    sessionsDir: string;
    reviewGateEnabled?: boolean;
    injectAgentGuide?: boolean;
    skipPermissions?: boolean;
    initialPrompt?: string;
    projectId?: number;
  }) {
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.command = opts.command;
    this.socketPath = opts.socketPath;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.createdAt = Date.now();
    this.hookSocketPath = opts.hookSocketPath;
    this.controlSocketPath = opts.controlSocketPath;
    this.sessionsDir = opts.sessionsDir;
    this.reviewGateEnabled = opts.reviewGateEnabled ?? false;
    this.injectAgentGuide = opts.injectAgentGuide ?? true;
    this.skipPermissions = opts.skipPermissions ?? false;
    this.initialPrompt = opts.initialPrompt;
    this.projectId = opts.projectId ?? null;
    // Issue #351 — compute hookEmits on every construction (including reattach
    // after server restart) so toInfo() always reflects the adapter that
    // matches this.session.command, not just the one bootstrapMaster() saw at
    // fresh spawn time. Pure lookup (no I/O), same as bootstrapMaster's own
    // applyHookAdapters call.
    this.hookEmits = getAdapterEmits(this.command);
    // 24 random bytes -> 48 hex chars: same order of magnitude as the
    // MULLION_AGENT_TOKEN/MULLION_AUTH_TOKEN guidance elsewhere in this repo
    // (openssl rand -hex 32) — see loadOrCreateHookToken() above for why
    // this is read-or-minted against a per-session file rather than always
    // freshly generated.
    this.hookToken = loadOrCreateHookToken(this.sessionsDir, this.id);
    // Computed once here (rather than re-parsed on every emitEvent() call)
    // and guarded: session ids are DB-issued numeric strings by domain
    // contract, but NotificationEvent.sessionId is typed as `number`, so an
    // unexpected non-numeric id must not silently become NaN deep inside
    // the event stream — fail loudly at construction instead, where it's
    // immediately traceable to the caller that passed a bad id.
    const numericId = Number(this.id);
    if (Number.isNaN(numericId)) {
      throw new Error(`Session id must be numeric, got: ${JSON.stringify(this.id)}`);
    }
    this.numericId = numericId;

    this.stateFile = new SessionStateFile<StoredStateFields>(
      stateFilePath(this.sessionsDir, this.id),
      () => {
        // Preserve the original launch version when state was restored
        // from a file (restoredVersion) — otherwise the write path would
        // overwrite it with the current APP_VERSION on every write, losing
        // the true session-launch version and making stale-hooks detection
        // unreliable after multiple server restarts.
        const payload: StoredSessionState<StoredStateFields> = {
          v: 1,
          launchedAtVersion: this.restoredVersion ?? APP_VERSION,
          state: this.collectState(),
        };
        return payload;
      },
      () => console.warn(`[pty-manager] session ${this.id} corrupt state file, using defaults`),
      (err) => console.error(`[pty-manager] session ${this.id} failed to write state file:`, err),
    );

    // Issue #323: read persisted state from disk (e.g. after a server
    // restart the session's dtach master survived but in-memory state was
    // lost). The state file is written by the debounced flush mechanism
    // below on every emitEvent() call.
    this.readStateFile();

    // Issue #323, fix: if the dtach socket doesn't exist yet, this is a
    // brand-new session — nothing lost, nothing to restore. Only a reattach
    // scenario (where the socket already exists from a prior spawn) could
    // have lost state.
    if (!existsSync(this.socketPath)) {
      this.stateRestored = true;
    }
  }

  get isAlive(): boolean {
    return this.ptyProcess !== null;
  }

  get subscriberCount(): number {
    return this.dataListeners.size;
  }

  // --- State file persistence (issue #323) ---

  /** Read and apply persisted state from disk. Called once at construction.
   * If the file exists and parses correctly, all non-null state fields are
   * applied and stateRestored is set to true. A missing or corrupt file is
   * handled silently — defaults remain at their idle/zero values. */
  private readStateFile(): void {
    const parsed = this.stateFile.read();
    if (parsed === null) return;

    const s = parsed.state;
    if (s.permissionState !== undefined) this.permissionState = s.permissionState;
    if (s.planState !== undefined) this.planState = s.planState;
    if (s.errorState !== undefined) this.errorState = s.errorState;
    if (s.errorAt !== undefined) this.errorAt = s.errorAt;
    if (s.errorDetail !== undefined) this.errorDetail = s.errorDetail;
    if (s.gateState !== undefined) this.gateState = s.gateState;
    if (s.gatePrompt !== undefined) this.gatePrompt = s.gatePrompt;
    if (s.promoteState !== undefined) this.promoteState = s.promoteState;
    if (s.promoteSummary !== undefined) this.promoteSummary = s.promoteSummary;
    if (s.promoteSuggestedBaseRef !== undefined)
      this.promoteSuggestedBaseRef = s.promoteSuggestedBaseRef;
    if (s.attentionKind !== undefined) {
      const ak = this.attentionState;
      if (s.attentionKind === null) {
        // Explicitly cleared — keep the machine state as-is (already idle).
      } else {
        // We can't fully reconstruct the attention machine, but setting
        // confirmedKind signals to the UI what was pending.
        this.applyAttentionTransition(
          advanceAttention(ak, { type: "signal", kind: s.attentionKind, now: Date.now() }),
        );
      }
    }
    if (s.compactState !== undefined) this.compactState = s.compactState;
    if (s.subagentCount !== undefined) this.subagentCount = s.subagentCount;
    // Phase 5 (Track A) — a state file written before this registry existed
    // simply has no `subagents` key (older `.state.json`, still valid), left
    // as the constructor's empty Map default. `Array.isArray` guards against
    // a corrupt/malformed value the same defensive way the rest of this
    // method treats an unexpected shape (skip, don't throw).
    if (Array.isArray(s.subagents)) {
      this.subagents = new Map(s.subagents.map((info) => [info.agentId, info]));
    }
    if (s.elicitationState !== undefined) this.elicitationState = s.elicitationState;
    if (s.elicitationServer !== undefined) this.elicitationServer = s.elicitationServer;
    if (s.questionState !== undefined) this.questionState = s.questionState;
    if (s.questionHeader !== undefined) this.questionHeader = s.questionHeader;
    if (s.questionAt !== undefined) this.questionAt = s.questionAt;
    if (s.lastTurnEndedAt !== undefined) this.lastTurnEndedAt = s.lastTurnEndedAt;
    if (s.lastAssistantMessage !== undefined) this.lastAssistantMessage = s.lastAssistantMessage;
    // Issue #428 — the persisted `backgroundTasksAt` timestamp itself is
    // NOT restored (same posture as subagentCountAt above — a restored
    // process shouldn't trust a clock value from before the restart), but
    // going through setBackgroundTasks() re-stamps it to NOW when the
    // restored list still has outstanding entries, so the busy-TTL sweep
    // has a baseline to measure from. Without this, `isStale(null, ...)` is
    // always false and a restored outstanding set could never be swept at
    // all until some unrelated turn_start/keystroke/hook event happened to
    // touch it (Hermes review, PR #453).
    if (Array.isArray(s.backgroundTasks)) this.setBackgroundTasks(s.backgroundTasks);
    // Fresh-review finding — `turnEndPingSent` itself isn't persisted (it's
    // not in StoredStateFields, same as backgroundTasksAt), so it would
    // otherwise always restore to its class-field default of `false`. That's
    // wrong when the restored state already represents an ended, fully-
    // drained turn: the ORIGINAL process already sent that ping before the
    // restart, so treating it as "not yet sent" risks a duplicate "Finished"
    // notification the moment any later hook event calls
    // resolveDeferredTurnEnd() again for this same still-latched turn (e.g.
    // a second, unrelated background task starting and draining before the
    // user's next keystroke). Derived rather than persisted: a turn counts
    // as already-pinged on restore exactly when it's both latched AND has
    // nothing outstanding — the same condition resolveDeferredTurnEnd()
    // itself checks before firing.
    if (this.lastTurnEndedAt !== null) {
      this.turnEndPingSent = filterOutstandingBackgroundTasks(this.backgroundTasks).length === 0;
    }

    this.stateRestored = true;
    this.restoredVersion = parsed.launchedAtVersion;
    // Compare stored launchedAtVersion with current APP_VERSION.
    // A change in any segment of the version string indicates a potential
    // hook config change; a plain string comparison is deliberate — semver
    // parsing would be overprecise here since even a build metadata change
    // could mean hook changes.
    this.staleHooks = parsed.launchedAtVersion !== APP_VERSION;
  }

  /** Gather the current state fields into a `StoredStateFields` object. */
  private collectState(): StoredStateFields {
    return {
      permissionState: this.permissionState,
      planState: this.planState,
      errorState: this.errorState,
      errorAt: this.errorAt,
      errorDetail: this.errorDetail,
      gateState: this.gateState,
      gatePrompt: this.gatePrompt,
      promoteState: this.promoteState,
      promoteSummary: this.promoteSummary,
      promoteSuggestedBaseRef: this.promoteSuggestedBaseRef,
      attentionKind: this.attentionState.confirmedKind,
      compactState: this.compactState,
      subagentCount: this.subagentCount,
      subagents: Array.from(this.subagents.values()),
      elicitationState: this.elicitationState,
      elicitationServer: this.elicitationServer,
      questionState: this.questionState,
      questionHeader: this.questionHeader,
      questionAt: this.questionAt,
      lastTurnEndedAt: this.lastTurnEndedAt,
      lastAssistantMessage: this.lastAssistantMessage,
      backgroundTasks: this.backgroundTasks,
    };
  }

  // --- Title-change event coalescing (A1) ---

  /**
   * Debounce the title_change EVENT — the thing that consumes a ring-buffer
   * slot, gets persisted to `session_events`, and gets broadcast over WS —
   * separately from title-change DETECTION. onData()'s title-change block
   * calls this instead of emitEvent() directly, but still updates
   * `lastTitle`/`lastTitleActivity` and evaluates the #98 working->idle
   * transition synchronously on EVERY raw title, uninterrupted by this
   * debounce: those two concerns must stay decoupled, or attention would
   * silently start lagging title changes by up to
   * TITLE_CHANGE_EVENT_DEBOUNCE_MS, which is exactly the regression this
   * split exists to avoid (see the PR description / A1 finding).
   *
   * Trailing-edge, reset on every new title, mirroring
   * SessionStateFile.schedule()'s shape (session-state-file.ts): a
   * per-session timer plus a ceiling timer armed only on the first pending
   * title, so a session whose TUI
   * NEVER stops retitling (the common case for an actively-working agent)
   * still gets an eventual title_change event rather than none at all.
   * Always emits the LATEST pending title at fire time, not the one that
   * started the window — an intermediate title a user never saw isn't
   * worth a slot in the ring buffer or a DB row.
   */
  private scheduleTitleChangeEvent(title: string): void {
    const wasAlreadyPending = this.pendingTitleChangeTitle !== null;
    this.pendingTitleChangeTitle = title;
    if (this.titleChangeEventTimeout !== null) clearTimeout(this.titleChangeEventTimeout);
    this.titleChangeEventTimeout = setTimeout(() => {
      this.flushTitleChangeEvent();
    }, TITLE_CHANGE_EVENT_DEBOUNCE_MS);
    this.titleChangeEventTimeout.unref();

    if (!wasAlreadyPending) {
      if (this.titleChangeEventCeilingTimeout !== null) {
        clearTimeout(this.titleChangeEventCeilingTimeout);
      }
      this.titleChangeEventCeilingTimeout = setTimeout(() => {
        this.flushTitleChangeEvent();
      }, TITLE_CHANGE_EVENT_CEILING_MS);
      this.titleChangeEventCeilingTimeout.unref();
    }
  }

  /** Fire the pending (possibly coalesced) title_change event, if any, and
   * clear both timers. Safe to call directly (kill()'s flush-on-detach
   * path below, tests) — a no-op when nothing is pending. */
  private flushTitleChangeEvent(): void {
    if (this.titleChangeEventTimeout !== null) {
      clearTimeout(this.titleChangeEventTimeout);
      this.titleChangeEventTimeout = null;
    }
    if (this.titleChangeEventCeilingTimeout !== null) {
      clearTimeout(this.titleChangeEventCeilingTimeout);
      this.titleChangeEventCeilingTimeout = null;
    }
    if (this.pendingTitleChangeTitle === null) return;
    const title = this.pendingTitleChangeTitle;
    this.pendingTitleChangeTitle = null;
    this.emitEvent("title_change", { title });
  }

  private spawning: Promise<void> | null = null;
  // B6 — the raw (un-swallowed) promise from this session's most recent
  // spawn() attempt, kept around after `spawning` itself is nulled out by
  // that attempt's own `.finally()`. `spawning`'s truthiness is only useful
  // WHILE a spawn is in flight; a caller that needs to know whether the
  // attempt actually SUCCEEDED (LocalBackend.spawn, via spawnOutcome()
  // below) needs a reference that survives settlement too. `null` until
  // spawn() has been called at least once on this instance.
  private lastSpawnAttempt: Promise<void> | null = null;

  /**
   * Spawn (or respawn) this session's dtach attach-client, bootstrapping the
   * underlying dtach master first if it doesn't exist yet. A no-op if a
   * client is already running or a spawn is already in flight — call sites
   * don't need to check `isAlive` first.
   *
   * Deliberately does NOT use `dtach -A` (attach-or-create) for the tracked
   * client: Milestone 1 found empirically that when `-A` creates a session,
   * the process it spawns is *itself* the master (dtach forks the program
   * as its child but does not detach into a separate master), not merely an
   * attach-client. Killing that process — which is exactly what happens on
   * every graceful shutdown/redeploy via killAll() below — killed the
   * program too, defeating the entire point. Master creation (`-n`, which
   * creates and immediately detaches/exits on its own) is therefore always
   * a separate, untracked, fire-and-forget step; only the subsequent
   * attach-only (`-a`) process is ever tracked as this.ptyProcess.
   *
   * B6 — returns a promise reflecting THIS attempt's real outcome (rejects
   * if spawnInternal() rejects), unlike the internal `this.spawning`
   * bookkeeping promise below (which always resolves, even on failure, by
   * design — see its own inline comment). This is deliberately additive,
   * not a behavior change for existing callers: every current call site
   * (PtyManager.getOrCreate, below) already ignored spawn()'s return value
   * back when it was `void`, and nothing about that changes just because
   * the value now exists — `this.spawning`'s own `.catch()` below still
   * unconditionally logs-and-swallows on the same tick this promise is
   * created, so an uncaught rejection here can never surface as an
   * unhandled-rejection warning regardless of whether a caller awaits it.
   * `LocalBackend.spawn` (session-backend.ts) is the one caller that DOES
   * await it, specifically so a genuine first-attempt failure (missing
   * systemd-run/dtach, a vanished cwd, a scope-name collision) can finally
   * propagate to session-lifecycle.ts's existing rollback `catch` block
   * instead of silently returning 201 with a dead session and an
   * unregistered worktree (see this method's git history / issue tracker
   * for the full incident this closes).
   *
   * A second/concurrent call while a spawn is already in flight
   * (`this.spawning` truthy) intentionally still returns the same
   * always-resolves bookkeeping promise, not this attempt's raw outcome —
   * that case isn't a "first attempt," so it keeps today's degenerate
   * "reports success" behavior rather than growing new failure-propagation
   * plumbing for a race outside this fix's stated scope.
   */
  spawn(): Promise<void> {
    if (this.ptyProcess || this.spawning) return this.spawning ?? Promise.resolve();
    // Issue #323: save restored state so it survives the reset below.
    // When a session is reattached after a restart (stateRestored === true),
    // the restored state should be preserved until hooks catch up, rather
    // than silently lost to idle defaults.
    const hadRestoredState = this.stateRestored;
    const savedState = hadRestoredState ? this.collectState() : null;
    this.permissionState = "idle";
    this.permissionAt = null;
    this.pendingPermissionTool = null;
    this.planState = "idle";
    this.planAt = null;
    this.gateState = "idle";
    this.gateAt = null;
    this.gatePrompt = null;
    this.promoteState = "idle";
    this.promoteAt = null;
    this.promoteSummary = null;
    this.promoteSuggestedBaseRef = null;
    this.errorState = "idle";
    this.errorAt = null;
    this.endedReason = null;
    this.exitCode = null;
    this._liveBranch = null;
    // Rich statuses — same "fresh session identity" reset as the fields
    // just above.
    this.errorDetail = null;
    this.lastAssistantMessage = null;
    this.compactState = "idle";
    this.compactAt = null;
    this.subagentCount = 0;
    this.subagentCountAt = null;
    this.subagents = new Map();
    this.elicitationState = "idle";
    this.elicitationServer = null;
    this.elicitationAt = null;
    this.questionState = "idle";
    this.questionHeader = null;
    this.questionAt = null;
    this.lastTurnEndedAt = null;
    this.turnEndPingSent = false;
    this.backgroundTasks = [];
    this.backgroundTasksAt = null;
    this.attentionState = INITIAL_ATTENTION_STATE;
    // Re-apply restored state if we had it, so the UI sees the known
    // pre-restart state until hooks catch up with fresh data.
    if (savedState) {
      this.permissionState = savedState.permissionState;
      this.planState = savedState.planState;
      this.errorState = savedState.errorState;
      this.errorAt = savedState.errorAt;
      this.errorDetail = savedState.errorDetail;
      this.gateState = savedState.gateState;
      this.gatePrompt = savedState.gatePrompt;
      this.promoteState = savedState.promoteState;
      this.promoteSummary = savedState.promoteSummary;
      this.promoteSuggestedBaseRef = savedState.promoteSuggestedBaseRef;
      this.compactState = savedState.compactState;
      this.subagentCount = savedState.subagentCount;
      // Array.isArray guard for defense-in-depth, matching readStateFile's
      // own guard (Hermes review, PR #415) — savedState always comes from
      // this.collectState(), which always produces an array, so this is
      // belt-and-suspenders rather than a currently-reachable case.
      if (Array.isArray(savedState.subagents)) {
        this.subagents = new Map(savedState.subagents.map((info) => [info.agentId, info]));
      }
      this.elicitationState = savedState.elicitationState;
      this.elicitationServer = savedState.elicitationServer;
      this.questionState = savedState.questionState;
      this.questionHeader = savedState.questionHeader;
      this.questionAt = savedState.questionAt;
      this.lastTurnEndedAt = savedState.lastTurnEndedAt;
      this.lastAssistantMessage = savedState.lastAssistantMessage;
      // The persisted backgroundTasksAt itself is NOT restored — going
      // through setBackgroundTasks() re-stamps it to NOW instead, same
      // reasoning as the state-file restore path's own comment above.
      if (Array.isArray(savedState.backgroundTasks)) {
        this.setBackgroundTasks(savedState.backgroundTasks);
      }
      // Fresh-review finding — same turnEndPingSent derivation as the
      // state-file restore path's own comment above: a respawn (re-applying
      // savedState after the fresh reset a few lines up) needs the same
      // "already-pinged" inference, not the reset's unconditional `false`.
      if (this.lastTurnEndedAt !== null) {
        this.turnEndPingSent = filterOutstandingBackgroundTasks(this.backgroundTasks).length === 0;
      }
      // attentionKind is restored from state file via readStateFile but
      // NOT re-applied here — the attention machine has its own timing
      // (tick-based confirmations) that's cleaner to let re-establish.
      // endedReason/exitCode are session-scoped, not state-restorable.
    }
    const attempt = this.spawnInternal();
    this.lastSpawnAttempt = attempt;
    // Chained synchronously, in the same tick `attempt` is created — this is
    // what makes returning the raw `attempt` below safe: Node only reports
    // an unhandled rejection if a promise reaches the end of a microtask
    // turn with no handler attached at all, and `.catch()` here attaches
    // one immediately, independent of whether `spawn()`'s own caller ever
    // looks at its return value.
    this.spawning = attempt
      .catch((err) => {
        console.error(`[pty-manager] failed to spawn session ${this.id}:`, err);
      })
      .finally(() => {
        this.spawning = null;
      });
    return attempt;
  }

  /**
   * B6 — the outcome of this session's most recent spawn() attempt, for a
   * caller that needs to know whether it actually succeeded rather than
   * just that one was kicked off. `null` if spawn() has never run on this
   * instance (e.g. a Session constructed but never handed to getOrCreate() —
   * not a real path today, but a safe default regardless).
   *
   * `LocalBackend.spawn` (session-backend.ts) is the intended caller:
   * `PtyManager.getOrCreate()` already calls `session.spawn()` internally
   * and discards its return value (getOrCreate() itself is synchronous and
   * used by many callers that must NOT block on a spawn completing), so
   * this is how a caller that specifically needs the awaited outcome
   * — without re-invoking spawn() itself, which would just hit the
   * reentrancy guard and return the always-resolves `spawning` bookkeeping
   * promise instead of this attempt's real result — gets at it.
   */
  spawnOutcome(): Promise<void> {
    return this.lastSpawnAttempt ?? Promise.resolve();
  }

  private async spawnInternal(): Promise<void> {
    // A10 — probeSocket() (not isSocketLive()) here on purpose. probeSocket's
    // own doc comment is explicit: "unknown" (the 2s probe timeout, or any
    // non-ECONNREFUSED error — EACCES, ENOTSOCK, a plain file at the path)
    // has "no way to positively confirm this case is safe, so callers should
    // treat it the same as 'live'." isSocketLive() collapses "unknown" to
    // `false` for callers that want a simple boolean (its own doc comment
    // says as much) — fine for most, but wrong here: unlinkSync + a fresh
    // bootstrapMaster() below is a DESTRUCTIVE action, and a probe that
    // merely timed out under load (or hit a permissions hiccup) is not
    // evidence the master is actually gone. Treating that as "dead" deletes
    // the only handle to a genuinely running agent process, and the
    // follow-on `systemd-run` then collides with the still-active scope and
    // is rejected — orphaning the original program forever, with nothing
    // left that will ever reattach to it. reclaimSocketPath() in this same
    // module reaches the identical conclusion for the same reason (see its
    // own doc comment) — this call site now matches it instead of being the
    // one place in the codebase that guesses "unknown" means safe to delete.
    const probeResult = await probeSocket(this.socketPath);
    if (probeResult === "dead") {
      // Either this session has never run, or its master died and left a
      // stale socket file behind (dtach doesn't clean these up itself) —
      // either way, `-a` alone would fail, so bootstrap a fresh master.
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ENOENT is the expected case (no prior session at all).
      }
      await this.bootstrapMaster();
    }
    this.attachClient();
  }

  /**
   * Create the dtach master and exit — no attach, nothing to track.
   *
   * PR 32 (Wave 6) split this into two parts: buildLaunchPlan() (launch-
   * plan.ts) computes everything about WHAT gets launched — the env scrub,
   * shell-integration setup, the five MULLION_* injections, agent-guide
   * injection, hook-adapter wiring, skip-permissions handling, and
   * initial-prompt composition — and this method now does only the actual
   * process launch: wrapping that plan's argv/env in the transient
   * `systemd --user` scope below. See launch-plan.ts's own doc comments for
   * the full step-by-step reasoning that used to live inline here.
   */
  private bootstrapMaster(): Promise<void> {
    const plan = buildLaunchPlan({
      id: this.id,
      cwd: this.cwd,
      command: this.command,
      socketPath: this.socketPath,
      hookToken: this.hookToken,
      hookSocketPath: this.hookSocketPath,
      controlSocketPath: this.controlSocketPath,
      sessionsDir: this.sessionsDir,
      reviewGateEnabled: this.reviewGateEnabled,
      injectAgentGuide: this.injectAgentGuide,
      skipPermissions: this.skipPermissions,
      initialPrompt: this.initialPrompt,
    });
    this.hooksActive = plan.hooksActive;
    this.hookEmits = plan.hookEmits;

    return new Promise((resolve, reject) => {
      // Wrapped in a transient `systemd --user` scope so the master lands
      // in its OWN cgroup — never this Node process's service cgroup. Under
      // the deploy plan's systemd unit, `systemctl --user restart` uses the
      // default KillMode=control-group, which SIGTERMs every process in the
      // *service's* cgroup on every redeploy. A master spawned as a plain
      // child would die right along with it — silently defeating the whole
      // "sessions survive redeploys" premise. Verified in Milestone 1 by
      // restarting the dev server's own transient scope and confirming a
      // master started this way survives. Requires `systemd-run --user` to
      // be available, i.e. a real host with a systemd user session — not a
      // plain container, which is one more reason this runs on the host
      // (see the plan's pivotal architecture decision).
      const child = spawnChild("systemd-run", plan.argv, {
        cwd: this.cwd,
        env: plan.env,
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`master bootstrap exited with code ${code} (unit ${plan.unitName})`));
      });
    });
  }

  /** Spawn the one attach-only client this process tracks and can safely kill. */
  private attachClient(): void {
    const ptyProcess = pty.spawn(
      "dtach",
      [
        "-a",
        this.socketPath,
        // Never treat any input byte as a detach keystroke — this process
        // detaches by exiting (kill()), not via a magic character passed
        // through from the browser.
        "-E",
        // Don't let dtach intercept Ctrl-Z as a suspend either; pass it
        // through to the program like any other keystroke.
        "-z",
        // On (re)attach, ask the program to redraw via SIGWINCH rather than
        // dtach's default Ctrl-L. This is the one setting Milestone 1 exists
        // to validate empirically against a real TUI (see the plan's Risk 1) —
        // WINCH is what most resize-aware TUI frameworks already listen for,
        // whereas Ctrl-L relies on the program treating that byte specially.
        "-r",
        "winch",
      ],
      {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        // This dtach client is I/O-proxy-only (it attaches to an
        // already-running shell rather than spawning a new one), so this
        // env has no functional effect on the session's own commands. Kept
        // scrubbed for consistency with bootstrapMaster() above — see
        // session-env.ts.
        env: buildSessionEnv(),
      },
    );

    ptyProcess.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      // Skipped during a redraw-nudge repaint window — see
      // redrawNudge's docstring above. Listeners below still get it live.
      if (!this.redrawNudge.suppressingOutput) this.scrollbackBuffer.push(chunk);

      // Prepend any carry from the previous chunk so a `?1049h`/mouse-mode
      // DECSET split across two PTY reads is still recognized — detection
      // only, `data`/`chunk` above are untouched (see detectCarry's
      // docstring; feeding this into scrollback or the fan-out below would
      // duplicate the carried bytes in the replayed stream).
      const detectChunk = this.detectCarry + data;
      const altScreenSwitch = detectAltScreenSwitch(detectChunk);
      // #98: exiting alt-screen (a TUI/editor closing back to the shell
      // prompt) is itself an attention candidate — "done, awaiting input".
      // Only a genuine alt -> primary flip counts, never a chunk that
      // merely re-asserts a mode already tracked.
      let altScreenExited = false;
      if (altScreenSwitch !== null) {
        // Transition-guarded (issue #166): detectAltScreenSwitch reports the
        // switch a chunk landed on even when that's the same mode already
        // tracked (e.g. two back-to-back "enter alt" sequences with no exit
        // between them, or a chunk that happens to re-assert the current
        // mode) — only emit a status_change event on a genuine flip, so a
        // chatty program can't spam this session's 100-slot event ring
        // buffer with no-op repeats.
        const nowInAltScreen = altScreenSwitch === "alt";
        if (nowInAltScreen !== this.inAltScreen) {
          altScreenExited = this.inAltScreen && !nowInAltScreen;
          this.inAltScreen = nowInAltScreen;
          this.emitEvent("status_change", { screen: altScreenSwitch });
        }
      }
      this.mouseTracking = applyMouseModeChanges(detectChunk, this.mouseTracking);
      this.detectCarry = carryPartialEscape(detectChunk);

      // Live cwd tracking (issue: sidebar worktree display) — its own carry
      // chunk since an OSC 7 payload (a full path) is long enough that a PTY
      // read boundary landing mid-path is a real possibility, unlike the
      // short fixed-shape CSI sequences detectCarry above tracks.
      const cwdDetectChunk = this.cwdDetectCarry + data;
      const cwdChange = detectCwdChange(cwdDetectChunk);
      if (cwdChange !== null) this._liveCwd = cwdChange;
      this.cwdDetectCarry = carryPartialOsc(cwdDetectChunk);

      const now = Date.now();
      // A gap longer than STREAK_GAP_MS since the last chunk starts a new
      // activity streak — used to tell a single spawn-time prompt-draw burst
      // apart from sustained output (see toInfo()).
      if (this.lastActivityAt === null || now - this.lastActivityAt >= STREAK_GAP_MS) {
        this.activityStreakStart = now;
      }
      this.lastActivityAt = now;

      const signals = detectAttentionSignals(data);

      // #98: a working->idle TITLE transition ("program that was working
      // just became idle") is an attention candidate — only on an actual
      // title CHANGE (matches the de-dup below, and means a session that
      // never had a "working" title read to transition FROM can't false-fire
      // on its very first idle title).
      let titleWentIdle = false;
      if (signals.titleChange !== null) {
        if (signals.titleChange !== this.lastTitle) {
          // A1: only the EVENT (ring buffer/DB/WS) is debounced here — the
          // idle/working classification just below always runs off this
          // raw, un-coalesced signal, on every tick, so the #98 attention
          // transition can never be delayed or missed by the coalescing.
          // See scheduleTitleChangeEvent()'s doc comment for the full split.
          this.scheduleTitleChangeEvent(signals.titleChange);
          const newTitleActivity = classifyActivityFromTitle(signals.titleChange, this.command);
          if (this.lastTitleActivity === "working" && newTitleActivity === "idle") {
            titleWentIdle = true;
          }
          if (newTitleActivity !== null) this.lastTitleActivity = newTitleActivity;
        }
        this.lastTitle = signals.titleChange;
      }

      // Attention state machine (issue #171/#98) — feed this chunk's
      // strongest candidate signal (or, if it carries none, its mere
      // arrival as plain output) through advanceAttention(). Priority when
      // more than one signal lands in the SAME chunk (rare but possible —
      // e.g. a TUI's alt-screen exit and its title flip to idle in one
      // read): the more deliberate, zero-threshold signals win over a bare
      // bell, the noisiest of the four and exactly what PENDING_ATTENTION's
      // debounce exists to tame (see attention-detect.ts).
      let candidateKind: AttentionSignalKind | null = null;
      if (altScreenExited) candidateKind = "altScreenExit";
      else if (titleWentIdle) candidateKind = "titleIdle";
      else if (signals.notification) candidateKind = "notification";
      else if (signals.bell) candidateKind = "bell";

      // A genuine candidate signal always feeds through, even during a
      // suppressed reattach repaint (see below) — those are real, deliberate
      // program transitions, not an artifact of the repaint itself. But the
      // bare "output" input — one of two things that can CLEAR a confirmed
      // attention flag, the other being a genuine "userInput" (see write()
      // and OUTPUT_IMMUNE_KINDS's doc comment in attention-detect.ts) — must
      // NOT be fed during requestRedraw()'s synthetic dip/restore repaint:
      // that repaint is output WE caused by resizing the pty, not the
      // program resuming work, and feeding it as `{type:"output"}` would
      // clear a "needs permission" flag the instant the user merely opens
      // the workspace tab. Reuses the same redrawNudge.suppressingOutput
      // flag that gates scrollback capture one guard above — see redraw-
      // nudge.ts's own docstring for why one flag deliberately serves both.
      // Real output confirming an actual resolution still arrives once the
      // grace window ends and clears normally for output-clearable kinds —
      // but follow-up to #275 (gap #3): for an OUTPUT_IMMUNE_KINDS-confirmed
      // flag (a hook's own "needs permission"/"blocked on a decision"
      // signal), output NEVER clears it, suppressed window or not — only a
      // real "userInput" or a superseding resolution does (see
      // advanceAttention's "attention" + "output" case).
      if (candidateKind !== null) {
        this.applyAttentionTransition(
          advanceAttention(this.attentionState, { type: "signal", kind: candidateKind, now }),
        );
      } else if (!this.redrawNudge.suppressingOutput) {
        this.applyAttentionTransition(
          advanceAttention(this.attentionState, { type: "output", now }),
        );
      }

      for (const listener of this.dataListeners) listener(chunk);
    });

    ptyProcess.onExit(() => {
      this.ptyProcess = null;
      // Cancels any nudge timer still pending against this now-dead client —
      // not just for suppressingOutput tidiness, but because a stale
      // dip/restore timer left running would fire against whichever NEW
      // attach-client a later respawn creates (the closure captures `this`,
      // not the pty instance), mis-resizing an unrelated process
      // incarnation. See redraw-nudge.ts's RedrawNudge.cancel() doc comment.
      this.redrawNudge.cancel();
      // A1 (Hermes review, PR #593): kill()'s own flushTitleChangeEvent()
      // call only covers the EXPLICIT-detach path. A pty process can also
      // die on its own — a crash, or (very commonly) an agent program
      // exiting cleanly right after a final title rewrite, e.g. "Done" or
      // an error summary — and that path reaches this onExit handler
      // WITHOUT ever going through kill(). Without this call, a pending
      // debounced title_change would fire 3-15s later than it should:
      // landing after the "exited" status_change emitted just below
      // (inverting chronological order), and — if this same session is
      // reattached (getOrCreate -> spawn()) before that stale timer fires —
      // racing a brand-new incarnation's own fresh title_change events on
      // the same numeric session id. Same flush, same rationale as kill()'s
      // own call (see its doc comment); calling it again from kill()'s own
      // ptyProcess?.kill() -> onExit chain is a harmless no-op here, since
      // flushTitleChangeEvent() already cleared `pendingTitleChangeTitle`.
      this.flushTitleChangeEvent();
      // Same reasoning as detectCarry's clear in kill() below — a client can
      // also die on its own (crash, not an explicit kill()), and this exit
      // handler is the only place that path passes through before a later
      // respawn's first chunk arrives.
      this.detectCarry = "";
      // Issue #166: mirrors terminal.ts's own onExit handler, which sends a
      // `{type:"exited"}` control message to every attached browser socket
      // on this exact same event regardless of whether the client died from
      // an explicit detach (kill()) or the program genuinely exiting on its
      // own — same "attach-client death is treated uniformly" posture, kept
      // consistent here rather than trying to discriminate the two causes.
      this.emitEvent("status_change", { reason: "exited" });
      for (const listener of this.exitListeners) listener();
    });

    this.ptyProcess = ptyProcess;
    // Force a real repaint on every fresh attach — see redraw-nudge.ts's
    // own header comment for why dtach's `-r winch` redraw request above
    // isn't enough on its own for an Ink-based TUI. Runs unconditionally,
    // regardless of whether the size actually changed, so a real resize
    // from the client still lands correctly on top of it. Deliberately NOT
    // suppressCapture: true here (unlike requestRedraw() below) — this is
    // the session's actual starting screen state and is exactly what a
    // later attach should see.
    this.redrawNudge.trigger();
  }

  /**
   * Record a notification event into this session's ring buffer and fan it
   * out to live subscribers (mirrors scrollbackBuffer's own FIFO-eviction
   * shape — see ScrollbackBuffer.push() in scrollback-buffer.ts — and
   * dataListeners' fan-out shape respectively). Only ever called from
   * genuinely byte-driven (or exit-driven) transitions — see onData/onExit
   * below — or from the attention state machine's own time-based
   * confirmations (tick(), via applyAttentionTransition() below) — never
   * from a plain poll, so callers don't need their own dedup: each call
   * site already only calls this when its own tracked state actually
   * changed (advanceAttention()'s transition-guards give tick() the same
   * guarantee onData's other call sites already have).
   */
  private emitEvent(kind: NotificationEvent["kind"], payload: Record<string, unknown>): void {
    this.eventSeq += 1;
    const event: NotificationEvent = {
      seq: this.eventSeq,
      sessionId: this.numericId,
      kind,
      ts: Date.now(),
      payload,
    };
    this.events.push(event);
    if (this.events.length > EVENTS_MAX) this.events.shift();
    for (const listener of this.eventListeners) listener(event);
    // Issue #323: persist state to disk so it survives server restarts.
    // Every state change flows through emitEvent (directly or via
    // emitHookEvent), so this is the single funnel point for scheduling a
    // debounced write.
    this.stateFile.schedule();
  }

  /**
   * Apply one advanceAttention() result: adopt the new machine state, turn
   * any `log` entries into debug lines (the issue's "add debug logging on
   * attention state transitions" ask — matches this file's existing
   * console.error(...) logging shape; Session has no Fastify logger to hang
   * this off, see spawn()'s own console.error call), and turn any `emit`
   * entries into real emitEvent("attention", ...) calls. The one place
   * onData/tick() ever touch `this.attentionState` — keeps every call site
   * from having to duplicate this bookkeeping.
   */
  private applyAttentionTransition(transition: AttentionTransition): void {
    for (const entry of transition.log) {
      // Skip PENDING_ATTENTION churn (entering it from idle, or being
      // cancelled back to idle from it without ever confirming) — during
      // exactly the bursty-signal scenario issue #171 exists to fix, this
      // is by far the highest-frequency transition, and logging every one
      // would spam stdout at the same frequency this PR is suppressing
      // false positives for (console.debug bypasses pino's level filter
      // entirely — see spawn()'s console.error for why Session logs this
      // way at all). Only the meaningful edges — a signal actually
      // CONFIRMING attention, or a confirmed session actually CLEARING
      // back to idle — are worth a line.
      const isPendingChurn =
        entry.to === "pending_attention" ||
        (entry.from === "pending_attention" && entry.to === "idle");
      if (isPendingChurn) continue;
      console.debug(
        `[pty-manager] session ${this.id} attention: ${entry.from} -> ${entry.to}` +
          (entry.kind ? ` (${entry.kind})` : ""),
      );
    }
    this.attentionState = transition.next;
    // Spread into a plain object: AttentionEmit's fixed shape (no index
    // signature) doesn't structurally satisfy emitEvent's deliberately
    // loose Record<string, unknown> payload type otherwise.
    for (const emit of transition.emit) this.emitEvent("attention", { ...emit });
  }

  /**
   * Follow-up to #275 (gap #3): a delivered decision — resolveGate(),
   * resolvePromote(), or a resolved `review_gate` hook message — is a
   * superseding authoritative resolution, exactly as `userInput` is (see
   * write()), for the ONE kind of OUTPUT_IMMUNE_KINDS confirmation it
   * actually resolves. Gated on `kind` matching the CURRENT confirmedKind so
   * a decision arriving after a newer, unrelated confirmed flag has already
   * superseded it (e.g. a fresh hookNotification while a reviewGate
   * resolution is still in flight) doesn't wrongly dismiss that newer flag.
   * A no-op outside "attention" or for any other confirmedKind.
   */
  private clearIfConfirmedKind(kind: AttentionSignalKind): void {
    if (this.attentionState.state === "attention" && this.attentionState.confirmedKind === kind) {
      this.applyAttentionTransition(
        advanceAttention(this.attentionState, { type: "userInput", now: Date.now() }),
      );
    }
  }

  /** Phase 5 (Track A) — creates a registry entry on SubagentStart. Evicts
   * the oldest FINISHED entry (by endedAt) if the cap is exceeded; a
   * still-running entry is never evicted, so a runaway parent can push the
   * map briefly over MAX_TRACKED_SUBAGENTS rather than losing live state. */
  private recordSubagentStart(agentId: string, agentType: string | null, now: number): void {
    // A duplicate/retried start for an already-tracked agentId (real
    // Claude Code agent_ids are unpredictable per-instance hex strings —
    // reuse means redelivery, not a new subagent) is a no-op: overwriting
    // would reset startedAt and discard accumulated fileChanges/
    // toolFailures/eventCount, and would needlessly trigger the eviction
    // check below even though the map wouldn't actually grow (independent
    // review finding, PR #415).
    if (this.subagents.has(agentId)) return;
    if (this.subagents.size >= MAX_TRACKED_SUBAGENTS) {
      let oldestFinishedId: string | null = null;
      let oldestFinishedAt = Infinity;
      for (const [id, info] of this.subagents) {
        if (info.endedAt !== null && info.endedAt < oldestFinishedAt) {
          oldestFinishedId = id;
          oldestFinishedAt = info.endedAt;
        }
      }
      if (oldestFinishedId !== null) this.subagents.delete(oldestFinishedId);
    }
    this.subagents.set(agentId, {
      agentId,
      agentType,
      startedAt: now,
      endedAt: null,
      summary: null,
      fileChanges: 0,
      toolFailures: 0,
      eventCount: 0,
    });
  }

  /** Phase 5 (Track A) — closes a registry entry on SubagentStop. A no-op
   * if this session never saw the matching start (e.g. one that began just
   * before this process restarted) — same defensive posture as
   * subagentCount's own clamp-at-0 for the identical race. */
  private recordSubagentStop(agentId: string, summary: string | null, now: number): void {
    const entry = this.subagents.get(agentId);
    if (entry === undefined) return;
    entry.endedAt = now;
    if (summary !== null) entry.summary = summary;
  }

  /** Phase 5 (Track A) — attributes one file_change/tool_failure hook to
   * the subagent that caused it, when its agentId matches a tracked entry.
   * Silently a no-op for an unmatched agentId (orphaned by a restart, or an
   * adapter that can't supply identity at all) — this registry is additive
   * only, never a gate on the surrounding hook handling. */
  private bumpSubagentActivity(agentId: string, kind: "file_change" | "tool_failure"): void {
    const entry = this.subagents.get(agentId);
    if (entry === undefined) return;
    if (kind === "file_change") entry.fileChanges += 1;
    else entry.toolFailures += 1;
    entry.eventCount += 1;
  }

  /**
   * Routes one validated hook message (issue #173's protocol, see
   * hook-protocol.ts) into this session's notification event model (issue
   * #176) — the structured-channel counterpart of the byte-driven
   * emitEvent()/applyAttentionTransition() call sites above. `notification`
   * and `review_gate` (state "waiting") additionally drive the attention
   * state machine via emitAttentionSignalWithExtras() below, so
   * SessionInfo.attention/attentionAt — and everything that reads them
   * (Kanban's "Needs Attention" column, the sidebar's status dot) — react
   * too, not just the event feed. A future/unrecognized kind the protocol
   * layer already accepts verbatim (extensibility) is likewise a no-op here
   * until a later phase teaches this method about it.
   */
  /**
   * PR 33a (Wave 6) — builds the narrow `SessionHookContext` facade the
   * HOOK_HANDLERS table (hook-handlers.ts) operates over, one per
   * emitHookEvent() call. A plain `this` can't be passed directly: Session's
   * state fields/methods below are `private`, and TypeScript refuses to
   * assign a class instance to a structurally-matching external interface
   * when the class has private members the interface doesn't know about
   * (confirmed empirically — `Session` is "not assignable" to
   * `SessionHookContext` with `this` passed raw). Each accessor here is a
   * thin proxy onto the real private field/method — this is the ONE place
   * that boundary is crossed, so every handler in hook-handlers.ts stays
   * provably scoped to just what's declared on SessionHookContext, not
   * Session's full surface.
   */
  private buildHookContext(): SessionHookContext {
    // The object literal's own get/set accessors below each have their OWN
    // dynamic `this` (bound to the ctx object itself, not this Session) —
    // an arrow function is the only way to close over the real Session
    // instance from inside them, hence capturing it under a plain name here.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get id() {
        return self.id;
      },
      get cwd() {
        return self.cwd;
      },
      get liveCwd() {
        return self._liveCwd;
      },
      set liveCwd(v: string | null) {
        self._liveCwd = v;
      },
      get liveBranch() {
        return self._liveBranch;
      },
      set liveBranch(v: string | null) {
        self._liveBranch = v;
      },
      get fileChangeQueue() {
        return self.fileChangeQueue;
      },
      set fileChangeQueue(v: Promise<void>) {
        self.fileChangeQueue = v;
      },
      get gitIgnoreDirCache() {
        return self.gitIgnoreDirCache;
      },
      get gateState() {
        return self.gateState;
      },
      set gateState(v) {
        self.gateState = v;
      },
      get gatePrompt() {
        return self.gatePrompt;
      },
      set gatePrompt(v) {
        self.gatePrompt = v;
      },
      get gateAt() {
        return self.gateAt;
      },
      set gateAt(v) {
        self.gateAt = v;
      },
      get promoteState() {
        return self.promoteState;
      },
      set promoteState(v) {
        self.promoteState = v;
      },
      get promoteSummary() {
        return self.promoteSummary;
      },
      set promoteSummary(v) {
        self.promoteSummary = v;
      },
      get promoteSuggestedBaseRef() {
        return self.promoteSuggestedBaseRef;
      },
      set promoteSuggestedBaseRef(v) {
        self.promoteSuggestedBaseRef = v;
      },
      get promoteAt() {
        return self.promoteAt;
      },
      set promoteAt(v) {
        self.promoteAt = v;
      },
      get permissionState() {
        return self.permissionState;
      },
      set permissionState(v) {
        self.permissionState = v;
      },
      get permissionAt() {
        return self.permissionAt;
      },
      set permissionAt(v) {
        self.permissionAt = v;
      },
      get pendingPermissionTool() {
        return self.pendingPermissionTool;
      },
      set pendingPermissionTool(v) {
        self.pendingPermissionTool = v;
      },
      get planState() {
        return self.planState;
      },
      set planState(v) {
        self.planState = v;
      },
      get planAt() {
        return self.planAt;
      },
      set planAt(v) {
        self.planAt = v;
      },
      get questionState() {
        return self.questionState;
      },
      set questionState(v) {
        self.questionState = v;
      },
      get questionHeader() {
        return self.questionHeader;
      },
      set questionHeader(v) {
        self.questionHeader = v;
      },
      get questionAt() {
        return self.questionAt;
      },
      set questionAt(v) {
        self.questionAt = v;
      },
      get elicitationState() {
        return self.elicitationState;
      },
      set elicitationState(v) {
        self.elicitationState = v;
      },
      get elicitationServer() {
        return self.elicitationServer;
      },
      set elicitationServer(v) {
        self.elicitationServer = v;
      },
      get elicitationAt() {
        return self.elicitationAt;
      },
      set elicitationAt(v) {
        self.elicitationAt = v;
      },
      get errorState() {
        return self.errorState;
      },
      set errorState(v) {
        self.errorState = v;
      },
      get errorAt() {
        return self.errorAt;
      },
      set errorAt(v) {
        self.errorAt = v;
      },
      get errorDetail() {
        return self.errorDetail;
      },
      set errorDetail(v) {
        self.errorDetail = v;
      },
      get lastAssistantMessage() {
        return self.lastAssistantMessage;
      },
      set lastAssistantMessage(v) {
        self.lastAssistantMessage = v;
      },
      get lastTurnEndedAt() {
        return self.lastTurnEndedAt;
      },
      set lastTurnEndedAt(v) {
        self.lastTurnEndedAt = v;
      },
      get turnEndPingSent() {
        return self.turnEndPingSent;
      },
      set turnEndPingSent(v) {
        self.turnEndPingSent = v;
      },
      get backgroundTasks() {
        return self.backgroundTasks;
      },
      set backgroundTasks(v) {
        self.backgroundTasks = v;
      },
      get backgroundTasksAt() {
        return self.backgroundTasksAt;
      },
      set backgroundTasksAt(v) {
        self.backgroundTasksAt = v;
      },
      get compactState() {
        return self.compactState;
      },
      set compactState(v) {
        self.compactState = v;
      },
      get compactAt() {
        return self.compactAt;
      },
      set compactAt(v) {
        self.compactAt = v;
      },
      get subagentCount() {
        return self.subagentCount;
      },
      set subagentCount(v) {
        self.subagentCount = v;
      },
      get subagentCountAt() {
        return self.subagentCountAt;
      },
      set subagentCountAt(v) {
        self.subagentCountAt = v;
      },
      get endedReason() {
        return self.endedReason;
      },
      set endedReason(v) {
        self.endedReason = v;
      },
      get exitCode() {
        return self.exitCode;
      },
      set exitCode(v) {
        self.exitCode = v;
      },
      emitEvent: (kind, payload) => self.emitEvent(kind, payload),
      emitAttentionSignalWithExtras: (kind, extras) =>
        self.emitAttentionSignalWithExtras(kind, extras),
      clearIfConfirmedKind: (kind) => self.clearIfConfirmedKind(kind),
      resolveDeferredTurnEnd: () => self.resolveDeferredTurnEnd(),
      setBackgroundTasks: (tasks) => self.setBackgroundTasks(tasks),
      bumpSubagentActivity: (agentId, kind) => self.bumpSubagentActivity(agentId, kind),
      recordSubagentStart: (agentId, agentType, now) =>
        self.recordSubagentStart(agentId, agentType, now),
      recordSubagentStop: (agentId, summary, now) => self.recordSubagentStop(agentId, summary, now),
    };
  }

  emitHookEvent(message: HookMessage): void {
    // Follow-up to #275 (gap #1): ANY delivered hook message — not just
    // "progress"/"done" — proves this session's hook pipeline genuinely
    // fires, so this latches unconditionally before the switch, ahead of
    // every case's own early `return`. See `hooksProven`'s field doc for why
    // this can't be the ONLY place it latches (Claude Code's own first hook,
    // SessionStart, never reaches this method at all — see markHooksProven).
    this.hooksProven = true;
    // PR 33a (Wave 6) — HOOK_HANDLERS (hook-handlers.ts) is populated one
    // case at a time as the roadmap's "one case per commit" migration
    // proceeds; a kind already migrated dispatches here and returns, a kind
    // still on the switch below falls through unchanged. Once every case has
    // migrated, this table lookup is this method's entire body and the
    // switch is deleted (tracked as the final commit of this migration).
    const handler = HOOK_HANDLERS.get(message.kind);
    if (handler) {
      handler(this.buildHookContext(), message);
      return;
    }
    switch (message.kind) {
      case "stop_failure": {
        const sf = message as StopFailureHookMessage;
        this.errorState = "api_error";
        this.errorAt = Date.now();
        // Rich statuses — the short, stable label (see errorType's doc
        // comment in hook-protocol.ts), falling back to the free-text detail
        // when the adapter couldn't classify the failure.
        this.errorDetail = sf.errorType ?? sf.errorDetails ?? null;
        this.emitEvent("stop_failure", { error: sf.error, errorDetails: sf.errorDetails ?? null });
        this.emitAttentionSignalWithExtras("hookNotification", {
          title: "API Error",
          body: sf.error,
        });
        return;
      }
      case "tool_failure": {
        const tf = message as ToolFailureHookMessage;
        this.errorState = "tool_failure";
        this.errorAt = Date.now();
        // Rich statuses — prefer the adapter's own summary; fall back to
        // just naming the failing tool.
        this.errorDetail = tf.summary ?? tf.tool;
        // Phase 5 (Track A) — attribute to the subagent that hit this
        // failure, if the hook carried one.
        if (tf.agentId !== undefined) this.bumpSubagentActivity(tf.agentId, "tool_failure");
        this.emitEvent("tool_failure", {
          tool: tf.tool,
          error: tf.error,
          summary: tf.summary ?? null,
          agentId: tf.agentId ?? null,
        });
        this.emitAttentionSignalWithExtras("hookNotification", {
          title: `Tool failed: ${tf.tool}`,
          body: tf.error,
        });
        return;
      }
      case "session_end": {
        const se = message as SessionEndHookMessage;
        this.endedReason = se.reason;
        this.exitCode = se.exitCode ?? null;
        this.emitEvent("session_end", { reason: se.reason, exitCode: se.exitCode ?? null });
        return;
      }
      case "plan_ready": {
        const plan = message as PlanReadyHookMessage;
        this.planState = "pending";
        this.planAt = Date.now();
        this.emitEvent("plan_ready", {
          plan: plan.plan,
          filePath: plan.filePath ?? null,
          summary: plan.summary ?? null,
        });
        this.emitAttentionSignalWithExtras("planReady", {
          summary: plan.summary ?? plan.plan.slice(0, 100),
        });
        return;
      }
      case "git_branch": {
        // Issue: sidebar worktree detection — an agent reports its current
        // branch (opencode's vcs.branch.updated, or a Bash tool intercept
        // detecting git worktree add from any agent). Same TS-narrowing
        // reasoning as the review_gate case above.
        const gitBranch = message as GitBranchHookMessage;
        this._liveBranch = gitBranch.branch;
        // When the hook also carries a worktree path, update _liveCwd so
        // the cwd-resolution pipeline (resolveSessionCwdTargets,
        // getGitStatus) can resolve the branch from the worktree's actual
        // git state on the next poll cycle.
        if (gitBranch.worktree && gitBranch.worktree !== this._liveCwd) {
          this._liveCwd = gitBranch.worktree;
        }
        this.emitEvent("status_change", { phase: "done" });
        return;
      }
      case "cwd_changed": {
        // Issue: sidebar worktree detection — an agent reports a working
        // directory change via structured hooks instead of OSC 7 (Claude
        // Code's CwdChanged, agy's PreToolUse Cwd, Codex's common cwd).
        // Update _liveCwd so the cwd-resolution pipeline (resolveSessionCwdTargets,
        // readGitBranch, getGitStatus) picks up the new location. Emit a
        // status_change event so consumers don't need to wait for the next
        // polling cycle to see the updated directory.
        const cwdMsg = message as CwdChangedHookMessage;
        if (cwdMsg.cwd !== this._liveCwd) {
          this._liveCwd = cwdMsg.cwd;
          this.emitEvent("status_change", { phase: "done" });
        }
        return;
      }
      case "turn_start": {
        // Issue: extend surfaced session statuses — a deterministic "a new
        // turn genuinely started" signal (Claude Code's UserPromptSubmit,
        // remapped — see forwarder-core.mjs). Releases every observational
        // "awaiting_*" latch and the `finished` latch, same set
        // progress:done already releases (permissionState/planState) plus
        // the ones only this event can authoritatively clear
        // (elicitationState, lastTurnEndedAt). Mirrors progress:done's own
        // choice NOT to force-clear the attention machine's confirmedKind
        // directly — see that case's own comment for why (moreAuthoritativeKind
        // already keeps an immune kind from being silently downgraded;
        // session-status.ts's precedence order is what actually protects
        // against a stale confirmedKind here, not an explicit clear).
        this.permissionState = "idle";
        this.permissionAt = null;
        this.pendingPermissionTool = null;
        this.planState = "idle";
        this.planAt = null;
        this.elicitationState = "idle";
        this.elicitationServer = null;
        this.elicitationAt = null;
        this.questionState = "idle";
        this.questionHeader = null;
        this.questionAt = null;
        this.errorState = "idle";
        this.errorAt = null;
        this.errorDetail = null;
        this.lastTurnEndedAt = null;
        this.turnEndPingSent = false;
        // Issue #428 — a new turn invalidates the previous Stop's
        // backgroundTasks snapshot; Claude Code re-sends the full list on
        // the next Stop regardless, so there's nothing to preserve here.
        this.backgroundTasks = [];
        this.backgroundTasksAt = null;
        this.emitEvent("status_change", { phase: "generating" });
        return;
      }
      case "compact": {
        const compact = message as CompactHookMessage;
        this.compactState = compact.state === "started" ? "compacting" : "idle";
        if (compact.state === "started") {
          this.compactAt = Date.now();
        } else {
          this.compactAt = null;
        }
        this.emitEvent("status_change", {
          compacting: this.compactState === "compacting",
          trigger: compact.trigger ?? null,
        });
        return;
      }
      case "subagent": {
        const subagent = message as SubagentHookMessage;
        // Clamped at 0 defensively — a SubagentStop this session never saw a
        // matching SubagentStart for (e.g. one that started just before this
        // process restarted) must not drive the count negative.
        this.subagentCount = Math.max(
          0,
          this.subagentCount + (subagent.state === "started" ? 1 : -1),
        );
        if (subagent.state === "started" && this.subagentCount > 0) {
          this.subagentCountAt = Date.now();
        } else if (subagent.state !== "started" && this.subagentCount === 0) {
          this.subagentCountAt = null;
        }
        // Phase 5 (Track A) — the registry is purely additive: it's only
        // populated when the hook carried an agentId (OpenCode's own
        // "subagent" events never do), so subagentCount above stays the
        // authoritative running count regardless of registry coverage.
        if (subagent.agentId !== undefined) {
          if (subagent.state === "started") {
            this.recordSubagentStart(subagent.agentId, subagent.agentType ?? null, Date.now());
          } else {
            this.recordSubagentStop(subagent.agentId, subagent.summary ?? null, Date.now());
          }
        }
        const subagentExtras: Record<string, unknown> = {
          subagentCount: this.subagentCount,
          agentType: subagent.agentType ?? null,
          agentId: subagent.agentId ?? null,
          // Named distinctly from the stale-blocked-clear branch's own
          // `state: "subagentCount"` (which names the FIELD that was
          // cleared, not a transition) — this one is the subagent's own
          // started/finished transition, so eventDescriptions.ts can
          // render it without the two meanings colliding on one key.
          subagentState: subagent.state,
        };
        // Issue #428 — SubagentStop is the ONLY drain signal for a
        // background subagent's own outstanding work: the parent's turn has
        // already ended by the time this fires (that's the whole point of a
        // background Agent/Task call), so no further "progress" message
        // will ever report the list shrinking. Same present-only-update
        // guard as the "progress" case — and the same reason
        // resolveDeferredTurnEnd() is called ONLY inside this guard, not
        // unconditionally for every subagent message: a plain
        // "started"/"finished" event with no backgroundTasks field (the
        // ordinary case) changes nothing about outstanding work, so calling
        // it unconditionally would re-fire `agentIdle` for an
        // already-resolved turn end the moment any unrelated subagent
        // activity arrives afterward (Hermes review, PR #453).
        let carriesBackgroundTasks = false;
        if (subagent.backgroundTasks !== undefined) {
          carriesBackgroundTasks = true;
          subagentExtras.backgroundTasks = subagent.backgroundTasks;
          this.setBackgroundTasks(subagent.backgroundTasks);
        }
        this.emitEvent("status_change", subagentExtras);
        if (carriesBackgroundTasks) this.resolveDeferredTurnEnd();
        return;
      }
      case "elicitation": {
        const elicitation = message as ElicitationHookMessage;
        if (elicitation.state === "started") {
          this.elicitationState = "pending";
          this.elicitationAt = Date.now();
          this.elicitationServer = elicitation.server ?? null;
          this.emitEvent("elicitation", { state: "started", server: elicitation.server ?? null });
          this.emitAttentionSignalWithExtras("elicitation", { server: elicitation.server ?? null });
        } else {
          this.elicitationState = "idle";
          this.elicitationServer = null;
          this.elicitationAt = null;
          this.emitEvent("elicitation", { state: "finished" });
          // Same "resolution over the hook channel itself is as
          // authoritative as a REST decision" reasoning as review_gate's own
          // non-waiting branch above.
          this.clearIfConfirmedKind("elicitation");
        }
        return;
      }
      case "question": {
        const q = message as QuestionHookMessage;
        if (q.state === "started") {
          this.questionState = "pending";
          this.questionHeader = q.header ?? null;
          this.questionAt = Date.now();
          this.emitEvent("question", {
            state: "started",
            header: q.header ?? null,
            summary: q.summary ?? null,
          });
          this.emitAttentionSignalWithExtras("question", { header: q.header ?? null });
        } else {
          this.questionState = "idle";
          this.questionHeader = null;
          this.questionAt = null;
          this.emitEvent("question", { state: "finished" });
          this.clearIfConfirmedKind("question");
        }
        return;
      }
      case "todo": {
        const todo = message as TodoHookMessage;
        this.emitEvent("todo", {
          content: todo.content,
          status: todo.status,
          priority: todo.priority,
        });
        return;
      }
      case "session_diff": {
        const sd = message as SessionDiffHookMessage;
        this.emitEvent("session_diff", { files: sd.files });
        return;
      }
      case "permission_resolved":
        // See PermissionResolvedHookMessage's doc comment (hook-protocol.ts)
        // — a possible EXTRA release path for a pending permission_request,
        // never asserted as the only one (Claude Code's PermissionDenied can
        // fire with no preceding PermissionRequest at all, per its own
        // docs). Safe to clear unconditionally either way: if nothing was
        // pending, this is a no-op.
        this.permissionState = "idle";
        this.permissionAt = null;
        this.pendingPermissionTool = null;
        this.clearIfConfirmedKind("permissionRequest");
        return;
      case "plan_resolved":
        this.planState = "idle";
        this.planAt = null;
        this.clearIfConfirmedKind("planReady");
        return;
      case "tool_done": {
        // Fix: status-clearing-semantics — a completed tool call is forward-
        // progress evidence: it means the agent is running again, which
        // clears a stale errorState (same "the agent recovered" reasoning
        // the "progress" case above already applies), and — matched by tool
        // NAME, since Claude Code has no dedicated "permission granted" hook
        // — can release a pending permission/plan that was waiting on THIS
        // tool specifically.
        //
        // Deliberately NOT a release for gateState/promoteState (Mullion's
        // own dialogs, resolved over REST — see resolveGate/resolvePromote)
        // or elicitationState (already correctly resolved by
        // ElicitationResult — see that case above); touching either here
        // would be premature, since the agent can genuinely still be
        // parked inside one of those while an unrelated tool_done arrives.
        const td = message as ToolDoneHookMessage;
        let changed = false;
        if (this.errorState !== "idle") {
          this.errorState = "idle";
          this.errorAt = null;
          this.errorDetail = null;
          changed = true;
        }
        // Tool-name matching, not a request id (the hook payloads don't
        // carry one). Accepted residual edge: two same-named tools in one
        // parallel batch (e.g. two concurrent Bash calls, one awaiting
        // permission, one completing) can release early. Narrowing further
        // would need a permission-request id Claude Code doesn't send.
        if (
          this.permissionState === "pending" &&
          (this.pendingPermissionTool === null || this.pendingPermissionTool === td.tool)
        ) {
          this.permissionState = "idle";
          this.permissionAt = null;
          this.pendingPermissionTool = null;
          this.clearIfConfirmedKind("permissionRequest");
          changed = true;
        }
        // ExitPlanMode resolving its own plan is the release path — see the
        // PostToolUse matcher's own comment in hook-adapters/claude-code.ts
        // for why this is unverified as an actual Claude Code behavior; the
        // progress:done release above still backstops planState regardless.
        if (td.tool === "ExitPlanMode" && this.planState === "pending") {
          this.planState = "idle";
          this.planAt = null;
          this.clearIfConfirmedKind("planReady");
          changed = true;
        }
        if (changed) this.emitEvent("status_change", { reason: "tool_done", tool: td.tool });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Follow-up to #275 (gap #1): latches `hooksProven` for the one hook kind
   * that bypasses emitHookEvent entirely — `session_start`, answered inline
   * by hooks.ts because it needs `app.pty.consumeSeed`, which this
   * Session-scoped class has no access to (see the `session_start` case
   * above). Without this, a freshly-spawned Claude Code session would stay
   * UNPROVEN through its own startup splash render — its genuinely-first
   * hook at cold start — re-opening the exact false positive #275 fixed
   * (see `hooksProven`'s field doc). Idempotent, like the latch itself.
   */
  markHooksProven(): void {
    this.hooksProven = true;
  }

  /**
   * Resolves a pending review gate (issue #178) — called from
   * PtyManager.resolveGate, itself called from hooks.ts once a real decision
   * exists (either POST /api/sessions/:id/review-gate, or hooks.ts's own
   * server-side gate timeout). Deliberately NOT driven by another incoming
   * hook message: the forwarder that receives this decision prints it
   * straight to the agent's stdout and exits — it never sends a follow-up
   * `review_gate` line of its own — so this is the one place gateState
   * transitions out of "waiting". Emits a `review_gate` event carrying the
   * resolved state (and `reason` for a denial) so the event feed/timeline
   * shows the outcome, not just the original prompt. Follow-up to #275 (gap
   * #3): DOES force-clear the attention state machine now, via
   * clearIfConfirmedKind — a confirmed `reviewGate` is output-immune, so
   * unlike before this hardening pass, the tool call's own PTY output no
   * longer clears it on its own; a decision made through this web-UI path
   * produces no terminal keystroke for write()'s "userInput" clear to catch
   * either, so this is the only remaining path that resolves it.
   */
  resolveGate(decision: "approved" | "denied", reason?: string): void {
    this.gateState = decision;
    this.gatePrompt = null;
    this.gateAt = null;
    this.emitEvent("review_gate", { state: decision, ...(reason !== undefined ? { reason } : {}) });
    this.clearIfConfirmedKind("reviewGate");
  }

  /**
   * Resolves a pending promote request (issue #271) — called from
   * PtyManager.resolvePromote, itself called from hooks.ts's
   * app.resolvePendingPromote once POST /api/sessions/:id/promote or
   * .../promote/decline delivers a real decision. Same "not driven by
   * another incoming hook message" reasoning as resolveGate above: the
   * `promote_to_worktree` MCP tool call this unblocks prints its own result
   * and returns, it never sends a follow-up `promote_request` line. Follow-up
   * to #275 (gap #3): force-clears the attention state machine the same way
   * resolveGate does now, for the same reason — see that method's doc
   * comment.
   */
  resolvePromote(decision: "accepted" | "declined"): void {
    this.promoteState = decision;
    this.promoteSummary = null;
    this.promoteSuggestedBaseRef = null;
    this.promoteAt = null;
    this.emitEvent("promote_request", { state: decision });
    this.clearIfConfirmedKind("promoteRequest");
  }

  /**
   * Issue #404 — scans this session's scrollback for a dev-server banner
   * (dev-server-detect.ts's parseDevServerPort) and, if a NEW port not
   * already offered/dismissed this session's in-process lifetime is found,
   * latches it as `pendingDevServerPort` and emits a `dev_server_detected`
   * event carrying it. Callers are expected to only call this for a session
   * already confirmed eligible (kind !== "dock", project has no
   * devServerUrl set yet) — see PtyManager.sweepDevServerDetection's own doc
   * comment for where that DB-derived eligibility check actually lives
   * (Session itself has no DB access, same as every other in-memory field
   * here). `projectId` is passed in by the caller rather than read off
   * `this.projectId`, since the latter is only reliably populated for a
   * session spawned fresh in this process's own lifetime (see
   * session-lifecycle.ts's createSessionRecord) — a session reattached via
   * /ws/terminal after a restart never threads it through — while the
   * caller's own DB query (joining sessions -> projects) always has the
   * real value.
   *
   * Returns the port when a new event was actually emitted, else null (no
   * banner found yet, or this exact port was already handled).
   */
  detectDevServerPort(projectId: number | null): string | null {
    const port = detectDevServerPortForPlainSession(this);
    if (!port || this.handledDevServerPorts.has(port)) return null;
    this.handledDevServerPorts.add(port);
    this.pendingDevServerPort = port;
    this.emitEvent("dev_server_detected", { port, projectId });
    return port;
  }

  /**
   * Issue #404 — accepts a pending dev-server offer for `port`, called from
   * POST /api/sessions/:id/dev-server/accept once the route has patched the
   * project's devServerUrl (and created/reused its preview). Validates
   * against this session's OWN `pendingDevServerPort` rather than trusting
   * an arbitrary client-supplied port — returns false (the route 409s) when
   * it doesn't match: already resolved elsewhere, a stale port from a
   * dev-server restart since the offer was made, or a port that was never
   * actually offered. Leaves the port in `handledDevServerPorts` (never
   * removed) so a re-printed banner for the SAME port doesn't re-offer.
   */
  acceptDevServerPort(port: string): boolean {
    if (this.pendingDevServerPort !== port) return false;
    this.pendingDevServerPort = null;
    this.emitEvent("dev_server_detected", { port, projectId: this.projectId, state: "accepted" });
    return true;
  }

  /**
   * Issue #404 — dismisses a pending dev-server offer for `port`, called
   * from POST /api/sessions/:id/dev-server/dismiss. Same validation posture
   * as acceptDevServerPort above (matches against the session's own live
   * `pendingDevServerPort`, not a trusted client value). The port stays in
   * `handledDevServerPorts` — that's what suppresses the SAME port from
   * being re-offered after a dismiss, per issue #404's "don't re-offer
   * after a dismiss" requirement.
   */
  dismissDevServerPort(port: string): boolean {
    if (this.pendingDevServerPort !== port) return false;
    this.pendingDevServerPort = null;
    this.emitEvent("dev_server_detected", { port, projectId: this.projectId, state: "dismissed" });
    return true;
  }

  /**
   * Drives the attention state machine with a zero-threshold hook signal
   * (hookNotification/reviewGate — see ATTENTION_CONFIRM_MS) to keep
   * `attentionState`/`SessionInfo.attention` correct, and unconditionally
   * emits an "attention" event with `extras` merged into its payload —
   * deliberately NOT gated on whether the transition itself produced a new
   * `emit` entry. confirmAttention()'s `alreadyConfirmed` guard suppresses
   * emitting again when attention was already confirmed, which is correct
   * for the generic, content-free PTY-parsed signals applyAttentionTransition()
   * handles (a second bell while already confirmed is genuinely nothing
   * new) — but a hook notification's title/body (or a review_gate's prompt)
   * is never "nothing new": each one is distinct content the event feed
   * must surface even if the boolean itself was already true. Deliberately
   * does NOT go through applyAttentionTransition() above for this reason,
   * and also because AttentionEmit's fixed `{attention, signal}` shape has
   * no room for title/body/prompt anyway — threading hook-specific display
   * text through the otherwise-pure, byte-driven attention state machine
   * isn't worth it for two call sites. Skips the console.debug transition
   * logging applyAttentionTransition() does (kept only on the byte-driven
   * path). `agentIdle` reuses this same call site (rather than getting its
   * own): it carries no title/body/prompt of its own, but "the agent just
   * finished" is exactly as one-shot/deliberate as a hook notification or
   * review gate, so the same always-emit semantics apply — though unlike
   * `hookNotification`/`reviewGate`/`promoteRequest`, `agentIdle` is NOT one
   * of attention-detect.ts's OUTPUT_IMMUNE_KINDS (follow-up to #275, gap #3):
   * it stays output-clearable, since it's purely informational ("turn over")
   * rather than "blocked pending a human decision", and it's the only
   * attention trigger opencode/codex/agy have at all.
   */
  private emitAttentionSignalWithExtras(
    kind: Extract<
      AttentionSignalKind,
      | "hookNotification"
      | "reviewGate"
      | "agentIdle"
      | "promoteRequest"
      | "permissionRequest"
      | "planReady"
      | "elicitation"
      | "question"
    >,
    extras: Record<string, unknown>,
  ): void {
    const transition = advanceAttention(this.attentionState, {
      type: "signal",
      kind,
      now: Date.now(),
    });
    this.attentionState = transition.next;
    this.emitEvent("attention", { attention: true, signal: kind, ...extras });
  }

  /** Issue #428 — the ONLY place `backgroundTasks`/`backgroundTasksAt` are
   * written. Called from both the "progress" and "subagent" hook cases,
   * each with their own present-only-update guard around the call (a
   * message with no `backgroundTasks` field must leave a previously-latched
   * outstanding set untouched). Re-stamps `backgroundTasksAt` on every call
   * that still has outstanding work, matching subagentCountAt's own
   * re-stamp-on-every-start (not just the initial idle -> busy transition)
   * precedent — the staleness sweep's silence window should reset on each
   * fresh report, not just the first. */
  private setBackgroundTasks(tasks: BackgroundTask[]): void {
    this.backgroundTasks = tasks;
    this.backgroundTasksAt = filterOutstandingBackgroundTasks(tasks).length > 0 ? Date.now() : null;
  }

  /** Issue #428 — fires the deferred "turn really is over" attention ping.
   * `progress:done` always latches `lastTurnEndedAt` (see its own doc
   * comment: that stays an honest "the Stop hook fired" signal regardless
   * of outstanding background work), but firing `agentIdle` right then would
   * be the premature ping issue #428 is about, when a background
   * `Agent`/`Task` call from this same turn hasn't returned yet. No-op
   * unless the turn has already ended, nothing outstanding remains, AND the
   * ping for THIS latch hasn't already fired (`turnEndPingSent` — see its
   * own doc comment; Hermes review, PR #453) — safe to call unconditionally
   * after any `backgroundTasks` update (a plain Stop with no background work
   * resolves it immediately; a SubagentStop or the staleness sweep resolves
   * it late instead of never; a repeated report of the same already-drained
   * state is a no-op instead of a duplicate ping). */
  private resolveDeferredTurnEnd(): void {
    if (this.lastTurnEndedAt === null) return;
    if (this.turnEndPingSent) return;
    if (filterOutstandingBackgroundTasks(this.backgroundTasks).length > 0) return;
    this.turnEndPingSent = true;
    this.emitAttentionSignalWithExtras("agentIdle", {});
  }

  /**
   * The attention state machine's time-based half (issue #171/#98) — called
   * periodically by PtyManager's own evaluator interval (see
   * ATTENTION_EVAL_INTERVAL_MS), never from onData. Two independent checks:
   *
   * 1. Promote a still-PENDING_ATTENTION signal to ATTENTION once it's gone
   *    uncontradicted long enough (advanceAttention's "tick" input) — the
   *    ONLY way a nonzero-threshold signal (bell/notification) ever
   *    confirms when the program stays genuinely silent afterward; nothing
   *    byte-driven would ever re-check it.
   * 2. The #98 "sustained silence after work" signal: a session that had a
   *    real, sustained activity streak (same `sustained` computation
   *    toInfo() uses) and has since gone quiet for at least SUSTAINED_SILENCE_MS
   *    (or HOOK_FALLBACK_SILENCE_MS — see below) raises a zero-threshold
   *    "silence" candidate. Gated to `attentionState.state === "idle"` — if a
   *    signal is already pending or confirmed, that already covers
   *    "something's up", and (2) running AFTER (1) in the same tick() call
   *    means this reads already-updated state rather than racing it.
   *    The required silence duration depends on `this.hooksActive`: a
   *    session whose command matched a real hook adapter (Claude Code/
   *    opencode/codex/agy) normally gets its "turn is over" signal
   *    authoritatively from that agent's own Stop/session.idle hook (routed
   *    to the `agentIdle` signal by emitHookEvent's "progress"/"done" case)
   *    — the byte guess here can't tell a real "went quiet after work" apart
   *    from the SAME agent's own multi-chunk startup splash render on a
   *    brand-new, never-touched terminal, which is indistinguishable in
   *    bytes alone at SUSTAINED_SILENCE_MS's short timescale. So a
   *    `hooksActive` session raises this signal only after the much longer
   *    HOOK_FALLBACK_SILENCE_MS — a bound no legitimate startup render comes
   *    close to — as a safety net for a hook pipeline that died or wedged
   *    (killed agent process, crashed forwarder, socket that never
   *    connected) rather than genuinely finishing quietly. Hookless sessions
   *    (plain shells, unrecognized commands) have no authoritative signal at
   *    all, so they always use the short SUSTAINED_SILENCE_MS bound. Any
   *    `hooksActive` session — proven or not — uses the 60s watchdog. The
   *    prior `hooksProven` gate (gap #1) caused a "needs input" cycle when
   *    Mullion restarted and `hooksProven` (in-memory only) was lost: the 10s
   *    fast bound fired repeatedly between turns while waiting for the hook
   *    pipeline to re-prove itself. A matched-but-never-proven session that
   *    truly stays silent for 60s (dead hook pipeline) still gets the signal
   *    — just without the 10s false-alarm tempo that made it feel permanently
   *    stuck.
   *
   * `now` is a parameter (defaulting to Date.now()) rather than read
   * unconditionally inside, purely so tests can call this directly with a
   * synthetic clock instead of needing fake real timers — see
   * test/services/pty-manager.test.ts.
   */
  tick(now: number = Date.now()): void {
    this.applyAttentionTransition(advanceAttention(this.attentionState, { type: "tick", now }));

    const hadSustainedStreak =
      this.activityStreakStart !== null &&
      this.lastActivityAt !== null &&
      this.lastActivityAt - this.activityStreakStart >= SUSTAIN_MS;
    const requiredSilenceMs = this.hooksActive ? HOOK_FALLBACK_SILENCE_MS : SUSTAINED_SILENCE_MS;
    const silentLongEnough =
      this.lastActivityAt !== null && now - this.lastActivityAt >= requiredSilenceMs;

    if (this.attentionState.state === "idle" && hadSustainedStreak && silentLongEnough) {
      this.applyAttentionTransition(
        advanceAttention(this.attentionState, { type: "signal", kind: "silence", now }),
      );
    }
  }

  /** Subscribe to this session's own notification events as they're emitted
   * — mirrors onData()/onExit()'s Set<listener> + unsubscribe-closure shape.
   * PtyManager (below) is the only caller: it subscribes once per session
   * (in getOrCreate) and re-emits through its own manager-level onEvent()
   * fan-out, the same one-layer-up relationship dataListeners has to
   * routes/terminal.ts's per-session subscriptions — except here the
   * manager itself is the aggregation point, not each route call. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Everything currently buffered for this session, oldest first — replay
   * this (alongside every other tracked session's own buffer) to a newly
   * connecting /ws/events client. Mirrors getScrollback()'s "replay on
   * connect" role, just for structured events instead of raw bytes. */
  getEvents(): NotificationEvent[] {
    return [...this.events];
  }

  /** Advance this session's read cursor to `seq` (a no-op if `seq` is behind
   * the cursor already — e.g. a duplicate or out-of-order "seen" message).
   * Never rejects an out-of-range seq outright: a client-supplied cursor
   * ahead of what this process has ever emitted (e.g. right after a
   * restart wiped the in-memory ring buffer but the client's own
   * last-known seq survived) is harmless to just accept. */
  markEventsSeen(seq: number): void {
    if (seq > this.lastSeenSeq) this.lastSeenSeq = seq;
  }

  /**
   * Everything currently buffered, oldest first, prefixed with a preamble
   * synthesized from tracked alt-screen and mouse-tracking state — replay
   * this to a newly-attaching client. The alt-screen half of the preamble is
   * unconditional (even against an empty buffer) so a freshly-connecting
   * xterm.js always lands in the correct mode rather than whatever it
   * happened to default to; forcing primary when already in primary, or alt
   * when already in alt, is a no-op escape sequence either way. See
   * inAltScreen's docstring for why this can't just trust the buffered bytes
   * themselves to be self-balanced.
   *
   * The mouse-tracking half is appended only when tracked state isn't the
   * default (protocol "NONE" / encoding "DEFAULT") — unlike alt-screen mode,
   * xterm.js's own default already IS "no tracking," so there's nothing to
   * force when that's also the tracked truth; this also keeps the emitted
   * bytes identical to before this mechanism existed for the common
   * untracked case. Order (alt-screen, then protocol, then encoding) isn't
   * load-bearing — these are independent xterm.js subsystems (?1049 never
   * touches CoreMouseService) — chosen only to match typical program emit
   * order. See MouseTrackingState's docstring in attention-detect.ts for why
   * this exists (issue #93).
   *
   * The preamble is synthesized here (not in ScrollbackBuffer) because it
   * depends on inAltScreen/mouseTracking — Session-level state that's read
   * and written by more than just scrollback replay (see this class's
   * inAltScreen field doc, and scrollback-buffer.ts's own header comment,
   * for why those two fields didn't move with the ring buffer itself).
   * ScrollbackBuffer.toBuffer() does the actual concat over the raw,
   * preamble-free bytes.
   */
  getScrollback(): Buffer {
    const altPreamble = this.inAltScreen ? ALT_SCREEN_ENTER : ALT_SCREEN_EXIT;
    let mousePreamble = "";
    if (this.mouseTracking.protocol !== "NONE") {
      mousePreamble += MOUSE_PROTOCOL_ENABLE[this.mouseTracking.protocol];
    }
    if (this.mouseTracking.encoding !== "DEFAULT") {
      mousePreamble += MOUSE_ENCODING_ENABLE[this.mouseTracking.encoding];
    }
    const preamble = Buffer.from(altPreamble + mousePreamble, "utf8");
    return this.scrollbackBuffer.toBuffer(preamble);
  }

  /**
   * Perf audit finding B8(1) — the LAST `maxBytes` of buffered output, no
   * mode preamble (unlike getScrollback() above, this isn't replayed to a
   * reattaching terminal — it only ever feeds a text scan, e.g.
   * dev-server-detect.ts's banner regex, where alt-screen/mouse-tracking
   * escape sequences are irrelevant noise). Delegates to
   * ScrollbackBuffer.tail() — see that method's own doc comment for the
   * O(chunks needed to reach maxBytes) walk and the maxBytes-trim step.
   */
  getScrollbackTail(maxBytes: number): Buffer {
    return this.scrollbackBuffer.tail(maxBytes);
  }

  /**
   * Writes browser/control-socket input into the pty. B9 — routes/terminal.ts's
   * `message` handler (and control-socket.ts's `sessions.input` op, which
   * ultimately calls this too) used to write straight through with no cap,
   * while the PTY->WS direction (Session.onData's consumer in terminal.ts)
   * has always dropped past BACKPRESSURE_MAX_BUFFERED_BYTES using the
   * browser WS socket's own live `bufferedAmount`. There's no equivalent
   * signal on this side: node-pty's IPty.write() returns void, and the
   * underlying write queue (unixTerminal.js's private `_writeQueue`) isn't
   * exposed — so a large paste (or a burst of rapid messages) into a
   * program that isn't reading its stdin would otherwise grow that queue
   * without bound in a process meant to run for days. This tracks bytes
   * handed to ptyProcess.write() in a fixed WRITE_BACKPRESSURE_WINDOW_MS
   * window instead (NOT a sliding/rolling window keyed off the gap since
   * the previous write — see the tradeoff paragraph below for why that
   * distinction matters), and drops (never queues) once
   * WRITE_BACKPRESSURE_MAX_BYTES is exceeded within it — a dropped paste is
   * recoverable (retype/repaste) in a way an unbounded in-process buffer
   * for a stuck program is not.
   *
   * Only the actual pty write is skipped on a drop — everything below
   * (lastUserInputAt, the genuine-user-input attention transition) still
   * runs unconditionally: the user DID act, and clearing a stale permission/
   * gate/promote latch on that basis is correct regardless of whether this
   * particular chunk made it to the program.
   *
   * Tradeoff, stated explicitly: this keys off elapsed wall-clock time, not
   * whether the pty is actually draining — there's no signal to key off
   * instead (see above). `writeWindowStartedAt` only advances on a RESET,
   * never on every write, so the window boundary is fixed relative to when
   * it last reset — not a per-write idle timer. That's deliberate: keying
   * the reset off the gap since the previous write instead would mean a
   * genuinely continuous stream (a user typing/pasting with no gap ever
   * exceeding the window) never resets at all, permanently capping that
   * session at WRITE_BACKPRESSURE_MAX_BYTES for its entire lifetime — far
   * worse than this design's own known caveat: a classic fixed-window-
   * counter can admit up to ~2x WRITE_BACKPRESSURE_MAX_BYTES in a short
   * span straddling a reset boundary (a burst filling the tail of one
   * window immediately followed by a fresh burst at the start of the
   * next). Averaged over any window-aligned interval this still bounds
   * throughput to WRITE_BACKPRESSURE_MAX_BYTES/WRITE_BACKPRESSURE_WINDOW_MS;
   * a legitimate multi-megabyte paste into a program reading its stdin
   * perfectly well can still land truncated if it crosses the cap within
   * one window regardless. 4 MiB/window is generous enough that this is
   * expected to be rare in practice, and the alternative (no cap at all) is
   * unbounded growth. No single `data` call can exceed the cap on its own
   * and get stuck permanently undeliverable either: every path that
   * reaches this method caps an individual frame well under
   * WRITE_BACKPRESSURE_MAX_BYTES already (`plugins/websocket.ts`'s
   * `maxPayload: 1 MiB`, `control-socket.ts`'s `MAX_LINE_BYTES` = 2 MiB).
   */
  write(data: string): void {
    const now = Date.now();
    if (now - this.writeWindowStartedAt >= WRITE_BACKPRESSURE_WINDOW_MS) {
      this.writeWindowStartedAt = now;
      this.pendingWriteBytes = 0;
      this.writeDropLogged = false;
    }
    const byteLength = Buffer.byteLength(data, "utf8");
    if (this.pendingWriteBytes + byteLength > WRITE_BACKPRESSURE_MAX_BYTES) {
      if (!this.writeDropLogged) {
        this.writeDropLogged = true;
        console.warn(
          `[pty-manager] session ${this.id} dropping input — write backpressure cap ` +
            `(${WRITE_BACKPRESSURE_MAX_BYTES} bytes/${WRITE_BACKPRESSURE_WINDOW_MS}ms) exceeded ` +
            `(further drops in this window are not logged individually)`,
        );
      }
    } else {
      this.pendingWriteBytes += byteLength;
      this.ptyProcess?.write(data);
    }
    this.lastUserInputAt = now;
    // Follow-up to #275 (gap #3): a genuine human keystroke (or a paste, or a
    // decline like Ctrl-C) is the authoritative "the user actually acted"
    // signal an OUTPUT_IMMUNE_KINDS-confirmed flag (hookNotification/
    // reviewGate/promoteRequest) needs to clear — see isGenuineUserInput's
    // doc comment for why this is filtered separately from, and more
    // strictly than, lastUserInputAt above. A no-op for every other
    // confirmedKind and for idle/pending states (advanceAttention's
    // "userInput" cases).
    if (isGenuineUserInput(data)) {
      this.applyAttentionTransition(
        advanceAttention(this.attentionState, { type: "userInput", now: Date.now() }),
      );
      // Rich statuses — a genuine keystroke means the user has responded to
      // (or moved past) the last finished turn; clear the `finished` latch
      // so the next poll doesn't keep reporting a turn that's no longer the
      // current one. See SessionInfo.lastTurnEndedAt's doc comment.
      let changed = this.lastTurnEndedAt !== null;
      this.lastTurnEndedAt = null;
      this.turnEndPingSent = false;
      // Issue #428 — same reasoning as turn_start's own clear: a genuine
      // keystroke means the user has moved past the finished turn, so its
      // backgroundTasks snapshot is stale too.
      if (this.backgroundTasks.length > 0) changed = true;
      this.backgroundTasks = [];
      this.backgroundTasksAt = null;
      // Follow-up to fix: status-clearing-semantics — a genuine keystroke
      // into a session showing a stale error IS the retry; typing is as
      // authoritative an "unblocking action" as the agent's own recovery
      // (the progress case above already treats forward progress this way).
      // This used to be markViewed()'s job (cleared on a mere glance, no
      // action required) — now that markViewed() is gone, a real keystroke
      // is the replacement unblocking signal. Without this, a hookless or
      // crashed agent would leave errorState clearable only by the TTL
      // sweep (clearStaleErrorIfOlderThan).
      if (this.errorState !== "idle") {
        this.errorState = "idle";
        this.errorAt = null;
        this.errorDetail = null;
        changed = true;
      }
      if (changed) this.emitEvent("status_change", { reason: "genuine_user_input" });
    }
  }

  /**
   * Rich statuses — the TTL backstop for `errorState` (issue: transient
   * status clearing). Nothing clears `errorState` on a mere glance (a
   * deliberate choice — a stale error survives a tab switch/reconnect same
   * as every other attention-worthy status; see write()'s genuine-user-input
   * clear just above): it's cleared by the next progress/turn_start hook, a
   * genuine keystroke (write() above), a respawn, or the session dying, but
   * a session whose resolving hook never fires (a crashed adapter, a dropped
   * socket message) would otherwise show a stale error forever. Called from
   * the existing 30s reconciler alongside reconcileExitedSessions — see
   * src/plugins/pty.ts. Returns whether it actually cleared anything, so the
   * caller can log only real transitions.
   */
  clearStaleErrorIfOlderThan(maxAgeMs: number, now: number): boolean {
    if (this.errorState === "idle" || this.errorAt === null) return false;
    if (now - this.errorAt < maxAgeMs) return false;
    this.errorState = "idle";
    this.errorAt = null;
    this.errorDetail = null;
    this.emitEvent("status_change", { reason: "stale_error_cleared" });
    return true;
  }

  /**
   * Issue #320 — the blocked/busy staleness backstop. Sweeps every
   * blocked/busy latch (permissionState, planState, gateState, promoteState,
   * elicitationState, compactState, subagentCount) and degrades any that
   * have been non-idle for longer than its own TTL without intervening PTY
   * activity. blockedMaxAgeMs applies to the blocked latches (permission/
   * plan/gate/promote/elicitation) — the agent is waiting on a human
   * decision, so a short backstop is right. busyMaxAgeMs applies to the busy
   * latches (compact/subagent) instead — separate and longer-default (issue
   * #320 follow-up), since a genuinely long compaction or subagent run is
   * ongoing work, not evidence something silently failed, and shouldn't be
   * degraded out from under a still-busy session just because it outran the
   * much shorter blocked-state TTL. A latch is only cleared when the agent
   * has been SILENT since before it was set, or the only intervening
   * activity landed within BLOCKED_STALE_GRACE_MS of the latch timestamp
   * (the dialog render that follows the hook firing, not genuine new work).
   * Returns true if anything was cleared.
   */
  clearStaleBlockedIfOlderThan(
    blockedMaxAgeMs: number,
    busyMaxAgeMs: number,
    now: number,
  ): boolean {
    let changed = false;

    // Helper: check if a latch timestamp is stale (past maxAgeMs) AND the
    // agent hasn't produced genuine new output since the latch. Activity
    // arriving within BLOCKED_STALE_GRACE_MS of the latch timestamp (e.g.
    // the dialog render that follows a hook firing) is treated as part of
    // the same triggering event — only activity well PAST the grace window
    // counts as evidence the agent is still progressing.
    const isStale = (at: number | null, maxAgeMs: number): boolean =>
      at !== null &&
      now - at >= maxAgeMs &&
      (this.lastActivityAt === null || this.lastActivityAt <= at + BLOCKED_STALE_GRACE_MS);

    if (this.permissionState !== "idle" && isStale(this.permissionAt, blockedMaxAgeMs)) {
      this.permissionState = "idle";
      this.permissionAt = null;
      this.pendingPermissionTool = null;
      this.emitEvent("status_change", {
        reason: "stale_blocked_cleared",
        state: "permissionState",
      });
      changed = true;
    }

    if (this.planState !== "idle" && isStale(this.planAt, blockedMaxAgeMs)) {
      this.planState = "idle";
      this.planAt = null;
      this.emitEvent("status_change", { reason: "stale_blocked_cleared", state: "planState" });
      changed = true;
    }

    if (this.gateState === "waiting" && isStale(this.gateAt, blockedMaxAgeMs)) {
      this.gateState = "idle";
      this.gateAt = null;
      this.gatePrompt = null;
      this.emitEvent("status_change", { reason: "stale_blocked_cleared", state: "gateState" });
      changed = true;
    }

    if (this.promoteState === "pending" && isStale(this.promoteAt, blockedMaxAgeMs)) {
      this.promoteState = "idle";
      this.promoteAt = null;
      this.promoteSummary = null;
      this.promoteSuggestedBaseRef = null;
      this.emitEvent("status_change", { reason: "stale_blocked_cleared", state: "promoteState" });
      changed = true;
    }

    if (this.elicitationState !== "idle" && isStale(this.elicitationAt, blockedMaxAgeMs)) {
      this.elicitationState = "idle";
      this.elicitationAt = null;
      this.elicitationServer = null;
      this.emitEvent("status_change", {
        reason: "stale_blocked_cleared",
        state: "elicitationState",
      });
      changed = true;
    }

    if (this.questionState !== "idle" && isStale(this.questionAt, blockedMaxAgeMs)) {
      this.questionState = "idle";
      this.questionHeader = null;
      this.questionAt = null;
      this.emitEvent("status_change", { reason: "stale_blocked_cleared", state: "questionState" });
      changed = true;
    }

    if (this.compactState !== "idle" && isStale(this.compactAt, busyMaxAgeMs)) {
      this.compactState = "idle";
      this.compactAt = null;
      this.emitEvent("status_change", { reason: "stale_blocked_cleared", state: "compactState" });
      changed = true;
    }

    if (this.subagentCount > 0 && isStale(this.subagentCountAt, busyMaxAgeMs)) {
      this.subagentCount = 0;
      this.subagentCountAt = null;
      this.emitEvent("status_change", { reason: "stale_blocked_cleared", state: "subagentCount" });
      changed = true;
    }

    // Issue #428 — same busyMaxAgeMs tier as compactState/subagentCount
    // above: genuinely outstanding background work is ongoing work, not
    // evidence something silently failed, so it gets the longer busy TTL
    // rather than the short blocked one. `isStale`'s silence requirement
    // catches a still-running SUBAGENT (its own PTY-adjacent activity keeps
    // lastActivityAt moving), but NOT a genuinely-running background Bash/
    // MCP task that produces no PTY output of its own at all — the session
    // can sit silent for the full TTL while that work is still legitimately
    // in progress. That's exactly why this deliberately does NOT call
    // resolveDeferredTurnEnd() (Hermes review, PR #453): clearing the list
    // is a "give up tracking it" backstop, same posture as subagentCount's
    // own stale-clear just above (which fires no completion ping either) —
    // NOT a confirmed drain, so it must not assert "the work is done" via an
    // `agentIdle`/"Finished" ping that could be wrong. The status itself
    // still degrades correctly on the next poll (deriveSessionStatus reads
    // the now-empty outstandingBackgroundTasks), just without a false ping.
    if (
      filterOutstandingBackgroundTasks(this.backgroundTasks).length > 0 &&
      isStale(this.backgroundTasksAt, busyMaxAgeMs)
    ) {
      this.backgroundTasks = [];
      this.backgroundTasksAt = null;
      this.emitEvent("status_change", {
        reason: "stale_blocked_cleared",
        state: "backgroundTasks",
      });
      changed = true;
    }

    // Phase 5 (Track A) — deliberately INDEPENDENT of the subagentCount
    // block above, checking each open entry against its own `startedAt`
    // rather than the aggregate `subagentCountAt`. An orphaned or duplicate
    // "finished" event (no matching start, or two stops for one start —
    // both already handled defensively by the clamp-at-0 in the "subagent"
    // hook case) can clamp `subagentCount` to 0 while a DIFFERENT,
    // genuinely-still-running subagent's registry entry stays open. Gating
    // this finalization on `subagentCount > 0` would leave that entry stuck
    // "running" forever the moment the count and the registry desync that
    // way (independent review finding, PR #415) — subagentCount being 0
    // must not be read as "nothing is running," since the registry is the
    // more precise of the two once they disagree.
    let staleSubagentsCleared = false;
    for (const info of this.subagents.values()) {
      if (info.endedAt === null && isStale(info.startedAt, busyMaxAgeMs)) {
        // No summary, distinguishing a stale clear from a genuine
        // SubagentStop (which may carry one).
        info.endedAt = now;
        staleSubagentsCleared = true;
      }
    }
    if (staleSubagentsCleared) {
      this.emitEvent("status_change", { reason: "stale_blocked_cleared", state: "subagents" });
      changed = true;
    }

    return changed;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    // Resizing the pty our dtach attach-client lives in delivers SIGWINCH to
    // it, which dtach forwards into the session — the same mechanism a real
    // resized SSH terminal would trigger. No special-casing needed here.
    //
    // Deliberately does NOT cancel a pending redraw-nudge cycle (unlike
    // kill()/onExit below). It's tempting to think a real resize already
    // forces its own repaint, making a pending synthetic dip/restore
    // redundant — but the frontend's on-open resize (TerminalPane.tsx,
    // sendResizeIfOpen) has no delta guard and fires on every attach even
    // when the size is unchanged, which lands here as a same-size resize().
    // A same-size resize is a kernel-level TIOCSWINSZ no-op (no SIGWINCH) —
    // see redraw-nudge.ts's own header comment. If this cancelled the
    // pending nudge, the nudge (the only thing that would force a repaint)
    // would never run, reintroducing the exact blank-screen-on-reconnect
    // bug it exists to fix. So any pending nudge must run to completion
    // regardless of what resize() does in the meantime — its restore stage
    // reads this.cols/this.rows live (via RedrawNudgeHost.getSize()), so it
    // still lands at the right size either way.
    this.ptyProcess?.resize(cols, rows);
  }

  /**
   * Force a repaint on an already-alive session that a fresh attach would
   * otherwise not get: attachClient() nudges on every spawn/respawn, but a
   * reattach to a still-alive client never respawns, so it must ask
   * explicitly (see attachSocketToSession's `wasAlive` check in
   * routes/terminal.ts). Safe to call any time — RedrawNudgeHost.resize()'s
   * optional chaining no-ops if the client has since died. Passes
   * suppressCapture: true — see RedrawNudge.trigger()'s docstring for why
   * this path (unlike the initial spawn-time nudge) shouldn't buffer its
   * own repaint.
   */
  requestRedraw(): void {
    const suppressCapture = true;
    this.redrawNudge.trigger(suppressCapture);
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Kill our attach-client only. The dtach master and the program it's running survive. */
  kill(): void {
    // A8 (state-file lifecycle, two bugs/one fix): this must be the very
    // first thing kill() does, before anything else runs.
    //
    // Bug 1 — lost on restart. Both of SessionStateFile's write and ceiling
    // timers are `.unref()`'d (see SessionStateFile.schedule() in
    // session-state-file.ts), specifically so a pending debounced write
    // can't keep the process alive on its own. That's correct for normal
    // operation, but it means a `systemctl --user restart` drains the event
    // loop before either timer ever fires — silently dropping the last
    // <=5s (<=30s at the ceiling) of
    // permissionState/gateState/promoteState/lastTurnEndedAt. Every
    // shutdown path (PtyManager.killAll() on graceful shutdown,
    // session-reconciler.ts, and terminate() below) routes through this
    // method, so flushing synchronously here — instead of trusting the
    // debounce timer to get there first — is what makes a restart capture
    // the true last-known state.
    //
    // Bug 2 — resurrected on delete. SessionStateFile.disable() must be
    // called BEFORE flush(), not after: a few lines down, ptyProcess?.kill()
    // triggers node-pty's onExit, which calls
    // emitEvent("status_change") -> this.stateFile.schedule() — re-arming a
    // brand-new timer *after* this method's own flush already ran. Left
    // unguarded, that timer would fire after terminate()'s
    // unlinkSync(stateFilePath(...)) below, resurrecting a `<id>.state.json`
    // for a session that no longer exists, and pinning this already-unmapped
    // Session (with up to 1 MiB of scrollback) alive until it fires. Since
    // kill() is only ever reached via PtyManager.kill(id) — which always
    // deletes this Session from the `sessions` map in the same call — this
    // instance is permanently done afterward: a later reattach always
    // constructs a brand-new Session (see getOrCreate), so disabling writes
    // here for good can never suppress a legitimate future write.
    this.stateFile.disable();
    this.stateFile.flush();
    // A1: flush (not drop) any still-pending, debounced title_change event
    // for the same two reasons this.stateFile.flush() above flushes rather
    // than waits — (1) this Session instance is permanently retired by this call
    // (see this method's own doc comment: a later reattach always builds a
    // brand-new Session), so a `.unref()`'d timer left dangling on it would
    // either never fire (process exit drains it) or, worse, fire LATE
    // against an abandoned instance whose emitEvent() still reaches the
    // manager-level fan-out (session.onEvent() in getOrCreate() is
    // subscribed once, for life — see its own doc comment) — a stale
    // title_change racing a brand-new Session's own fresh ones on the same
    // numeric session id; (2) the pending title is real, observed state
    // (not synthetic), so — same posture as the state file — it's worth
    // capturing rather than silently discarding on every ordinary detach.
    // Not a new pattern for kill(): a few lines down, ptyProcess?.kill()
    // already triggers node-pty's onExit -> emitEvent("status_change",
    // {reason: "exited"}) synchronously during teardown, same as this call
    // does for title_change. Running this flush BEFORE that means any
    // flushed title_change lands strictly before the exited status_change
    // in event order, matching what actually happened chronologically.
    this.flushTitleChangeEvent();
    // See redraw-nudge.ts's RedrawNudge.cancel() doc comment: without this,
    // a pending nudge timer would survive this kill and fire against
    // whatever NEW attach-client a later respawn of this same Session
    // creates. Covers every higher-level teardown path transitively —
    // PtyManager.killAll() and session-reconciler.ts both route through
    // PtyManager.kill() -> Session.kill(), as does terminate() before its
    // own stopScope() call.
    this.redrawNudge.cancel();
    this.ptyProcess?.kill();
    this.ptyProcess = null;
    // Unlike inAltScreen/mouseTracking (which deliberately persist across a
    // respawn — they track true, ongoing screen/mouse state), detectCarry is
    // just a byte-stream artifact of wherever the old attach-client's last
    // chunk happened to end. It carries no meaning once that stream is gone,
    // so clear it rather than risk it being misread as a prefix of the new
    // attach-client's first chunk.
    this.detectCarry = "";
    // B8(3) — this Session instance is permanently done after this kill()
    // call (see this method's own doc comment above), so the per-session
    // git-ignore memoization cache has nothing left to serve; drop it
    // explicitly rather than leaving it to whatever later GC pass reclaims
    // this whole Session, same "don't leave per-lifetime state dangling"
    // posture as detectCarry/cwdDetectCarry below.
    this.gitIgnoreDirCache.clear();
    // Same reasoning as detectCarry just above — a byte-stream artifact of
    // the old attach-client, not meaningful once that stream is gone. Note
    // `_liveCwd` itself is NOT cleared here: it tracks true, ongoing shell
    // state (same posture as inAltScreen/mouseTracking) that survives a
    // respawn/reattach to the same dtach session.
    this.cwdDetectCarry = "";
  }

  toInfo(idleThresholdMs: number = IDLE_THRESHOLD_MS): SessionInfo {
    const titleSignal = classifyActivityFromTitle(this.lastTitle, this.command);
    let activity: "working" | "idle";
    if (titleSignal !== null) {
      activity = titleSignal;
    } else {
      const recent =
        this.lastActivityAt !== null && Date.now() - this.lastActivityAt < idleThresholdMs;
      // A single spawn-time prompt-draw burst doesn't count as "working" —
      // require output to have persisted for at least SUSTAIN_MS (see the
      // streak tracking in onData).
      const sustained =
        this.activityStreakStart !== null &&
        this.lastActivityAt !== null &&
        this.lastActivityAt - this.activityStreakStart >= SUSTAIN_MS;
      // Recent output that closely follows a keystroke is more likely echo
      // or a redraw of that input than autonomous work — see
      // USER_INPUT_ECHO_MS's docstring.
      const withinEchoWindow =
        this.lastUserInputAt !== null && Date.now() - this.lastUserInputAt < USER_INPUT_ECHO_MS;
      activity = recent && sustained && !withinEchoWindow ? "working" : "idle";
    }
    return {
      id: this.id,
      cwd: this.cwd,
      liveCwd: this._liveCwd,
      browserUrl: null,
      command: this.command,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      alive: this.isAlive,
      subscriberCount: this.subscriberCount,
      lastActivityAt: this.lastActivityAt,
      activity,
      attention: this.attentionState.confirmedAt !== null,
      attentionAt: this.attentionState.confirmedAt,
      lastTitle: this.lastTitle,
      gateState: this.gateState,
      gatePrompt: this.gatePrompt,
      gateAt: this.gateAt,
      promoteState: this.promoteState,
      promoteSummary: this.promoteSummary,
      promoteSuggestedBaseRef: this.promoteSuggestedBaseRef,
      promoteAt: this.promoteAt,
      permissionState: this.permissionState,
      permissionAt: this.permissionAt,
      planState: this.planState,
      planAt: this.planAt,
      errorState: this.errorState,
      errorAt: this.errorAt,
      endedReason: this.endedReason,
      exitCode: this.exitCode,
      liveBranch: this.liveBranch,
      // Rich statuses — attentionKind mirrors attentionState.confirmedKind
      // directly (see its own SessionInfo doc comment for why), same
      // posture as attention/attentionAt just above.
      attentionKind: this.attentionState.confirmedKind,
      errorDetail: this.errorDetail,
      lastAssistantMessage: this.lastAssistantMessage,
      compactState: this.compactState,
      compactAt: this.compactAt,
      subagentCount: this.subagentCount,
      subagentCountAt: this.subagentCountAt,
      subagents: Array.from(this.subagents.values()),
      elicitationState: this.elicitationState,
      elicitationServer: this.elicitationServer,
      elicitationAt: this.elicitationAt,
      questionState: this.questionState,
      questionHeader: this.questionHeader,
      questionAt: this.questionAt,
      lastTurnEndedAt: this.lastTurnEndedAt,
      backgroundTasks: this.backgroundTasks,
      backgroundTasksAt: this.backgroundTasksAt,
      outstandingBackgroundTasks: filterOutstandingBackgroundTasks(this.backgroundTasks),
      // Issue #323: state file persistence metadata.
      stateRestored: this.stateRestored,
      staleHooks: this.staleHooks,
      restoredVersion: this.restoredVersion,
      hookEmits: this.hookEmits,
      pendingDevServerPort: this.pendingDevServerPort,
    };
  }
}

// SKIP_PERMISSION_FLAGS/getSkipPermissionFlag moved to launch-plan.ts in
// PR 32 (Wave 6) alongside buildLaunchPlan(), the only other place that
// calls getSkipPermissionFlag(); re-exported near the top of this file for
// existing importers (src/routes/agents.ts, this module's own tests).

export class PtyManager {
  private sessions = new Map<string, Session>();
  private readonly sessionsDir: string;
  // Issue #271 — see stashSeed()/consumeSeed() below.
  private pendingSeeds = new Map<string, string>();
  // Phase 2 (issue #172) — the ONE shared Unix socket every session in this
  // process is told about via MULLION_HOOK_SOCKET (see Session.bootstrapMaster()),
  // and the socket src/plugins/hooks.ts's listener actually binds. Computed
  // once here, alongside sessionsDir, rather than re-derived per session.
  readonly hookSocketPath: string;
  // Phase 2 (issue #172) — token -> session id, populated as each Session is
  // constructed (getOrCreate below) and cleaned up when a session is fully
  // removed from `sessions` (kill()). Deliberately resolved via a linear scan
  // + timingSafeTokenMatch (resolveToken below) rather than a plain
  // Map.get(token) lookup — see the Session.hookToken field doc comment and
  // crypto-utils.ts's timingSafeTokenMatch for why a constant-time compare
  // matters even for an already-filesystem-scoped (0600) socket.
  private hookTokens = new Map<string, string>();
  // Phase 4 (#185) — the general-purpose control socket
  // src/plugins/control-socket.ts listens on, distinct from hookSocketPath
  // above: the hook socket authenticates a *session's own agent* via its
  // per-session MULLION_HOOK_TOKEN, while this one accepts either the
  // operator's MULLION_AUTH_TOKEN (full scope) or a live session's hook token
  // (pinned to that session) — see control-socket.ts's own doc comment.
  // Defaults alongside hookSocketPath in the same sessionsDir unless
  // MULLION_SOCKET_PATH overrides it (src/plugins/pty.ts).
  readonly controlSocketPath: string;
  // Manager-level fan-out (issue #166) — mirrors dataListeners/onData()'s
  // Set<listener> + unsubscribe-closure shape, just one layer up: each
  // Session emits to its OWN eventListeners set (above), and getOrCreate()
  // below subscribes once per session to re-emit into this aggregated set,
  // the single subscription point routes/events.ts's /ws/events needs to
  // see every session's events without subscribing to each one individually.
  private eventListeners = new Set<EventListener>();
  // The one new timer this PR (#171/#98) adds — see ATTENTION_EVAL_INTERVAL_MS's
  // doc comment for why it lives here (unconditionally, not gated behind
  // MULLION_ROLE like session-reconciler.ts's timer in src/plugins/pty.ts)
  // rather than as a per-Session timer: one interval regardless of session
  // count, mirroring the reconciler's own single-timer-for-N-sessions shape.
  private readonly attentionEvalTimer: ReturnType<typeof setInterval>;
  // Mirrors app.config.MULLION_REVIEW_GATE_ENABLED (default false, see
  // env.ts) — threaded into every Session this manager creates (getOrCreate
  // below) so its bootstrapMaster() can pass it through to
  // applyHookAdapters. Optional in opts, defaulting false, so existing
  // `new PtyManager({ sessionsDir })` call sites (tests, mainly) keep
  // compiling unchanged.
  private readonly reviewGateEnabled: boolean;
  // Issue #437c — a live accessor, not a cached boolean: unlike
  // reviewGateEnabled above (a boot-time app.config constant),
  // sessions.injectAgentGuide is DB-backed and can be toggled at runtime via
  // Settings -> Sessions with no restart. PtyManager has no DB access of its
  // own (deliberately — see this constructor's opts), so pty.ts hands it a
  // narrow closure over app.db instead of a raw handle. Called fresh inside
  // getOrCreate() below on every new session, not cached here, so each
  // spawn sees the setting's current value at that moment — the closest
  // opencode's spawn-time-only injection mechanism (hook-adapters/
  // opencode.ts) can get to hooks.ts's own per-hook-fire live read for
  // every other agent. Defaults to the setting's own default (`true`, see
  // settings.ts) so existing `new PtyManager({ sessionsDir })` call sites
  // (tests, mainly) keep compiling unchanged and behave as if the setting
  // were on, matching production's default.
  private readonly getInjectAgentGuide: () => boolean;

  constructor(opts: {
    sessionsDir: string;
    reviewGateEnabled?: boolean;
    controlSocketPath?: string;
    getInjectAgentGuide?: () => boolean;
  }) {
    // Must be absolute: dtach is spawned with cwd set to the *session's*
    // project directory (e.g. a user's repo), not the server's cwd, so a
    // relative sessionsDir would resolve against the wrong directory and
    // dtach would look for the socket in the wrong place entirely.
    this.sessionsDir = path.resolve(opts.sessionsDir);
    mkdirSync(this.sessionsDir, { recursive: true });
    // Lives alongside the per-session dtach sockets in the same directory —
    // SESSIONS_DIR is already host-local, per-install storage with no other
    // sanctioned reader, and src/plugins/hooks.ts locks this file down to
    // 0600 once it starts listening.
    this.hookSocketPath = path.join(this.sessionsDir, "hooks.sock");
    // Empty/unset MULLION_SOCKET_PATH (opts.controlSocketPath) means
    // "derive from sessionsDir", same fallback shape as hookSocketPath — see
    // env.ts's MULLION_SOCKET_PATH comment for why an explicit override is
    // resolved rather than defaulted to a fixed path. Deliberately NOT run
    // through pty.ts's ensureSessionsDir sun_path redirect: that logic
    // protects a *derived* path the operator never chose; an explicit
    // MULLION_SOCKET_PATH override is their own choice of path, and if it
    // exceeds the 108-byte sun_path limit, control-socket.ts's listen()
    // fails loudly at boot rather than silently relocating a path the
    // operator asked for by name.
    this.controlSocketPath = opts.controlSocketPath
      ? path.resolve(opts.controlSocketPath)
      : path.join(this.sessionsDir, "mullion.sock");
    this.reviewGateEnabled = opts.reviewGateEnabled ?? false;
    this.getInjectAgentGuide = opts.getInjectAgentGuide ?? (() => true);

    // unref() so this timer alone never keeps the process (or, in tests, a
    // PtyManager instance nobody explicitly tore down) alive — same
    // reasoning as src/plugins/pty.ts's reconcile timer.
    this.attentionEvalTimer = setInterval(() => {
      for (const session of this.sessions.values()) session.tick();
    }, ATTENTION_EVAL_INTERVAL_MS);
    this.attentionEvalTimer.unref();
  }

  private socketPathFor(id: string): string {
    return path.join(this.sessionsDir, `${id}.sock`);
  }

  /** Resolve a hook-socket handshake token to the session id it belongs to,
   * or undefined if it matches no currently-tracked session (unknown,
   * stale/already-killed, or forged). Linear scan + timingSafeTokenMatch
   * rather than Map.get(token) — see the hookTokens field doc comment. */
  resolveToken(token: string): string | undefined {
    for (const [candidate, id] of this.hookTokens) {
      if (timingSafeTokenMatch(token, candidate)) return id;
    }
    return undefined;
  }

  /**
   * Get the tracked session for `id`, creating and spawning it if this is
   * the first time this process has seen it. If a previously-tracked
   * session's attach-client has died (Node restart, crash), respawn it —
   * this is the fresh-dtach-reattach path.
   */
  getOrCreate(opts: CreateSessionOptions): Session {
    let session = this.sessions.get(opts.id);
    if (!session) {
      session = new Session({
        id: opts.id,
        cwd: opts.cwd,
        command: opts.command,
        socketPath: this.socketPathFor(opts.id),
        cols: opts.cols,
        rows: opts.rows,
        hookSocketPath: this.hookSocketPath,
        controlSocketPath: this.controlSocketPath,
        sessionsDir: this.sessionsDir,
        reviewGateEnabled: this.reviewGateEnabled,
        // Called now, at this session's own creation — see getInjectAgentGuide's
        // own doc comment for why this must be a fresh call, not a value
        // cached at PtyManager-construction/boot time.
        injectAgentGuide: this.getInjectAgentGuide(),
        skipPermissions: opts.skipPermissions,
        initialPrompt: opts.initialPrompt,
        projectId: opts.projectId,
      });
      // Subscribed exactly once, at creation — re-emits every event this
      // brand-new session ever produces into the manager-level fan-out
      // above, for as long as this process runs (never unsubscribed; a
      // Session's own eventListeners set only otherwise loses subscribers
      // via a WS route's unsubscribe closure, which this internal one never
      // is).
      session.onEvent((event) => {
        for (const listener of this.eventListeners) listener(event);
      });
      this.sessions.set(opts.id, session);
      // Registered once, at creation, mirroring the onEvent subscription
      // just above — see resolveToken()/the hookTokens field doc comment.
      this.hookTokens.set(session.hookToken, opts.id);
    }
    if (!session.isAlive) {
      // getOrCreate() itself stays synchronous (many callers rely on that),
      // so this fire-and-forget call is unchanged behavior even though
      // spawn() now returns a promise (B6) — see spawn()'s own doc comment.
      // A caller that specifically needs the awaited outcome uses
      // session.spawnOutcome() after this returns, not this call's own
      // (intentionally discarded) return value.
      void session.spawn();
    }
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.toInfo());
  }

  /** Rich statuses — the TTL backstop's entry point, called from the
   * existing 30s reconciler timer (src/plugins/pty.ts). Local-only by
   * construction: `this.sessions` only ever tracks sessions this process's
   * PtyManager owns, same scope as list()/get() above — a remote host's own
   * sessions are its own PtyManager's problem. Returns the ids actually
   * cleared, purely so the caller can log a real transition rather than a
   * no-op sweep. */
  sweepStaleErrors(maxAgeMs: number): string[] {
    const now = Date.now();
    const cleared: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.clearStaleErrorIfOlderThan(maxAgeMs, now)) cleared.push(id);
    }
    return cleared;
  }

  /**
   * Issue #320 — sweeps every tracked session's blocked/busy latches and
   * degrades any that have been non-idle for longer than their TTL
   * (blockedMaxAgeMs for permission/plan/gate/promote/elicitation,
   * busyMaxAgeMs for compact/subagent — see clearStaleBlockedIfOlderThan's
   * doc comment for why they're separate) without intervening PTY activity.
   * Mirrors sweepStaleErrors()'s local-only-by-construction posture. Returns
   * the ids of any sessions that changed, purely so the caller can log real
   * transitions.
   */
  sweepStaleStates(blockedMaxAgeMs: number, busyMaxAgeMs: number): string[] {
    const now = Date.now();
    const cleared: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.clearStaleBlockedIfOlderThan(blockedMaxAgeMs, busyMaxAgeMs, now))
        cleared.push(id);
    }
    return cleared;
  }

  /** Subscribe to every tracked session's notification events, present and
   * future — see the eventListeners field doc comment above. Returns an
   * unsubscribe closure, mirroring every other listener registration in
   * this file. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Every currently-buffered event across every tracked session (alive or
   * not — a session's final `status_change` "exited" event is exactly the
   * kind of thing a client connecting moments later still wants to see),
   * unsorted. Callers (routes/events.ts) sort/cap this for replay. */
  listEvents(): NotificationEvent[] {
    return [...this.sessions.values()].flatMap((s) => s.getEvents());
  }

  /** Advance a tracked session's read cursor — a no-op (not an error) for an
   * id this process isn't tracking, the same "unknown id is harmless" shape
   * as every other per-id lookup in this class (e.g. get()). */
  markEventsSeen(id: string, seq: number): void {
    this.sessions.get(id)?.markEventsSeen(seq);
  }

  /** Routes one validated hook message (src/plugins/hooks.ts) to the session
   * it's attributed to — a no-op (not an error) for an id this process
   * isn't tracking, the same "unknown id is harmless" shape as every other
   * per-id lookup in this class. In practice this should never actually be
   * unknown: hooks.ts only ever calls this with an id resolveToken() just
   * returned, and resolveToken() only ever returns ids of tracked sessions —
   * but a session could in principle be killed in the gap between resolving
   * a message's token and this call reaching it, so the no-op fallback
   * matters, not just consistency with markEventsSeen(). */
  emitHookEvent(id: string, message: HookMessage): void {
    this.sessions.get(id)?.emitHookEvent(message);
  }

  /** Follow-up to #275 (gap #1) — see Session.markHooksProven's doc comment
   * for why `session_start` needs its own dedicated delegator rather than
   * going through emitHookEvent above. Same "unknown id is quietly ignored"
   * posture as every other per-id lookup in this class. */
  markHooksProven(id: string): void {
    this.sessions.get(id)?.markHooksProven();
  }

  /** Issue #178 — see Session.resolveGate's doc comment. A no-op (never
   * throws) if `id` isn't tracked, same "unknown id is quietly ignored"
   * posture as emitHookEvent above (hooks.ts only ever calls this with an id
   * resolveToken() itself returned, so in practice it's always tracked). */
  resolveGate(id: string, decision: "approved" | "denied", reason?: string): void {
    this.sessions.get(id)?.resolveGate(decision, reason);
  }

  /** Issue #271 — see Session.resolvePromote's doc comment. Same "unknown id
   * is quietly ignored" posture as resolveGate above. */
  resolvePromote(id: string, decision: "accepted" | "declined"): void {
    this.sessions.get(id)?.resolvePromote(decision);
  }

  /**
   * Issue #404 — the DB-aware entry point src/plugins/pty.ts's dedicated
   * dev-server-detection timer calls: `eligible` is a sessionId -> projectId
   * map the caller has ALREADY filtered down to plain (kind !== "dock"),
   * active sessions whose project has no devServerUrl set yet (a DB join
   * only the caller can do — see Session.detectDevServerPort's own doc
   * comment for why that filtering can't live here or on Session itself).
   * Skips any id this process isn't currently tracking (e.g. a DB row for a
   * session that hasn't been attached since a restart) the same "unknown id
   * is quietly ignored" way every other per-id lookup in this class does.
   * Returns every newly-detected (sessionId, port) pair, purely so the
   * caller can log real transitions the same way sweepStaleErrors/
   * sweepStaleStates do.
   */
  sweepDevServerDetection(
    eligible: ReadonlyMap<string, number | null>,
  ): { sessionId: string; port: string }[] {
    const detected: { sessionId: string; port: string }[] = [];
    for (const [id, projectId] of eligible) {
      const session = this.sessions.get(id);
      if (!session) continue;
      const port = session.detectDevServerPort(projectId);
      if (port) detected.push({ sessionId: id, port });
    }
    return detected;
  }

  /** Issue #404 — see Session.acceptDevServerPort's doc comment. Same
   * "unknown id is quietly ignored" posture as resolveGate/resolvePromote
   * above (returns false, the route's own 409). */
  acceptDevServerPort(id: string, port: string): boolean {
    return this.sessions.get(id)?.acceptDevServerPort(port) ?? false;
  }

  /** Issue #404 — see Session.dismissDevServerPort's doc comment. Same
   * "unknown id is quietly ignored" posture as acceptDevServerPort above. */
  dismissDevServerPort(id: string, port: string): boolean {
    return this.sessions.get(id)?.dismissDevServerPort(port) ?? false;
  }

  /**
   * Stashes a seed prompt (issue #271's promote flow) for a NEW session's
   * `SessionStart` hook to pick up once it fires — see consumeSeed() below
   * and hooks.ts's "session_start" handling. Keyed independently of the
   * `sessions` map (rather than as a Session field) because the stash
   * happens right after POST /api/sessions/:id/promote spawns the new
   * session, and the corresponding Session object is guaranteed to exist by
   * then (getOrCreate is synchronous), but keeping this as a flat,
   * short-lived map avoids coupling a one-shot handoff value to a Session's
   * full lifecycle.
   */
  stashSeed(id: string, seed: string): void {
    this.pendingSeeds.set(id, seed);
  }

  /** Reads and clears a stashed seed (single-use — a SessionStart hook only
   * ever fires once per real session start). Returns null if nothing was
   * stashed for `id` (the ordinary case: most sessions are never promoted
   * targets). */
  consumeSeed(id: string): string | null {
    const seed = this.pendingSeeds.get(id);
    if (seed === undefined) return null;
    this.pendingSeeds.delete(id);
    return seed;
  }

  /**
   * B9 — the terminal-lifecycle counterpart to stashSeed()/consumeSeed():
   * discards a stashed-but-never-consumed seed so it can't leak in this map
   * for the process's entire lifetime (see stashSeed's own doc comment for
   * the leak scenario). Deliberately NOT called from kill() itself — kill()
   * is also reached via killAll() on a graceful shutdown/redeploy, which is
   * explicitly NOT terminal for `id`: the dtach master and the program
   * inside it survive (see kill()'s and killAll()'s own doc comments, and
   * hookTokens' identical non-clearing treatment right below in kill()), so
   * a SessionStart hook that hasn't fired yet by the time a redeploy's
   * killAll() runs can still fire once the process reattaches afterward —
   * clearing pendingSeeds unconditionally in kill() would silently and
   * permanently lose that seed even though the promoted session itself
   * survives the redeploy (independent review, PR #587).
   *
   * Callers are exactly the genuinely-terminal moments for `id`: this
   * class's own terminate() (below), the exited-session reconciler
   * (session-reconciler.ts, once isMasterAlive confirms the process is
   * actually gone), and the local-spawn-failure rollback
   * (session-lifecycle.ts, where the session row itself is deleted right
   * after). None of those has any live process left that could ever fire a
   * SessionStart hook again.
   */
  discardPendingSeed(id: string): void {
    this.pendingSeeds.delete(id);
  }

  /** Kill our tracked attach-client only (detach); the dtach master + program survive. */
  kill(id: string): void {
    const session = this.sessions.get(id);
    try {
      session?.kill();
    } catch (err) {
      // Don't let one already-dead process (e.g. ESRCH) abort killAll()'s
      // loop over every other tracked session.
      console.error(`[pty-manager] error killing session ${id}:`, err);
    }
    this.sessions.delete(id);
    // B9 — deliberately NOT clearing pendingSeeds here (unlike an earlier
    // version of this fix — see discardPendingSeed's own doc comment for
    // why): this method is also reached via killAll() on a graceful
    // shutdown/redeploy, which is NOT terminal for `id` — the dtach master
    // and the program inside it survive that, same reasoning as hookTokens'
    // own non-clearing treatment just below. Callers that DO know `id` is
    // genuinely done (terminate(), the exited-session reconciler,
    // session-lifecycle.ts's spawn-failure rollback) call
    // discardPendingSeed(id) themselves alongside this method.
    // A killed session's in-memory Session object is discarded here, but —
    // unlike before hook-token persistence — its hookToken is NOT: this
    // path (via killAll()) runs on every graceful shutdown/redeploy, and
    // the whole point of persisting the token to `<id>.token` is that the
    // dtach master + agent process kill() deliberately leaves running (see
    // this method's own doc comment) still hold that exact value in their
    // env. Deleting the file here would make the very next restart repeat
    // the bug this fixes. getOrCreate() reconstructs a Session with the
    // SAME token via loadOrCreateHookToken() the next time this id is
    // requested (on reattach), so it's re-added to this map then. Only
    // remove the map entry now, so resolveToken() can't match hook
    // messages against a token whose in-memory Session is momentarily gone.
    if (session) this.hookTokens.delete(session.hookToken);
  }

  /**
   * Fully end a session: kill our tracked attach-client (if any) AND stop
   * its systemd scope, which is what actually owns the dtach master and the
   * program running inside it. Unlike kill(), this works even when nothing
   * is tracked in this process's memory at all — e.g. right after a restart,
   * before anything has re-attached — because the scope name is derived
   * from `id` alone, not from any in-memory Session. This is the operation
   * an explicit user-initiated "delete this session" should use; kill() by
   * itself would just detach and leave the program running forever, since
   * nothing will ever reattach to a session once it's marked killed.
   *
   * This IS the right place to delete the persisted hook-token file (unlike
   * kill() above): stopScope() actually ends the dtach master and program,
   * so nothing will ever again present this token, and no future
   * getOrCreate() for this id should silently resurrect it either. Same
   * reasoning makes this the right place for discardPendingSeed(id) (B9) —
   * stopScope() below actually ends the process, so no SessionStart hook
   * for `id` will ever fire again.
   */
  async terminate(id: string): Promise<void> {
    this.kill(id);
    this.discardPendingSeed(id);
    await stopScope(id);
    try {
      unlinkSync(hookTokenPath(this.sessionsDir, id));
    } catch {
      // ENOENT (this session's hooks never fired, or it predates this
      // feature) is the expected common case — nothing to clean up.
    }
    try {
      unlinkSync(stateFilePath(this.sessionsDir, id));
    } catch {
      // ENOENT (never wrote a state file, or session predates this feature).
    }
  }

  /** Kill every tracked attach-client. Called on server shutdown; the dtach masters survive. */
  killAll(): void {
    // Defense-in-depth alongside attentionEvalTimer's own unref() — same
    // "stop it explicitly on shutdown too, don't rely on unref() alone"
    // posture as src/plugins/pty.ts's onClose hook takes with its
    // reconcile timer.
    clearInterval(this.attentionEvalTimer);
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  /**
   * Whether `id`'s systemd scope — the true owner of the dtach master and
   * the program running inside it, per terminate()'s doc comment above — is
   * still active. See isMasterAlive() in session-process.ts for the full
   * doc comment (the "close" vs "exit" race, the false-vs-unknown
   * collapse). Kept as a real instance method — not just a re-export of the
   * imported function — so `app.pty.isMasterAlive` stays the one call
   * surface session-reconciler.ts, session-backend.ts, and their tests
   * (pty-manager.test.ts calls `manager.isMasterAlive` directly) already
   * use.
   */
  isMasterAlive(id: string): Promise<boolean> {
    return isMasterAliveProcess(id);
  }

  /**
   * Lists the genuine OS processes currently running inside `id`'s systemd
   * scope. See listSessionProcesses() in session-process.ts for the full
   * doc comment; same "keep it a real method" reasoning as isMasterAlive()
   * above — session-backend.ts calls `app.pty.listSessionProcesses(id)`.
   */
  listSessionProcesses(id: string): Promise<CgroupProcess[]> {
    return listSessionProcessesProcess(id);
  }

  /**
   * Perf audit finding B8(2) — batched counterpart to isMasterAlive()
   * above. See isMasterAliveBatch() in session-process.ts for the full doc
   * comment (the trust-rule rationale for collapsing failures to an empty
   * record rather than all-false). Kept as a real method for the same
   * reason as isMasterAlive() above — session-reconciler.test.ts spies on
   * `app.pty.isMasterAliveBatch` directly.
   */
  isMasterAliveBatch(ids: string[]): Promise<Record<string, boolean>> {
    return isMasterAliveBatchProcess(ids);
  }
}
