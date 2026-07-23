import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import net from "node:net";
import path from "node:path";
import {
  detectAttentionSignals,
  classifyActivityFromTitle,
  detectAltScreenSwitch,
  applyMouseModeChanges,
  carryPartialEscape,
  INITIAL_MOUSE_TRACKING_STATE,
  type MouseTrackingState,
} from "./attention-detect.js";
import { buildSessionEnv } from "./session-env.js";

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
  /** True once a BEL or OSC 9/777 notification sequence has been observed
   * without being cleared since — see the attention-clear check in
   * Session.spawn()'s onData, which treats a bell followed by another chunk
   * within ATTENTION_CLEAR_WINDOW_MS as a work-in-progress ping rather than
   * a "waiting for input" signal. */
  attention: boolean;
  /** Ms-epoch of the most recent attention signal, or null if none yet. */
  attentionAt: number | null;
  /** Payload of the most recent OSC 0/2 title-change sequence — consulted by
   * classifyActivityFromTitle() for a fast-path "working"/"idle" read on
   * agent CLIs that self-report their status in the title. */
  lastTitle: string | null;
}

type DataListener = (chunk: Buffer) => void;
type ExitListener = () => void;

// Phase 1's notification event model (issue #166) — a structured, replayable
// record of the byte-driven "something happened" moments a session produces,
// distinct from `SessionInfo`'s poll-derived snapshot fields above. `seq` is
// per-session and monotonic (starts at 1), not globally unique — a consumer
// keys read/unread state off (sessionId, seq) together, never seq alone
// (two different sessions both legitimately have a seq:1). `kind` is
// deliberately a small closed set for this PR; the roadmap's later phases
// extend it (`file_change`, `review_gate`, ...) without needing a shape
// change here. Deliberately does NOT include a `working`/`idle` kind — see
// Session.onData's own comment on why activity stays poll-derived.
export interface NotificationEvent {
  seq: number;
  sessionId: number;
  kind: "attention" | "status_change" | "title_change";
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

// How long after nudgeRedraw()'s final resize to keep suppressing scrollback
// capture (see Session.suppressScrollback). The repaint a resize provokes
// arrives asynchronously — SIGWINCH, then whatever the TUI takes to
// re-render — not synchronously with the resize() call, so the window has to
// extend past it rather than closing the instant the last resize() returns.
const NUDGE_REPAINT_GRACE_MS = 500;

// A session showing no output for this long is considered "idle" rather
// than "working" — a coarse, admittedly heuristic threshold (see the plan's
// WS-6: we plumb activity timing, we don't over-promise a precise
// "waiting for input" classifier). Fallback used when a caller doesn't pass
// its own threshold (mirrors DEFAULT_SETTINGS.notifications.idleThresholdSeconds
// in services/settings.ts); routes/sessions.ts passes the live,
// server-persisted value from Settings -> Notifications & status instead.
const IDLE_THRESHOLD_MS = 2_000;

// A bell/notification arriving mid-burst (another chunk within this window
// either side of it) is a work-in-progress ping, not a "waiting for input"
// signal — see the attention-clear check in Session.spawn()'s onData.
const ATTENTION_CLEAR_WINDOW_MS = 2_000;

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
  // suppression window. While set, onData still fans chunks out to live
  // subscribers (a reconnecting client must see the repaint) but does not
  // buffer them into scrollback, so repeated reconnect-triggered repaints
  // don't evict real user output from the ring buffer.
  private suppressScrollback = false;
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
  private attentionAt: number | null = null;
  private lastTitle: string | null = null;
  // Ms-epoch of the last write() call (user keystrokes, plus a couple of
  // automated terminal-protocol replies routed through the same browser->pty
  // channel — see USER_INPUT_ECHO_MS's docstring). Used by toInfo()'s timing
  // fall-through to tell keystroke echo apart from autonomous output.
  private lastUserInputAt: number | null = null;

