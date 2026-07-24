import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
import type * as ChildProcess from "node:child_process";

// PtyManager spawns real OS processes (systemd-run, dtach) — see
// src/services/pty-manager.ts. Milestone 1 already proved the real
// mechanics work empirically against a live Claude Code session; these
// tests are for our own orchestration logic (spawn-once, scrollback
// trimming, listener lifecycle), so node-pty and the systemd-run/dtach
// bootstrap child_process are faked rather than depending on a real
// systemd --user session existing in CI.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<(e: { exitCode: number }) => void> = [];
  cols: number;
  rows: number;
  killed = false;
  writeSpy = vi.fn();
  resizeSpy = vi.fn();

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }

  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitListeners.push(cb);
    return { dispose: () => {} };
  }

  write(data: string) {
    this.writeSpy(data);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resizeSpy(cols, rows);
  }

  kill() {
    this.killed = true;
    for (const cb of this.exitListeners) cb({ exitCode: 0 });
  }

  emitData(chunk: string) {
    for (const cb of this.dataListeners) cb(chunk);
  }
}

vi.mock("node-pty", () => ({
  spawn: vi.fn((_file: string, _args: string[], opts: { cols: number; rows: number }) => {
    const child = new FakePty(opts.cols, opts.rows);
    fakePtyChildren.push(child);
    return child;
  }),
}));

