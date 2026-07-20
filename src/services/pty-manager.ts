import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { detectAttentionSignals, classifyActivityFromTitle } from "./attention-detect.js";

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
   * prompt-draw burst doesn't count), else "idle" — a coarse heuristic, not
   * a real "is the program busy" signal. */
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

// Enough for a handful of full-screen repaints of a typical TUI; more than
// enough to reconstruct "the last screen" without holding unbounded history.
const SCROLLBACK_MAX_BYTES = 256 * 1024;

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
// activity streak — see the streak tracking in onData.
const STREAK_GAP_MS = 2_000;

// An activity streak must span at least this long before it counts as
// "working" rather than a single spawn-time prompt-draw burst.
const SUSTAIN_MS = 1_000;

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
  readonly cwd: string;
  readonly command: string;
  readonly socketPath: string;
  readonly createdAt: number;

  private ptyProcess: IPty | null = null;
  private cols: number;
  private rows: number;
  private scrollback: Buffer[] = [];
  private scrollbackBytes = 0;
  private dataListeners = new Set<DataListener>();
  private exitListeners = new Set<ExitListener>();
  private lastActivityAt: number | null = null;
  private activityStreakStart: number | null = null;
  private attentionAt: number | null = null;
  private lastTitle: string | null = null;

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
        { cwd: this.cwd, env: process.env, stdio: "ignore" },
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
        env: process.env,
      },
    );

    ptyProcess.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      this.pushScrollback(chunk);

      // A bell arriving mid-burst was a work-in-progress notification, not a
      // "waiting for input" signal — clear the sticky attention flag. Reads
      // the PREVIOUS chunk's timestamp, before it's overwritten below.
      if (this.attentionAt !== null && this.lastActivityAt !== null) {
        if (Date.now() - this.lastActivityAt < ATTENTION_CLEAR_WINDOW_MS) {
          this.attentionAt = null;
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
      if (signals.bell || signals.notification) this.attentionAt = Date.now();
      if (signals.titleChange !== null) this.lastTitle = signals.titleChange;

      for (const listener of this.dataListeners) listener(chunk);
    });

    ptyProcess.onExit(() => {
      this.ptyProcess = null;
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
   */
  private nudgeRedraw(): void {
    const dipRows = Math.max(4, Math.floor(this.rows / 2));
    setTimeout(() => {
      this.ptyProcess?.resize(this.cols, dipRows);
      setTimeout(() => {
        this.ptyProcess?.resize(this.cols, this.rows);
      }, 400);
    }, 300);
  }

  private pushScrollback(chunk: Buffer): void {
    this.scrollback.push(chunk);
    this.scrollbackBytes += chunk.length;
    while (this.scrollbackBytes > SCROLLBACK_MAX_BYTES && this.scrollback.length > 1) {
      const dropped = this.scrollback.shift();
      if (dropped) this.scrollbackBytes -= dropped.length;
    }
  }

  /** Everything currently buffered, oldest first — replay this to a newly-attaching client. */
  getScrollback(): Buffer {
    return Buffer.concat(this.scrollback);
  }

  write(data: string): void {
    this.ptyProcess?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    // Resizing the pty our dtach attach-client lives in delivers SIGWINCH to
    // it, which dtach forwards into the session — the same mechanism a real
    // resized SSH terminal would trigger. No special-casing needed here.
    this.ptyProcess?.resize(cols, rows);
  }

  /**
   * Force a repaint on an already-alive session that a fresh attach would
   * otherwise not get: attachClient() nudges on every spawn/respawn, but a
   * reattach to a still-alive client never respawns, so it must ask
   * explicitly (see attachSocketToSession's `wasAlive` check in
   * routes/terminal.ts). Safe to call any time — nudgeRedraw()'s optional
   * chaining no-ops if the client has since died.
   */
  requestRedraw(): void {
    this.nudgeRedraw();
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
    this.ptyProcess?.kill();
    this.ptyProcess = null;
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
      activity = recent && sustained ? "working" : "idle";
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
