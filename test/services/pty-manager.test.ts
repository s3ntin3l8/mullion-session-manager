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

    it("sets attention once a bell or OSC 9/777 notification is observed", async () => {
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

      const info = session.toInfo();
      expect(info.attention).toBe(true);
      expect(info.attentionAt).toEqual(expect.any(Number));
    });

    it("clears attention when output continues within the burst window after a bell", async () => {
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
        fakePtyChildren[0].emitData("progress\x07"); // bell mid-work
        expect(session.toInfo().attention).toBe(true);

        // A further chunk arrives shortly after (within the burst window)
        // with no bell of its own — the earlier bell was a work-in-progress
        // ping, not a "waiting for input" signal, so attention clears.
        vi.setSystemTime(start + 500);
        fakePtyChildren[0].emitData("more progress");
        expect(session.toInfo().attention).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps attention set when a bell is followed by silence", async () => {
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
        fakePtyChildren[0].emitData("done\x07");
        expect(session.toInfo().attention).toBe(true);

        // No further output arrives — nothing clears the flag, so it
        // correctly keeps reading as "needs input".
        vi.setSystemTime(start + 5000);
        expect(session.toInfo().attention).toBe(true);
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
});