// Maps a scope unit name (e.g. "crs-session-1.scope") to the `systemctl
// is-active` reply isMasterAlive() should see for it; defaults to "active"
// for units not explicitly configured, so tests unrelated to isMasterAlive
// don't need to care about it.
const isActiveReplies: Record<string, string> = {};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[]) => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      if (file === "systemctl" && args[1] === "is-active") {
        ee.stdout = new EventEmitter();
        const unit = args[2];
        const reply = isActiveReplies[unit] ?? "active";
        // 'exit' fires before 'data'/'close' — the exact real race
        // isMasterAlive() must resolve off 'close' to survive; see its own
        // doc comment and agent-detect.ts's probe() for the live bug this
        // guards against.
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            ee.stdout?.emit("data", Buffer.from(`${reply}\n`));
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      // Stands in for `systemd-run --user --scope ... dtach -n ...` and
      // `systemctl --user stop ...`: succeeds immediately with no output,
      // matching a real bootstrap against a socket that doesn't exist yet.
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { PtyManager } = await import("../../src/services/pty-manager.js");

describe("PtyManager", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    fakePtyChildren.length = 0;
    for (const key of Object.keys(isActiveReplies)) delete isActiveReplies[key];
    sessionsDir = path.join(
      os.tmpdir(),
      `pty-manager-test-${crypto.randomBytes(4).toString("hex")}`,
    );
    manager = new PtyManager({ sessionsDir });
  });

  afterEach(() => {
    // Stops PtyManager's own attention-evaluator interval (issue #171/#98) —
    // unref()'d so it can't hang the test runner either way, but leaving it
    // running would keep ticking (and console.debug-logging) an abandoned
    // manager's sessions into later, unrelated tests.
    manager.killAll();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  // spawnInternal() chains an async socket-liveness check with the mocked
  // child_process "exit" event (itself fired via setImmediate) before
  // attachClient() runs — that's more event-loop hops than a single
  // setImmediate flush covers, and how many exactly is an implementation
  // detail we shouldn't hard-code. Poll for the actual condition instead.
  async function waitForSpawn(session: { isAlive: boolean }) {
    for (let i = 0; i < 50; i++) {
      if (session.isAlive) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("session never became alive");
  }

  it("creates and spawns a session on first getOrCreate", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    expect(fakePtyChildren).toHaveLength(1);
    expect(session.isAlive).toBe(true);
  });

  it("reuses the same session object and does not respawn while alive", async () => {
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);
    const second = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });

    expect(second).toBe(first);
    expect(fakePtyChildren).toHaveLength(1);
  });

  it("respawns a fresh attach-client if the tracked one died", async () => {
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);
    fakePtyChildren[0].kill();

    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    expect(session.isAlive).toBe(true);
    expect(fakePtyChildren).toHaveLength(2);
  });

  // getScrollback() always prepends a screen-mode preamble (see pty-manager.ts)
  // — "\x1b[?1049l" while tracked state is primary (the default), so a fresh
  // xterm.js is guaranteed to land with a scrollbar. Assert with a suffix
  // check rather than exact equality so these tests don't hard-code the
  // preamble's own byte content.
  const PRIMARY_PREAMBLE = "\x1b[?1049l";

  it("forwards data to subscribers and buffers it as scrollback", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    const received: Buffer[] = [];
    session.onData((chunk) => received.push(chunk));
    fakePtyChildren[0].emitData("hello");

    expect(received).toHaveLength(1);
    expect(received[0].toString()).toBe("hello");
    expect(session.getScrollback().toString()).toBe(`${PRIMARY_PREAMBLE}hello`);
  });

  it("replays scrollback to a late subscriber without needing a new attach", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    fakePtyChildren[0].emitData("existing output");

    // A second "viewer" joining later (e.g. a reconnecting browser tab)
    // reads getScrollback() directly rather than a fresh dtach attach —
    // this is the no-redraw-needed common case from pty-manager.ts.
    expect(session.getScrollback().toString()).toBe(`${PRIMARY_PREAMBLE}existing output`);
  });

  it("trims scrollback to the configured byte cap", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    // 1 MiB cap — push comfortably past it in large chunks. The preamble is
    // added on top of the cap (it's synthesized at read time, not buffered),
    // so allow a little slack for it.
    const chunk = "x".repeat(256 * 1024);
    for (let i = 0; i < 8; i++) fakePtyChildren[0].emitData(chunk);

    expect(session.getScrollback().length).toBeLessThanOrEqual(1024 * 1024 + 32);
  });

  it("tracks alt-screen state and prepends a matching preamble on replay", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    // Enter alt-screen (e.g. a TUI starting up) with no matching exit yet —
    // the true state is alt, so replay should land a fresh xterm.js there
    // too rather than forcing it back to primary.
    fakePtyChildren[0].emitData("\x1b[?1049hTUI frame");
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h")).toBe(true);

    // Exiting again should flip tracked state back to primary.
    fakePtyChildren[0].emitData("\x1b[?1049lback to shell");
    expect(session.getScrollback().toString().startsWith(PRIMARY_PREAMBLE)).toBe(true);
  });

  it("tracks the legacy ?47 and ?1047 alt-screen pairs too", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?47h");
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h")).toBe(true);

    fakePtyChildren[0].emitData("\x1b[?1047l");
    expect(session.getScrollback().toString().startsWith(PRIMARY_PREAMBLE)).toBe(true);
  });

  it("uses the LAST switch in a chunk when a chunk contains more than one", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1049h...\x1b[?1049l...\x1b[?1049h");
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h")).toBe(true);
  });

  it("still tracks an alt-screen switch when a PTY read splits the escape sequence across two chunks", async () => {
    // Regression test for a real live desync: two consecutive `onData`
    // reads landing mid-sequence (e.g. right after "\x1b[?1049") used to
    // leave `inAltScreen` stuck at its old value forever, since neither
    // half alone matches ALT_SCREEN_SWITCH. See carryPartialEscape in
    // attention-detect.ts.
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("TUI starting\x1b[?1049");
    // Split lands mid-sequence — tracked state must not have flipped yet.
    expect(session.getScrollback().toString().startsWith(PRIMARY_PREAMBLE)).toBe(true);

    fakePtyChildren[0].emitData("hTUI frame");
    // The read that completes the sequence must be the one that flips it.
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h")).toBe(true);

    // And the raw scrollback itself must NOT contain any duplicated bytes
    // from the carry — it's detection-only, never fed into scrollback.
    expect(session.getScrollback().toString()).toBe("\x1b[?1049hTUI starting\x1b[?1049hTUI frame");
  });

  it("still tracks a split mouse-tracking DECSET across two chunks", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("enabling tracking\x1b[?100");
    fakePtyChildren[0].emitData("3h");
    expect(session.getScrollback().toString().startsWith(`${PRIMARY_PREAMBLE}\x1b[?1003h`)).toBe(
      true,
    );
  });

  it("does not carry a dangling partial escape across a kill()+respawn into the new attach-client's stream", async () => {
    // Review follow-up on the split-sequence fix above: a stale
    // detectCarry left over from the OLD attach-client's last chunk must
    // not be prepended to the NEW attach-client's first chunk after a
    // respawn — that byte sequence belongs to a stream that's gone.
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);

    // Leave a dangling partial alt-screen escape uncompleted, then kill.
    fakePtyChildren[0].emitData("TUI starting\x1b[?1049");
    fakePtyChildren[0].kill();

    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    expect(fakePtyChildren).toHaveLength(2);

    // The new attach-client's first chunk happens to complete what WOULD
    // have been the old dangling sequence, were it (wrongly) still carried.
    fakePtyChildren[1].emitData("hfresh shell output");
    expect(session.getScrollback().toString().startsWith(PRIMARY_PREAMBLE)).toBe(true);
  });

  // Mirrors the alt-screen preamble tests above, for the same class of gap
  // (issue #93): tracked mouse-tracking state, synthesized into the replay
  // preamble so a reconnecting client doesn't silently lose mouse tracking
  // once the program's original enabling escape ages out of the scrollback
  // ring buffer. See MouseTrackingState's docstring in attention-detect.ts.
  it("tracks mouse-tracking state and prepends a matching preamble on replay", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1003h\x1b[?1006h");
    // startsWith, not exact equality — the raw buffered bytes ALSO begin
    // with this same escape sequence (pushScrollback stores it verbatim
    // regardless of mode tracking), same reason the alt-screen tests above
    // use startsWith rather than asserting the full byte count.
    expect(
      session.getScrollback().toString().startsWith(`${PRIMARY_PREAMBLE}\x1b[?1003h\x1b[?1006h`),
    ).toBe(true);
  });

  it("restores mouse tracking on replay even after the original enabling bytes are evicted from scrollback — the confirmed #93 bug", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1003h\x1b[?1006h");
    // Push well past the 1 MiB scrollback cap so the enabling escape above
    // is FIFO-evicted — the same thing that happens to a real, heavily-
    // active session (e.g. the "WORKING" opencode session from the live
    // repro) between when it started and when a browser reconnects.
    const chunk = "x".repeat(256 * 1024);
    for (let i = 0; i < 8; i++) fakePtyChildren[0].emitData(chunk);

    const scrollback = session.getScrollback().toString();
    expect(scrollback.startsWith(`${PRIMARY_PREAMBLE}\x1b[?1003h\x1b[?1006h`)).toBe(true);
    // Confirm the raw bytes are genuinely gone from the buffered portion —
    // this is the preamble doing real work, not coincidentally still there.
    expect(scrollback.slice(`${PRIMARY_PREAMBLE}\x1b[?1003h\x1b[?1006h`.length)).not.toContain(
      "\x1b[?1003h",
    );
  });

  it("does not resurrect mouse tracking that was explicitly disabled before reconnect", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1003h\x1b[?1006h");
    fakePtyChildren[0].emitData("\x1b[?1003l\x1b[?1006l");

    // Final tracked state is NONE/DEFAULT, so the mouse preamble is empty —
    // this IS exact-equality-safe (unlike the enabled-state tests above)
    // since nothing is being prepended on top of the raw buffered bytes,
    // which are both emitted chunks concatenated verbatim (neither evicted).
    expect(session.getScrollback().toString()).toBe(
      `${PRIMARY_PREAMBLE}\x1b[?1003h\x1b[?1006h\x1b[?1003l\x1b[?1006l`,
    );
  });

  it("replays the LAST protocol set when it changes mid-session", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1000h");
    fakePtyChildren[0].emitData("\x1b[?1003h");

    // Check the PREAMBLE specifically (its known, exact prefix), not the
    // whole getScrollback() output — the raw buffered bytes legitimately
    // still contain "\x1b[?1000h" as history (pushScrollback stores
    // everything verbatim regardless of mode tracking), so a whole-string
    // not-toContain check would be testing the wrong thing.
    const scrollback = session.getScrollback().toString();
    expect(scrollback.startsWith(`${PRIMARY_PREAMBLE}\x1b[?1003h`)).toBe(true);
    expect(scrollback.startsWith(`${PRIMARY_PREAMBLE}\x1b[?1000h`)).toBe(false);
  });

  it("omits the mouse preamble when a DECRST for any protocol code resets the whole protocol axis (xterm's own cross-code fall-through)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    // ?1002h then ?1003h then ?1003l — real xterm.js ends at NONE here (its
    // DECRST case block falls through 9/1000/1002/1003 into one
    // activeProtocol = 'NONE' assignment), even though ?1002 itself was
    // never reset. This is the case that would trip up a naive per-code
    // "last seen on" map instead of tracking the derived protocol enum.
    fakePtyChildren[0].emitData("\x1b[?1002h\x1b[?1003h");
    fakePtyChildren[0].emitData("\x1b[?1003l");

    // Final tracked protocol is NONE, so the mouse preamble is empty —
    // exact-equality-safe against the raw buffered bytes (both chunks,
    // concatenated verbatim, neither evicted) with no preamble contribution.
    expect(session.getScrollback().toString()).toBe(
      `${PRIMARY_PREAMBLE}\x1b[?1002h\x1b[?1003h\x1b[?1003l`,
    );
  });

  it("combines the alt-screen and mouse-tracking preambles correctly", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1049h\x1b[?1003h\x1b[?1006h");

    // startsWith, not exact equality — same duplication reason as the
    // mouse-only "prepends a matching preamble" test above.
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h\x1b[?1003h\x1b[?1006h")).toBe(
      true,
    );
  });

  it("suppresses scrollback capture during a nudgeRedraw repaint but still delivers it live", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const pty = fakePtyChildren[0];

      // Flush the spawn-time nudge (attachClient() -> nudgeRedraw()) so it
      // doesn't interfere with the assertions below.
      await vi.advanceTimersByTimeAsync(700 + 500);
      const before = session.getScrollback().toString();

      const received: Buffer[] = [];
      session.onData((chunk) => received.push(chunk));

      session.requestRedraw();
      // Repaint output arriving mid-nudge (asynchronously, as the real
      // program would emit it after SIGWINCH) should still reach live
      // subscribers...
      pty.emitData("repaint frame");
      expect(received.map((c) => c.toString())).toEqual(["repaint frame"]);
      // ...but not land in the buffer replayed to the next attaching client.
      expect(session.getScrollback().toString()).toBe(before);

      // Once the suppression window (dip 300ms + restore 400ms + grace
      // 500ms) has fully elapsed, capture resumes as normal.
      await vi.advanceTimersByTimeAsync(300 + 400 + 500);
      pty.emitData("post-nudge output");
      expect(session.getScrollback().toString()).toBe(`${before}post-nudge output`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a requestRedraw() repaint does not clear a confirmed attention flag (opening the workspace must not dismiss a pending permission)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const pty = fakePtyChildren[0];
      await vi.advanceTimersByTimeAsync(700 + 500); // flush the spawn-time nudge

      // Simulates a Claude Code Notification hook flagging "needs permission".
      session.emitHookEvent({ kind: "notification", title: "Permission needed", body: "" });
      expect(session.toInfo().attention).toBe(true);

      // Opening the workspace tab attaches -> requestRedraw() -> nudge
      // dip/restore -> the program's repaint arrives here as plain output.
      session.requestRedraw();
      pty.emitData("repainted frame");
      expect(session.toInfo().attention).toBe(true);

      // Real output arriving AFTER the suppression window closes still
      // clears it normally (e.g. the agent's own post-approval output).
      await vi.advanceTimersByTimeAsync(300 + 400 + 500);
      pty.emitData("post-approval output");
      expect(session.toInfo().attention).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes input to the underlying pty", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.write("echo hi\n");
    expect(fakePtyChildren[0].writeSpy).toHaveBeenCalledWith("echo hi\n");
  });

  it("resize updates the tracked size and calls through to the pty", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.resize(120, 40);
    expect(fakePtyChildren[0].resizeSpy).toHaveBeenCalledWith(120, 40);
  });

  it("requestRedraw dips then restores rows to force a repaint", async () => {
    // Fake only setTimeout/clearTimeout — nudgeRedraw()'s the sole user of
    // real timers on this path, and leaving setImmediate real keeps
    // waitForSpawn's polling loop and the mocked child_process bootstrap
    // (both setImmediate-based) working exactly as in every other test here.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const pty = fakePtyChildren[0];

      // Flush the spawn-time nudge (attachClient() -> nudgeRedraw()) so it
      // doesn't interfere with the assertions below.
      await vi.advanceTimersByTimeAsync(700);
      pty.resizeSpy.mockClear();

      session.requestRedraw();
      expect(pty.resizeSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 12); // max(4, floor(24 / 2))

      await vi.advanceTimersByTimeAsync(400);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requestRedraw called again before the first dip fires coalesces into one cycle", async () => {
    // Regression test for the overlapping-nudge-cycles bug (issue #107): two
    // unserialized nudgeRedraw() calls used to schedule fully independent
    // dip/restore/grace-reset timers, so a second reattach landing while a
    // first cycle was still in flight produced FOUR resize calls (two dips,
    // two restores) instead of one clean pair, and could let the first
    // cycle's grace-reset clear suppression mid-repaint (see the next test).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const pty = fakePtyChildren[0];

      await vi.advanceTimersByTimeAsync(700);
      pty.resizeSpy.mockClear();

      session.requestRedraw();
      // Re-nudge BEFORE the first cycle's dip (300ms) fires — cancelPendingNudge()
      // clears its still-pending dip timer, so the first cycle never produces
      // any resize call at all; only the second (superseding) cycle's own
      // dip/restore should ever fire.
      await vi.advanceTimersByTimeAsync(100);
      session.requestRedraw();

      // Second cycle's dip fires 300ms after ITS OWN call (at local t=400).
      await vi.advanceTimersByTimeAsync(300);
      expect(pty.resizeSpy).toHaveBeenCalledTimes(1);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 12);

      // Second cycle's restore fires 400ms after its dip (at local t=800).
      await vi.advanceTimersByTimeAsync(400);
      expect(pty.resizeSpy).toHaveBeenCalledTimes(2);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a same-size resize() mid-nudge does not cancel the pending dip/restore", async () => {
    // Regression test: it's tempting to have resize() cancel any in-flight
    // nudge (a real dimension change already forces its own repaint, so the
    // synthetic one seems redundant) — but the frontend's on-open resize
    // (sendResizeIfOpen) has no delta guard and resends the CURRENT size on
    // every attach. A same-size resize() is a kernel-level no-op (no
    // SIGWINCH), so if it cancelled the pending nudge, the nudge — the only
    // thing that would force a repaint — would never run, reintroducing the
    // Milestone-1 blank-screen-on-reconnect bug. This asserts the nudge
    // survives a same-size resize() landing mid-cycle.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const pty = fakePtyChildren[0];

      await vi.advanceTimersByTimeAsync(700);
      pty.resizeSpy.mockClear();

      session.requestRedraw();
      await vi.advanceTimersByTimeAsync(300);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 12); // dip fired

      // A resize to the SAME size the session already has (80, 24) — exactly
      // what sendResizeIfOpen's no-delta-guard resend looks like.
      session.resize(80, 24);
      // Clear right after the manual call: asserting the restore's args
      // alone wouldn't discriminate here, since the manual resize() already
      // set this.cols/this.rows to (80, 24) — a naive "last called with
      // (80, 24)" check would pass whether or not the restore actually
      // fires, because the manual call alone satisfies it. Clearing first
      // and asserting a call COUNT after is what actually proves the
      // restore ran rather than got silently cancelled.
      pty.resizeSpy.mockClear();

      await vi.advanceTimersByTimeAsync(400);
      expect(pty.resizeSpy).toHaveBeenCalledTimes(1);
      expect(pty.resizeSpy).toHaveBeenLastCalledWith(80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an earlier nudge cycle's cancelled grace-reset can't clear suppression for a still-in-flight later cycle", async () => {
    // Regression test for the core cross-cycle race (issue #107): the OLD
    // code's three bare setTimeouts per cycle meant a first cycle's
    // grace-reset (suppressSynthesizedOutput = false) could fire while a SECOND,
    // later cycle's own dip/restore repaint was still genuinely in flight —
    // letting that second cycle's own reduced-height dip frame leak into
    // scrollback and get replayed to a future attach. cancelPendingNudge()
    // fixes this by cancelling whichever single stage is pending (including
    // an already-scheduled grace-reset) the instant a new cycle starts.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const pty = fakePtyChildren[0];

      await vi.advanceTimersByTimeAsync(700 + 500);
      const before = session.getScrollback().toString();

      // Cycle 1 (local t=0): dip@300, restore@700, grace-reset@1200.
      session.requestRedraw();
      // Advance past cycle 1's restore (700) so its grace-reset is now the
      // single pending timer, scheduled to fire at t=1200.
      await vi.advanceTimersByTimeAsync(800);

      // Cycle 2 starts at t=800 — cancelPendingNudge() cancels cycle 1's
      // still-pending grace-reset (would have fired at t=1200) before it can
      // run, then schedules its own: dip@1100, restore@1500, grace@2000.
      session.requestRedraw();

      // Advance to cycle 1's ORIGINAL (now-cancelled) grace-reset time,
      // t=1200. Cycle 2's dip (t=1100) has already fired but its restore
      // (t=1500) hasn't — cycle 2's own repaint is legitimately still in
      // flight. Without the fix, cycle 1's grace-reset would have fired here
      // and wrongly cleared suppression.
      await vi.advanceTimersByTimeAsync(1200 - 800);
      pty.emitData("mid-cycle-2 repaint frame");
      expect(session.getScrollback().toString()).toBe(before);

      // Advance past cycle 2's OWN grace-reset (t=2000) — suppression should
      // now be genuinely lifted.
      await vi.advanceTimersByTimeAsync(2000 - 1200);
      pty.emitData("post-nudge output");
      expect(session.getScrollback().toString()).toBe(`${before}post-nudge output`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kill() only kills our tracked client, not conceptually the whole session", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.kill("1");
    expect(fakePtyChildren[0].killed).toBe(true);
    expect(session.isAlive).toBe(false);
    expect(manager.get("1")).toBeUndefined();
  });

  it("terminate() stops the session's systemd scope in addition to killing our tracked client", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    await manager.terminate("1");

    expect(fakePtyChildren[0].killed).toBe(true);
    expect(manager.get("1")).toBeUndefined();
    // Deterministic, id-derived scope name — this is what lets terminate()
    // fully end a session's master + program even when nothing about it is
    // tracked in this process's memory (e.g. right after a restart).
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "stop", "crs-session-1.scope"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  it("terminate() stops the scope even when the session was never tracked in this process", async () => {
    // Simulates deleting a session in a fresh process that hasn't re-attached
    // to it yet — the real gap found during M2's E2E verification.
    await manager.terminate("42");

    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "stop", "crs-session-42.scope"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  it("list() reports alive state and subscriber counts", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    session.onData(() => {});

    const [info] = manager.list();
    expect(info).toMatchObject({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      alive: true,
      subscriberCount: 1,
    });
  });

  it("killAll() kills every tracked session", async () => {
    const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(a);
    await waitForSpawn(b);

    manager.killAll();
    expect(fakePtyChildren.every((c) => c.killed)).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });

  describe("isMasterAlive", () => {
    it("resolves true when the scope is active", async () => {
      isActiveReplies["crs-session-1.scope"] = "active";
      await expect(manager.isMasterAlive("1")).resolves.toBe(true);
      expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "is-active", "crs-session-1.scope"],
        expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
      );
    });

    it("resolves false when the scope is inactive (program exited on its own)", async () => {
      isActiveReplies["crs-session-1.scope"] = "inactive";
      await expect(manager.isMasterAlive("1")).resolves.toBe(false);
    });

    it("resolves false when the scope failed or never existed", async () => {
      isActiveReplies["crs-session-1.scope"] = "failed";
      await expect(manager.isMasterAlive("1")).resolves.toBe(false);
      isActiveReplies["crs-session-1.scope"] = "unknown";
      await expect(manager.isMasterAlive("1")).resolves.toBe(false);
    });

    it("never rejects, even if the probe itself fails to spawn", async () => {
      vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
        const ee = new EventEmitter();
        setImmediate(() => ee.emit("error", new Error("ENOENT")));
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });
      await expect(manager.isMasterAlive("1")).resolves.toBe(false);
    });
  });

  describe("activity/attention signals (WS-6)", () => {
    it("reports idle with no activity yet, and stays idle for a single spawn-time burst", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(session.toInfo()).toMatchObject({ activity: "idle", lastActivityAt: null });

      // A bash prompt draw at spawn is exactly one output burst — it must
      // NOT read as "working" (that was the bug: a single recent timestamp
      // was treated the same as sustained output).
      fakePtyChildren[0].emitData("some output");
      const info = session.toInfo();
      expect(info.activity).toBe("idle");
      expect(info.lastActivityAt).toEqual(expect.any(Number));
    });

    it("reports working once output has persisted for at least the sustain window", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("some output");
        expect(session.toInfo().activity).toBe("idle"); // single burst, not sustained yet

        // More output arrives well within the streak-gap window, 1.2s into
        // the same streak — past the 1s sustain threshold, so now "working".
        vi.setSystemTime(start + 1200);
        fakePtyChildren[0].emitData("more output");
        expect(session.toInfo().activity).toBe("working");
      } finally {
        vi.useRealTimers();
      }
    });

    it("reads as idle while output closely follows a keystroke, e.g. a TUI echoing what the user types (#97)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        session.write("h");
        fakePtyChildren[0].emitData("h"); // echoed keystroke
        expect(session.toInfo().activity).toBe("idle"); // single burst anyway

        // A second keystroke 1.2s later would normally push this streak past
        // SUSTAIN_MS into "working" (see the previous test) — but each write()
        // is followed immediately by its echo, so the streak never stops
        // looking like echo rather than autonomous output.
        vi.setSystemTime(start + 1200);
        session.write("e");
        fakePtyChildren[0].emitData("e");
        expect(session.toInfo().activity).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes reading as working once output persists well past the echo window, e.g. real agent output after a submit", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        session.write("prompt\n"); // user submits, no further input after this

        vi.setSystemTime(start + 1200);
        fakePtyChildren[0].emitData("agent output 1"); // streak just started
        expect(session.toInfo().activity).toBe("idle"); // not sustained yet

        // 2.4s past the submit — well outside USER_INPUT_ECHO_MS — so this
        // sustained streak is genuine autonomous work, not echo.
        vi.setSystemTime(start + 2400);
        fakePtyChildren[0].emitData("agent output 2");
        expect(session.toInfo().activity).toBe("working");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps accruing a single streak across gaps shorter than STREAK_GAP_MS, e.g. periodic status pings", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("status: 1");
        expect(session.toInfo().activity).toBe("idle"); // streak just started

        // A gap of 3s between chunks is longer than IDLE_THRESHOLD_MS (2s)
        // but shorter than STREAK_GAP_MS (4s) — the streak must carry over
        // rather than reset, so it keeps accruing toward "working".
        vi.setSystemTime(start + 3000);
        fakePtyChildren[0].emitData("status: 2");
        expect(session.toInfo().activity).toBe("working");
      } finally {
        vi.useRealTimers();
      }
    });

    it("accepts a caller-supplied idle threshold (Settings -> Notifications & status)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("some output");
        vi.setSystemTime(start + 1200);
        fakePtyChildren[0].emitData("more output"); // now sustained

        vi.setSystemTime(start + 1210);
        // A 1ms threshold: definitely idle by now.
        expect(session.toInfo(1).activity).toBe("idle");
        // A 60s threshold: still well within the window, so still "working".
        expect(session.toInfo(60_000).activity).toBe("working");
      } finally {
        vi.useRealTimers();
      }
    });

    // Issue #171/#98: the ad-hoc "bell followed by another chunk within
    // ATTENTION_CLEAR_WINDOW_MS clears it" heuristic these three tests used
    // to cover is gone — replaced by the explicit attention-detect.ts state
    // machine (IDLE -> PENDING_ATTENTION -> ATTENTION -> CLEARING). A signal
    // no longer confirms synchronously; it must go uncontradicted for its
    // own per-kind ATTENTION_CONFIRM_MS window (checked by Session.tick(),
    // the one new timer this PR adds — see ATTENTION_EVAL_INTERVAL_MS in
    // pty-manager.ts) before `attention` reads true. Tests call tick()
    // directly with a synthetic `now` rather than waiting on the real
    // interval or faking real timers, per tick()'s own doc comment.
    it("does not set attention while a bell is still debouncing (PENDING_ATTENTION)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(session.toInfo().attention).toBe(false);
      fakePtyChildren[0].emitData("done\x07");
      // Not yet confirmed — the bell's own 2s debounce hasn't elapsed.
      expect(session.toInfo().attention).toBe(false);
    });

    it("confirms attention once a bell's debounce window elapses with nothing to contradict it", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("done\x07");
      session.tick(Date.now() + 2_000); // past ATTENTION_CONFIRM_MS.bell

      const info = session.toInfo();
      expect(info.attention).toBe(true);
      expect(info.attentionAt).toEqual(expect.any(Number));
    });

    it("cancels a pending bell if plain output arrives before its debounce window elapses", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("progress\x07"); // bell mid-work -> PENDING_ATTENTION
      // Output resumes before the bell's window elapses — that's itself
      // evidence the program is still working, so the pending signal is
      // cancelled outright rather than ever confirming.
      fakePtyChildren[0].emitData("more progress");
      session.tick(Date.now() + 3_000); // well past the bell's own window
      expect(session.toInfo().attention).toBe(false);
    });

    it("keeps attention set when a confirmed bell is followed by silence", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("done\x07");
      session.tick(Date.now() + 2_000); // confirms
      expect(session.toInfo().attention).toBe(true);

      // No further output arrives — nothing clears the flag, and re-ticking
      // an already-confirmed session is a no-op, so it correctly keeps
      // reading as "needs input".
      session.tick(Date.now() + 7_000);
      expect(session.toInfo().attention).toBe(true);
    });

    it("never confirms attention from a rapid BEL burst during heavy output (issue #171 false-positive regression)", async () => {
      // The original bug: a bell followed by ANOTHER chunk within the burst
      // window cleared attention a tick later, but each bell in a rapid
      // burst still transiently flagged `attention: true` (and emitted a
      // #166 event) the instant it arrived, before self-correcting. This
      // simulates a busy Ink-style TUI (Claude Code/Codex) ringing the bell
      // roughly every 200ms as an incidental part of normal rendering —
      // each one must just re-arm the pending window, never confirm.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      let lastBellAt = 0;
      try {
        const start = Date.now();
        for (let i = 0; i < 20; i++) {
          lastBellAt = start + i * 200;
          vi.setSystemTime(lastBellAt);
          fakePtyChildren[0].emitData(`frame ${i}\x07`);
          expect(session.toInfo().attention).toBe(false);
        }

        // Even ticking shortly after the LAST bell in the burst — before
        // ITS OWN 2s debounce has elapsed — must not confirm.
        session.tick(lastBellAt + 500);
        expect(session.toInfo().attention).toBe(false);
      } finally {
        vi.useRealTimers();
      }

      // Only once the burst genuinely STOPS and stays quiet for the bell's
      // full debounce window does it confirm — the correct "eventually
      // actually done" case, not a false positive.
      session.tick(lastBellAt + 2_000);
      expect(session.toInfo().attention).toBe(true);
    });

    it("confirms an OSC 9 notification faster than a bare bell (per-kind thresholds)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("\x1b]9;Build finished\x07"); // OSC 9 notification
      session.tick(Date.now() + 1_000); // notification's own, shorter threshold
      expect(session.toInfo().attention).toBe(true);
    });

    it("does not yet confirm a bare bell at the 1s mark a notification would already confirm at", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("done\x07");
      session.tick(Date.now() + 1_000); // still short of the bell's 2s threshold
      expect(session.toInfo().attention).toBe(false);
      session.tick(Date.now() + 2_000);
      expect(session.toInfo().attention).toBe(true);
    });

    it("sets attention on a working->idle title transition (#98)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("\x1b]2;Thinking…\x07"); // working title
      expect(session.toInfo().attention).toBe(false);

      // titleIdle is a zero-threshold kind (already a deliberate, debounced
      // signal by construction — see ATTENTION_CONFIRM_MS) — confirms
      // immediately, no tick() needed.
      fakePtyChildren[0].emitData("\x1b]2;Ready\x07"); // idle title
      expect(session.toInfo().attention).toBe(true);
    });

    it("does not set attention for an idle title with no prior working title observed", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // First title this session has ever reported is already idle — there
      // was no "working" read to transition FROM, so this isn't the #98
      // signal at all.
      fakePtyChildren[0].emitData("\x1b]2;Ready\x07");
      expect(session.toInfo().attention).toBe(false);
    });

    it("sets attention when a program exits alt-screen mode back to the shell prompt (#98)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("\x1b[?1049h"); // enter alt-screen (e.g. an editor opening)
      expect(session.toInfo().attention).toBe(false);

      fakePtyChildren[0].emitData("\x1b[?1049l"); // exit -- zero-threshold, confirms immediately
      expect(session.toInfo().attention).toBe(true);
    });

    it("does not set attention on ENTERING alt-screen, only on exit", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("\x1b[?1049h");
      expect(session.toInfo().attention).toBe(false);
    });

    it("sets attention after a sustained work streak goes silent for long enough (#98 sustained-silence-after-work)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("agent output 1"); // streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("agent output 2");
        expect(session.toInfo().activity).toBe("working");
        expect(session.toInfo().attention).toBe(false); // not silent yet

        // No further output at all — tick well past SUSTAINED_SILENCE_MS
        // since the last chunk. This is a purely time-driven signal (see
        // Session.tick's own doc comment) — nothing byte-driven triggers it.
        session.tick(start + 1_200 + 10_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
    });

    it("does not fire the sustained-silence signal for a single spawn-time burst (not a real work streak)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("prompt draw"); // single burst, never sustained
        session.tick(start + 15_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(false);
    });

    it("does not fire sustained-silence for a hook-active agent's startup splash render (a brand-new, never-touched terminal)", async () => {
      // "claude" matches claudeCodeAdapter, so this session's hooksActive is
      // true — its own Stop hook (routed to the agentIdle signal) is the
      // authoritative "turn is over" signal, so the byte-driven guess must
      // stay silent even though the splash render below looks byte-for-byte
      // identical to the "real work streak" case above.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("splash frame 1"); // streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- looks "sustained"
        fakePtyChildren[0].emitData("splash frame 2");
        expect(session.toInfo().activity).toBe("working");

        // Left untouched (no keystroke, no hook signal) well past
        // SUSTAINED_SILENCE_MS — a hookless session would flag here (see
        // the "sustained-silence-after-work" test above).
        session.tick(start + 1_200 + 10_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(false);
    });

    it("does eventually fire the fallback sustained-silence signal for a hook-active session after HOOK_FALLBACK_SILENCE_MS (dead/wedged hook pipeline safety net)", async () => {
      // Same "claude" hooksActive session as the splash-render test above,
      // but silent for much longer than any legitimate startup render could
      // ever take — this must still surface attention eventually, covering
      // a killed agent process or crashed forwarder that never sends its
      // Stop/"done" hook message at all.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("work output 1");

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("work output 2");
        expect(session.toInfo().attention).toBe(false); // not silent long enough yet

        // Still well short of HOOK_FALLBACK_SILENCE_MS -- must not fire yet.
        session.tick(start + 1_200 + 10_000);
        expect(session.toInfo().attention).toBe(false);

        // Past HOOK_FALLBACK_SILENCE_MS with no hook signal ever arriving --
        // the fallback watchdog must now fire.
        session.tick(start + 1_200 + 60_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
    });

    it("tracks the most recent OSC 0/2 title-change payload", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(session.toInfo().lastTitle).toBeNull();
      fakePtyChildren[0].emitData("\x1b]2;waiting for input\x07");
      expect(session.toInfo().lastTitle).toBe("waiting for input");
    });
  });

  describe("hook socket (issue #172)", () => {
    it("exposes one shared hookSocketPath under sessionsDir", () => {
      expect(manager.hookSocketPath).toBe(path.join(sessionsDir, "hooks.sock"));
    });

    it("gives each session its own hookToken", async () => {
      const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      await waitForSpawn(a);
      await waitForSpawn(b);

      expect(a.hookToken).toEqual(expect.any(String));
      expect(a.hookToken.length).toBeGreaterThan(0);
      expect(a.hookToken).not.toBe(b.hookToken);
      // Every session shares the same socket path — only the token
      // disambiguates messages on it.
      expect(a.hookSocketPath).toBe(manager.hookSocketPath);
      expect(b.hookSocketPath).toBe(manager.hookSocketPath);
    });

    it("injects MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN into the master bootstrap env", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
        "systemd-run",
        expect.arrayContaining(["dtach", "-n", expect.any(String)]),
        expect.objectContaining({
          cwd: "/tmp",
          env: expect.objectContaining({
            MULLION_HOOK_SOCKET: manager.hookSocketPath,
            MULLION_HOOK_TOKEN: session.hookToken,
          }),
          stdio: "ignore",
        }),
      );
    });

    it("resolveToken() resolves a live session's token to its id", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(manager.resolveToken(session.hookToken)).toBe("1");
    });

    it("resolveToken() returns undefined for an unknown/forged token", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(manager.resolveToken("not-a-real-token")).toBeUndefined();
      // Same length as a real token but wrong content — exercises the
      // timingSafeTokenMatch path rather than the length-mismatch fast-path.
      expect(manager.resolveToken("0".repeat(session.hookToken.length))).toBeUndefined();
    });

    it("resolveToken() no longer resolves a token once its session is killed", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const token = session.hookToken;

      manager.kill("1");

      expect(manager.resolveToken(token)).toBeUndefined();
    });

    it("a respawned session (after kill) gets a fresh token, and only the fresh one resolves", async () => {
      const first = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(first);
      const oldToken = first.hookToken;

      manager.kill("1");
      const second = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(second);

      expect(second.hookToken).not.toBe(oldToken);
      expect(manager.resolveToken(oldToken)).toBeUndefined();
      expect(manager.resolveToken(second.hookToken)).toBe("1");
    });
  });

  describe("emitHookEvent (issue #176)", () => {
    it("notification: emits an attention event carrying title/body and flips SessionInfo.attention", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({ kind: "notification", title: "Build done", body: "0 errors" });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("attention");
      expect(event.payload).toEqual({
        attention: true,
        signal: "hookNotification",
        title: "Build done",
        body: "0 errors",
      });
      expect(session.toInfo().attention).toBe(true);
    });

    it("notification: still emits a fresh event with new title/body even when attention is already confirmed", async () => {
      // Regression test: confirmAttention()'s `alreadyConfirmed` guard
      // suppresses re-emitting for a repeat GENERIC signal (correct for a
      // second bell while already confirmed) — but a hook notification's
      // title/body is never "nothing new", and emitAttentionSignalWithExtras()
      // must not silently drop it just because attention was already true.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "notification", title: "First", body: "one" });
      expect(session.toInfo().attention).toBe(true);

      session.emitHookEvent({ kind: "notification", title: "Second", body: "two" });

      const attentionEvents = session.getEvents().filter((e) => e.kind === "attention");
      expect(attentionEvents).toHaveLength(2);
      expect(attentionEvents[1].payload).toEqual({
        attention: true,
        signal: "hookNotification",
        title: "Second",
        body: "two",
      });
    });

    it("progress: emits a status_change event with the phase, no attention change", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "progress", phase: "thinking" });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("status_change");
      expect(event.payload).toEqual({ phase: "thinking" });
      expect(session.toInfo().attention).toBe(false);
    });

    it("progress (done): also flips attention via the authoritative agentIdle signal", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({ kind: "progress", phase: "done" });

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["status_change", "attention"]);
      expect(events[1].payload).toEqual({ attention: true, signal: "agentIdle" });
      expect(session.toInfo().attention).toBe(true);
    });

    it("file_change: emits a file_change event with path and action", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "file_change", path: "src/index.ts", action: "modify" });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("file_change");
      expect(event.payload).toEqual({ path: "src/index.ts", action: "modify" });
    });

    it("review_gate (waiting): emits a review_gate event AND flips attention with the prompt attached", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({
        kind: "review_gate",
        state: "waiting",
        prompt: "Run rm -rf /tmp/build?",
      });

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["review_gate", "attention"]);
      expect(events[0].payload).toEqual({
        state: "waiting",
        prompt: "Run rm -rf /tmp/build?",
      });
      expect(events[1].payload).toEqual({
        attention: true,
        signal: "reviewGate",
        prompt: "Run rm -rf /tmp/build?",
      });
      expect(session.toInfo().attention).toBe(true);
    });

    it("review_gate (approved/denied): emits a review_gate event only, no attention change", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "review_gate", state: "approved", prompt: "x" });

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["review_gate"]);
      expect(session.toInfo().attention).toBe(false);
    });

    it("fork/join: validated but not surfaced as events yet (Phase 5)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "fork", childPid: 1234 });
      session.emitHookEvent({ kind: "join", childPid: 1234 });

      expect(session.getEvents()).toHaveLength(0);
    });

    it("PtyManager.emitHookEvent() routes to the right session by id", async () => {
      const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      await waitForSpawn(a);
      await waitForSpawn(b);

      manager.emitHookEvent("2", { kind: "progress", phase: "done" });

      expect(a.getEvents()).toHaveLength(0);
      // "done" also drives attention (issue: agentIdle) — see the dedicated
      // "progress: done" describe block below for that behavior in detail.
      expect(b.getEvents().map((e) => e.kind)).toEqual(["status_change", "attention"]);
      expect(b.getEvents()[0].payload).toEqual({ phase: "done" });
    });

    it("PtyManager.emitHookEvent() is a no-op for an id it isn't tracking", () => {
      expect(() => manager.emitHookEvent("999", { kind: "progress", phase: "done" })).not.toThrow();
    });

    it("review_gate: waiting sets SessionInfo.gateState/gatePrompt; a resolved state clears the prompt", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo()).toMatchObject({ gateState: "idle", gatePrompt: null });

      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
      expect(session.toInfo()).toMatchObject({ gateState: "waiting", gatePrompt: "Deploy?" });

      session.emitHookEvent({ kind: "review_gate", state: "approved", prompt: "Deploy?" });
      expect(session.toInfo()).toMatchObject({ gateState: "approved", gatePrompt: null });
    });
  });

  describe("resolveGate (issue #178)", () => {
    it("Session.resolveGate flips gateState/clears gatePrompt and emits a review_gate event with the outcome", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });

      session.resolveGate("denied", "looks unsafe");

      expect(session.toInfo()).toMatchObject({ gateState: "denied", gatePrompt: null });
      const events = session.getEvents();
      expect(events[events.length - 1]).toMatchObject({
        kind: "review_gate",
        payload: { state: "denied", reason: "looks unsafe" },
      });
    });

    it("Session.resolveGate omits `reason` from the event payload when none is given", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.resolveGate("approved");

      const events = session.getEvents();
      expect(events[events.length - 1].payload).toEqual({ state: "approved" });
    });

    it("PtyManager.resolveGate() routes to the right session by id and is a no-op for an untracked id", async () => {
      const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      await waitForSpawn(a);
      await waitForSpawn(b);

      manager.resolveGate("2", "approved");

      expect(a.toInfo().gateState).toBe("idle");
      expect(b.toInfo().gateState).toBe("approved");
      expect(() => manager.resolveGate("999", "denied")).not.toThrow();
    });
  });

  // Confirms bootstrapMaster() actually wires applyHookAdapters() in — the
  // adapter framework itself is unit-tested directly against
  // (test/services/hook-adapters/), this just proves the spawn seam calls
  // it with the right context and uses its result (issue #174).
  describe("hook adapter integration at spawn (issue #174)", () => {
    it("spawns a matching (claude) command with --settings appended, and writes the settings file", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const settingsPath = path.join(sessionsDir, "1.hooks.json");
      expect(fs.existsSync(settingsPath)).toBe(true);

      // reviewGateEnabled defaults to false (PtyManager constructed with no
      // override above) — the blocking PreToolUse gate must not be written
      // by default, or every Bash call from this session would stall on a
      // human decision nobody unattended can give (see env.ts's
      // MULLION_REVIEW_GATE_ENABLED doc comment).
      const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      expect(written.hooks.PreToolUse).toBeUndefined();

      // .findLast, not .find: this mock is shared (and never cleared)
      // across every test in this file, so earlier tests' own "systemd-run"
      // calls are still in its history — only the MOST RECENT one is this
      // test's own spawn.
      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      expect(call).toBeDefined();
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe(`claude --settings ${JSON.stringify(settingsPath)}`);
    });

    it("registers the blocking PreToolUse gate only when PtyManager is constructed with reviewGateEnabled: true", async () => {
      const gatedManager = new PtyManager({ sessionsDir, reviewGateEnabled: true });
      const session = gatedManager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const settingsPath = path.join(sessionsDir, "1.hooks.json");
      const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      expect(written.hooks.PreToolUse).toBeDefined();
      expect(written.hooks.PreToolUse[0].matcher).toBe("Bash");

      // This test's own manager, not the outer `manager` — the shared
      // afterEach above only tears down the latter, so this one must clean
      // up its own attention-evaluator interval/sessions itself (same
      // reasoning as that afterEach's own comment).
      gatedManager.killAll();
    });

    it("spawns a non-matching command completely unchanged, writing no settings file", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(fs.existsSync(path.join(sessionsDir, "1.hooks.json"))).toBe(false);
      // .findLast, not .find: this mock is shared (and never cleared)
      // across every test in this file, so earlier tests' own "systemd-run"
      // calls are still in its history — only the MOST RECENT one is this
      // test's own spawn.
      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe("bash");
    });

    it("spawns a matching (opencode) command with OPENCODE_CONFIG_DIR injected and the plugin file written, command left untouched (issue #175)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const pluginPath = path.join(
        sessionsDir,
        "1.opencode-config",
        "plugins",
        "mullion-hook-emitter.js",
      );
      expect(fs.existsSync(pluginPath)).toBe(true);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const args = call?.[1] as string[];
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(args[args.length - 1]).toBe("opencode");
      expect(opts.env?.OPENCODE_CONFIG_DIR).toBe(path.join(sessionsDir, "1.opencode-config"));
    });

    describe("Codex (issue #252)", () => {
      let codexHome: string;
      const originalCodexHome = process.env.CODEX_HOME;

      beforeEach(() => {
        // Codex's adapter merges into the REAL $CODEX_HOME/hooks.json (see
        // codex.ts's own header comment for why it can't be ephemeral) —
        // this MUST be redirected to a scratch dir for the test, never the
        // real developer/CI-runner's own ~/.codex.
        codexHome = path.join(sessionsDir, "codex-home-scratch");
        process.env.CODEX_HOME = codexHome;
      });

      afterEach(() => {
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
      });

      it("spawns a matching (codex) command completely unchanged, merging a managed hooks.json into $CODEX_HOME (not sessionsDir)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "codex",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const hooksPath = path.join(codexHome, "hooks.json");
        // managedInstall() is fire-and-forget from the spawn seam's point of
        // view (see applyHookAdapters) — poll rather than assume it's done
        // by the time waitForSpawn resolves.
        for (let i = 0; i < 50 && !fs.existsSync(hooksPath); i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(fs.existsSync(hooksPath)).toBe(true);
        const written = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
        expect(written.hooks.Stop).toHaveLength(1);
        expect(written.hooks.PostToolUse[0].matcher).toBe("apply_patch");

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        const args = call?.[1] as string[];
        expect(args[args.length - 1]).toBe("codex");
      });
    });
  });
});