  constructor(opts: {
    id: string;
    cwd: string;
    command: string;
    socketPath: string;
    cols: number;
    rows: number;
  }) {
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.command = opts.command;
    this.socketPath = opts.socketPath;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.createdAt = Date.now();
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
          this.command,
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
      // suppressScrollback's docstring. Listeners below still get it live.
      if (!this.suppressScrollback) this.pushScrollback(chunk);

      // Prepend any carry from the previous chunk so a `?1049h`/mouse-mode
      // DECSET split across two PTY reads is still recognized — detection
      // only, `data`/`chunk` above are untouched (see detectCarry's
      // docstring; feeding this into scrollback or the fan-out below would
      // duplicate the carried bytes in the replayed stream).
      const detectChunk = this.detectCarry + data;
      const altScreenSwitch = detectAltScreenSwitch(detectChunk);
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
          this.inAltScreen = nowInAltScreen;
          this.emitEvent("status_change", { screen: altScreenSwitch });
        }
      }
      this.mouseTracking = applyMouseModeChanges(detectChunk, this.mouseTracking);
      this.detectCarry = carryPartialEscape(detectChunk);

      // A bell arriving mid-burst was a work-in-progress notification, not a
      // "waiting for input" signal — clear the sticky attention flag. Reads
      // the PREVIOUS chunk's timestamp, before it's overwritten below.
      if (this.attentionAt !== null && this.lastActivityAt !== null) {
        if (Date.now() - this.lastActivityAt < ATTENTION_CLEAR_WINDOW_MS) {
          this.attentionAt = null;
          // Issue #166: the clear is itself a byte-driven transition (the
          // NEXT chunk arriving is what proves the earlier bell was
          // work-in-progress, not a real "waiting for input" state) — emit
          // it the same way the initial set below does.
          this.emitEvent("attention", { attention: false });
        }
      }

      const now = Date.now();
      // A gap longer than STREAK_GAP_MS since the last chunk starts a new
      // activity streak — used to tell a single spawn-time prompt-draw burst
      // apart from sustained output (see toInfo()).
      if (this.lastActivityAt === null || now - this.lastActivityAt >= STREAK_GAP_MS) {
        this.activityStreakStart = now;
      }
      this.lastActivityAt = now;

      const signals = detectAttentionSignals(data);
      if (signals.bell || signals.notification) {
        // Transition-guarded: a session already flagged for attention that
        // sees ANOTHER bell/notification before anything clears the first
        // one is still just "still needs attention," not a new transition —
        // only the initial set (false -> true) is byte-driven-transition
        // worthy of its own event (issue #166).
        const wasAttention = this.attentionAt !== null;
        this.attentionAt = Date.now();
        if (!wasAttention) {
          this.emitEvent("attention", {
            attention: true,
            bell: signals.bell,
            notification: signals.notification,
          });
        }
      }
      if (signals.titleChange !== null) {
        if (signals.titleChange !== this.lastTitle) {
          this.emitEvent("title_change", { title: signals.titleChange });
        }
        this.lastTitle = signals.titleChange;
      }

      for (const listener of this.dataListeners) listener(chunk);
    });

    ptyProcess.onExit(() => {
      this.ptyProcess = null;
      // Cancels any nudge timer still pending against this now-dead client —
      // not just for the suppressScrollback tidiness noted below, but because
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
   * into scrollback (see suppressScrollback's docstring). Only set by
   * requestRedraw()'s reattach path, where the SAME repaint recurs on every
   * reconnect and would otherwise progressively evict real output from the
   * ring buffer. The initial spawn-time nudge from attachClient() below
   * deliberately does NOT set this — that repaint is the session's actual
   * starting screen state and is exactly what a later attach should see.
   */
  private nudgeRedraw(suppressCapture = false): void {
    // Supersede (never stack with) any cycle already in flight — see
    // cancelPendingNudge()'s doc comment for why. Must run BEFORE the
    // suppressCapture assignment below: cancelling clears suppressScrollback
    // when it was left set by a cycle it's aborting, so doing this after
    // would immediately wipe out the suppression this very call is about to
    // set.
    this.cancelPendingNudge();
    // Suppress scrollback capture for the whole dip-then-restore cycle plus a
    // grace period past the final resize — see suppressScrollback's
    // docstring for why the window has to extend past resize() returning.
    if (suppressCapture) this.suppressScrollback = true;
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
    this.suppressScrollback = false;
    this.nudgeTimer = null;
  }

  /**
   * Cancel whichever stage of a nudgeRedraw() cycle is currently pending, so
   * a new nudge always supersedes rather than interleaves with a prior one.
   * Without this, two overlapping cycles on the same shared Session (e.g. a
   * second reattach — two browser tabs, or reconnect retries — landing
   * while a first cycle's dip/restore/grace-reset timers are still ticking)
   * can let an EARLIER cycle's grace-reset clear suppressScrollback while a
   * LATER cycle's own dip/restore repaint is still in flight, letting that
   * repaint's reduced-height frame leak into scrollback and get replayed to
   * a future attach. Cancelling also takes over the responsibility of
   * clearing suppressScrollback: the timer that would have done so (this
   * cycle's own grace-reset) is exactly what's being cancelled, so leaving
   * suppression untouched here would strand it on indefinitely.
   */
  private cancelPendingNudge(): void {
    if (this.nudgeTimer !== null) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    if (this.suppressScrollback) this.suppressScrollback = false;
  }

  /**
   * Record a notification event into this session's ring buffer and fan it
   * out to live subscribers (mirrors pushScrollback's FIFO-eviction shape
   * and dataListeners' fan-out shape respectively). Only ever called from
   * genuinely byte-driven (or exit-driven) transitions — see onData/onExit
   * below — never from a poll, so callers don't need their own dedup: each
   * call site already only calls this when its own tracked state actually
   * changed.
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
      attention: this.attentionAt !== null,
      attentionAt: this.attentionAt,
      lastTitle: this.lastTitle,
    };
  }
}

export class PtyManager {
  private sessions = new Map<string, Session>();
  private readonly sessionsDir: string;
  // Manager-level fan-out (issue #166) — mirrors dataListeners/onData()'s
  // Set<listener> + unsubscribe-closure shape, just one layer up: each
  // Session emits to its OWN eventListeners set (above), and getOrCreate()
  // below subscribes once per session to re-emit into this aggregated set,
  // the single subscription point routes/events.ts's /ws/events needs to
  // see every session's events without subscribing to each one individually.
  private eventListeners = new Set<EventListener>();

  constructor(opts: { sessionsDir: string }) {
    // Must be absolute: dtach is spawned with cwd set to the *session's*
    // project directory (e.g. a user's repo), not the server's cwd, so a
    // relative sessionsDir would resolve against the wrong directory and
    // dtach would look for the socket in the wrong place entirely.
    this.sessionsDir = path.resolve(opts.sessionsDir);
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  private socketPathFor(id: string): string {
    return path.join(this.sessionsDir, `${id}.sock`);
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

  /** Kill our tracked attach-client only (detach); the dtach master + program survive. */
  kill(id: string): void {
    try {
      this.sessions.get(id)?.kill();
    } catch (err) {
      // Don't let one already-dead process (e.g. ESRCH) abort killAll()'s
      // loop over every other tracked session.
      console.error(`[pty-manager] error killing session ${id}:`, err);
    }
    this.sessions.delete(id);
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
