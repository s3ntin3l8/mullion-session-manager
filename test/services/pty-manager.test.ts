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

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    // Stands in for `systemd-run --user --scope ... dtach -n ...`: succeeds
    // immediately, matching a real bootstrap against a socket that doesn't
    // exist yet.
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
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
    sessionsDir = path.join(os.tmpdir(), `pty-manager-test-${crypto.randomBytes(4).toString("hex")}`);
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
    const first = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(first);
    const second = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });

    expect(second).toBe(first);
    expect(fakePtyChildren).toHaveLength(1);
  });

  it("respawns a fresh attach-client if the tracked one died", async () => {
    const first = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(first);
    fakePtyChildren[0].kill();

    const session = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(session);

    expect(session.isAlive).toBe(true);
    expect(fakePtyChildren).toHaveLength(2);
  });

  it("forwards data to subscribers and buffers it as scrollback", async () => {
    const session = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(session);

    const received: Buffer[] = [];
    session.onData((chunk) => received.push(chunk));
    fakePtyChildren[0].emitData("hello");

    expect(received).toHaveLength(1);
    expect(received[0].toString()).toBe("hello");
    expect(session.getScrollback().toString()).toBe("hello");
  });

  it("replays scrollback to a late subscriber without needing a new attach", async () => {
    const session = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(session);
    fakePtyChildren[0].emitData("existing output");

    // A second "viewer" joining later (e.g. a reconnecting browser tab)
    // reads getScrollback() directly rather than a fresh dtach attach —
    // this is the no-redraw-needed common case from pty-manager.ts.
    expect(session.getScrollback().toString()).toBe("existing output");
  });

  it("trims scrollback to the configured byte cap", async () => {
    const session = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(session);

    // 256 KiB cap — push comfortably past it in large chunks.
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 8; i++) fakePtyChildren[0].emitData(chunk);

    expect(session.getScrollback().length).toBeLessThanOrEqual(256 * 1024);
  });

  it("writes input to the underlying pty", async () => {
    const session = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(session);

    session.write("echo hi\n");
    expect(fakePtyChildren[0].writeSpy).toHaveBeenCalledWith("echo hi\n");
  });

  it("resize updates the tracked size and calls through to the pty", async () => {
    const session = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(session);

    session.resize(120, 40);
    expect(fakePtyChildren[0].resizeSpy).toHaveBeenCalledWith(120, 40);
  });

  it("kill() only kills our tracked client, not conceptually the whole session", async () => {
    const session = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(session);

    manager.kill("1");
    expect(fakePtyChildren[0].killed).toBe(true);
    expect(session.isAlive).toBe(false);
    expect(manager.get("1")).toBeUndefined();
  });

  it("terminate() stops the session's systemd scope in addition to killing our tracked client", async () => {
    const session = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
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
    const session = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(session);
    session.onData(() => {});

    const [info] = manager.list();
    expect(info).toMatchObject({ id: "1", cwd: "/tmp", command: "bash", alive: true, subscriberCount: 1 });
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
});
