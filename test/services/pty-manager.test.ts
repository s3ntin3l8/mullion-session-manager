import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
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

const { PtyManager, Session, getSkipPermissionFlag } =
  await import("../../src/services/pty-manager.js");

describe("getSkipPermissionFlag", () => {
  it("returns the flag for a bare binary name", () => {
    expect(getSkipPermissionFlag("claude")).toBe("--dangerously-skip-permissions");
    expect(getSkipPermissionFlag("codex")).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(getSkipPermissionFlag("opencode")).toBe("--auto");
    expect(getSkipPermissionFlag("gemini")).toBe("--approval-mode yolo");
    expect(getSkipPermissionFlag("agy")).toBe("--dangerously-skip-permissions");
    expect(getSkipPermissionFlag("aider")).toBe("--yes");
  });

  it("returns the flag for a path-qualified binary", () => {
    expect(getSkipPermissionFlag("/usr/local/bin/claude")).toBe("--dangerously-skip-permissions");
    expect(getSkipPermissionFlag("/home/user/.local/bin/opencode")).toBe("--auto");
  });

  it("returns the flag when followed by arguments", () => {
    expect(getSkipPermissionFlag("claude --resume")).toBe("--dangerously-skip-permissions");
    expect(getSkipPermissionFlag("gemini -m gemini-3-pro-preview")).toBe("--approval-mode yolo");
  });

  it("returns null for a shell metacharacter chain", () => {
    expect(getSkipPermissionFlag("claude; echo hi")).toBeNull();
    expect(getSkipPermissionFlag("claude | grep foo")).toBeNull();
    expect(getSkipPermissionFlag("echo foo & claude")).toBeNull();
    expect(getSkipPermissionFlag("claude > out.txt")).toBeNull();
  });

  it("returns null for a non-agent command", () => {
    expect(getSkipPermissionFlag("bash")).toBeNull();
    expect(getSkipPermissionFlag("npm run dev")).toBeNull();
    expect(getSkipPermissionFlag("zsh")).toBeNull();
  });

  it("returns null for an unknown agent", () => {
    expect(getSkipPermissionFlag("pi")).toBeNull();
    expect(getSkipPermissionFlag("unknown-tool")).toBeNull();
  });

  it("handles leading/trailing whitespace", () => {
    expect(getSkipPermissionFlag("  claude  ")).toBe("--dangerously-skip-permissions");
  });
});

