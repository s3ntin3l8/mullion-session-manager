import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { timingSafeTokenMatch } from "./crypto-utils.js";
import {
  detectAttentionSignals,
  classifyActivityFromTitle,
  detectAltScreenSwitch,
  applyMouseModeChanges,
  carryPartialEscape,
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
  HookMessage,
  ReviewGateHookMessage,
  PromoteRequestHookMessage,
} from "./hook-protocol.js";
import { applyHookAdapters, resolveForwarderPath } from "./hook-adapters/index.js";

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
// reattach at all: the scrollback ring buffer below is a continuous,
// gap-free record of everything the session produced while unwatched, so
// replaying it reconstructs the screen exactly. A fresh OS-level `dtach -a`
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
}

export interface SessionInfo {
  id: string;
  cwd: string;
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
}

type DataListener = (chunk: Buffer) => void;
type ExitListener = () => void;

// Phase 1's notification event model (issue #166) — a structured, replayable
// record of the byte-driven "something happened" moments a session produces,
// distinct from `SessionInfo`'s poll-derived snapshot fields above. `seq` is
// per-session and monotonic (starts at 1), not globally unique — a consumer
// keys read/unread state off (sessionId, seq) together, never seq alone
// (two different sessions both legitimately have a seq:1). `file_change` and
// `review_gate` (Phase 2, issue #176) are the first two kinds sourced from
// the structured hook channel (src/plugins/hooks.ts) rather than PTY
// parsing — exactly the extension the original closed set anticipated, with
// no shape change needed here. Deliberately does NOT include a
// `working`/`idle` kind — see Session.onData's own comment on why activity
// stays poll-derived.
export interface NotificationEvent {
  seq: number;
  sessionId: number;
  kind:
    | "attention"
    | "status_change"
    | "title_change"
    | "file_change"
    | "review_gate"
    | "promote_request";
  ts: number;
  payload: Record<string, unknown>;
}

type EventListener = (event: NotificationEvent) => void;

// Cap on each session's own event ring buffer — mirrors SCROLLBACK_MAX_BYTES's
// FIFO-eviction shape (pushScrollback below) but bounded by count rather than
// bytes, since events are small structured records, not raw terminal bytes.
const EVENTS_MAX = 100;

// Enough for a healthy amount of scrollback history, not just "the last
// screen" — raised from the original 256KiB (issue #83) because that cap and
// xterm's own line-based scrollback (DEFAULT_SETTINGS.terminal.scrollback in
// settings.ts) were both starving real history, especially once nudgeRedraw()
// repaints (see NUDGE_REPAINT_GRACE_MS below) are folded in too. Keep this
// roughly proportionate to that line cap if either changes — at typical line
// widths they trade off against each other, so raising one alone barely
// helps.
const SCROLLBACK_MAX_BYTES = 1024 * 1024;

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

// How long after nudgeRedraw()'s final resize to keep suppressing the
// synthesized repaint (see Session.suppressSynthesizedOutput). The repaint a
// resize provokes arrives asynchronously — SIGWINCH, then whatever the TUI
// takes to re-render — not synchronously with the resize() call, so the
// window has to extend past it rather than closing the instant the last
// resize() returns.
const NUDGE_REPAINT_GRACE_MS = 500;

// A session showing no output for this long is considered "idle" rather
// than "working" — a coarse, admittedly heuristic threshold (see the plan's
// WS-6: we plumb activity timing, we don't over-promise a precise
// "waiting for input" classifier). Fallback used when a caller doesn't pass
// its own threshold (mirrors DEFAULT_SETTINGS.notifications.idleThresholdSeconds
// in services/settings.ts); routes/sessions.ts passes the live,
// server-persisted value from Settings -> Notifications & status instead.
const IDLE_THRESHOLD_MS = 2_000;

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
// `hooksActive` session instead — see Session.tick()'s doc comment. A hook
// agent's own Stop/session.idle hook is the normal, authoritative way its
// session's attention gets set, but that hook message travels over a
// separate process (the forwarder subprocess) and socket that can itself
// die or wedge — a killed agent process, a crashed forwarder, a hook socket
// that never connects — none of which stop this evaluator from running.
// Without SOME fallback, a session in that state would never surface
// attention at all, silently worse than the pre-`hooksActive` behavior this
// PR otherwise improves on. Deliberately much longer than
// SUSTAINED_SILENCE_MS (which a hook agent's own multi-chunk startup splash
// render can spuriously satisfy in ~1-2s, the false positive this PR fixes)
// — no legitimate startup render comes close to a full minute, so this bound
// only ever fires for a genuinely broken hook pipeline, not a slow splash.
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

