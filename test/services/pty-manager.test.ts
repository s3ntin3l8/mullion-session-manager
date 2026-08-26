import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import type { HookMessage } from "../../src/services/hook-protocol.js";
import { sessionAgentGuidePath } from "../../src/services/agent-guide.js";

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

// Perf audit finding B8(2) — the fake `systemctl --user list-units` reply
// isMasterAliveBatch() should see: a list of unit names to report as
// active, in the real `--plain --no-legend` output shape. Defaults to
// empty (nothing active) so tests unrelated to isMasterAliveBatch don't
// need to care about it, mirroring isActiveReplies' own default-fallback
// convention above.
let listUnitsReply: string[] = [];

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
      if (file === "systemctl" && args[1] === "list-units") {
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            const lines = listUnitsReply
              .map((unit) => `${unit} loaded active running ${unit}`)
              .join("\n");
            ee.stdout?.emit("data", Buffer.from(lines ? `${lines}\n` : ""));
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
const { getAdapterEmits } = await import("../../src/services/hook-adapters/index.js");

describe("getSkipPermissionFlag", () => {
  it("returns the flag for a bare binary name", () => {
    expect(getSkipPermissionFlag("claude")).toBe("--dangerously-skip-permissions");
    expect(getSkipPermissionFlag("codex")).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(getSkipPermissionFlag("opencode")).toBe("--auto");
    expect(getSkipPermissionFlag("gemini")).toBe("--approval-mode yolo");
    expect(getSkipPermissionFlag("agy")).toBe("--dangerously-skip-permissions --mode accept-edits");
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
    listUnitsReply = [];
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

  // A10 — an inconclusive socket probe must not unlink a live dtach socket.
  it("does not unlink or bootstrap a socket whose probe is merely inconclusive, not confirmed dead (A10)", async () => {
    // Real-world "unknown" is either the 2s probe timeout or a non-
    // ECONNREFUSED connect error (EACCES, ENOTSOCK, ...) — see
    // unix-socket.ts's own doc comment. Rather than depend on which syscall
    // error a plain regular file happens to produce on any given OS/kernel
    // (not portable, and not the point of this test), force the exact
    // "unknown" outcome directly and assert on spawnInternal()'s reaction to
    // it — the same "assert on the SUT's behavior, not on OS plumbing"
    // approach the rest of this file already uses for `systemctl` replies
    // via isActiveReplies.
    const unixSocketModule = await import("../../src/services/unix-socket.js");
    const socketFilePath = path.join(sessionsDir, "1.sock");
    fs.writeFileSync(socketFilePath, "");
    const probeSpy = vi.spyOn(unixSocketModule, "probeSocket").mockResolvedValue("unknown");
    // spawnChildProcess is a module-level mock shared across this whole test
    // file (not reset per-test), so a plain `.not.toHaveBeenCalledWith(...)`
    // would also "pass" for the wrong reason if it only ever inspected the
    // full cross-test history — snapshot the call count first and only
    // inspect calls made by THIS test.
    const callsBefore = vi.mocked(spawnChildProcess).mock.calls.length;

    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(probeSpy).toHaveBeenCalledWith(socketFilePath);

      // The file must survive completely untouched — no unlink attempt.
      // Before the fix, isSocketLive() collapsed "unknown" straight to
      // `false`, and spawnInternal() would unlinkSync this file and
      // bootstrap a brand-new systemd-run scope — deleting the only handle
      // to what could genuinely be a live, running agent process, whose
      // real dtach master would then collide with the freshly-created scope
      // and be orphaned.
      expect(fs.existsSync(socketFilePath)).toBe(true);
      expect(fs.readFileSync(socketFilePath, "utf8")).toBe("");

      // No fresh systemd-run bootstrap either — that's the second half of
      // the same bug (the follow-on scope creation colliding with the
      // still-active one and orphaning the real master).
      const callsDuringThisTest = vi.mocked(spawnChildProcess).mock.calls.slice(callsBefore);
      expect(callsDuringThisTest.some((call) => call[0] === "systemd-run")).toBe(false);

      // spawnInternal() falls through to attachClient() regardless (an
      // inconclusive probe is treated the same as "live" — just attempt the
      // dtach -a attach, which fails harmlessly against a genuinely stale
      // socket) — so this session still ends up alive via the mocked pty.
      expect(session.isAlive).toBe(true);
    } finally {
      probeSpy.mockRestore();
    }
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

  // Perf audit finding B8(1) — getScrollbackTail() backs the 10s
  // dev-server-detect sweep (dev-server-detect.ts's
  // detectDevServerPortForPlainSession): it must return only the most
  // recent bytes, not getScrollback()'s full ring, and — unlike
  // getScrollback() — no mode preamble, since callers only feed it into a
  // text scan.
  describe("getScrollbackTail", () => {
    it("returns everything (no preamble) when total scrollback is under the requested cap", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData("hello world");

      expect(session.getScrollbackTail(1024).toString()).toBe("hello world");
    });

    it("returns only the last N bytes when scrollback exceeds the requested cap", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData("a".repeat(100));
      fakePtyChildren[0].emitData("b".repeat(100));
      fakePtyChildren[0].emitData("c".repeat(100));

      const tail = session.getScrollbackTail(150);
      expect(tail.length).toBe(150);
      // Exactly the last 150 bytes of "a"*100 + "b"*100 + "c"*100: the last
      // 50 b's followed by all 100 c's.
      expect(tail.toString()).toBe(`${"b".repeat(50)}${"c".repeat(100)}`);
    });

    it("never returns more than the requested cap even across many small chunks", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      for (let i = 0; i < 50; i++) fakePtyChildren[0].emitData(`chunk-${i}-`);

      const tail = session.getScrollbackTail(64);
      expect(tail.length).toBeLessThanOrEqual(64);
      // Must end with the very last chunk emitted.
      expect(tail.toString().endsWith("chunk-49-")).toBe(true);
    });
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

  it("resets attentionState on respawn so a stale confirmedKind doesn't leak into the new incarnation", async () => {
    // Set up confirmed attention via a BEL byte + tick past its debounce window.
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);
    fakePtyChildren[0].emitData("done\x07");
    first.tick(Date.now() + 2_000);
    expect(first.toInfo().attention).toBe(true);

    // Kill and respawn — the new session must have a fresh attention machine.
    fakePtyChildren[0].kill();
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    expect(session.toInfo().attention).toBe(false);
    expect(session.toInfo().attentionKind).toBeNull();
    expect(session.toInfo().attentionAt).toBeNull();
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
    // with this same escape sequence (ScrollbackBuffer.push() stores it
    // verbatim regardless of mode tracking), same reason the alt-screen
    // tests above use startsWith rather than asserting the full byte count.
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
    // still contain "\x1b[?1000h" as history (ScrollbackBuffer.push() stores
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

  it("suppresses scrollback capture during a redraw-nudge repaint but still delivers it live", async () => {
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

      // Flush the spawn-time nudge (attachClient() -> RedrawNudge.trigger())
      // so it doesn't interfere with the assertions below.
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
      // i.e. exactly the case the old redraw-nudge-suppression-only fix
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
    // agentIdle now settles for 3s (ATTENTION_SETTLE_MS) before it confirms —
    // advance past that window so it's actually CONFIRMED before exercising
    // the output-clears-it behavior this test is about.
    session.tick(Date.now() + 3_000);
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

  // B9 — WS->PTY backpressure: a large paste (or a burst of rapid messages)
  // into a session whose program isn't reading its stdin must not grow the
  // write queue without bound.
  describe("write() backpressure (B9)", () => {
    it("drops writes once WRITE_BACKPRESSURE_MAX_BYTES is exceeded within the current window", async () => {
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
        vi.setSystemTime(0);
        // A single "paste" comfortably under the 4 MiB cap goes through in
        // full.
        const underCap = "a".repeat(3 * 1024 * 1024);
        session.write(underCap);
        expect(fakePtyChildren[0].writeSpy).toHaveBeenCalledWith(underCap);

        // A second chunk that pushes the running total over the cap, still
        // within the same window, is dropped entirely rather than partially
        // written or queued.
        fakePtyChildren[0].writeSpy.mockClear();
        const overCap = "b".repeat(2 * 1024 * 1024);
        session.write(overCap);
        expect(fakePtyChildren[0].writeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("many rapid small messages within the window are capped the same way a single large paste is", async () => {
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
        vi.setSystemTime(0);
        const chunk = "x".repeat(512 * 1024); // 0.5 MiB per message
        for (let i = 0; i < 16; i++) session.write(chunk); // 8 MiB total, well over the 4 MiB cap

        const writtenBytes = fakePtyChildren[0].writeSpy.mock.calls.reduce(
          (sum: number, [data]: [string]) => sum + Buffer.byteLength(data, "utf8"),
          0,
        );
        expect(writtenBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(writtenBytes).toBeGreaterThan(0); // not everything was dropped
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the cap once the window elapses, so a session recovers rather than staying capped forever", async () => {
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
        vi.setSystemTime(0);
        session.write("a".repeat(4 * 1024 * 1024)); // fills the window's cap exactly
        fakePtyChildren[0].writeSpy.mockClear();
        session.write("b"); // dropped — still within the same window
        expect(fakePtyChildren[0].writeSpy).not.toHaveBeenCalled();

        // Past WRITE_BACKPRESSURE_WINDOW_MS (1000ms), the window resets.
        vi.setSystemTime(1_001);
        session.write("c");
        expect(fakePtyChildren[0].writeSpy).toHaveBeenCalledWith("c");
      } finally {
        vi.useRealTimers();
      }
    });

    it("still clears a confirmed attention flag on a dropped write — the user genuinely acted", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      // Same OUTPUT_IMMUNE_KINDS-confirmed attention flag the "focus-report
      // / mouse-report / OSC color-reply" test above exercises — only a
      // genuine keystroke (write()'s own isGenuineUserInput check) clears
      // it, not mere output.
      session.emitHookEvent({ kind: "notification", title: "Permission needed", body: "" });
      expect(session.toInfo().attention).toBe(true);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(0);
        session.write("a".repeat(4 * 1024 * 1024)); // fills the cap
        fakePtyChildren[0].writeSpy.mockClear();

        // Dropped by the cap, but it's still a genuine keystroke — the
        // attention flag above must still clear. Only the actual
        // ptyProcess.write() call is skipped on a drop; everything else in
        // write() (lastUserInputAt, the genuine-user-input transition) runs
        // unconditionally.
        session.write("y");
        expect(fakePtyChildren[0].writeSpy).not.toHaveBeenCalled();
        expect(session.toInfo().attention).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
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

  // Issue #676 — a promoted session's brand-new dockview panel can attach
  // with a garbage-tiny size (production incident: a real WS attach with
  // cols=10&rows=13), which reaches here as a real resize and silently
  // killed a freshly-booted opencode session (its own "terminal too small"
  // exit path, reproduced in isolation with no dtach/nudge/worktree
  // involved). Session must never construct or resize below the floor.
  it("clamps an initial spawn size below the floor", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 10,
      rows: 5,
    });
    await waitForSpawn(session);

    expect(session.toInfo().cols).toBe(40);
    expect(session.toInfo().rows).toBe(10);
    // attachClient() spawns the pty at the (already-clamped) tracked size.
    expect(fakePtyChildren[0].cols).toBe(40);
    expect(fakePtyChildren[0].rows).toBe(10);
  });

  it("does not clamp an initial spawn size that's already at or above the floor", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    expect(session.toInfo().cols).toBe(80);
    expect(session.toInfo().rows).toBe(24);
    expect(fakePtyChildren[0].cols).toBe(80);
    expect(fakePtyChildren[0].rows).toBe(24);
  });

  it("clamps a resize() call below the floor, and calls through to the pty with the clamped size", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.resize(10, 5);
    expect(fakePtyChildren[0].resizeSpy).toHaveBeenCalledWith(40, 10);
    expect(session.toInfo().cols).toBe(40);
    expect(session.toInfo().rows).toBe(10);
  });

  it("does not clamp a resize() call that's already at or above the floor", async () => {
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
    expect(session.toInfo().cols).toBe(120);
    expect(session.toInfo().rows).toBe(40);
  });

  it("requestRedraw dips then restores rows to force a repaint", async () => {
    // Fake only setTimeout/clearTimeout — RedrawNudge.trigger()'s the sole
    // user of real timers on this path, and leaving setImmediate real keeps
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

      // Flush the spawn-time nudge (attachClient() -> RedrawNudge.trigger())
      // so it doesn't interfere with the assertions below.
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
    // unserialized RedrawNudge.trigger() calls used to schedule fully
    // independent dip/restore/grace-reset timers, so a second reattach
    // landing while a first cycle was still in flight produced FOUR resize
    // calls (two dips, two restores) instead of one clean pair, and could
    // let the first cycle's grace-reset clear suppression mid-repaint (see
    // the next test).
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
      // Re-nudge BEFORE the first cycle's dip (300ms) fires — RedrawNudge.
      // cancel() clears its still-pending dip timer, so the first cycle
      // never produces any resize call at all; only the second
      // (superseding) cycle's own dip/restore should ever fire.
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
    // grace-reset (suppressed = false) could fire while a SECOND, later
    // cycle's own dip/restore repaint was still genuinely in flight —
    // letting that second cycle's own reduced-height dip frame leak into
    // scrollback and get replayed to a future attach. RedrawNudge.cancel()
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

      // Cycle 2 starts at t=800 — RedrawNudge.cancel() cancels cycle 1's
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

  // A8 — state-file lifecycle: lost on restart, resurrected on delete.
  it("kill() flushes pending dirty state immediately, not after the 5s debounce (A8)", async () => {
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

      const filePath = path.join(sessionsDir, "1.state.json");

      // Dirty the state (schedules the normal 5s debounced write) without
      // ever letting that timer fire on its own.
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "Run ls" });
      expect(session.toInfo().permissionState).toBe("pending");
      expect(fs.existsSync(filePath)).toBe(false);

      // Before the fix, both stateFileTimeout and stateFileCeilingTimeout
      // are .unref()'d and kill() never flushed — so a `systemctl --user
      // restart` (which drains the event loop, exactly what killAll() on
      // shutdown simulates here) would silently drop this pending
      // permissionState. manager.kill() must flush synchronously instead
      // of relying on the debounce timer to get there first.
      manager.kill("1");

      expect(fs.existsSync(filePath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        state: { permissionState: string };
      };
      expect(written.state.permissionState).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminate() leaves no resurrected state file even after waiting past the old 5s debounce window (A8)", async () => {
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

      const filePath = path.join(sessionsDir, "1.state.json");

      // Dirty the state so there's something for a stray write to
      // resurrect, then terminate. terminate() -> kill() -> ptyProcess.kill()
      // triggers the fake pty's onExit synchronously, which (before the
      // fix) re-dirties the session via emitEvent("status_change") and
      // arms a BRAND NEW 5s timer after kill()'s own flush already ran —
      // that timer would fire after terminate()'s own unlinkSync below,
      // resurrecting the file terminate() just deleted.
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "Run ls" });

      await manager.terminate("1");

      expect(fs.existsSync(filePath)).toBe(false);

      // Advance well past both the old 5s debounce and the 30s ceiling —
      // before the fix, a leftover timer would fire in here and recreate
      // the file for a session that no longer exists.
      await vi.advanceTimersByTimeAsync(35_000);

      expect(fs.existsSync(filePath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // B9 — a seed stashed for the promote flow (stashSeed) must not leak
  // forever when `id` is genuinely done (terminate(), the exited-session
  // reconciler, a spawn-failure rollback) before its SessionStart hook ever
  // fires and consumes it (consumeSeed) — but a plain kill()/killAll() must
  // NOT discard it, since killAll() is reached on a graceful shutdown/
  // redeploy, where the dtach master and program (and so a still-pending
  // SessionStart hook) survive. Independent review on PR #587 caught an
  // earlier version of this fix clearing it unconditionally inside kill()
  // itself, which would have silently lost a seed on every redeploy.
  it("kill() alone (the killAll()-reachable path) does NOT clear a stashed seed", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.stashSeed("1", "some initial prompt");
    manager.kill("1");

    expect(manager.consumeSeed("1")).toBe("some initial prompt");
  });

  it("killAll() (the redeploy/shutdown path) does NOT clear a stashed seed", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.stashSeed("1", "some initial prompt");
    manager.killAll();

    expect(manager.consumeSeed("1")).toBe("some initial prompt");
  });

  it("discardPendingSeed() explicitly clears a stashed-but-never-consumed seed", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.stashSeed("1", "some initial prompt");
    manager.kill("1");
    manager.discardPendingSeed("1");

    // consumeSeed is single-use and destructive, so calling it once already
    // proves whether anything was left.
    expect(manager.consumeSeed("1")).toBeNull();
  });

  it("terminate() discards a stashed seed (it's a genuinely terminal call, unlike kill() alone)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.stashSeed("1", "some initial prompt");
    await manager.terminate("1");

    expect(manager.consumeSeed("1")).toBeNull();
  });

  it("discardPendingSeed() does not clear an unrelated session's stashed seed", async () => {
    const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(a);
    await waitForSpawn(b);

    manager.stashSeed("1", "seed for session 1");
    manager.stashSeed("2", "seed for session 2");
    manager.kill("1");
    manager.discardPendingSeed("1");

    expect(manager.consumeSeed("1")).toBeNull();
    expect(manager.consumeSeed("2")).toBe("seed for session 2");
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

  // Perf audit finding B8(2) — batched counterpart to isMasterAlive above:
  // a single `systemctl --user list-units` spawn for the whole id batch,
  // instead of one `is-active` spawn per id.
  describe("isMasterAliveBatch", () => {
    it("resolves true only for ids whose scope unit is in the active list", async () => {
      listUnitsReply = ["crs-session-1.scope", "crs-session-3.scope"];
      await expect(manager.isMasterAliveBatch(["1", "2", "3"])).resolves.toEqual({
        "1": true,
        "2": false,
        "3": true,
      });
    });

    it("spawns exactly one systemctl call for the whole batch, not one per id", async () => {
      listUnitsReply = ["crs-session-1.scope", "crs-session-2.scope"];
      vi.mocked(spawnChildProcess).mockClear();
      await manager.isMasterAliveBatch(["1", "2", "3", "4", "5"]);
      expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
        "systemctl",
        [
          "--user",
          "list-units",
          "--type=scope",
          "--state=active",
          "--no-legend",
          "--plain",
          "crs-session-*.scope",
        ],
        expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
      );
    });

    it("resolves an empty record for an empty id list without spawning anything", async () => {
      vi.mocked(spawnChildProcess).mockClear();
      await expect(manager.isMasterAliveBatch([])).resolves.toEqual({});
      expect(vi.mocked(spawnChildProcess)).not.toHaveBeenCalled();
    });

    it("resolves every id false when nothing is active", async () => {
      listUnitsReply = [];
      await expect(manager.isMasterAliveBatch(["1", "2"])).resolves.toEqual({
        "1": false,
        "2": false,
      });
    });

    // Trust rule (see isMasterAliveBatch's own doc comment) — a spawn
    // failure means "unknown," not "confirmed not alive": resolving with
    // false for every id would tell session-reconciler.ts to mass-exit
    // every active session on a single transient systemctl error. An empty
    // record hits the reconciler's own "host omitted liveness, skip"
    // branch instead (the same one that already protects the
    // remote-host/partial-response case).
    it("resolves an empty record (not all-false) when the spawn itself fails", async () => {
      vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
        const ee = new EventEmitter();
        setImmediate(() => ee.emit("error", new Error("ENOENT")));
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });
      await expect(manager.isMasterAliveBatch(["1", "2"])).resolves.toEqual({});
    });

    it("resolves an empty record (not all-false) when systemctl exits non-zero", async () => {
      vi.mocked(spawnChildProcess).mockImplementationOnce(() => {
        const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 1);
          setImmediate(() => ee.emit("close", 1));
        });
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });
      await expect(manager.isMasterAliveBatch(["1", "2"])).resolves.toEqual({});
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

    it("a MATCHED-but-never-PROVEN hooksActive session uses the slow watchdog, same as a proven session", async () => {
      // Models the untrusted-codex scenario: hooksActive true (an adapter
      // matched), but no hook has ever actually fired, so hooksProven never
      // latches. Before this fix, tick() used the fast 10s bound here,
      // causing repeated "needs input" cycles (every 10s of silence after
      // a work streak). Now hooksActive alone gates the long watchdog — the
      // hook pipeline gets 60s to prove itself, avoiding the false-alarm
      // cycle for sessions whose hooks arrived at least once before a
      // restart. Uses "claude" (not "codex") purely to avoid codex's
      // real-$CODEX_HOME managedInstall filesystem write — see the
      // dedicated "Codex (issue #252)" describe block below for that
      // adapter's own install coverage; the latch logic under test here is
      // adapter-agnostic.
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

        // Well past the fast 10s bound — must NOT fire, because hooksActive
        // gates the 60s watchdog regardless of hooksProven.
        session.tick(start + 1_200 + 60_000 - 1);
        expect(session.toInfo().attention).toBe(false);

        // Past the 60s HOOK_FALLBACK_SILENCE_MS bound — fires.
        session.tick(start + 1_200 + 60_000);
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

    describe("title_change event coalescing (A1)", () => {
      it("bounds emitted title_change events during a rapid burst while attention/idle-detection still observes EVERY raw title change", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          // Realistic TUI spinner/timer churn: 20 title rewrites, 50ms apart
          // (~1s total), alternating a "working" and an idle title so every
          // odd tick is a genuine #98 working->idle transition -- prior to
          // this fix, EVERY one of these 20 raw changes would also have
          // produced its own persisted+broadcast title_change event.
          for (let i = 0; i < 20; i++) {
            const working = i % 2 === 0;
            const title = working ? "Thinking…" : "Ready";
            fakePtyChildren[0].emitData(`\x1b]2;${title}\x07`);

            // Detection runs off the RAW signal on EVERY tick, uninterrupted
            // by the still-pending debounce asserted below -- lastTitle
            // always reflects the very latest raw title, not the debounced
            // one.
            expect(session.toInfo().lastTitle).toBe(title);
            if (!working) {
              // A working->idle transition is a zero-threshold attention
              // signal (#98) -- confirms immediately, mid-burst, even
              // though not a single title_change EVENT has fired yet (this
              // is exactly the "detection stays live, persistence gets
              // coalesced" split — see scheduleTitleChangeEvent()'s doc
              // comment). If the debounce accidentally gated detection too
              // (the regression this test exists to catch), this would
              // still read false here.
              expect(session.toInfo().attention).toBe(true);
            }

            // The title_change EVENT itself stays coalesced through the
            // whole burst -- still inside the trailing-edge debounce
            // window every tick reset.
            expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(0);

            await vi.advanceTimersByTimeAsync(50);
          }

          // Let TITLE_CHANGE_EVENT_DEBOUNCE_MS elapse from the last raw
          // title change.
          await vi.advanceTimersByTimeAsync(3_000);

          const titleEvents = session.getEvents().filter((e) => e.kind === "title_change");
          // 20 raw title-change signals (each one independently observed by
          // attention/idle-detection above, mid-burst) -> 1 emitted event: a
          // 95% reduction on this burst alone, carrying the LATEST title,
          // not the one that started the window.
          expect(titleEvents).toHaveLength(1);
          expect(titleEvents[0].payload).toEqual({ title: "Ready" });
        } finally {
          vi.useRealTimers();
        }
      });

      it("forces an eventual title_change event at the 15s ceiling under CONTINUOUS 1Hz title churn that never lets the 3s trailing debounce elapse on its own", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          // Simulates production's measured ~1 title_change/sec for an
          // actively-working agent: a title change every 1s, well inside
          // the 3s trailing-edge debounce window, resetting it every time
          // -- the only thing that can force an emission here is the 15s
          // ceiling armed once, on the FIRST pending title (t=0).
          for (let i = 0; i < 14; i++) {
            fakePtyChildren[0].emitData(`\x1b]2;working (${i})\x07`);
            await vi.advanceTimersByTimeAsync(1_000); // t = 1000, 2000, ..., 14000
          }
          // At t=14000 the last emit (i=13) set its own debounce deadline
          // for t=17000 -- well AFTER the ceiling's fixed t=15000 deadline,
          // so whatever fires next can only be the ceiling, not the
          // trailing debounce settling on its own.
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(0);

          await vi.advanceTimersByTimeAsync(1_000); // t = 15000 -- ceiling fires
          const titleEvents = session.getEvents().filter((e) => e.kind === "title_change");
          expect(titleEvents).toHaveLength(1);
          expect(titleEvents[0].payload).toEqual({ title: "working (13)" });

          // Steady state under sustained, unbroken churn: this same cycle
          // repeats every CEILING_MS (15s) instead of every ~1s -- a ~15x
          // (~93%) reduction, closely tracking the audit's own measured
          // 93.6% title_change share of production's session_events table.
          // Mirrors the first cycle's exact shape: the ceiling that just
          // fired at t=15000 re-armed fresh (for t=30000) on the very next
          // pending title, so 14 more 1s-spaced emits land one tick short
          // of that new deadline (t=29000) before a final explicit advance
          // crosses it.
          for (let i = 14; i < 28; i++) {
            fakePtyChildren[0].emitData(`\x1b]2;working (${i})\x07`);
            await vi.advanceTimersByTimeAsync(1_000); // t = 16000, ..., 29000
          }
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(1);
          await vi.advanceTimersByTimeAsync(1_000); // t = 30000 -- ceiling fires again
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it("flushes a still-pending debounced title_change event on kill() rather than dropping it", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          fakePtyChildren[0].emitData("\x1b]2;Ready\x07");
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(0);

          manager.kill("1");

          const titleEvents = session.getEvents().filter((e) => e.kind === "title_change");
          expect(titleEvents).toHaveLength(1);
          expect(titleEvents[0].payload).toEqual({ title: "Ready" });
        } finally {
          vi.useRealTimers();
        }
      });

      it("also flushes a still-pending debounced title_change event when the pty process exits on its own (crash/natural exit, not Session.kill()) — Hermes review, PR #593", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          fakePtyChildren[0].emitData("\x1b]2;Done\x07");
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(0);

          // The pty process dying on its own (a crash, or — very commonly —
          // an agent program exiting cleanly right after a final title
          // rewrite) — NOT session.kill()/manager.kill(). This fires the
          // exit listener spawn() registered via ptyProcess.onExit()
          // directly, the same path a real crash takes, bypassing kill()'s
          // own flushTitleChangeEvent() call entirely.
          fakePtyChildren[0].kill();

          const events = session.getEvents();
          const titleEvents = events.filter((e) => e.kind === "title_change");
          // The pending title_change must still be flushed here -- not
          // silently dropped for another 3-15s (or forever, if this Session
          // instance never spawns again) -- exactly the "session ended with
          // unflushed state" class of bug the state file's own A8 fix
          // already covers, now closed for this debounce too.
          expect(titleEvents).toHaveLength(1);
          expect(titleEvents[0].payload).toEqual({ title: "Done" });

          // Chronological order preserved: the flush happens BEFORE the
          // exit handler's own status_change("exited") emission, matching
          // what actually happened (the title changed, then the process
          // exited) — not after, which would invert it.
          const exitedEvent = events.find(
            (e) => e.kind === "status_change" && e.payload.reason === "exited",
          );
          expect(exitedEvent).toBeDefined();
          expect(titleEvents[0].seq).toBeLessThan(exitedEvent!.seq);
        } finally {
          vi.useRealTimers();
        }
      });
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

    it("injects MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN, MULLION_SOCKET_PATH/MULLION_SESSION_ID, and MULLION_REVIEW_GATE_ENABLED into the master bootstrap env", async () => {
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
            MULLION_SOCKET_PATH: manager.controlSocketPath,
            MULLION_SESSION_ID: "1",
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

  describe("control socket (issue #185)", () => {
    it("derives controlSocketPath under sessionsDir, alongside hookSocketPath", () => {
      expect(manager.controlSocketPath).toBe(path.join(sessionsDir, "mullion.sock"));
      expect(manager.controlSocketPath).not.toBe(manager.hookSocketPath);
    });

    it("resolves an explicit controlSocketPath override (MULLION_SOCKET_PATH)", () => {
      const overridden = new PtyManager({
        sessionsDir,
        controlSocketPath: path.join(sessionsDir, "custom.sock"),
      });
      expect(overridden.controlSocketPath).toBe(path.join(sessionsDir, "custom.sock"));
    });

    it("resolves a relative controlSocketPath override against the process cwd", () => {
      const overridden = new PtyManager({ sessionsDir, controlSocketPath: "relative.sock" });
      expect(overridden.controlSocketPath).toBe(path.resolve("relative.sock"));
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

    it("progress: forwards 'detail' into the status_change payload when present (issue #321)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "generating",
        detail: "retry attempt 2: rate limited",
      });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("status_change");
      expect(event.payload).toEqual({
        phase: "generating",
        detail: "retry attempt 2: rate limited",
      });
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
      // agentIdle now settles for 3s (ATTENTION_SETTLE_MS) before it
      // confirms — advance past that window (see cancelDeferred's own
      // comment for why a plain tick, with no intervening
      // progress:generating, lets it confirm rather than cancel).
      session.tick(Date.now() + 3_000);

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["status_change", "attention"]);
      expect(events[1].payload).toEqual({ attention: true, signal: "agentIdle" });
      expect(session.toInfo().attention).toBe(true);
    });

    // Issue #428 — the core bug: a Stop hook (progress:done) firing while
    // Claude Code reports outstanding backgroundTasks (a background Agent/
    // Task call from the same turn) must NOT fire the premature "your move"
    // agentIdle ping, even though it still latches lastTurnEndedAt.
    it("progress (done) with outstanding backgroundTasks: latches lastTurnEndedAt but gates agentIdle", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["status_change"]);
      expect(session.toInfo().attention).toBe(false);
      expect(session.toInfo().lastTurnEndedAt).not.toBeNull();
      expect(session.toInfo().outstandingBackgroundTasks).toEqual([
        { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
      ]);
    });

    it("a later progress message whose backgroundTasks have all drained fires the deferred agentIdle", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
        ],
      });
      // The drain resolves resolveDeferredTurnEnd()'s guards and SCHEDULES
      // the ping (ATTENTION_SETTLE_MS's 3s agentIdle window) rather than
      // firing it immediately — advance past it.
      session.tick(Date.now() + 3_000);

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual(["status_change", "status_change", "attention"]);
      expect(events[2].payload).toEqual({ attention: true, signal: "agentIdle" });
      expect(session.toInfo().attention).toBe(true);
      expect(session.toInfo().outstandingBackgroundTasks).toEqual([]);
    });

    // Issue #428 — the drain signal in practice: a background subagent's own
    // SubagentStop (not a further "progress" message — the parent's turn has
    // already ended) reports the outstanding list emptied.
    it("SubagentStop carrying a drained backgroundTasks list fires the deferred agentIdle with no intervening progress message", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });
      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      expect(session.toInfo().attention).toBe(false);

      session.emitHookEvent({
        kind: "subagent",
        state: "finished",
        agentType: "Explore",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
        ],
      });
      // Same as the previous test — the drain SCHEDULES the deferred ping;
      // advance past its 3s settle window.
      session.tick(Date.now() + 3_000);

      const events = session.getEvents();
      expect(events.map((e) => e.kind)).toEqual([
        "status_change",
        "status_change",
        "status_change",
        "attention",
      ]);
      expect(events[3].payload).toEqual({ attention: true, signal: "agentIdle" });
      expect(session.toInfo().attention).toBe(true);
      expect(session.toInfo().outstandingBackgroundTasks).toEqual([]);
    });

    // Hermes review, PR #453 — resolveDeferredTurnEnd() must only run for a
    // "subagent" hook message that actually carries backgroundTasks. Calling
    // it unconditionally for every subagent message (including a plain
    // "started"/"finished" with no backgroundTasks field) would re-fire
    // agentIdle for an already-resolved turn end the moment ANY unrelated
    // subagent activity arrives afterward, since lastTurnEndedAt stays
    // latched until the next turn_start/keystroke.
    it("a plain subagent message with no backgroundTasks field does not re-fire agentIdle for an already-resolved turn end", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // An ordinary Stop with no backgroundTasks at all — resolves and
      // schedules the deferred agentIdle ping, same as any plain "done".
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.tick(Date.now() + 3_000); // past ATTENTION_SETTLE_MS.agentIdle
      expect(session.toInfo().attention).toBe(true);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);

      // A later, wholly unrelated subagent event (no backgroundTasks field)
      // arrives before the user has typed anything or a new turn started.
      session.emitHookEvent({ kind: "subagent", state: "started", agentType: "Explore" });

      // Must NOT have fired a second agentIdle.
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);
    });

    // Hermes review, PR #453 — a late/reordered SubagentStop re-reporting
    // the SAME already-drained backgroundTasks state (Claude Code re-sends
    // the full list on every Stop/SubagentStop) must not re-fire agentIdle
    // for a turn end that already got its ping — the one-shot guard
    // (turnEndPingSent) exists specifically for this.
    it("a SubagentStop re-reporting an already-drained backgroundTasks state does not re-fire agentIdle", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      expect(session.toInfo().attention).toBe(false);

      const drainedTasks = [
        { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
      ];
      session.emitHookEvent({
        kind: "subagent",
        state: "finished",
        agentType: "Explore",
        backgroundTasks: drainedTasks,
      });
      // The drain SCHEDULES the deferred ping; confirm it before asserting.
      session.tick(Date.now() + 3_000);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);

      // A late/reordered duplicate SubagentStop reports the same drained
      // state again, before the user has typed anything or a new turn
      // started.
      session.emitHookEvent({
        kind: "subagent",
        state: "finished",
        agentType: "Explore",
        backgroundTasks: drainedTasks,
      });

      // Must still be exactly one agentIdle, not two.
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);
    });

    it("a fresh progress:done latch gets its own ping even if a prior latch's ping already fired and the user hasn't typed since", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // First plain "done" — schedules the deferred ping; confirm it.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.tick(Date.now() + 3_000);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);

      // A second, independent "done" (e.g. a distinct later Stop) — this is
      // a genuinely NEW turn-end occurrence and gets its own single ping
      // (its own fresh settle window), not suppressed by the prior latch's
      // one-shot guard.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.tick(Date.now() + 3_000);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(2);
    });

    it("a progress:done with no backgroundTasks field (e.g. idle_prompt) does not wipe a previously-latched outstanding set", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      // A second "done" with no backgroundTasks field at all (the
      // idle_prompt-mapped notification path never carries one).
      session.emitHookEvent({ kind: "progress", phase: "done" });

      expect(session.toInfo().outstandingBackgroundTasks).toEqual([
        { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
      ]);
      expect(session.toInfo().attention).toBe(false);
    });

    it("turn_start clears a latched outstanding backgroundTasks set", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      expect(session.toInfo().outstandingBackgroundTasks).toHaveLength(1);

      session.emitHookEvent({ kind: "turn_start" });

      expect(session.toInfo().outstandingBackgroundTasks).toEqual([]);
      expect(session.toInfo().lastTurnEndedAt).toBeNull();
    });

    it("fix: sticky needs_input (D4) — progress:done pairs its planState/permissionState/questionState resets with clearIfConfirmedKind, so a confirmed planReady no longer survives its own latch going idle", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "plan_ready", plan: "do the thing" });
      expect(session.toInfo()).toMatchObject({
        attention: true,
        attentionKind: "planReady",
        planState: "pending",
      });

      // progress:done resets planState to idle directly (see hook-handlers.ts's
      // "progress" case), then its own resolveDeferredTurnEnd() unconditionally
      // fires an `agentIdle` signal (nothing outstanding) — a legitimate,
      // separate "the turn just ended" reason for attention to stay true
      // (deriveSessionStatus reads this as `finished`, which outranks
      // `needs_input` anyway). Before this fix, planState's own reset ran
      // WITHOUT calling clearIfConfirmedKind first: the confirmed planReady
      // (output-immune) survived that unrelated agentIdle signal too —
      // moreAuthoritativeKind refuses to let a non-immune incoming kind
      // downgrade an already-confirmed immune one — so confirmedKind stayed
      // "planReady" forever, an orphan the sweep in
      // clearStaleBlockedIfOlderThan can't reach either (it only clears a
      // latch that's still stale-AND-set, and this path nulls it in the same
      // statement). Fixed by pairing each latch reset with its own
      // clearIfConfirmedKind call BEFORE resolveDeferredTurnEnd() runs: the
      // orphaned planReady is cleared first, so agentIdle then confirms
      // fresh as the CURRENT, honest confirmedKind instead — once its own
      // settle window (ATTENTION_SETTLE_MS) elapses; the clearing of
      // planReady itself is still synchronous, only agentIdle's own
      // confirmation is deferred.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      session.tick(Date.now() + 3_000);

      expect(session.toInfo()).toMatchObject({
        planState: "idle",
        attention: true,
        attentionKind: "agentIdle",
      });
    });

    it("fix: sticky needs_input (D4) — turn_start unconditionally clears the attention machine, closing the one orphan class progress:done's own paired clears can't reach: a bare, generic hookNotification with no owning per-state latch to pair a clear against", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // No specific dialog behind this — a plain Notification hook message,
      // exactly the "hookNotification has no owning latch" case the stale
      // sweep also deliberately leaves alone (see that describe block's own
      // negative test).
      session.emitHookEvent({ kind: "notification", title: "heads up", body: "" });
      expect(session.toInfo().attention).toBe(true);

      // progress:done's own resolveDeferredTurnEnd() fires `agentIdle` here,
      // but moreAuthoritativeKind refuses to let that non-immune signal
      // downgrade the already-confirmed immune hookNotification — it
      // survives, same as any other repaint/non-immune signal would.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      expect(session.toInfo().attention).toBe(true);

      session.emitHookEvent({ kind: "turn_start" });

      expect(session.toInfo().attention).toBe(false);
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
      expect(event.payload).toEqual({ path: "src/index.ts", action: "modify", agentId: null });
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

    it("an unrecognized kind is a no-op (extensibility, not a Phase 5 case anymore)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // "fork"/"join" used to be recognized-but-unsurfaced kinds reserved for
      // Phase 5; they were deleted as dead code (no adapter ever emitted
      // them — Claude Code subagents run in-process, no PID). Any kind this
      // file doesn't recognize is still accepted verbatim by the protocol
      // layer and still a no-op here, same as before.
      session.emitHookEvent({ kind: "some_future_kind", value: 1234 } as unknown as HookMessage);

      expect(session.getEvents()).toHaveLength(0);
    });

    it("PR 33a: a kind matching an Object.prototype member name is a no-op, not a crash", async () => {
      // HOOK_HANDLERS (hook-handlers.ts) dispatches via `Map.get`, not a
      // plain object-property lookup, specifically so a `kind` string that
      // happens to collide with an inherited Object.prototype member
      // (`"constructor"`, `"__proto__"`, `"toString"`, ...) can't walk the
      // prototype chain and get invoked as if it were a real handler.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "constructor" } as unknown as HookMessage);
      session.emitHookEvent({ kind: "__proto__" } as unknown as HookMessage);
      session.emitHookEvent({ kind: "toString" } as unknown as HookMessage);

      expect(session.getEvents()).toHaveLength(0);
    });

    it("session_start: a no-op even when it reaches emitHookEvent directly (it normally bypasses it entirely)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "session_start" });

      expect(session.getEvents()).toHaveLength(0);
    });

    it("todo: emits a todo event carrying content/status/priority", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "todo",
        content: "Fix the bug",
        status: "pending",
        priority: "high",
      });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("todo");
      expect(event.payload).toEqual({
        content: "Fix the bug",
        status: "pending",
        priority: "high",
      });
    });

    it("session_diff: emits a session_diff event carrying the file list", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "session_diff",
        files: [{ file: "src/index.ts", additions: 3, deletions: 1 }],
      });

      const events = session.getEvents();
      const event = events[events.length - 1];
      expect(event.kind).toBe("session_diff");
      expect(event.payload).toEqual({
        files: [{ file: "src/index.ts", additions: 3, deletions: 1 }],
      });
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

      // permissionState updates synchronously — session status must stay
      // truthful immediately — but the permission_request/attention EVENT
      // pair is deferred (ATTENTION_SETTLE_MS) until it either confirms or
      // is cancelled by a fast auto-resolution. Advance past the window.
      expect(session.toInfo().permissionState).toBe("pending");
      session.tick(Date.now() + 2_000);
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

      // The stop_failure NotificationEvent itself is immediate; only the
      // trailing `attention` (apiError) ping is deferred — advance past its
      // settle window before checking for it.
      expect(session.toInfo().errorState).toBe("api_error");
      session.tick(Date.now() + 2_000);
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

      // Same shape as stop_failure above — the tool_failure NotificationEvent
      // is immediate, only the trailing `attention` (toolFailure) ping is
      // deferred.
      expect(session.toInfo().errorState).toBe("tool_failure");
      session.tick(Date.now() + 2_000);
      const events = session.getEvents();
      const event = events[events.length - 2];
      expect(event.kind).toBe("tool_failure");
      expect(event.payload).toEqual({
        tool: "Bash",
        error: "Command failed",
        summary: "ls: no such file",
        agentId: null,
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

    describe("ExitPlanMode dedup (Hermes review, PR #675)", () => {
      it("the common-order case: plan_ready arrives first (as it reliably does — PreToolUse before PermissionRequest), so the later permission_request{ExitPlanMode} is a no-op and 'Plan ready' wins", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix bug" });
        expect(session.toInfo()).toMatchObject({
          planState: "pending",
          permissionState: "idle",
          attentionKind: "planReady",
        });
        const eventsBefore = session.getEvents().length;

        session.emitHookEvent({
          kind: "permission_request",
          tool: "ExitPlanMode",
          summary: "ExitPlanMode",
        });

        // A genuine no-op: no new event at all, not even a suppressed one.
        expect(session.getEvents().length).toBe(eventsBefore);
        expect(session.toInfo()).toMatchObject({
          planState: "pending",
          permissionState: "idle",
          attentionKind: "planReady",
        });
      });

      it("the fallback case: plan_ready never arrives at all (PreToolUse hook missing/not registered) — permission_request{ExitPlanMode} still shows SOMETHING rather than nothing", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "permission_request",
          tool: "ExitPlanMode",
          summary: "ExitPlanMode",
        });
        // permissionState updates synchronously; attentionKind only reaches
        // "permissionRequest" once the settle window confirms it.
        session.tick(Date.now() + 2_000);

        expect(session.toInfo()).toMatchObject({
          permissionState: "pending",
          planState: "idle",
          attentionKind: "permissionRequest",
        });
      });

      it("the reordered case: permission_request{ExitPlanMode} arrives BEFORE plan_ready — the fallback permissionState is superseded once the real plan_ready lands, so 'Plan ready' still wins", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "permission_request",
          tool: "ExitPlanMode",
          summary: "ExitPlanMode",
        });
        expect(session.toInfo()).toMatchObject({ permissionState: "pending" });

        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix bug" });

        expect(session.toInfo()).toMatchObject({
          permissionState: "idle",
          planState: "pending",
          attentionKind: "planReady",
        });
      });

      it("permission_request for a DIFFERENT tool while planState is pending is NOT deduped — the dedup is scoped to ExitPlanMode specifically", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix bug" });
        session.emitHookEvent({
          kind: "permission_request",
          tool: "Bash",
          summary: "rm -rf /tmp/x",
        });

        expect(session.toInfo()).toMatchObject({
          planState: "pending",
          permissionState: "pending",
        });
      });
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

    it("fix: AskUserQuestion mislabelled (D3) — tool_done releases a pending questionState only for AskUserQuestion, and clears the attention machine's confirmed 'question' kind with it", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({ kind: "question", state: "started", header: "Approach?" });
      session.emitHookEvent({ kind: "tool_done", tool: "Bash" });
      expect(session.toInfo()).toMatchObject({ questionState: "pending", attention: true });

      session.emitHookEvent({ kind: "tool_done", tool: "AskUserQuestion" });
      expect(session.toInfo()).toMatchObject({
        questionState: "idle",
        questionHeader: null,
        attention: false,
      });
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

    it("fix: status-clearing-semantics — a stale errorState and the finished latch survive a reattach-style repaint and later plain output; only a genuine keystroke (or a resolving hook) clears them now that markViewed() is gone. Fix: sticky needs_input — unlike those two, tool_failure's OWN attention flag is no longer output-immune, so it clears on the very next real output chunk instead of waiting for that keystroke", async () => {
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
        // Both the deferred agentIdle (progress:done) and the deferred
        // toolFailure (tool_failure) ping are still settling — advance past
        // both windows (session.tick() is explicit-clock, unaffected by the
        // faked setTimeout/clearTimeout above). toolFailure drains after
        // agentIdle (insertion order) and neither is immune, so it becomes
        // the final confirmedKind — output-clearable, which is exactly what
        // this test goes on to exercise.
        session.tick(Date.now() + 3_000);
        expect(session.toInfo()).toMatchObject({
          errorState: "tool_failure",
          lastTurnEndedAt: expect.any(Number),
          attention: true,
        });

        // A reattach (opening the workspace tab) forces a repaint — the
        // exact byte pattern markViewed() used to piggyback its "user is
        // looking" clear on. Must no longer clear anything (repaints are
        // suppressed from the attention machine entirely — see
        // redrawNudge.suppressingOutput — regardless of which kind is
        // confirmed).
        session.requestRedraw();
        pty.emitData("repainted frame");
        expect(session.toInfo()).toMatchObject({
          errorState: "tool_failure",
          lastTurnEndedAt: expect.any(Number),
          attention: true,
        });

        // Fix: sticky needs_input (D1) — once the repaint suppression
        // window has fully elapsed, arbitrary later output IS evidence the
        // agent is working again: `toolFailure` is deliberately NOT in
        // OUTPUT_IMMUNE_KINDS (attention-detect.ts), so it clears here —
        // unlike errorState/lastTurnEndedAt, which have no such auto-clear
        // and stay sticky until a keystroke or a resolving hook.
        await vi.advanceTimersByTimeAsync(300 + 400 + 500);
        pty.emitData("just more program output, not a decision");
        expect(session.toInfo()).toMatchObject({
          errorState: "tool_failure",
          lastTurnEndedAt: expect.any(Number),
          attention: false,
        });

        // A genuine keystroke is the replacement unblocking signal for the
        // two latches output alone can't touch.
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

    // Fresh-review finding on PR #453 — this clear path (write()'s
    // genuine-keystroke branch) wasn't exercised by any existing test with
    // backgroundTasks actually set beforehand.
    it("issue #428: a genuine keystroke clears a latched outstanding backgroundTasks set", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      session.emitHookEvent({
        kind: "progress",
        phase: "done",
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      });
      expect(session.toInfo().outstandingBackgroundTasks).toHaveLength(1);

      const eventsBefore = session.getEvents().length;
      session.write("y");

      const info = session.toInfo();
      expect(info.outstandingBackgroundTasks).toEqual([]);
      expect(info.lastTurnEndedAt).toBeNull();
      const newEvents = session.getEvents().slice(eventsBefore);
      expect(newEvents.filter((e) => e.kind === "status_change")).toHaveLength(1);

      // The one-shot guard resets too — a later, unrelated Stop for a NEW
      // turn (no outstanding work) fires its own ping rather than being
      // silently suppressed by stale one-shot state from before the
      // keystroke.
      session.emitHookEvent({ kind: "progress", phase: "done" });
      // This turn-end resolves cleanly (no outstanding work) and SCHEDULES
      // its own fresh deferred agentIdle ping — advance past the window.
      session.tick(Date.now() + 3_000);
      expect(
        session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
      ).toHaveLength(1);
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
      // Confirm both deferred pings (see the repaint test above for why
      // toolFailure ends up the final confirmedKind) before eventsBefore is
      // captured, so the synthetic write below is checked against a
      // steady, already-confirmed state.
      session.tick(Date.now() + 3_000);
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

      it("fix: sticky needs_input (D4) — a stale permissionState sweep also drops the attention machine's permissionRequest-owned flag it confirmed", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        // `now` pinned here (rather than emitHookEvent's own default
        // Date.now()) so the settle window's dueAt and this tick() below
        // race against the identical synthetic clock, not two independent
        // real-time reads a few CI-scheduling milliseconds apart — see
        // emitAttentionSignalDeferred's own doc comment.
        session.emitHookEvent(
          {
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          },
          now,
        );
        // Confirm it (settle window) — the sweep this test exercises only
        // makes sense against an already-CONFIRMED flag, per the test's own
        // name ("...it confirmed").
        session.tick(now + 2_000);
        expect(session.toInfo()).toMatchObject({ permissionState: "pending", attention: true });

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);

        expect(session.toInfo().attention).toBe(false);
      });

      it("fix: sticky needs_input (D4) — the stale sweep does NOT drop a hookNotification-confirmed flag with no dedicated latch behind it (deliberately left to keystroke/notification_resolved only)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
        const now = Date.now();

        // A bare generic notification, nothing else pending — `hookNotification`
        // has no owning per-state latch for this sweep to key its clear off,
        // unlike the six blocked/busy latches above.
        session.emitHookEvent({ kind: "notification", title: "heads up", body: "" });
        expect(session.toInfo().attention).toBe(true);

        // Nothing is stale from this sweep's perspective (every one of the
        // six latches it checks is already idle) — correctly a no-op.
        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(false);

        expect(session.toInfo().attention).toBe(true);
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

        session.emitHookEvent({ kind: "plan_ready", plan: "1. Fix bug" });
        const now = Date.now();
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

        session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
        const now = Date.now();
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

        session.emitHookEvent({ kind: "promote_request", summary: "Refactor widget" });
        const now = Date.now();
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

        session.emitHookEvent({ kind: "elicitation", state: "started", server: "my-mcp" });
        const now = Date.now();
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

      // Hermes review, PR #453 — the sweep deliberately does NOT fire the
      // deferred agentIdle ping: clearing a stale outstanding entry is a
      // "give up tracking it" backstop (isStale's silence test can't tell a
      // stuck report apart from a genuinely-running, PTY-silent background
      // task), not a confirmed drain, so it must not assert "the work is
      // done" via a possibly-false "Finished" notification.
      it("issue #428: resets stale outstanding backgroundTasks past the TTL and emits status_change, without firing a possibly-false agentIdle ping", async () => {
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
          kind: "progress",
          phase: "done",
          backgroundTasks: [
            { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
          ],
        });
        expect(session.toInfo().outstandingBackgroundTasks).toHaveLength(1);
        // The deferred-turn-end gate held: no attention event fired yet.
        expect(session.getEvents().map((e) => e.kind)).not.toContain("attention");

        expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, now + 600_001)).toBe(true);
        expect(session.toInfo().outstandingBackgroundTasks).toHaveLength(0);

        const events = session.getEvents();
        const payload = events.findLast((e) => e.kind === "status_change")?.payload;
        expect(payload).toMatchObject({
          reason: "stale_blocked_cleared",
          state: "backgroundTasks",
        });
        // No attention/agentIdle ping — the sweep isn't a confirmed drain.
        expect(events.map((e) => e.kind)).not.toContain("attention");
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

    describe("subagent registry (Phase 5, Track A)", () => {
      it("with an agentId: creates, then closes, a named entry additive to subagentCount", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "sub-1",
        });
        expect(session.toInfo().subagentCount).toBe(1);
        expect(session.toInfo().subagents).toEqual([
          expect.objectContaining({
            agentId: "sub-1",
            agentType: "Explore",
            endedAt: null,
            summary: null,
            fileChanges: 0,
            toolFailures: 0,
          }),
        ]);

        session.emitHookEvent({
          kind: "subagent",
          state: "finished",
          agentId: "sub-1",
          summary: "Found the config file.",
        });
        expect(session.toInfo().subagentCount).toBe(0);
        const [entry] = session.toInfo().subagents;
        expect(entry.endedAt).not.toBeNull();
        expect(entry.summary).toBe("Found the config file.");
      });

      it("without an agentId: subagentCount still moves, but no entry is created (OpenCode's case)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "opencode",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "subagent", state: "started" });
        expect(session.toInfo().subagentCount).toBe(1);
        expect(session.toInfo().subagents).toEqual([]);
      });

      it("a finish for an agentId never seen (e.g. crossed a restart) is a no-op on the registry", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({ kind: "subagent", state: "finished", agentId: "never-started" });
        expect(session.toInfo().subagents).toEqual([]);
      });

      it("file_change/tool_failure with a matching agentId attribute to that subagent's counters", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "sub-1",
        });
        session.emitHookEvent({
          kind: "file_change",
          path: "src/a.ts",
          action: "modify",
          agentId: "sub-1",
        });
        // The git-ignore check (issue: sidebar worktree display's Part B)
        // is async even for this non-repo cwd's fast path — flush the
        // microtask queue before asserting, same as the plain file_change
        // test above.
        await new Promise((resolve) => setImmediate(resolve));
        session.emitHookEvent({
          kind: "tool_failure",
          tool: "Bash",
          error: "boom",
          agentId: "sub-1",
        });

        const [entry] = session.toInfo().subagents;
        expect(entry.fileChanges).toBe(1);
        expect(entry.toolFailures).toBe(1);
        expect(entry.eventCount).toBe(2);

        // A matching agentId also reaches the event payload, so the
        // timeline can group/filter by subagent.
        const fileChangeEvent = session.getEvents().find((e) => e.kind === "file_change");
        expect(fileChangeEvent?.payload).toMatchObject({ agentId: "sub-1" });
        const toolFailureEvent = session.getEvents().find((e) => e.kind === "tool_failure");
        expect(toolFailureEvent?.payload).toMatchObject({ agentId: "sub-1" });
      });

      it("file_change/tool_failure with an unmatched agentId are a no-op on the registry (no phantom entry)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "file_change",
          path: "src/a.ts",
          action: "modify",
          agentId: "orphan",
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(session.toInfo().subagents).toEqual([]);
      });

      it("stale-clearing subagentCount also marks any still-open registry entries finished, with no summary", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          const now = Date.now();
          session.emitHookEvent({
            kind: "subagent",
            state: "started",
            agentType: "Explore",
            agentId: "sub-1",
          });

          expect(session.clearStaleBlockedIfOlderThan(1000, 1000, now + 5000)).toBe(true);
          const [entry] = session.toInfo().subagents;
          expect(entry.endedAt).toBe(now + 5000);
          expect(entry.summary).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it("evicts exactly the 11 oldest FINISHED entries once the tracked-subagent cap is exceeded, never a still-running one", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        // One still-running entry that must survive the cap.
        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "still-running",
        });

        // Fill past MAX_TRACKED_SUBAGENTS (50) with finished entries. With 1
        // still-running entry already present, the cap (map size >= 50) is
        // first hit inserting finished-49 (1 + 49 already-inserted = 50),
        // evicting finished-0; each subsequent insert (finished-50..59)
        // evicts the next-oldest finished entry in turn — finished-1
        // through finished-10 — for 11 evictions total. Final size:
        // 1 (still-running) + 60 (inserted) - 11 (evicted) = 50.
        for (let i = 0; i < 60; i++) {
          const agentId = `finished-${i}`;
          session.emitHookEvent({ kind: "subagent", state: "started", agentId });
          session.emitHookEvent({ kind: "subagent", state: "finished", agentId });
        }

        const subagents = session.toInfo().subagents;
        expect(subagents.length).toBe(50);
        expect(subagents.some((s) => s.agentId === "still-running")).toBe(true);
        for (let i = 0; i <= 10; i++) {
          expect(subagents.some((s) => s.agentId === `finished-${i}`)).toBe(false);
        }
        for (let i = 11; i <= 59; i++) {
          expect(subagents.some((s) => s.agentId === `finished-${i}`)).toBe(true);
        }
      });

      it("a duplicate/retried start for an already-tracked agentId is a no-op (doesn't reset counters or startedAt)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "sub-1",
        });
        session.emitHookEvent({
          kind: "file_change",
          path: "src/a.ts",
          action: "modify",
          agentId: "sub-1",
        });
        await new Promise((resolve) => setImmediate(resolve));
        const [beforeRedelivery] = session.toInfo().subagents;
        expect(beforeRedelivery.fileChanges).toBe(1);

        // A redelivered/duplicate SubagentStart for the SAME agentId must
        // not reset the accumulated fileChanges or startedAt.
        session.emitHookEvent({
          kind: "subagent",
          state: "started",
          agentType: "Explore",
          agentId: "sub-1",
        });
        const [afterRedelivery] = session.toInfo().subagents;
        expect(afterRedelivery.startedAt).toBe(beforeRedelivery.startedAt);
        expect(afterRedelivery.fileChanges).toBe(1);
        expect(session.toInfo().subagents).toHaveLength(1);
      });

      it("a still-open entry is finalized by its OWN staleness even after an unrelated orphaned/duplicate finish has already clamped subagentCount to 0", async () => {
        // This is the desync case the independent registry sweep exists
        // for: subagentCount and the registry can legitimately disagree,
        // and subagentCount reaching 0 must not be read as "nothing is
        // running" — the registry is the more precise of the two once
        // they disagree.
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          const now = Date.now();
          // A real subagent starts and is genuinely still running.
          session.emitHookEvent({
            kind: "subagent",
            state: "started",
            agentType: "Explore",
            agentId: "sub-1",
          });
          expect(session.toInfo().subagentCount).toBe(1);

          // An orphaned/duplicate "finished" for a DIFFERENT (or already
          // resolved) agentId clamps the aggregate count to 0, even though
          // sub-1 is still genuinely open.
          session.emitHookEvent({ kind: "subagent", state: "finished", agentId: "never-started" });
          expect(session.toInfo().subagentCount).toBe(0);
          expect(session.toInfo().subagentCountAt).toBeNull();
          const [entryBeforeSweep] = session.toInfo().subagents;
          expect(entryBeforeSweep.endedAt).toBeNull();

          // The subagentCount-gated block can no longer fire (count is
          // already 0) — only the independent per-entry sweep can finalize
          // sub-1's still-open entry.
          expect(session.clearStaleBlockedIfOlderThan(1000, 1000, now + 5000)).toBe(true);
          const [entryAfterSweep] = session.toInfo().subagents;
          expect(entryAfterSweep.endedAt).toBe(now + 5000);
          expect(entryAfterSweep.summary).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });
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
      // Confirm it first — this test is specifically about clearing an
      // already-CONFIRMED flag (see the next test for the "still pending,
      // never confirmed at all" case, which is the actual 537-phantom-
      // permission fix).
      session.tick(Date.now() + 2_000);
      expect(session.toInfo()).toMatchObject({ permissionState: "pending", attention: true });

      session.emitHookEvent({ kind: "permission_resolved" });

      expect(session.toInfo()).toMatchObject({ permissionState: "idle", attention: false });
    });

    it("settle-window fix: permission_resolved arriving BEFORE the settle window elapses cancels the still-pending deferred emit with ZERO events — the 537-of-538 auto-approved-opencode-permission case", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const eventsBefore = session.getEvents().length;

      session.emitHookEvent({
        kind: "permission_request",
        tool: "opencode",
        summary: "external_directory /tmp/worktree/*",
      });
      // permissionState is truthful immediately — the sidebar must reflect
      // the agent being genuinely blocked, even though nothing has been
      // reported to the user yet.
      expect(session.toInfo()).toMatchObject({ permissionState: "pending", attention: false });

      // Auto-approved by the agent's own trust config well inside the 2s
      // settle window (measured mean: 26ms) — no session.tick() at all.
      session.emitHookEvent({ kind: "permission_resolved" });

      expect(session.toInfo()).toMatchObject({ permissionState: "idle", attention: false });
      // No permission_request row, no attention event — nothing at all.
      // Advance well past the window too, to prove drainDeferred() has
      // nothing left to flush (the entry was actually removed, not just
      // not-yet-due).
      session.tick(Date.now() + 5_000);
      expect(session.getEvents().slice(eventsBefore)).toEqual([]);
    });

    describe("settle-window cancel on session exit/respawn (issue #720)", () => {
      // Each test arms a deferred attention signal through the REAL hook
      // chain (emitHookEvent), then kills the attach-client before the settle
      // window elapses — exercising pty-manager.ts:2021's onExit
      // clearDeferred() AND, via the forced respawn, pty-manager.ts:1628's
      // spawn()-reset clearDeferred() — then advances the clock well past the
      // original deadline and asserts the deferred emit never fires. This is
      // the "drive it through the real hook chain, not just internal methods"
      // gap the rest of this PR's tests already cover for the
      // resolution-hook cancel path (see the test just above).
      //
      // The clock is anchored with fake `Date` timers (mirroring the sibling
      // settle test at pty-manager.test.ts's markHooksProven test) so the
      // "well past the deadline" advance is explicit and deterministic rather
      // than relying on real wall-clock time between arming and ticking. The
      // kill + respawn run under that fake clock too, but only `Date` is
      // faked (setImmediate/setTimeout stay real), so the respawn's
      // waitForSpawn still resolves.
      async function spawnAndKillMidWindow(session: InstanceType<typeof Session>): Promise<void> {
        // Session dies before the settle window elapses.
        fakePtyChildren[0].kill();
        // Force the respawn so the spawn()-reset clearDeferred path is also
        // exercised (the kill's onExit already ran its own clearDeferred).
        manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);
      }

      it("settle-window cancel on exit/respawn: a pending permissionRequest deferred emit is dropped with ZERO events", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const eventsBefore = session.getEvents().length;
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const start = Date.now();
          vi.setSystemTime(start);

          session.emitHookEvent({
            kind: "permission_request",
            tool: "Bash",
            summary: "rm -rf /tmp/x",
          });
          // permissionState is truthful immediately — the sidebar must reflect
          // the agent being genuinely blocked, even though nothing has been
          // reported to the user yet.
          expect(session.toInfo()).toMatchObject({ permissionState: "pending", attention: false });

          await spawnAndKillMidWindow(session);

          // Advance well past the original 2s deadline.
          vi.setSystemTime(start + 5_000);
          session.tick(Date.now());
        } finally {
          vi.useRealTimers();
        }

        const emitted = session.getEvents().slice(eventsBefore);
        // No permission_request row, no attention ping — nothing at all
        // escaped the settle window for a session that no longer exists.
        expect(emitted.some((e) => e.kind === "attention")).toBe(false);
        expect(emitted.some((e) => e.kind === "permission_request")).toBe(false);
      });

      it("settle-window cancel on exit/respawn: a pending agentIdle deferred emit is dropped with ZERO events", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const eventsBefore = session.getEvents().length;
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const start = Date.now();
          vi.setSystemTime(start);

          // progress:done arms the deferred agentIdle ping (3s window).
          session.emitHookEvent({ kind: "progress", phase: "done" });
          expect(session.toInfo().attention).toBe(false);

          await spawnAndKillMidWindow(session);

          // Advance well past the original 3s deadline.
          vi.setSystemTime(start + 5_000);
          session.tick(Date.now());
        } finally {
          vi.useRealTimers();
        }

        const emitted = session.getEvents().slice(eventsBefore);
        // agentIdle carries no alsoEmit companion, so only the attention ping
        // would have fired — and it must not.
        expect(emitted.some((e) => e.kind === "attention")).toBe(false);
      });

      it("settle-window cancel on exit/respawn: a pending toolFailure deferred ping is dropped (the immediate tool_failure row still fires)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const eventsBefore = session.getEvents().length;
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const start = Date.now();
          vi.setSystemTime(start);

          // Unlike permissionRequest, tool_failure emits its NotificationEvent
          // IMMEDIATELY and only defers the attention ping (D1: the agent's own
          // next output chunk resolves it). So the row is expected; the ping is not.
          session.emitHookEvent({ kind: "tool_failure", tool: "Bash", error: "boom" });
          expect(session.toInfo()).toMatchObject({ errorState: "tool_failure" });

          await spawnAndKillMidWindow(session);

          // Advance well past the original 2s deadline.
          vi.setSystemTime(start + 5_000);
          session.tick(Date.now());
        } finally {
          vi.useRealTimers();
        }

        const emitted = session.getEvents().slice(eventsBefore);
        expect(emitted.some((e) => e.kind === "attention")).toBe(false);
        // The immediate notification event must still be present — only the
        // deferred ping was cancelled.
        expect(emitted.some((e) => e.kind === "tool_failure")).toBe(true);
      });

      it("settle-window cancel on exit/respawn: a pending apiError deferred ping is dropped (the immediate stop_failure row still fires)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const eventsBefore = session.getEvents().length;
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const start = Date.now();
          vi.setSystemTime(start);

          // stop_failure → api_error: NotificationEvent fires immediately, only
          // the attention ping is deferred.
          session.emitHookEvent({ kind: "stop_failure", error: "rate_limit" });
          expect(session.toInfo()).toMatchObject({ errorState: "api_error" });

          await spawnAndKillMidWindow(session);

          // Advance well past the original 2s deadline.
          vi.setSystemTime(start + 5_000);
          session.tick(Date.now());
        } finally {
          vi.useRealTimers();
        }

        const emitted = session.getEvents().slice(eventsBefore);
        expect(emitted.some((e) => e.kind === "attention")).toBe(false);
        expect(emitted.some((e) => e.kind === "stop_failure")).toBe(true);
      });
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
      // agentIdle settles for 3s before it confirms — advance the RIGHT
      // session's clock past that window (proving routing extends to
      // drainDeferred() too: `a` never scheduled anything, so ticking it
      // would be a no-op regardless).
      b.tick(Date.now() + 3_000);

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

      const eventsBefore = session.getEvents().length;
      session.emitHookEvent({ kind: "stop_failure", error: "rate_limit" });
      expect(session.toInfo().errorState).toBe("api_error");

      // Recovery arriving purely over the hook channel (no PTY output bytes
      // in between) must cancel the still-settling deferred apiError ping
      // too, not just clear errorState — otherwise the ping fires 2s later
      // reporting a failure the session has already recovered from.
      session.emitHookEvent({ kind: "progress", phase: "thinking" });
      expect(session.toInfo().errorState).toBe("idle");

      session.tick(Date.now() + 5_000);
      const emitted = session.getEvents().slice(eventsBefore);
      expect(emitted.some((e) => e.kind === "attention")).toBe(false);
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
      // A fresh, unrelated permission request supersedes the reviewGate as
      // the currently-confirmed kind before the gate decision arrives. Uses
      // a second SPECIFIC immune kind, not a generic hookNotification —
      // fix: sticky needs_input (D2) added a guard specifically so a
      // generic hookNotification can no longer steal confirmedKind from an
      // already-confirmed specific kind (see attention-detect.ts's
      // GENERIC_IMMUNE_KINDS), which is the race this test used to rely on
      // to construct "a newer, unrelated confirmed flag" in the first
      // place — two distinct specific kinds still replace each other
      // exactly as before.
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "rm -rf /tmp/x" });
      // permissionRequest settles for 2s before it confirms and actually
      // supersedes reviewGate as confirmedKind — advance past it, or
      // resolveGate("approved") below would still be resolving the
      // CURRENTLY-confirmed reviewGate (not a stale one) and this test
      // would no longer be exercising what its name says.
      session.tick(Date.now() + 2_000);
      expect(session.toInfo().attention).toBe(true);

      session.resolveGate("approved");

      // The stale gate resolution must not clear the newer permission request.
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

    it("injects SSH_AUTH_SOCK from the spawned systemd-run env only when PtyManager is constructed with sshAuthSock set", async () => {
      const bridgedManager = new PtyManager({ sessionsDir, sshAuthSock: "/tmp/ssh-agent.sock" });
      const session = bridgedManager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      expect(call).toBeDefined();
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");

      // Same "this test's own manager, clean up its own timers/sessions"
      // reasoning as the reviewGateEnabled gatedManager test above.
      bridgedManager.killAll();
    });

    it("resolves a relative sshAuthSock against the server's own cwd, not a session's project cwd", async () => {
      // dtach (and every session shell) runs with cwd set to the SESSION's
      // own project directory, not this process's — same reasoning as
      // controlSocketPath's own path.resolve() a few lines above it in
      // PtyManager's constructor. An unresolved relative path here would
      // otherwise resolve differently (or not at all) per session.
      const relativeManager = new PtyManager({
        sessionsDir,
        sshAuthSock: "relative/ssh-agent.sock",
      });
      const session = relativeManager.getOrCreate({
        id: "1",
        cwd: "/tmp/some-other-project",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      expect(call).toBeDefined();
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.SSH_AUTH_SOCK).toBe(path.resolve(process.cwd(), "relative/ssh-agent.sock"));

      relativeManager.killAll();
    });

    it("leaves an inherited SSH_AUTH_SOCK untouched by default (PtyManager constructed with no sshAuthSock override)", async () => {
      // Deliberately NOT asserting absence here: buildSessionEnv() never
      // strips SSH_AUTH_SOCK (see session-env.ts's "Deliberately NOT
      // stripped" comment), so the default-off behavior is pass-through, not
      // removal — matching whatever this test process itself inherited, set
      // explicitly here so the assertion doesn't depend on the host's own
      // ambient environment.
      const original = process.env.SSH_AUTH_SOCK;
      process.env.SSH_AUTH_SOCK = "/run/user/1000/gnupg/S.gpg-agent.ssh";
      try {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        expect(call).toBeDefined();
        const opts = call?.[2] as { env?: Record<string, string> };
        expect(opts.env?.SSH_AUTH_SOCK).toBe("/run/user/1000/gnupg/S.gpg-agent.ssh");
      } finally {
        if (original === undefined) delete process.env.SSH_AUTH_SOCK;
        else process.env.SSH_AUTH_SOCK = original;
      }
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

    // Task Master's initial-prompt fix — a claim/retry/review spawn no
    // longer relies on stashSeed's SessionStart `additionalContext` (which
    // injects context but never submits a turn); it appends the matched
    // hook adapter's initialPromptArgs to the spawned command line instead.
    // Pins the ordering this whole fix depends on (see pty-manager.ts's own
    // doc comment on `initialPromptArgs`'s composition): commandTransform's
    // own flags first, then skipPermissions, then the prompt LAST — so
    // neither the hook-adapter matches() guard nor getSkipPermissionFlag's
    // metacharacter guard ever sees prompt text, and shell metacharacters in
    // the prompt (a real-world issue body routinely has them) can't break
    // either guard or escape the surrounding single quotes.
    //
    // Covers claude and codex through the full spawn path (both write into
    // test-scoped scratch dirs — sessionsDir / $CODEX_HOME). agy's
    // managedInstall() writes into the REAL developer/CI-runner's
    // ~/.gemini/config (no env override exists — see agy.test.ts's own doc
    // comment for why even the adapter-level merge test uses a scratch path
    // via __testing rather than spawning "agy" for real); its
    // initialPromptArgs argv shape (`-i '<prompt>'`) and metacharacter
    // safety are covered instead by
    // hook-adapters/initial-prompt.test.ts's adapter-level tests, which
    // exercise the exact same shellQuote() this integration path calls.
    describe("Task Master initial-prompt argv (claimed task never starting a turn)", () => {
      // ; & | < > are shell-significant outside single quotes; an
      // apostrophe needs its own escape. A real task body routinely
      // contains all of these.
      const dangerousPrompt = "fix the bug; rm -rf / && it's broken | echo <script> > out.txt";
      // Hermes review, PR #538 — claude/codex both prepend `--` so a
      // leading-hyphen prompt isn't parsed as an unrecognized option (see
      // claude-code.ts's own doc comment for the live-verified failure this
      // fixes).
      const quotedDangerousPrompt =
        "-- 'fix the bug; rm -rf / && it'\\''s broken | echo <script> > out.txt'";

      it("appends the shell-quoted prompt after --settings/--mcp-config for claude, with skipPermissions off", async () => {
        const session = manager.getOrCreate({
          id: "10",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
          initialPrompt: dangerousPrompt,
        });
        await waitForSpawn(session);

        const settingsPath = path.join(sessionsDir, "10.hooks.json");
        const mcpConfigPath = path.join(sessionsDir, "10.mcp.json");
        expect(fs.existsSync(settingsPath)).toBe(true);

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        const args = call?.[1] as string[];
        expect(args[args.length - 1]).toBe(
          `claude --settings ${JSON.stringify(settingsPath)} --mcp-config ${JSON.stringify(mcpConfigPath)} ${quotedDangerousPrompt}`,
        );
        // Hooks stayed wired — the exact regression the rejected
        // "append the prompt to `command` before matches()" alternative
        // would have caused (dangerousPrompt's `;`/`&`/`|`/`<`/`>` would
        // have failed SHELL_METACHARACTERS_RE and silently disabled hooks).
        const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        expect(written.hooks.Notification).toBeDefined();
      });

      it("appends the shell-quoted prompt after --settings/--mcp-config AND the skip-permissions flag for claude, with skipPermissions on", async () => {
        const session = manager.getOrCreate({
          id: "11",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
          skipPermissions: true,
          initialPrompt: dangerousPrompt,
        });
        await waitForSpawn(session);

        const settingsPath = path.join(sessionsDir, "11.hooks.json");
        const mcpConfigPath = path.join(sessionsDir, "11.mcp.json");

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        const args = call?.[1] as string[];
        expect(args[args.length - 1]).toBe(
          `claude --settings ${JSON.stringify(settingsPath)} --mcp-config ${JSON.stringify(mcpConfigPath)} --dangerously-skip-permissions ${quotedDangerousPrompt}`,
        );
      });

      it("does not append any prompt argv when initialPrompt is omitted (claude)", async () => {
        const session = manager.getOrCreate({
          id: "12",
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
        expect(args[args.length - 1]).not.toContain(dangerousPrompt);
        expect(args[args.length - 1].endsWith('.mcp.json"')).toBe(true);
      });

      // Hermes review, PR #538 — a task title starting with `-` is a real,
      // reachable prompt (issue titles routinely start with punctuation),
      // and verified live to fail argv parsing without the `--` marker
      // (`claude: error: unknown option '-x hello'`).
      it("prepends `--` so a leading-hyphen prompt reaches claude as a positional, not an option", async () => {
        const session = manager.getOrCreate({
          id: "15",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
          initialPrompt: "- fix the leading-hyphen bug",
        });
        await waitForSpawn(session);

        const settingsPath = path.join(sessionsDir, "15.hooks.json");
        const mcpConfigPath = path.join(sessionsDir, "15.mcp.json");
        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        const args = call?.[1] as string[];
        expect(args[args.length - 1]).toBe(
          `claude --settings ${JSON.stringify(settingsPath)} --mcp-config ${JSON.stringify(mcpConfigPath)} -- '- fix the leading-hyphen bug'`,
        );
      });

      describe("codex", () => {
        let codexHome: string;
        const originalCodexHome = process.env.CODEX_HOME;

        beforeEach(() => {
          // Same scratch-dir redirection as the existing "Codex (issue
          // #252)" describe block above — codex.ts merges into the REAL
          // $CODEX_HOME/hooks.json.
          codexHome = path.join(sessionsDir, "codex-home-scratch-prompt");
          process.env.CODEX_HOME = codexHome;
        });

        afterEach(() => {
          if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
          else process.env.CODEX_HOME = originalCodexHome;
        });

        it("appends the shell-quoted prompt as a trailing positional, with skipPermissions off", async () => {
          const session = manager.getOrCreate({
            id: "13",
            cwd: "/tmp",
            command: "codex",
            cols: 80,
            rows: 24,
            initialPrompt: dangerousPrompt,
          });
          await waitForSpawn(session);

          const call = vi
            .mocked(spawnChildProcess)
            .mock.calls.findLast(([file]) => file === "systemd-run");
          const args = call?.[1] as string[];
          expect(args[args.length - 1]).toBe(`codex ${quotedDangerousPrompt}`);
        });

        it("appends the skip-permissions flag before the shell-quoted prompt, with skipPermissions on", async () => {
          const session = manager.getOrCreate({
            id: "14",
            cwd: "/tmp",
            command: "codex",
            cols: 80,
            rows: 24,
            skipPermissions: true,
            initialPrompt: dangerousPrompt,
          });
          await waitForSpawn(session);

          const call = vi
            .mocked(spawnChildProcess)
            .mock.calls.findLast(([file]) => file === "systemd-run");
          const args = call?.[1] as string[];
          expect(args[args.length - 1]).toBe(
            `codex --dangerously-bypass-approvals-and-sandbox ${quotedDangerousPrompt}`,
          );
        });
      });
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

    it("injects OPENCODE_CONFIG_CONTENT pointing at this session's own agent-guide copy when injectAgentGuide is on (issue #437c, default manager — getInjectAgentGuide defaults to () => true)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.OPENCODE_CONFIG_CONTENT).toBeDefined();
      expect(JSON.parse(opts.env!.OPENCODE_CONFIG_CONTENT)).toEqual({
        instructions: [sessionAgentGuidePath(sessionsDir, "1")],
      });
    });

    it("omits OPENCODE_CONFIG_CONTENT when the manager's getInjectAgentGuide reports the setting off — mirrors hooks.ts gating the pointer, not the on-disk write, for every other agent (issue #437c)", async () => {
      const ungatedManager = new PtyManager({ sessionsDir, getInjectAgentGuide: () => false });
      const session = ungatedManager.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      // The plugin/OPENCODE_CONFIG_DIR mechanism is unaffected by this gate.
      expect(opts.env?.OPENCODE_CONFIG_DIR).toBe(path.join(sessionsDir, "2.opencode-config"));

      // This test's own manager, not the outer `manager` — same cleanup
      // reasoning as the reviewGateEnabled gatedManager test above.
      ungatedManager.killAll();
    });

    // Issue #678 — the end-to-end proof the plumbing actually works: a
    // `seedPrompt` passed into getOrCreate() survives the full six-hop
    // chain (CreateSessionOptions -> Session's own field -> the
    // LaunchPlanSession literal buildLaunchPlan() receives -> ctx ->
    // openCodeAdapter.prepareLaunch()) and reaches the REAL env passed to
    // the spawned systemd-run process, not just a typechecked-but-untested
    // pass-through.
    it("delivers a seedPrompt to opencode's OPENCODE_CONFIG_CONTENT instructions, independently of injectAgentGuide", async () => {
      const ungatedManager = new PtyManager({ sessionsDir, getInjectAgentGuide: () => false });
      const session = ungatedManager.getOrCreate({
        id: "3",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
        seedPrompt: "resume the refactor",
      });
      await waitForSpawn(session);

      const seedPath = path.join(sessionsDir, "3.opencode-seed.md");
      expect(fs.existsSync(seedPath)).toBe(true);
      expect(fs.readFileSync(seedPath, "utf8")).toBe("resume the refactor");

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.OPENCODE_CONFIG_CONTENT).toBeDefined();
      // injectAgentGuide is off on this manager, so only the seed path
      // should be present — proves the gate is independent of that setting.
      expect(JSON.parse(opts.env!.OPENCODE_CONFIG_CONTENT)).toEqual({
        instructions: [seedPath],
      });

      ungatedManager.killAll();
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

// Issue #404 — the plain-session dev-server detection/dedup/accept/dismiss
// logic, unit-tested directly against Session/PtyManager rather than only
// through an integration test (see the issue's own requirement that the
// once-per-(session,port) dedup and dismiss-suppression behavior get real
// coverage, not just "the route returns 200"). The actual throttle (how
// often this gets CALLED at all) is a fixed interval constant in
// src/plugins/pty.ts, outside PtyManager/Session entirely — see that file's
// DEV_SERVER_DETECT_INTERVAL_MS comment for why detection couldn't live in
// Session.tick()'s own 500ms loop (no settings/DB access there).
describe("PtyManager dev-server detection (issue #404)", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    fakePtyChildren.length = 0;
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-manager-devserver-test-"));
    manager = new PtyManager({ sessionsDir });
  });

  afterEach(() => {
    manager.killAll();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  async function waitForSpawn(session: { isAlive: boolean }) {
    for (let i = 0; i < 50; i++) {
      if (session.isAlive) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("session never became alive");
  }

  const VITE_BANNER = "  ➜  Local:   http://localhost:5173/\n";
  const VITE_BANNER_RESTART = "  ➜  Local:   http://localhost:5174/\n";

  describe("Session.detectDevServerPort", () => {
    it("returns null when no banner has appeared yet", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.detectDevServerPort(1)).toBeNull();
    });

    it("returns the port and emits a dev_server_detected event on first detection", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);

      expect(session.detectDevServerPort(7)).toBe("5173");
      expect(session.toInfo().pendingDevServerPort).toBe("5173");

      const events = session.getEvents();
      const detected = events.find((e) => e.kind === "dev_server_detected");
      expect(detected?.payload).toEqual({ port: "5173", projectId: 7 });
    });

    it("does not re-emit for the SAME port on a second call (once per (session, port))", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);

      expect(session.detectDevServerPort(1)).toBe("5173");
      // A re-printed banner for the SAME port (e.g. a restart that happens
      // to land back on the same port) — still must not re-offer.
      fakePtyChildren[0].emitData(VITE_BANNER);
      expect(session.detectDevServerPort(1)).toBeNull();
      expect(session.getEvents().filter((e) => e.kind === "dev_server_detected")).toHaveLength(1);
    });

    it("DOES re-offer a genuinely different port (a restart that lands on a new port)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      expect(session.detectDevServerPort(1)).toBe("5173");

      fakePtyChildren[0].emitData(VITE_BANNER_RESTART);
      expect(session.detectDevServerPort(1)).toBe("5174");
      expect(session.toInfo().pendingDevServerPort).toBe("5174");
    });
  });

  describe("Session.acceptDevServerPort / dismissDevServerPort", () => {
    it("accept returns false when nothing is pending", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(session.acceptDevServerPort("5173")).toBe(false);
    });

    it("accept returns false for a stale/mismatched port", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      session.detectDevServerPort(1);

      expect(session.acceptDevServerPort("9999")).toBe(false);
      // The real pending port is untouched by the failed attempt.
      expect(session.toInfo().pendingDevServerPort).toBe("5173");
    });

    it("accept clears pendingDevServerPort and emits an 'accepted' follow-up event", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        projectId: 1,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      session.detectDevServerPort(1);

      expect(session.acceptDevServerPort("5173")).toBe(true);
      expect(session.toInfo().pendingDevServerPort).toBeNull();

      const events = session.getEvents().filter((e) => e.kind === "dev_server_detected");
      expect(events).toHaveLength(2);
      expect(events[1].payload).toEqual({ port: "5173", projectId: 1, state: "accepted" });
    });

    it("dismiss clears pendingDevServerPort, emits a 'dismissed' event, and suppresses re-offering the SAME port", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        projectId: 1,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      session.detectDevServerPort(1);

      expect(session.dismissDevServerPort("5173")).toBe(true);
      expect(session.toInfo().pendingDevServerPort).toBeNull();

      const events = session.getEvents().filter((e) => e.kind === "dev_server_detected");
      expect(events).toHaveLength(2);
      expect(events[1].payload).toEqual({ port: "5173", projectId: 1, state: "dismissed" });

      // The banner re-prints (e.g. the dev server's own periodic recompile
      // log noise mentions "Local" again) — must NOT re-offer after a
      // dismiss for the same (session, port).
      fakePtyChildren[0].emitData(VITE_BANNER);
      expect(session.detectDevServerPort(1)).toBeNull();
    });

    it("dismiss returns false when the port doesn't match what's pending", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      session.detectDevServerPort(1);

      expect(session.dismissDevServerPort("9999")).toBe(false);
      expect(session.toInfo().pendingDevServerPort).toBe("5173");
    });
  });

  describe("PtyManager.sweepDevServerDetection", () => {
    it("only scans sessions present in the eligible map, skipping unknown ids", async () => {
      const s1 = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      const s2 = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
      await waitForSpawn(s1);
      await waitForSpawn(s2);
      fakePtyChildren[0].emitData(VITE_BANNER);
      fakePtyChildren[1].emitData(VITE_BANNER);

      // "2" is eligible (per the caller's DB-derived map); "1" and "999"
      // (untracked) are not — only "2" should be scanned/detected.
      const detected = manager.sweepDevServerDetection(new Map([["2", 3]]));

      expect(detected).toEqual([{ sessionId: "2", port: "5173" }]);
      expect(s1.toInfo().pendingDevServerPort).toBeNull();
      expect(s2.toInfo().pendingDevServerPort).toBe("5173");
    });

    it("returns an empty array when nothing eligible has a banner yet", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      expect(manager.sweepDevServerDetection(new Map([["1", 1]]))).toEqual([]);
    });
  });

  describe("PtyManager.acceptDevServerPort / dismissDevServerPort", () => {
    it("returns false for an id this process isn't tracking", () => {
      expect(manager.acceptDevServerPort("999", "5173")).toBe(false);
      expect(manager.dismissDevServerPort("999", "5173")).toBe(false);
    });

    it("delegates to the tracked session", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData(VITE_BANNER);
      manager.sweepDevServerDetection(new Map([["1", 1]]));

      expect(manager.acceptDevServerPort("1", "5173")).toBe(true);
      expect(session.toInfo().pendingDevServerPort).toBeNull();
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
      controlSocketPath: path.join(sessionsDir, "mullion.sock"),
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
    // Phase 5 (Track A) — a state file written before the subagent
    // registry existed simply has no `subagents` key at all (an upgrade
    // scenario, not a corrupt one) — subagentCount survives with an empty
    // registry rather than the restore failing or the count being zeroed.
    expect(info.subagents).toEqual([]);
  });

  it("restores a persisted subagent registry from state file, keyed correctly on reconstruction", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
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
        subagentCount: 1,
        subagents: [
          {
            agentId: "sub-1",
            agentType: "Explore",
            startedAt: 1000,
            endedAt: null,
            summary: null,
            fileChanges: 3,
            toolFailures: 0,
            eventCount: 3,
          },
        ],
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();

    expect(info.subagentCount).toBe(1);
    expect(info.subagents).toEqual([
      {
        agentId: "sub-1",
        agentType: "Explore",
        startedAt: 1000,
        endedAt: null,
        summary: null,
        fileChanges: 3,
        toolFailures: 0,
        eventCount: 3,
      },
    ]);
  });

  // Issue #428 — backgroundTasks is part of StoredStateFields (unlike the
  // PERSISTED backgroundTasksAt value, deliberately not saved — see
  // collectState()'s own comment). The restore path still re-stamps
  // backgroundTasksAt to restore-time via setBackgroundTasks() (Hermes
  // review, PR #453) — without this, a restored outstanding set could never
  // be cleared by the staleness sweep at all, since isStale(null, ...) is
  // always false.
  it("restores a latched backgroundTasks list from state file, re-stamping backgroundTasksAt to restore time", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
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
        lastTurnEndedAt: 123,
        lastAssistantMessage: null,
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const before = Date.now();
    const session = makeSession("1");
    const info = session.toInfo();

    expect(info.backgroundTasks).toEqual([
      { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
    ]);
    expect(info.outstandingBackgroundTasks).toEqual([
      { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
    ]);
    expect(info.backgroundTasksAt).not.toBeNull();
    expect(info.backgroundTasksAt as number).toBeGreaterThanOrEqual(before);
  });

  it("restores an all-terminal backgroundTasks list from state file with backgroundTasksAt left null", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
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
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
        ],
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();

    expect(info.outstandingBackgroundTasks).toEqual([]);
    expect(info.backgroundTasksAt).toBeNull();
  });

  // Fresh-review finding on PR #453 — turnEndPingSent isn't itself
  // persisted, but must be DERIVED correctly on restore rather than always
  // defaulting to false, or a restart can produce a duplicate "Finished"
  // ping for a turn the original process already notified about. Asserted
  // behaviorally (turnEndPingSent has no toInfo() field of its own) via
  // whether a later drain-reporting event fires a fresh agentIdle.
  it("restoring an already-latched, already-drained turn does not re-fire agentIdle on a later duplicate drain report", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
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
        lastTurnEndedAt: 123,
        lastAssistantMessage: null,
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
        ],
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    // A late/reordered duplicate SubagentStop re-reports the same
    // already-drained state post-restart.
    session.emitHookEvent({
      kind: "subagent",
      state: "finished",
      agentType: "Explore",
      backgroundTasks: [
        { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
      ],
    });

    expect(
      session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
    ).toHaveLength(0);
  });

  it("restoring an already-latched but still-outstanding turn still fires agentIdle exactly once when it later drains", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
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
        lastTurnEndedAt: 123,
        lastAssistantMessage: null,
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    session.emitHookEvent({
      kind: "subagent",
      state: "finished",
      agentType: "Explore",
      backgroundTasks: [
        { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
      ],
    });
    // The drain SCHEDULES the deferred agentIdle ping; confirm it.
    session.tick(Date.now() + 3_000);

    expect(
      session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
    ).toHaveLength(1);
  });

  it("a state file written before backgroundTasks existed (no key at all) restores with the empty default", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
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
    const info = session.toInfo();

    expect(info.backgroundTasks).toEqual([]);
    expect(info.outstandingBackgroundTasks).toEqual([]);
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
      controlSocketPath: path.join(sessionsDir, "mullion.sock"),
      sessionsDir,
    });
  }

  it("reports hookEmits matching CLAUDE_CODE_EMITS for a claude-matching command", () => {
    const emits = getAdapterEmits("claude");
    expect(emits).toContain("notification");
    expect(emits).toContain("progress");
    expect(emits).toContain("stop_failure");
    expect(emits).toContain("session_end");
    // Also verify through Session constructor -> toInfo() path
    const session = makeSession({ id: "1", command: "claude" });
    const info = session.toInfo();
    expect(info.hookEmits).toContain("notification");
  });

  it("reports hookEmits as [] for a bash (non-matching) command", () => {
    expect(getAdapterEmits("bash")).toEqual([]);
    const session = makeSession({ id: "2", command: "bash" });
    const info = session.toInfo();
    expect(info.hookEmits).toEqual([]);
  });
});