describe("PtyManager", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    fakePtyChildren.length = 0;
    for (const key of Object.keys(isActiveReplies)) delete isActiveReplies[key];
    // mkdtempSync, not a hand-rolled random suffix: the OS's own atomic,
    // exclusive directory creation is what CodeQL's js/insecure-temporary-
    // file query treats as safe — a hand-templated path under os.tmpdir()
    // is a TOCTOU sink the moment test code (this file's own token-file
    // tests, below) writes into it directly, even with high-entropy
    // randomness in the name (same reasoning already documented in
    // test/routes/projects.test.ts's own worktree fixtures).
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-manager-test-"));
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

  // Live cwd tracking (issue: sidebar worktree display) — see detectCwdChange/
  // carryPartialOsc in attention-detect.ts.
  it("starts with liveCwd null until the shell emits an OSC 7 sequence", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    expect(session.toInfo().liveCwd).toBeNull();
  });

  it("sets liveCwd from an OSC 7 sequence in the PTY stream", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b]7;file:///home/user/worktree\x07");
    expect(session.toInfo().liveCwd).toBe("/home/user/worktree");
  });

  it("uses the LAST cwd when a chunk contains more than one OSC 7 sequence", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b]7;file:///first\x07some output\x1b]7;file:///second\x07");
    expect(session.toInfo().liveCwd).toBe("/second");
  });

  it("still tracks a cwd change when a PTY read splits the OSC 7 sequence across two chunks", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b]7;file:///home/user/wor");
    // Split lands mid-path — must not have picked up a bogus partial value.
    expect(session.toInfo().liveCwd).toBeNull();

    fakePtyChildren[0].emitData("ktree\x07");
    expect(session.toInfo().liveCwd).toBe("/home/user/worktree");

    // And the raw scrollback must NOT contain any duplicated bytes from the
    // carry — same detection-only contract as detectCarry.
    expect(session.getScrollback().toString()).toBe(
      `${PRIMARY_PREAMBLE}\x1b]7;file:///home/user/worktree\x07`,
    );
  });

  it("keeps liveCwd (true ongoing shell state) across a kill()+respawn, unlike the byte-stream carry", async () => {
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);

    fakePtyChildren[0].emitData("\x1b]7;file:///home/user/worktree\x07");
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

    expect(session.toInfo().liveCwd).toBe("/home/user/worktree");
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

  it("a requestRedraw() repaint does not clear a confirmed attention flag, and — follow-up to #275 (gap #3) — neither does ANY later cosmetic output; only a genuine decision does", async () => {
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

      // Reported bug this hardening pass fixes: a cosmetic repaint (here,
      // simulating the SIGWINCH repaint a mere terminal select/resize
      // provokes) arriving well AFTER the suppression window has closed —
      // i.e. exactly the case the old suppressSynthesizedOutput-only fix
      // did NOT cover — must still not clear a hookNotification-confirmed
      // flag. Only a genuine decision may (see below).
      await vi.advanceTimersByTimeAsync(300 + 400 + 500);
      pty.emitData("just a repaint, not a decision");
      expect(session.toInfo().attention).toBe(true);

      // A real keystroke answering the prompt is the genuine decision that
      // finally clears it.
      session.write("y");
      expect(session.toInfo().attention).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an agentIdle-confirmed flag, unlike hookNotification/reviewGate, still clears on plain output (informational, not a pending decision)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    const pty = fakePtyChildren[0];

    session.emitHookEvent({ kind: "progress", phase: "done" });
    expect(session.toInfo().attention).toBe(true);

    pty.emitData("the agent's next turn starts producing output");
    expect(session.toInfo().attention).toBe(false);
  });

  it("a focus-report / mouse-report / OSC color-reply write() does not count as genuine user input and does not clear a confirmed flag", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.emitHookEvent({ kind: "notification", title: "Permission needed", body: "" });
    expect(session.toInfo().attention).toBe(true);

    session.write("\x1b[I"); // DECSET ?1004 focus-in report
    expect(session.toInfo().attention).toBe(true);
    session.write("\x1b[<0;10;5M"); // SGR mouse report
    expect(session.toInfo().attention).toBe(true);
    session.write("\x1b]11;rgb:1e1e/1e1e/1e1e\x07"); // OSC 11 color-query reply
    expect(session.toInfo().attention).toBe(true);
    session.write("\x1b[?997;1n"); // theme-toggle color-scheme notification
    expect(session.toInfo().attention).toBe(true);

    // A genuine keystroke (even a single arrow key) does clear it.
    session.write("\x1b[A");
    expect(session.toInfo().attention).toBe(false);
  });

  it("a promoteRequest-confirmed flag is output-immune and clears only via Session.resolvePromote (gap #3)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    const pty = fakePtyChildren[0];

    session.emitHookEvent({ kind: "promote_request", summary: "Refactor the widget layer" });
    expect(session.toInfo().attention).toBe(true);

    // The tool call this unblocks producing PTY output must not clear it.
    pty.emitData("just a repaint, not a decision");
    expect(session.toInfo().attention).toBe(true);

    // The web-UI decision (no keystroke) is what finally resolves it.
    session.resolvePromote("accepted");
    expect(session.toInfo().attention).toBe(false);
  });

  it("an opencode permission-prompt notification (gap #2) survives a cosmetic repaint and clears on notification_resolved (permission.replied)", async () => {
    // Simulates opencode-plugin.js's mapping of a real permission.updated
    // event into a `notification` hook message (see
    // test/hooks/opencode-plugin.test.ts for the mapping itself) — this
    // Session-level test proves the resulting attention behavior end to end:
    // same output-immunity gap #3 gives Claude Code's own Notification hook,
    // and the same auto-approved-permission resolution path gap #2 adds.
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "opencode",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    const pty = fakePtyChildren[0];

    session.emitHookEvent({
      kind: "notification",
      title: "opencode",
      body: "Run `rm -rf build/`?",
    });
    expect(session.toInfo().attention).toBe(true);

    // A cosmetic repaint (the reported bug this hardening pass fixes) must
    // not clear it.
    pty.emitData("just a repaint, not a decision");
    expect(session.toInfo().attention).toBe(true);

    // opencode's permission.replied (an auto-approved permission, no
    // keystroke) is what finally resolves it.
    session.emitHookEvent({ kind: "notification_resolved" });
    expect(session.toInfo().attention).toBe(false);
  });

  it("notification_resolved does not dismiss a NEWER, unrelated confirmed flag (gated on confirmedKind)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "opencode",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.emitHookEvent({ kind: "notification", title: "opencode", body: "Permission needed" });
    // A fresh review_gate supersedes the notification as the currently-
    // confirmed kind before the permission's own resolution arrives.
    session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
    expect(session.toInfo().attention).toBe(true);

    session.emitHookEvent({ kind: "notification_resolved" });

    // The stale permission resolution must not clear the newer review gate.
    expect(session.toInfo().attention).toBe(true);
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

    it("does not fire sustained-silence for a PROVEN hook-active agent's startup splash render (a brand-new, never-touched terminal)", async () => {
      // "claude" matches claudeCodeAdapter, so this session's hooksActive is
      // true. Follow-up to #275 (gap #1): the long HOOK_FALLBACK_SILENCE_MS
      // watchdog additionally requires hooksProven — established here via
      // markHooksProven(), standing in for Claude Code's own SessionStart
      // hook (see hooks.ts's session_start branch, which this Session-level
      // test can't reach directly). Once proven, its own Stop hook (routed
      // to the agentIdle signal) is the authoritative "turn is over" signal,
      // so the byte-driven guess must stay silent even though the splash
      // render below looks byte-for-byte identical to the "real work streak"
      // case above.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.markHooksProven();

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

    it("a MATCHED-but-never-PROVEN hooksActive session (e.g. untrusted codex) fires the FAST sustained-silence guess, not the slow watchdog (gap #1)", async () => {
      // Models the untrusted-codex scenario: hooksActive true (an adapter
      // matched), but no hook has ever actually fired, so hooksProven never
      // latches. Before this fix, tick() gated the long watchdog on
      // hooksActive alone, leaving that session with NEITHER the fast guess
      // (disabled) NOR agentIdle (never fires) — the regression #275
      // introduced that gap #1 closes: it must fall back to the same fast
      // SUSTAINED_SILENCE_MS bound a hookless session uses. Uses "claude"
      // (not "codex") purely to avoid codex's real-$CODEX_HOME managedInstall
      // filesystem write, which needs its own scratch-dir setup — see the
      // dedicated "Codex (issue #252)" describe block below for that
      // adapter's own install coverage; the latch logic under test here is
      // adapter-agnostic (it never inspects which adapter matched).
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
        expect(session.toInfo().attention).toBe(false);

        // Just short of the FAST bound -- must not fire yet.
        session.tick(start + 1_200 + 10_000 - 1);
        expect(session.toInfo().attention).toBe(false);

        // Past the fast SUSTAINED_SILENCE_MS bound -- fires, same as a
        // hookless session would, NOT gated behind the slow 60s watchdog.
        session.tick(start + 1_200 + 10_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
    });

    it("does eventually fire the fallback sustained-silence signal for a PROVEN hook-active session after HOOK_FALLBACK_SILENCE_MS (dead/wedged hook pipeline safety net)", async () => {
      // Same "claude" hooksActive session as the splash-render test above,
      // proven via markHooksProven() (see that test's comment), but silent
      // for much longer than any legitimate startup render could ever take
      // — this must still surface attention eventually, covering a killed
      // agent process or crashed forwarder that never sends its Stop/"done"
      // hook message at all, despite having proven itself once already.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.markHooksProven();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("work output 1");

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("work output 2");
        expect(session.toInfo().attention).toBe(false); // not silent long enough yet

        // Still well short of HOOK_FALLBACK_SILENCE_MS -- must not fire yet
        // (unlike the never-proven codex case above, which fires here).
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

    it("markHooksProven latches monotonically -- once proven, later ticks keep using the slow watchdog even across further activity", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.markHooksProven();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("work output 1");
        vi.setSystemTime(start + 1_200);
        fakePtyChildren[0].emitData("work output 2");

        // A second, later hook message (not just the first) must not
        // somehow "un-prove" the session -- still on the slow bound.
        session.emitHookEvent({ kind: "file_change", path: "/tmp/x.ts", action: "modify" });
        session.tick(start + 1_200 + 10_000);
        expect(session.toInfo().attention).toBe(false); // still short of the slow bound
        session.tick(start + 1_200 + 60_000);
        expect(session.toInfo().attention).toBe(true); // slow bound still applies
      } finally {
        vi.useRealTimers();
      }
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

    it("injects MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN and MULLION_REVIEW_GATE_ENABLED into the master bootstrap env", async () => {
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
            MULLION_REVIEW_GATE_ENABLED: "false",
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

    it("a respawned session (after kill/detach) keeps the SAME token — kill() only detaches, the dtach master + its already-baked-in env survive", async () => {
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

      // Issue: worktree/branch detection — the surviving dtach master's
      // agent process still holds `oldToken` in its env; if a reattach
      // minted a different one, every hook message it ever sends again
      // would be rejected. See loadOrCreateHookToken()'s doc comment.
      expect(second.hookToken).toBe(oldToken);
      expect(manager.resolveToken(second.hookToken)).toBe("1");
    });

    it("persists the token to <id>.token under sessionsDir, and a brand-new PtyManager pointed at the same directory adopts it (simulates a Mullion process restart)", async () => {
      const first = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(first);

      const tokenFile = path.join(sessionsDir, "1.token");
      expect(fs.readFileSync(tokenFile, "utf8").trim()).toBe(first.hookToken);

      // A fresh PtyManager, in a fresh process's memory, pointed at the
      // same on-disk sessionsDir — exactly what happens across a restart,
      // since dtach masters and their env are outside this process.
      const restarted = new PtyManager({ sessionsDir });
      const reattached = restarted.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(reattached);

      expect(reattached.hookToken).toBe(first.hookToken);
      expect(restarted.resolveToken(first.hookToken)).toBe("1");
    });

    it("replaces a corrupt/malformed token file rather than adopting it", async () => {
      // sessionsDir already exists — created by mkdtempSync above, and
      // again (idempotently) by PtyManager's own constructor.
      const tokenFile = path.join(sessionsDir, "1.token");
      fs.writeFileSync(tokenFile, "not-a-valid-hex-token");

      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(session.hookToken).not.toBe("not-a-valid-hex-token");
      expect(session.hookToken).toMatch(/^[0-9a-f]{48}$/);
      // The corrupt file is overwritten with the freshly minted, valid one.
      expect(fs.readFileSync(tokenFile, "utf8").trim()).toBe(session.hookToken);
    });

    it("terminate() deletes the persisted token file, so a future spawn for the same id gets a fresh token", async () => {
      const first = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(first);
      const oldToken = first.hookToken;
      const tokenFile = path.join(sessionsDir, "1.token");
      expect(fs.existsSync(tokenFile)).toBe(true);

      await manager.terminate("1");
      expect(fs.existsSync(tokenFile)).toBe(false);

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
      // The git-ignore check (issue: sidebar worktree display's Part B) is
      // async even for this non-repo cwd's fast path — flush the microtask
      // queue before asserting. See the "filters a git-ignored file_change
      // path" describe block below for the git-ignore behavior itself.
      await new Promise((resolve) => setImmediate(resolve));

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

    it("git_branch: stores the branch in liveBranch and emits a status_change event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().liveBranch).toBeNull();

      session.emitHookEvent({ kind: "git_branch", branch: "feat/foo" });
      expect(session.toInfo().liveBranch).toBe("feat/foo");

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toContain("status_change");
    });

    it("git_branch with worktree: also updates liveCwd to the worktree path", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.liveCwd).toBeNull();

      session.emitHookEvent({
        kind: "git_branch",
        branch: "feat/foo",
        worktree: "/tmp/.worktrees/foo",
      });
      expect(session.toInfo().liveBranch).toBe("feat/foo");
      expect(session.liveCwd).toBe("/tmp/.worktrees/foo");
    });

    it("cwd_changed: updates liveCwd and emits a status_change event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.liveCwd).toBeNull();

      session.emitHookEvent({ kind: "cwd_changed", cwd: "/workspace/src" });
      expect(session.liveCwd).toBe("/workspace/src");

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toContain("status_change");
    });

    it("permission_request: sets permissionState to pending and emits a permission_request event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().permissionState).toBe("idle");

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "Run ls" });

      expect(session.toInfo().permissionState).toBe("pending");
      const events = session.getEvents();
      const event = events[events.length - 2];
      expect(event.kind).toBe("permission_request");
      expect(event.payload).toEqual({ tool: "Bash", summary: "Run ls" });
    });

    it("stop_failure: sets errorState to api_error and emits a stop_failure event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().errorState).toBe("idle");

      session.emitHookEvent({
        kind: "stop_failure",
        error: "API timeout",
        errorDetails: "rate limited",
      });

      expect(session.toInfo().errorState).toBe("api_error");
      const events = session.getEvents();
      const event = events[events.length - 2];
      expect(event.kind).toBe("stop_failure");
      expect(event.payload).toEqual({ error: "API timeout", errorDetails: "rate limited" });
      expect(events[events.length - 1].kind).toBe("attention");
    });

    it("tool_failure: sets errorState to tool_failure and emits a tool_failure event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().errorState).toBe("idle");

      session.emitHookEvent({
        kind: "tool_failure",
        tool: "Bash",
        error: "Command failed",
        summary: "ls: no such file",
      });

      expect(session.toInfo().errorState).toBe("tool_failure");
      const events = session.getEvents();
      const event = events[events.length - 2];
      expect(event.kind).toBe("tool_failure");
      expect(event.payload).toEqual({
        tool: "Bash",
        error: "Command failed",
        summary: "ls: no such file",
      });
      expect(events[events.length - 1].kind).toBe("attention");
    });

    it("session_end: sets endedReason and emits a session_end event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().endedReason).toBeNull();
      expect(session.toInfo().exitCode).toBeNull();

      session.emitHookEvent({ kind: "session_end", reason: "finished" });

      expect(session.toInfo().endedReason).toBe("finished");
      expect(session.toInfo().exitCode).toBeNull();
      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("session_end");
      expect(event.payload).toEqual({ reason: "finished", exitCode: null });
    });

    it("session_end: carries exitCode through to SessionInfo and the event payload when the adapter reports one", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "session_end", reason: "crashed", exitCode: 1 });

      expect(session.toInfo().exitCode).toBe(1);
      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.payload).toEqual({ reason: "crashed", exitCode: 1 });
    });

    it("plan_ready: sets planState to pending and emits a plan_ready event + flips attention", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().planState).toBe("idle");
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({
        kind: "plan_ready",
        plan: "1. Fix bug\n2. Test",
        summary: "Fix the issue",
      });

      expect(session.toInfo().planState).toBe("pending");
      const events = session.getEvents();
      const planEvent = events[events.length - 2];
      expect(planEvent.kind).toBe("plan_ready");
      expect(planEvent.payload).toEqual({
        plan: "1. Fix bug\n2. Test",
        filePath: null,
        summary: "Fix the issue",
      });
      const attentionEvent = events[events.length - 1];
      expect(attentionEvent.kind).toBe("attention");
      expect(attentionEvent.payload).toMatchObject({ attention: true, signal: "planReady" });
      expect(session.toInfo().attention).toBe(true);
    });

    it("turn_start: releases permissionState/planState/elicitationState/errorState and the finished latch", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // "progress: done" already resets permissionState/planState/errorState
      // to idle and latches lastTurnEndedAt (pre-existing behavior) — emit it
      // FIRST, then re-raise permissionState/planState/errorState afterward,
      // so this test exercises turn_start's OWN clearing of every one of
      // these fields simultaneously, not a leftover partial state from
      // progress:done's own clearing.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
      session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });
      session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
      expect(session.toInfo()).toMatchObject({
        permissionState: "pending",
        planState: "pending",
        elicitationState: "pending",
        errorState: "tool_failure",
        lastTurnEndedAt: expect.any(Number),
      });

      session.emitHookEvent({ kind: "turn_start" });

      expect(session.toInfo()).toMatchObject({
        permissionState: "idle",
        planState: "idle",
        elicitationState: "idle",
        elicitationServer: null,
        errorState: "idle",
        errorDetail: null,
        lastTurnEndedAt: null,
      });
    });

    it("fix: status-clearing-semantics — tool_done releases a pending permissionState when the tool NAME matches, and clears errorState as forward-progress evidence", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
      expect(session.toInfo()).toMatchObject({
        permissionState: "pending",
        errorState: "tool_failure",
      });
      const eventsBefore = session.getEvents().length;

      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });

      const info = session.toInfo();
      expect(info.permissionState).toBe("idle");
      expect(info.errorState).toBe("idle");
      expect(info.errorDetail).toBeNull();
      const newEvents = session.getEvents().slice(eventsBefore);
      expect(newEvents.filter((e) => e.kind === "status_change")).toHaveLength(1);
    });

    it("fix: status-clearing-semantics — REGRESSION GUARD: a tool_done for a DIFFERENT tool name does NOT release a pending permissionState (the parallel-tool-call case the rejected 'any progress releases' design would have broken)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // Bash is awaiting permission; a concurrent, already-permitted Write
      // call completes first — Claude Code runs tools in parallel, so this
      // ordering is realistic, not contrived.
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "tool_done", tool: "Write" });

      expect(session.toInfo().permissionState).toBe("pending");

      // The matching tool_done, once it finally arrives, still releases it.
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.toInfo().permissionState).toBe("idle");
    });

    it("fix: status-clearing-semantics — tool_done releases a pending planState only for ExitPlanMode", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.toInfo().planState).toBe("pending");

      session.emitHookEvent({ kind: "tool_done", tool: "ExitPlanMode" });
      expect(session.toInfo().planState).toBe("idle");
    });

    it("fix: status-clearing-semantics — a matched release clears pendingPermissionTool, so a LATER tool_done with the same name is a clean no-op rather than matching a stale pending tool", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.toInfo().permissionState).toBe("idle");
      const eventsBefore = session.getEvents().length;

      // Nothing pending anymore — this must be a genuine no-op, not a match
      // against a leftover pendingPermissionTool.
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.getEvents().length).toBe(eventsBefore);
    });

    it("fix: status-clearing-semantics — tool_done never touches gateState/promoteState (Mullion's own REST-resolved dialogs)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "rm -rf /tmp/x" });
      session.emitHookEvent({
        kind: "promote_request",
        summary: "start a worktree session",
      });
      expect(session.toInfo()).toMatchObject({ gateState: "waiting", promoteState: "pending" });

      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });

      expect(session.toInfo()).toMatchObject({ gateState: "waiting", promoteState: "pending" });
    });

    it("fix: status-clearing-semantics — a tool_done that changes nothing emits no status_change", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const eventsBefore = session.getEvents().length;

      session.emitHookEvent({ kind: "tool_done", tool: "Read" });

      expect(session.getEvents().length).toBe(eventsBefore);
    });

    it("fix: status-clearing-semantics — REGRESSION GUARD: 'progress: generating' alone releases nothing (the rejected design this replaces)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });

      session.emitHookEvent({ kind: "progress", phase: "generating" });

      expect(session.toInfo()).toMatchObject({ permissionState: "pending", planState: "pending" });
    });

    it("fix: status-clearing-semantics — a tool_done for a DIFFERENT tool still clears errorState (forward-progress evidence) even when it doesn't release permissionState", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });

      session.emitHookEvent({ kind: "tool_done", tool: "Write" });

      const info = session.toInfo();
      expect(info.errorState).toBe("idle");
      expect(info.permissionState).toBe("pending");
    });

    it("fix: status-clearing-semantics — a genuine keystroke does NOT release permissionState even when its tool matches (arrow keys navigating an open dialog must not blank it)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.write("\x1b[A"); // arrow-key navigation inside the still-open dialog

      expect(session.toInfo().permissionState).toBe("pending");
    });

    it("fix: status-clearing-semantics — a stale errorState, the finished latch, and a confirmed hookNotification attention all survive a reattach-style repaint and later plain output; only a genuine keystroke (or a resolving hook) clears them now that markViewed() is gone", async () => {
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

        session.emitHookEvent({ kind: "progress", phase: "done" });
        session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
        expect(session.toInfo()).toMatchObject({
          errorState: "tool_failure",
          lastTurnEndedAt: expect.any(Number),
          attention: true,
        });

        // A reattach (opening the workspace tab) forces a repaint — the
        // exact byte pattern markViewed() used to piggyback its "user is
        // looking" clear on. Must no longer clear anything.
        session.requestRedraw();
        pty.emitData("repainted frame");
        expect(session.toInfo()).toMatchObject({
          errorState: "tool_failure",
          lastTurnEndedAt: expect.any(Number),
          attention: true,
        });

        // Nor does arbitrary later output, once the repaint suppression
        // window has fully elapsed.
        await vi.advanceTimersByTimeAsync(300 + 400 + 500);
        pty.emitData("just more program output, not a decision");
        expect(session.toInfo()).toMatchObject({
          errorState: "tool_failure",
          lastTurnEndedAt: expect.any(Number),
          attention: true,
        });

        // A genuine keystroke is the replacement unblocking signal — clears
        // all three, and records the transition.
        const eventsBefore = session.getEvents().length;
        session.write("y");
        const info = session.toInfo();
        expect(info.errorState).toBe("idle");
        expect(info.errorDetail).toBeNull();
        expect(info.lastTurnEndedAt).toBeNull();
        expect(info.attention).toBe(false);
        const newEvents = session.getEvents().slice(eventsBefore);
        expect(newEvents.filter((e) => e.kind === "status_change")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fix: status-clearing-semantics — a genuine keystroke does NOT release permissionState/planState/elicitationState; those still need an explicit decision", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
      session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });

      session.write("y");

      const info = session.toInfo();
      expect(info.permissionState).toBe("pending");
      expect(info.planState).toBe("pending");
      expect(info.elicitationState).toBe("pending");
    });

    it("fix: status-clearing-semantics — synthetic (non-genuine) input clears none of errorState/finished/attention", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
      const eventsBefore = session.getEvents().length;

      // A focus-report is filtered by isGenuineUserInput — not a real
      // keystroke, so it must not count as the unblocking action.
      session.write("\x1b[I");

      const info = session.toInfo();
      expect(info.errorState).toBe("tool_failure");
      expect(info.lastTurnEndedAt).not.toBeNull();
      expect(info.attention).toBe(true);
      expect(session.getEvents().length).toBe(eventsBefore);
    });

    it("clearStaleErrorIfOlderThan: clears errorState past the TTL and logs a real transition", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const now = Date.now();
      session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });

      // Not yet stale.
      expect(session.clearStaleErrorIfOlderThan(600_000, now)).toBe(false);
      expect(session.toInfo().errorState).toBe("tool_failure");

      // Past the TTL.
      expect(session.clearStaleErrorIfOlderThan(600_000, now + 600_001)).toBe(true);
      expect(session.toInfo().errorState).toBe("idle");
      expect(session.toInfo().errorDetail).toBeNull();

      // A second check with nothing left to clear is a no-op, not a
      // re-trigger.
      expect(session.clearStaleErrorIfOlderThan(600_000, now + 700_000)).toBe(false);
    });

    describe("clearStaleBlockedIfOlderThan (issue #320)", () => {
      it("a1: clears a stale permissionState past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({
          kind: "permission_request",
          tool: "Bash",
          summary: "rm -rf /tmp/x",
        });
        expect(session.toInfo().permissionState).toBe("pending");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now)).toBe(false);

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().permissionState).toBe("idle");

        const events = session.getEvents();
        const statusEvent = events[events.length - 1];
        expect(statusEvent.kind).toBe("status_change");
        expect(statusEvent.payload).toMatchObject({
          reason: "stale_blocked_cleared",
          state: "permissionState",
        });
      });

      it("a2: clears a stale planState past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix bug" });
        expect(session.toInfo().planState).toBe("pending");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().planState).toBe("idle");

        const events = session.getEvents();
        const statusEvent = events[events.length - 1];
        expect(statusEvent.payload).toMatchObject({
          reason: "stale_blocked_cleared",
          state: "planState",
        });
      });

      it("a3: clears a stale gateState (waiting) past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
        expect(session.toInfo().gateState).toBe("waiting");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().gateState).toBe("idle");
        expect(session.toInfo().gatePrompt).toBeNull();

        const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
        expect(payload).toMatchObject({ reason: "stale_blocked_cleared", state: "gateState" });
      });

      it("a4: clears a stale promoteState (pending) past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "promote_request", summary: "Refactor widget" });
        expect(session.toInfo().promoteState).toBe("pending");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().promoteState).toBe("idle");
        expect(session.toInfo().promoteSummary).toBeNull();

        const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
        expect(payload).toMatchObject({ reason: "stale_blocked_cleared", state: "promoteState" });
      });

      it("a5: clears a stale elicitationState past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });
        expect(session.toInfo().elicitationState).toBe("pending");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().elicitationState).toBe("idle");
        expect(session.toInfo().elicitationServer).toBeNull();

        const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
        expect(payload).toMatchObject({
          reason: "stale_blocked_cleared",
          state: "elicitationState",
        });
      });

      it("a6: clears a stale compactState (compacting) past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
        expect(session.toInfo().compactState).toBe("compacting");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().compactState).toBe("idle");

        const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
        expect(payload).toMatchObject({ reason: "stale_blocked_cleared", state: "compactState" });
      });

      it("a7: resets stale subagentCount > 0 past the TTL and emits status_change", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
        expect(session.toInfo().subagentCount).toBe(1);

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().subagentCount).toBe(0);

        const payload = session.getEvents().findLast((e) => e.kind === "status_change")?.payload;
        expect(payload).toMatchObject({ reason: "stale_blocked_cleared", state: "subagentCount" });
      });

      it("a8: busy latches (compactState) use busyMaxAgeMs, not blockedMaxAgeMs — past the short blocked TTL but within the longer busy TTL stays untouched", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
        expect(session.toInfo().compactState).toBe("compacting");

        // Well past a 10-minute blocked TTL, but still within a 2-hour busy TTL.
        expect(session.clearStaleBlockedIfOlderThan(600_000, 7_200_000, now + 600_001)).toBe(false);
        expect(session.toInfo().compactState).toBe("compacting");
      });

      it("a9: busy latches (subagentCount) use busyMaxAgeMs, not blockedMaxAgeMs — past the short blocked TTL but within the longer busy TTL stays untouched", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
        expect(session.toInfo().subagentCount).toBe(1);

        expect(session.clearStaleBlockedIfOlderThan(600_000, 7_200_000, now + 600_001)).toBe(false);
        expect(session.toInfo().subagentCount).toBe(1);
      });

      it("a10: busy latches ARE cleared once past their own (longer) busyMaxAgeMs, even while a shorter blockedMaxAgeMs applies to blocked latches", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
        session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });

        expect(session.clearStaleBlockedIfOlderThan(600_000, 7_200_000, now + 7_200_001)).toBe(
          true,
        );
        expect(session.toInfo().compactState).toBe("idle");
        expect(session.toInfo().subagentCount).toBe(0);
      });

      it("a11: a blocked latch past blockedMaxAgeMs is cleared even while a busy latch set at the same time is still within its own (longer) busyMaxAgeMs", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({
          kind: "permission_request",
          tool: "Bash",
          summary: "rm -rf /tmp/x",
        });
        session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });

        expect(session.clearStaleBlockedIfOlderThan(600_000, 7_200_000, now + 600_001)).toBe(true);
        expect(session.toInfo().permissionState).toBe("idle");
        expect(session.toInfo().compactState).toBe("compacting");
      });

      it("b: recent blocked states are untouched by the sweep", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        session.emitHookEvent({
          kind: "permission_request",
          tool: "Bash",
          summary: "rm -rf /tmp/x",
        });
        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
        session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
        session.emitHookEvent({ kind: "promote_request", summary: "Refactor" });
        session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });
        session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
        session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Plan" });

        // Everything set at roughly `now` — well within the TTL
        const eventsBefore = session.getEvents().length;
        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 10_000)).toBe(false);
        expect(session.getEvents().length).toBe(eventsBefore);

        expect(session.toInfo()).toMatchObject({
          permissionState: "pending",
          planState: "pending",
          gateState: "waiting",
          promoteState: "pending",
          elicitationState: "pending",
          compactState: "compacting",
          subagentCount: 1,
        });
      });

      it("c: stale state with recent PTY output (lastActivityAt > latch time) is NOT cleared", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "bash",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);
          const start = Date.now();
          vi.setSystemTime(start);

          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });
          expect(session.toInfo().permissionState).toBe("pending");

          // PTY output arrives AFTER the permission was set — the agent is clearly still alive
          vi.setSystemTime(start + 100_000);
          fakePtyChildren[0].emitData("agent is still working...");

          // Now check well past the TTL
          vi.setSystemTime(start + 700_000);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(false);
          expect(session.toInfo().permissionState).toBe("pending");
        } finally {
          vi.useRealTimers();
        }
      });

      it("c2: PTY output within BLOCKED_STALE_GRACE_MS of the latch is NOT considered new activity — stale latch still cleared", async () => {
        /* Grace window: activity arriving very close to the latch timestamp
         * (e.g. the dialog render that follows the hook firing) is treated
         * as part of the same triggering event, not as evidence the agent
         * is still progressing. Without this, the dialog's own PTY render
         * would permanently block the sweep. */
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "bash",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);
          const latchTime = 100_000;
          vi.setSystemTime(latchTime);

          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });
          expect(session.toInfo().permissionState).toBe("pending");

          // PTY output arrives just 100ms after the latch — well within the
          // 2000ms grace window. This simulates the dialog rendering to PTY
          // at the same moment the hook fires (the real-world scenario this
          // PR fixes).
          vi.setSystemTime(latchTime + 100);
          fakePtyChildren[0].emitData("rendered prompt dialog...");

          // Advance past the TTL (600s)
          vi.setSystemTime(latchTime + 700_000);

          // With the grace window fix, the sweep should detect the latch as
          // stale — the 100ms-later PTY output is just the dialog render,
          // not genuine new agent activity.
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().permissionState).toBe("idle");
        } finally {
          vi.useRealTimers();
        }
      });

      it("d: only stale latches are cleared, recent ones remain — permission stale, plan recent", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "bash",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);
          const start = Date.now();
          vi.setSystemTime(start);

          // Old permission request
          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });

          // Recent plan_ready — just before the sweep (10s ago, well within TTL)
          vi.setSystemTime(start + 690_000);
          session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });

          // Sweep with 600s TTL: permission (set at 0) is old, plan (set at 690s) is recent
          vi.setSystemTime(start + 700_000);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().permissionState).toBe("idle");
          expect(session.toInfo().planState).toBe("pending");
        } finally {
          vi.useRealTimers();
        }
      });

      it("e: stale subagentCount > 0 resets to 0 and clears subagentCountAt", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "bash",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);
          const start = Date.now();
          vi.setSystemTime(start);

          session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
          expect(session.toInfo().subagentCount).toBe(1);

          vi.setSystemTime(start + 700_000);
          expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now())).toBe(true);
          expect(session.toInfo().subagentCount).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("f: clearStaleBlockedIfOlderThan returns false when nothing is stale", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        // Nothing set at all
        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now)).toBe(false);
        // Already cleared states
        session.emitHookEvent({ kind: "progress", phase: "done" });
        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now)).toBe(false);
      });
    });

    it("PtyManager.sweepStaleErrors: only local sessions past the TTL, returns cleared ids", async () => {
      const stale = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      const fresh = manager.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(stale);
      await waitForSpawn(fresh);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        stale.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });

        vi.setSystemTime(start + 700_000);
        fresh.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });

        const cleared = manager.sweepStaleErrors(600_000);

        expect(cleared).toEqual(["1"]);
        expect(stale.toInfo().errorState).toBe("idle");
        expect(fresh.toInfo().errorState).toBe("tool_failure");
      } finally {
        vi.useRealTimers();
      }
    });

    it("PtyManager.sweepStaleStates: calls clearStaleBlockedIfOlderThan on each session, returns ids of stale sessions", async () => {
      const stale = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      const fresh = manager.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(stale);
      await waitForSpawn(fresh);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        stale.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });

        vi.setSystemTime(start + 700_000);
        fresh.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });

        const cleared = manager.sweepStaleStates(600_000, 600_000);

        expect(cleared).toEqual(["1"]);
        expect(stale.toInfo().permissionState).toBe("idle");
        expect(fresh.toInfo().permissionState).toBe("pending");
      } finally {
        vi.useRealTimers();
      }
    });

    it("PtyManager.sweepStaleStates: applies busyMaxAgeMs (not blockedMaxAgeMs) to compact/subagent latches (issue #320 follow-up)", async () => {
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
        session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });

        // Past a 10-minute blockedMaxAgeMs, but still within a 2-hour busyMaxAgeMs.
        vi.setSystemTime(start + 600_001);
        expect(manager.sweepStaleStates(600_000, 7_200_000)).toEqual([]);
        expect(session.toInfo().compactState).toBe("compacting");

        // Now past the busyMaxAgeMs too.
        vi.setSystemTime(start + 7_200_001);
        expect(manager.sweepStaleStates(600_000, 7_200_000)).toEqual(["1"]);
        expect(session.toInfo().compactState).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    });

    it("compact: tracks compactState across a started/finished pair", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().compactState).toBe("idle");

      session.emitHookEvent({ kind: "compact", state: "started", trigger: "auto" });
      expect(session.toInfo().compactState).toBe("compacting");

      session.emitHookEvent({ kind: "compact", state: "finished" });
      expect(session.toInfo().compactState).toBe("idle");
    });

    it("subagent: increments/decrements subagentCount, clamped at zero", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().subagentCount).toBe(0);

      session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
      session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Plan" });
      expect(session.toInfo().subagentCount).toBe(2);

      session.emitHookEvent({ kind: "subagent", state: "finished" });
      expect(session.toInfo().subagentCount).toBe(1);

      // An extra "finished" this session never saw a matching "started"
      // for (e.g. one that began just before a restart) must not drive the
      // count negative.
      session.emitHookEvent({ kind: "subagent", state: "finished" });
      session.emitHookEvent({ kind: "subagent", state: "finished" });
      expect(session.toInfo().subagentCount).toBe(0);
    });

    it("elicitation: sets elicitationState to pending, flips attention, and clears on finish", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });

      expect(session.toInfo()).toMatchObject({
        elicitationState: "pending",
        elicitationServer: "my-mcp",
        attention: true,
      });
      const events = session.getEvents();
      expect(events[events.length - 2]).toMatchObject({
        kind: "elicitation",
        payload: { state: "started", server: "my-mcp" },
      });
      expect(events[events.length - 1]).toMatchObject({
        kind: "attention",
        payload: { attention: true, signal: "elicitation" },
      });

      session.emitHookEvent({ kind: "elicitation", state: "finished" });

      expect(session.toInfo()).toMatchObject({
        elicitationState: "idle",
        elicitationServer: null,
        attention: false,
      });
    });

    it("permission_resolved: clears permissionState and a confirmed permissionRequest attention signal", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      expect(session.toInfo()).toMatchObject({ permissionState: "pending", attention: true });

      session.emitHookEvent({ kind: "permission_resolved" });

      expect(session.toInfo()).toMatchObject({ permissionState: "idle", attention: false });
    });

    it("plan_resolved: clears planState and a confirmed planReady attention signal", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix" });
      expect(session.toInfo()).toMatchObject({ planState: "pending", attention: true });

      session.emitHookEvent({ kind: "plan_resolved" });

      expect(session.toInfo()).toMatchObject({ planState: "idle", attention: false });
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

    it("PtyManager.markHooksProven() routes to the right session by id and is a no-op for an untracked id (gap #1)", async () => {
      const a = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(a);

      expect(() => manager.markHooksProven("999")).not.toThrow();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("splash frame 1");
        vi.setSystemTime(start + 1_200);
        fakePtyChildren[0].emitData("splash frame 2");

        manager.markHooksProven("1");
        a.tick(start + 1_200 + 10_000); // short bound -- must not fire, now proven
        expect(a.toInfo().attention).toBe(false);
      } finally {
        vi.useRealTimers();
      }
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

    it("permission_request state clears on progress:done", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().permissionState).toBe("idle");

      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "npm install" });
      expect(session.toInfo().permissionState).toBe("pending");

      session.emitHookEvent({ kind: "progress", phase: "done" });
      expect(session.toInfo().permissionState).toBe("idle");
    });

    it("stop_failure error state clears on any progress event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.toInfo().errorState).toBe("idle");

      session.emitHookEvent({ kind: "stop_failure", error: "rate_limit" });
      expect(session.toInfo().errorState).toBe("api_error");

      session.emitHookEvent({ kind: "progress", phase: "thinking" });
      expect(session.toInfo().errorState).toBe("idle");
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

      expect(session.toInfo()).toMatchObject({
        gateState: "denied",
        gatePrompt: null,
        // Follow-up to #275 (gap #3): resolveGate is now the superseding
        // resolution that clears a reviewGate-confirmed flag (it no longer
        // clears on the tool call's own PTY output — see resolveGate's doc
        // comment), so the attention flag comes down alongside the decision.
        attention: false,
      });
      const events = session.getEvents();
      // The gap #3 clear fires an "attention" event AFTER the review_gate
      // event — check the review_gate event by content, not by position.
      const reviewGateEvent = events.findLast((e) => e.kind === "review_gate");
      expect(reviewGateEvent).toMatchObject({
        kind: "review_gate",
        payload: { state: "denied", reason: "looks unsafe" },
      });
      expect(events[events.length - 1]).toMatchObject({
        kind: "attention",
        payload: { attention: false },
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

    it("Session.resolveGate does not dismiss a NEWER, unrelated confirmed flag (gated on confirmedKind)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
      // A fresh, unrelated notification supersedes the reviewGate as the
      // currently-confirmed kind before the gate decision arrives.
      session.emitHookEvent({ kind: "notification", title: "Build failed", body: "" });
      expect(session.toInfo().attention).toBe(true);

      session.resolveGate("approved");

      // The stale gate resolution must not clear the newer notification.
      expect(session.toInfo().attention).toBe(true);
    });

    it("Session.resolveGate is a no-op on the attention machine when nothing is confirmed", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.resolveGate("approved"); // no prior "waiting" review_gate at all

      expect(session.toInfo().attention).toBe(false);
      const events = session.getEvents();
      expect(events.some((e) => e.kind === "attention")).toBe(false);
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
    it("spawns a matching (claude) command with --settings and --mcp-config appended, and writes both files (issue #271)", async () => {
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
      const mcpConfigPath = path.join(sessionsDir, "1.mcp.json");
      expect(fs.existsSync(mcpConfigPath)).toBe(true);

      // reviewGateEnabled defaults to false (PtyManager constructed with no
      // override above) — the blocking PreToolUse gate for Bash must not be
      // written by default, or every Bash call from this session would stall
      // on a human decision nobody unattended can give (see env.ts's
      // MULLION_REVIEW_GATE_ENABLED doc comment). The ExitPlanMode matcher
      // is always registered regardless of reviewGateEnabled.
      const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      expect(written.hooks.PreToolUse).toBeDefined();
      expect(written.hooks.PreToolUse[0].matcher).toBe("ExitPlanMode");
      expect(written.hooks.PreToolUse[1]).toBeUndefined();

      // .findLast, not .find: this mock is shared (and never cleared)
      // across every test in this file, so earlier tests' own "systemd-run"
      // calls are still in its history — only the MOST RECENT one is this
      // test's own spawn.
      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      expect(call).toBeDefined();
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe(
        `claude --settings ${JSON.stringify(settingsPath)} --mcp-config ${JSON.stringify(mcpConfigPath)}`,
      );
    });

    it("registers the blocking PreToolUse gate and injects MULLION_REVIEW_GATE_ENABLED=true only when PtyManager is constructed with reviewGateEnabled: true", async () => {
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
      expect(written.hooks.PreToolUse[0].matcher).toBe("ExitPlanMode");
      expect(written.hooks.PreToolUse[1].matcher).toBe("Bash");

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      expect(call).toBeDefined();
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.MULLION_REVIEW_GATE_ENABLED).toBe("true");

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

    it("appends the skip-permissions flag when skipPermissions is true", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        skipPermissions: true,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toMatch(/claude.*--dangerously-skip-permissions/);
    });

    it("does not append the skip-permissions flag when skipPermissions is false or absent", async () => {
      const session = manager.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).not.toMatch(/--dangerously-skip-permissions/);
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

describe("Session state file persistence (issue #323)", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-state-test-"));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function makeSession(id = "1") {
    return new Session({
      id,
      cwd: "/tmp",
      command: "bash",
      socketPath: path.join(sessionsDir, `${id}.sock`),
      cols: 80,
      rows: 24,
      hookSocketPath: path.join(sessionsDir, "hooks.sock"),
      sessionsDir,
    });
  }

  function stateFilePath(id = "1"): string {
    return path.join(sessionsDir, `${id}.state.json`);
  }

  function socketPath(id = "1"): string {
    return path.join(sessionsDir, `${id}.sock`);
  }

  it("reports stateRestored=true for a fresh session with no state file on disk (nothing lost)", () => {
    const session = makeSession();
    const info = session.toInfo();
    expect(info.stateRestored).toBe(true);
    expect(info.staleHooks).toBe(false);
    expect(info.restoredVersion).toBeNull();
  });

  it("restores state from a valid file on construction", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "pending",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 2,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();

    expect(info.stateRestored).toBe(true);
    expect(info.permissionState).toBe("pending");
    expect(info.subagentCount).toBe(2);
  });

  it("restores permissionState pending from state file", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "pending",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    expect(session.toInfo().permissionState).toBe("pending");
  });

  it("handles a corrupt state file gracefully by using defaults", () => {
    fs.writeFileSync(stateFilePath("1"), "not valid json");

    const session = makeSession("1");
    const info = session.toInfo();
    expect(info.stateRestored).toBe(true);
    expect(info.permissionState).toBe("idle");
  });

  it("handles a state file with missing fields by using defaults for those fields", () => {
    const state = { v: 1, launchedAtVersion: "0.0.0", state: {} };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();
    // permissionState should default to "idle" when not in the file
    expect(info.stateRestored).toBe(true);
    expect(info.permissionState).toBe("idle");
  });

  it("reports stateRestored=false when the dtach socket already exists (a real reattach) but there is no state file to restore from", () => {
    // Unlike the "fresh session, no state file" case above, an existing
    // socket means a dtach master really did survive a restart — so a
    // missing state file here is genuine data loss, not "nothing to
    // restore yet", and stateRestored must NOT be forced true.
    fs.writeFileSync(socketPath("1"), "");

    const session = makeSession("1");
    expect(session.toInfo().stateRestored).toBe(false);
  });

  it("reports stateRestored=false when the dtach socket already exists but the state file is corrupt", () => {
    fs.writeFileSync(socketPath("1"), "");
    fs.writeFileSync(stateFilePath("1"), "not valid json");

    const session = makeSession("1");
    const info = session.toInfo();
    expect(info.stateRestored).toBe(false);
    expect(info.permissionState).toBe("idle");
  });

  it("reports staleHooks=true when current version differs from launchedAtVersion", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: { permissionState: "idle" },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();
    // The current app version is "0.2.9" — older than 0.2.9 would be stale
    expect(info.staleHooks).toBe(true);
  });

  it("reports staleHooks=false when launchedAtVersion matches current version", () => {
    const { version } = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    const state = {
      v: 1,
      launchedAtVersion: version,
      state: { permissionState: "idle" },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();
    expect(info.staleHooks).toBe(false);
    expect(info.restoredVersion).toBe(version);
  });

  it("reports restoredVersion from the state file", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.1.0",
      state: { permissionState: "idle" },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));
    const session = makeSession("1");
    expect(session.toInfo().restoredVersion).toBe("0.1.0");
  });

  it("forces a flush at MAX_WRITE_DELAY_MS even when continuous activity keeps resetting the 5s debounce window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = makeSession("1");
      const filePath = stateFilePath("1");

      // Each emit lands well inside the 5s trailing-edge debounce window
      // (scheduleStateFileWrite's own setTimeout), so the debounce timer
      // keeps getting reset before it can ever fire on its own -- the ONLY
      // thing that can force a write here is the MAX_WRITE_DELAY_MS
      // (30s) ceiling armed on the very first dirty transition.
      for (let i = 0; i < 8; i++) {
        session.emitHookEvent({ kind: "notification", title: `n${i}`, body: "" });
        await vi.advanceTimersByTimeAsync(4000); // t = 4000, 8000, ..., 32000
        if (i < 7) {
          expect(fs.existsSync(filePath)).toBe(false);
        }
      }

      // The ceiling armed at t=0 for t=30000 fires within the final 4s
      // advance (t: 28000 -> 32000), despite the trailing debounce having
      // been reset every 4s the whole way through and never once reaching
      // its own 5s window uninterrupted.
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Session.hookEmits (issue #351)", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-hookemits-"));
    // Create sessionsDir for Session constructor
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function makeSession(opts: { id: string; command: string; cols?: number; rows?: number }) {
    return new Session({
      id: opts.id,
      cwd: "/tmp",
      command: opts.command,
      socketPath: path.join(sessionsDir, `${opts.id}.sock`),
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      hookSocketPath: path.join(sessionsDir, "hooks.sock"),
      sessionsDir,
    });
  }

  it("reports hookEmits matching CLAUDE_CODE_EMITS for a claude-matching command", () => {
    const session = makeSession({ id: "1", command: "claude" });
    // bootstrapMaster() calls applyHookAdapters — but we can't easily mock
    // its I/O side effects here (node-pty spawn, systemd-run). Instead, we
    // inject via the Session's private field directly to test toInfo().
    (session as unknown as { hookEmits: readonly string[] }).hookEmits = [
      "notification",
      "progress",
      "file_change",
      "session_start",
      "cwd_changed",
      "permission_request",
      "tool_done",
      "stop_failure",
      "tool_failure",
      "session_end",
      "plan_ready",
      "git_branch",
      "turn_start",
      "compact",
      "subagent",
      "permission_resolved",
      "elicitation",
      "promote_request",
    ];
    const info = session.toInfo();
    expect(info.hookEmits).toContain("notification");
    expect(info.hookEmits).toContain("progress");
    expect(info.hookEmits).toContain("stop_failure");
    expect(info.hookEmits).toContain("session_end");
  });

  it("reports hookEmits as [] for a bash (non-matching) command", () => {
    const session = makeSession({ id: "2", command: "bash" });
    const info = session.toInfo();
    expect(info.hookEmits).toEqual([]);
  });
});