// Deterministic (no timestamp) so a *future* process — one that never
// tracked this session in memory at all, e.g. right after a restart — can
// still reference the exact same scope to fully terminate it. See
// PtyManager.terminate().
function scopeUnitName(id: string): string {
  return `crs-session-${id}`;
}

/** Stop a session's systemd scope, killing its dtach master + program. Safe
 * to call even if the scope doesn't exist or is already gone. */
function stopScope(id: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawnChild("systemctl", ["--user", "stop", `${scopeUnitName(id)}.scope`], {
      stdio: "ignore",
    });
    // "unit not loaded" (already stopped / never existed) is an expected,
    // ignorable outcome here — this is a best-effort cleanup, not a
    // correctness-critical step whose failure should propagate.
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
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
  // meant to know or guess another session's token. Generated once at
  // construction, injected into this session's own env (bootstrapMaster()
  // below), and never persisted or logged. Not a defense against this
  // session's own children forging messages (they inherit it, same as any
  // other env var) — only against a *different* session on the same shared
  // socket impersonating this one.
  readonly hookToken: string;
  // The shared hook-socket path every session (and PtyManager's own
  // src/plugins/hooks.ts listener) uses — same value for every session in
  // this process, unlike hookToken above. Passed in from PtyManager rather
  // than derived locally so there's exactly one source of truth for it (see
  // PtyManager.hookSocketPath).
  readonly hookSocketPath: string;
  // Mirrors app.config.MULLION_REVIEW_GATE_ENABLED (default false), passed
  // down from PtyManager — see applyHookAdapters' ctx in bootstrapMaster()
  // below. Determines whether the Claude Code adapter registers the
  // blocking PreToolUse review gate for this session's launch.
  private readonly reviewGateEnabled: boolean;

  private ptyProcess: IPty | null = null;
  private cols: number;
  private rows: number;
  private scrollback: Buffer[] = [];
  private scrollbackBytes = 0;
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
  // True while a nudgeRedraw() repaint is in flight — see nudgeRedraw()'s
  // suppression window. Deliberately dual-purpose (two call sites in onData
  // below both check it) rather than two separate flags with the same
  // lifecycle, since both readings are really the same fact — "this chunk is
  // OUR synthesized repaint, not real program content" — just applied to two
  // different consumers:
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
  // A future change to this field's lifecycle (e.g. narrowing the window for
  // scrollback reasons alone) affects BOTH consumers — keep this comment and
  // both call sites in sync if that ever happens.
  private suppressSynthesizedOutput = false;
  // Handle for whichever stage (dip / restore / grace-reset) of the current
  // nudgeRedraw() cycle is still pending — see cancelPendingNudge()'s doc
  // comment for why this must be tracked at all. A single nullable handle
  // rather than a list: the three stages are strictly sequential (each
  // schedules the next from inside its own callback), so at most one is ever
  // outstanding at a time.
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
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

  // Issue #271, option 2 — see SessionInfo.promoteState's doc comment. Set
  // from emitHookEvent's "promote_request" case and from resolvePromote()
  // below; read by toInfo().
  private promoteState: "idle" | "pending" | "accepted" | "declined" = "idle";
  private promoteSummary: string | null = null;
  private promoteSuggestedBaseRef: string | null = null;
  // Last title-derived working/idle read (classifyActivityFromTitle), kept
  // ONLY to detect the #98 working->idle TRANSITION (a program that was
  // working just went idle — "ready for input") — distinct from `activity`
  // in toInfo(), which recomputes this from scratch on every poll and has
  // no memory of the previous read.
  private lastTitleActivity: "working" | "idle" | null = null;
  private lastTitle: string | null = null;
  // Ms-epoch of the last write() call (user keystrokes, plus a couple of
  // automated terminal-protocol replies routed through the same browser->pty
  // channel — see USER_INPUT_ECHO_MS's docstring). Used by toInfo()'s timing
  // fall-through to tell keystroke echo apart from autonomous output.
  private lastUserInputAt: number | null = null;
  // Set once spawn() learns whether applyHookAdapters actually matched this
  // session's command to a real hook adapter (Claude Code/opencode/codex/agy)
  // — see AppliedHooks.matched's own docstring. Gates Session.tick()'s
  // byte-driven sustained-silence guess: a hook agent's own Stop/
  // session.idle hook (routed through emitHookEvent's "progress"/"done" case
  // into the `agentIdle` signal) is authoritative, so the byte guess — which
  // can't tell a real "went quiet after work" apart from this same agent's
  // own startup splash render — only runs for hookless sessions (plain
  // shells, unrecognized commands).
  private hooksActive = false;

  constructor(opts: {
    id: string;
    cwd: string;
    command: string;
    socketPath: string;
    cols: number;
    rows: number;
    hookSocketPath: string;
    reviewGateEnabled?: boolean;
  }) {
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.command = opts.command;
    this.socketPath = opts.socketPath;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.createdAt = Date.now();
    this.hookSocketPath = opts.hookSocketPath;
    this.reviewGateEnabled = opts.reviewGateEnabled ?? false;
    // 24 random bytes -> 48 hex chars: same order of magnitude as the
    // MULLION_AGENT_TOKEN/MULLION_AUTH_TOKEN guidance elsewhere in this repo
    // (openssl rand -hex 32), generated in-process here since this is a
    // per-session, ephemeral secret rather than an operator-configured one.
    this.hookToken = crypto.randomBytes(24).toString("hex");
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
  }

  get isAlive(): boolean {
    return this.ptyProcess !== null;
  }

  get subscriberCount(): number {
    return this.dataListeners.size;
  }

  private spawning: Promise<void> | null = null;

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
   */
  spawn(): void {
    if (this.ptyProcess || this.spawning) return;
    this.spawning = this.spawnInternal()
      .catch((err) => {
        console.error(`[pty-manager] failed to spawn session ${this.id}:`, err);
      })
      .finally(() => {
        this.spawning = null;
      });
  }

  private async spawnInternal(): Promise<void> {
    if (!(await this.socketIsLive())) {
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

  private socketIsLive(): Promise<boolean> {
    if (!existsSync(this.socketPath)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const probe = net.createConnection(this.socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
  }

  /** Create the dtach master and exit — no attach, nothing to track. */
  private bootstrapMaster(): Promise<void> {
    const shell = process.env.SHELL || "/bin/bash";
    const unitName = scopeUnitName(this.id);
    // Strip this server's own Mullion config (PORT, DATABASE_URL,
    // SESSIONS_DIR, secrets, ...) before it reaches the session's shell — a
    // session must not inherit the identity of the process that spawned it,
    // e.g. a `make dev` run from inside this session must not see this
    // process's PORT/DATABASE_URL (issue #70). See session-env.ts.
    const sessionEnv = buildSessionEnv();
    // Phase 2 (issue #172): injected AFTER the scrub above (not before), so
    // this session's own hook socket/token survive it — SERVER_ENV_KEYS lists
    // both purely so a *nested* Mullion re-scrubs them from ITS OWN sessions,
    // not so buildSessionEnv() strips them from this one. An agent that
    // ignores these two vars is completely unaffected: the socket exists but
    // nothing ever connects.
    sessionEnv.MULLION_HOOK_SOCKET = this.hookSocketPath;
    sessionEnv.MULLION_HOOK_TOKEN = this.hookToken;

    // Phase 2 (issue #174): if `this.command` matches a known agent with a
    // hook adapter (currently just Claude Code), rewrite the command/env for
    // this launch only — see hook-adapters/index.ts's applyHookAdapters for
    // the defensive-fallback behavior (any adapter failure launches the
    // original, unmodified command instead of failing the session outright).
    // `sessionsDir` is derived from hookSocketPath (`<sessionsDir>/hooks.sock`,
    // see PtyManager's constructor) rather than threaded through as its own
    // field, since this is the only place that needs it.
    const {
      command: launchCommand,
      envAdditions,
      matched,
    } = applyHookAdapters(this.command, {
      sessionId: this.id,
      sessionsDir: path.dirname(this.hookSocketPath),
      hookSocketPath: this.hookSocketPath,
      hookToken: this.hookToken,
      forwarderPath: resolveForwarderPath(),
      reviewGateEnabled: this.reviewGateEnabled,
    });
    Object.assign(sessionEnv, envAdditions);
    this.hooksActive = matched;

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
      const child = spawnChild(
        "systemd-run",
        [
          "--user",
          "--scope",
          "--collect",
          "-u",
          unitName,
          "--",
          "dtach",
          "-n",
          this.socketPath,
          shell,
          "-lc",
          launchCommand,
        ],
        { cwd: this.cwd, env: sessionEnv, stdio: "ignore" },
      );
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`master bootstrap exited with code ${code} (unit ${unitName})`));
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
      // Skipped during a nudgeRedraw() repaint window — see
      // suppressSynthesizedOutput's docstring. Listeners below still get it live.
      if (!this.suppressSynthesizedOutput) this.pushScrollback(chunk);

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
          this.emitEvent("title_change", { title: signals.titleChange });
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
      // bare "output" input — the ONLY thing that can CLEAR a confirmed
      // attention flag (see clearAttention()) — must NOT be fed during
      // requestRedraw()'s synthetic dip/restore repaint: that repaint is
      // output WE caused by resizing the pty, not the program resuming work,
      // and feeding it as `{type:"output"}` would clear a "needs permission"
      // flag the instant the user merely opens the workspace tab. Reuses the
      // same suppressSynthesizedOutput flag that gates scrollback capture one
      // guard above — see its docstring for why one flag deliberately serves
      // both. Real output confirming an actual resolution still arrives once
      // the grace window ends and clears normally.
      if (candidateKind !== null) {
        this.applyAttentionTransition(
          advanceAttention(this.attentionState, { type: "signal", kind: candidateKind, now }),
        );
      } else if (!this.suppressSynthesizedOutput) {
        this.applyAttentionTransition(
          advanceAttention(this.attentionState, { type: "output", now }),
        );
      }

      for (const listener of this.dataListeners) listener(chunk);
    });

    ptyProcess.onExit(() => {
      this.ptyProcess = null;
      // Cancels any nudge timer still pending against this now-dead client —
      // not just for the suppressSynthesizedOutput tidiness noted below, but because
      // a stale dip/restore timer left running would fire against whichever
      // NEW attach-client a later respawn creates (the closure captures
      // `this`, not the pty instance), mis-resizing an unrelated process
      // incarnation. See cancelPendingNudge()'s own doc comment.
      this.cancelPendingNudge();
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
    this.nudgeRedraw();
  }

  /**
   * Force a real repaint on every fresh attach by resizing away from and
   * back to the current size. Milestone 1 found empirically that dtach's own
   * `-r winch` redraw request is not enough on its own: Claude's Ink-based
   * TUI only re-renders when it detects an actual dimension change (Node's
   * tty resize-event machinery itself skips firing if the reported size is
   * unchanged), so reattaching at the *same* size — the common case, since a
   * reconnecting browser tab typically fits to the same window — produced a
   * blank screen even with winch. A same-size nudge (±1 row) wasn't a big
   * enough delta to reliably trigger it either; a proportionally larger dip
   * (half the rows, floor of 4) was. This runs on every attach regardless of
   * whether the size actually changed, so a real resize from the client
   * still lands correctly on top of it.
   *
   * @param suppressCapture Skip buffering the repaint this nudge provokes
   * into scrollback, and don't let it clear attention either (see
   * suppressSynthesizedOutput's docstring). Only set by
   * requestRedraw()'s reattach path, where the SAME repaint recurs on every
   * reconnect and would otherwise progressively evict real output from the
   * ring buffer. The initial spawn-time nudge from attachClient() below
   * deliberately does NOT set this — that repaint is the session's actual
   * starting screen state and is exactly what a later attach should see.
   */
  private nudgeRedraw(suppressCapture = false): void {
    // Supersede (never stack with) any cycle already in flight — see
    // cancelPendingNudge()'s doc comment for why. Must run BEFORE the
    // suppressCapture assignment below: cancelling clears
    // suppressSynthesizedOutput when it was left set by a cycle it's
    // aborting, so doing this after would immediately wipe out the
    // suppression this very call is about to set.
    this.cancelPendingNudge();
    // Suppress scrollback capture (and attention-clearing) for the whole
    // dip-then-restore cycle plus a grace period past the final resize — see
    // suppressSynthesizedOutput's docstring for why the window has to extend
    // past resize() returning.
    if (suppressCapture) this.suppressSynthesizedOutput = true;
    const dipRows = Math.max(4, Math.floor(this.rows / 2));
    this.nudgeTimer = setTimeout(() => this.nudgeDip(dipRows, suppressCapture), 300);
  }

  // The dip/restore/grace-reset stages below are split into named steps
  // (rather than nesting them as inline closures inside nudgeRedraw) purely
  // for readability — each one's single job reads on its own instead of
  // three levels deep. They still form one strictly-sequential chain, each
  // scheduling the next via `this.nudgeTimer`, which is exactly what makes a
  // single handle (rather than a list of timers) enough to track and cancel
  // the whole in-flight cycle from cancelPendingNudge().

  private nudgeDip(dipRows: number, suppressCapture: boolean): void {
    this.ptyProcess?.resize(this.cols, dipRows);
    this.nudgeTimer = setTimeout(() => this.nudgeRestore(suppressCapture), 400);
  }

  private nudgeRestore(suppressCapture: boolean): void {
    this.ptyProcess?.resize(this.cols, this.rows);
    if (suppressCapture) {
      this.nudgeTimer = setTimeout(() => this.nudgeGraceReset(), NUDGE_REPAINT_GRACE_MS);
    } else {
      this.nudgeTimer = null;
    }
  }

  private nudgeGraceReset(): void {
    this.suppressSynthesizedOutput = false;
    this.nudgeTimer = null;
  }

  /**
   * Cancel whichever stage of a nudgeRedraw() cycle is currently pending, so
   * a new nudge always supersedes rather than interleaves with a prior one.
   * Without this, two overlapping cycles on the same shared Session (e.g. a
   * second reattach — two browser tabs, or reconnect retries — landing
   * while a first cycle's dip/restore/grace-reset timers are still ticking)
   * can let an EARLIER cycle's grace-reset clear suppressSynthesizedOutput
   * while a LATER cycle's own dip/restore repaint is still in flight, letting
   * that repaint's reduced-height frame leak into scrollback (or clear
   * attention) and get replayed to a future attach. Cancelling also takes
   * over the responsibility of clearing suppressSynthesizedOutput: the timer
   * that would have done so (this cycle's own grace-reset) is exactly what's
   * being cancelled, so leaving suppression untouched here would strand it on
   * indefinitely.
   */
  private cancelPendingNudge(): void {
    if (this.nudgeTimer !== null) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    if (this.suppressSynthesizedOutput) this.suppressSynthesizedOutput = false;
  }

  /**
   * Record a notification event into this session's ring buffer and fan it
   * out to live subscribers (mirrors pushScrollback's FIFO-eviction shape
   * and dataListeners' fan-out shape respectively). Only ever called from
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
   * Routes one validated hook message (issue #173's protocol, see
   * hook-protocol.ts) into this session's notification event model (issue
   * #176) — the structured-channel counterpart of the byte-driven
   * emitEvent()/applyAttentionTransition() call sites above. `notification`
   * and `review_gate` (state "waiting") additionally drive the attention
   * state machine via emitAttentionSignalWithExtras() below, so
   * SessionInfo.attention/attentionAt — and everything that reads them
   * (Kanban's "Needs Attention" column, the sidebar's status dot) — react
   * too, not just the event feed. `fork`/`join` are validated by the
   * protocol layer but not surfaced here at all yet — that's Phase 5's
   * subagent-awareness work; a future/unrecognized kind the protocol layer
   * already accepts verbatim (extensibility) is likewise a no-op here until
   * a later phase teaches this method about it.
   */
  emitHookEvent(message: HookMessage): void {
    switch (message.kind) {
      case "notification":
        this.emitAttentionSignalWithExtras("hookNotification", {
          title: message.title,
          body: message.body,
        });
        return;
      case "progress":
        this.emitEvent("status_change", { phase: message.phase });
        // "done" is the agent's own authoritative "my turn is over" signal
        // (Claude Code's Stop hook, opencode's session.idle, codex/agy's
        // Stop — see forwarder-core.mjs/opencode-plugin.js) — drive
        // attention off it directly rather than waiting on Session.tick's
        // byte-driven sustained-silence guess, which can't tell a genuine
        // "went quiet after work" apart from a brand-new terminal's startup
        // splash render (see tick()'s hooksActive guard).
        if (message.phase === "done") {
          this.emitAttentionSignalWithExtras("agentIdle", {});
        }
        return;
      case "file_change":
        this.emitEvent("file_change", { path: message.path, action: message.action });
        return;
      case "review_gate": {
        // HookMessage's `UnknownHookMessage` fallback has a `kind: string`
        // (not a literal) plus a `[key: string]: unknown` index signature,
        // so TS can't discriminate `message` down to just
        // ReviewGateHookMessage from `message.kind === "review_gate"`
        // alone — reading `.state`/`.prompt` off the still-widened union
        // resolves to `unknown`. Safe to assert narrow here: the protocol
        // layer's validateReviewGate (hook-protocol.ts) only ever produces
        // a real ReviewGateHookMessage for this kind, never
        // UnknownHookMessage.
        const gate = message as ReviewGateHookMessage;
        this.gateState = gate.state;
        this.gatePrompt = gate.state === "waiting" ? gate.prompt : null;
        this.emitEvent("review_gate", { state: gate.state, prompt: gate.prompt });
        if (gate.state === "waiting") {
          this.emitAttentionSignalWithExtras("reviewGate", { prompt: gate.prompt });
        }
        return;
      }
      case "fork":
      case "join":
        return;
      case "promote_request": {
        // Same TS-narrowing reasoning as the review_gate case above: safe to
        // assert narrow since hook-protocol.ts's validatePromoteRequest only
        // ever produces a real PromoteRequestHookMessage for this kind.
        const promote = message as PromoteRequestHookMessage;
        this.promoteState = "pending";
        this.promoteSummary = promote.summary;
        this.promoteSuggestedBaseRef = promote.suggestedBaseRef ?? null;
        this.emitEvent("promote_request", {
          summary: promote.summary,
          suggestedBaseRef: promote.suggestedBaseRef ?? null,
        });
        this.emitAttentionSignalWithExtras("promoteRequest", { summary: promote.summary });
        return;
      }
      case "session_start":
        // Answered directly by hooks.ts (it needs app.pty.consumeSeed, which
        // this Session-scoped method has no access to) — never reaches here.
        return;
      default:
        return;
    }
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
   * shows the outcome, not just the original prompt. Does not force-clear
   * the attention state machine: the tool call this unblocks (or the
   * agent's own denial handling) produces PTY output imminently either way,
   * which already clears attention via the existing output-driven path —
   * adding a second, gate-specific clear input to attention-detect.ts's
   * state machine isn't worth it for this one call site.
   */
  resolveGate(decision: "approved" | "denied", reason?: string): void {
    this.gateState = decision;
    this.gatePrompt = null;
    this.emitEvent("review_gate", { state: decision, ...(reason !== undefined ? { reason } : {}) });
  }

  /**
   * Resolves a pending promote request (issue #271) — called from
   * PtyManager.resolvePromote, itself called from hooks.ts's
   * app.resolvePendingPromote once POST /api/sessions/:id/promote or
   * .../promote/decline delivers a real decision. Same "not driven by
   * another incoming hook message" reasoning as resolveGate above: the
   * `promote_to_worktree` MCP tool call this unblocks prints its own result
   * and returns, it never sends a follow-up `promote_request` line.
   */
  resolvePromote(decision: "accepted" | "declined"): void {
    this.promoteState = decision;
    this.promoteSummary = null;
    this.promoteSuggestedBaseRef = null;
    this.emitEvent("promote_request", { state: decision });
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
   * review gate, so the same always-emit semantics apply.
   */
  private emitAttentionSignalWithExtras(
    kind: Extract<
      AttentionSignalKind,
      "hookNotification" | "reviewGate" | "agentIdle" | "promoteRequest"
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
   *    all, so they always use the short SUSTAINED_SILENCE_MS bound.
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

  private pushScrollback(chunk: Buffer): void {
    this.scrollback.push(chunk);
    this.scrollbackBytes += chunk.length;
    while (this.scrollbackBytes > SCROLLBACK_MAX_BYTES && this.scrollback.length > 1) {
      const dropped = this.scrollback.shift();
      if (dropped) this.scrollbackBytes -= dropped.length;
    }
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
    return Buffer.concat([preamble, ...this.scrollback]);
  }

  write(data: string): void {
    this.ptyProcess?.write(data);
    this.lastUserInputAt = Date.now();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    // Resizing the pty our dtach attach-client lives in delivers SIGWINCH to
    // it, which dtach forwards into the session — the same mechanism a real
    // resized SSH terminal would trigger. No special-casing needed here.
    //
    // Deliberately does NOT cancel a pending nudgeRedraw() cycle (unlike
    // kill()/onExit below). It's tempting to think a real resize already
    // forces its own repaint, making a pending synthetic dip/restore
    // redundant — but the frontend's on-open resize (TerminalPane.tsx,
    // sendResizeIfOpen) has no delta guard and fires on every attach even
    // when the size is unchanged, which lands here as a same-size resize().
    // A same-size resize is a kernel-level TIOCSWINSZ no-op (no SIGWINCH) —
    // see nudgeRedraw()'s own docstring. If this cancelled the pending nudge,
    // the nudge (the only thing that would force a repaint) would never run,
    // reintroducing the exact blank-screen-on-reconnect bug nudgeRedraw()
    // exists to fix. So any pending nudge must run to completion regardless
    // of what resize() does in the meantime — its restore stage reads
    // this.cols/this.rows live, so it still lands at the right size either
    // way.
    this.ptyProcess?.resize(cols, rows);
  }

  /**
   * Force a repaint on an already-alive session that a fresh attach would
   * otherwise not get: attachClient() nudges on every spawn/respawn, but a
   * reattach to a still-alive client never respawns, so it must ask
   * explicitly (see attachSocketToSession's `wasAlive` check in
   * routes/terminal.ts). Safe to call any time — nudgeRedraw()'s optional
   * chaining no-ops if the client has since died. Passes suppressCapture:
   * true — see nudgeRedraw()'s docstring for why this path (unlike the
   * initial spawn-time nudge) shouldn't buffer its own repaint.
   */
  requestRedraw(): void {
    const suppressCapture = true;
    this.nudgeRedraw(suppressCapture);
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
    // See cancelPendingNudge()'s doc comment: without this, a pending nudge
    // timer would survive this kill and fire against whatever NEW
    // attach-client a later respawn of this same Session creates. Covers
    // every higher-level teardown path transitively — PtyManager.killAll()
    // and session-reconciler.ts both route through PtyManager.kill() ->
    // Session.kill(), as does terminate() before its own stopScope() call.
    this.cancelPendingNudge();
    this.ptyProcess?.kill();
    this.ptyProcess = null;
    // Unlike inAltScreen/mouseTracking (which deliberately persist across a
    // respawn — they track true, ongoing screen/mouse state), detectCarry is
    // just a byte-stream artifact of wherever the old attach-client's last
    // chunk happened to end. It carries no meaning once that stream is gone,
    // so clear it rather than risk it being misread as a prefix of the new
    // attach-client's first chunk.
    this.detectCarry = "";
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
      promoteState: this.promoteState,
      promoteSummary: this.promoteSummary,
      promoteSuggestedBaseRef: this.promoteSuggestedBaseRef,
    };
  }
}

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

  constructor(opts: { sessionsDir: string; reviewGateEnabled?: boolean }) {
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
    this.reviewGateEnabled = opts.reviewGateEnabled ?? false;

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
        reviewGateEnabled: this.reviewGateEnabled,
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
      session.spawn();
    }
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.toInfo());
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
    // A killed session's Session object (and its hookToken) is discarded
    // here — getOrCreate() constructs a brand-new Session, with a brand-new
    // token, the next time this id is requested. Removing the stale token
    // now (rather than leaving it resolvable forever) keeps resolveToken()
    // from matching hook messages against a token no live session still
    // holds.
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
   */
  async terminate(id: string): Promise<void> {
    this.kill(id);
    await stopScope(id);
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
   * the program running inside it, per terminate()'s doc comment above —
   * is still active. False for "inactive" (the program exited on its own;
   * dtach exits with its child and the `--collect` scope is then reaped),
   * "failed", or "unknown" (never existed), and for any spawn error. This
   * is the source of truth session-reconciler.ts polls to catch a program
   * that exited without an explicit DELETE /api/sessions/:id — deliberately
   * NOT based on anything tracked in this process's memory, so it works
   * correctly even right after a restart, before anything has re-attached.
   */
  isMasterAlive(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      let stdout = "";
      const child = spawnChild("systemctl", ["--user", "is-active", `${scopeUnitName(id)}.scope`], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", () => resolve(false));
      // 'close', not 'exit' — see agent-detect.ts's probe() for the exact
      // same race this avoids: 'exit' fires once the process itself has
      // ended, but doesn't guarantee every stdout 'data' chunk has been
      // delivered yet, which reconcileExitedSessions() polling many
      // sessions concurrently could hit in the same way.
      child.on("close", () => resolve(stdout.trim() === "active"));
    });
  }
}
