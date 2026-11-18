// PtyManager retire / restore hardening (PR D) — the in-flight bootstrap, the exit attribution log and the throwing-listener guards.
//
// Split out of the former test/services/pty-manager.test.ts (issue #3277) —
// that file sat at the file-size ratchet's ceiling, so a change here could no
// longer land next to the tests it belongs with. The shared mock preamble and
// helpers live in test/helpers/pty-manager-harness.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FakePty,
  bundleSyncMock,
  cgroupInventoryMock,
  childProcessMock,
  fakePtyChildren,
  nodePtyMock,
  ownedLine,
  scopeMocks,
} from "../helpers/pty-manager-harness.js";
import { spawn as spawnChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager } = await import("../../src/services/pty-manager.js");

describe("PtyManager retire / restore hardening (PR D)", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    fakePtyChildren.length = 0;
    for (const key of Object.keys(scopeMocks.showReplies)) delete scopeMocks.showReplies[key];
    scopeMocks.listUnitsReply = [];
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-manager-retire-"));
    manager = new PtyManager({ sessionsDir });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    manager.killAll();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  async function flush(n = 20) {
    for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  // A fake `systemd-run` child that stays pending until the test settles it
  // (never a real systemd-run — issue #1137).
  function hangNextBootstrap() {
    const ee = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      exitCode: number | null;
      signalCode: string | null;
    };
    ee.kill = vi.fn();
    ee.exitCode = null;
    ee.signalCode = null;
    vi.mocked(spawnChildProcess).mockImplementationOnce(
      (() => ee) as unknown as typeof spawnChildProcess,
    );
    return ee;
  }

  const opts = (id = "1") => ({ id, cwd: "/tmp", command: "bash", cols: 80, rows: 24 });

  it("H5: kill() during an in-flight bootstrap prevents the later attach", async () => {
    const bootstrap = hangNextBootstrap();
    const session = manager.getOrCreate(opts());
    await flush();
    manager.kill("1");
    bootstrap.emit("exit", 0);
    await session.spawnOutcome();
    await flush();
    expect(fakePtyChildren).toHaveLength(0);
    expect(session.isAlive).toBe(false);
  });

  it("H5: terminate() waits for the in-flight spawn before stopping the scope, and getOrCreate refuses meanwhile", async () => {
    const bootstrap = hangNextBootstrap();
    manager.getOrCreate(opts());
    await flush();
    scopeMocks.listUnitsReply = [ownedLine("1", sessionsDir)];
    const callsBefore = vi.mocked(spawnChildProcess).mock.calls.length;
    const done = manager.terminate("1");
    await flush();
    const stopCalls = () =>
      vi
        .mocked(spawnChildProcess)
        .mock.calls.slice(callsBefore)
        .filter((c) => c[0] === "systemctl" && (c[1] as string[])[1] === "stop");
    expect(stopCalls()).toHaveLength(0);
    expect(() => manager.getOrCreate(opts())).toThrow(/being terminated/);

    bootstrap.emit("exit", 0);
    await done;
    expect(stopCalls()).toHaveLength(1);
    expect(fakePtyChildren).toHaveLength(0);
    // Refusal is lifted once terminate() completes.
    expect(() => manager.getOrCreate(opts())).not.toThrow();
  });

  it("H6: restored non-idle latches get a timestamp baseline so the stale sweep can clear them", async () => {
    const first = manager.getOrCreate(opts());
    await waitForSpawnAlive(first);
    first.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "x" });
    first.emitHookEvent({ kind: "plan_ready", plan: "p" });
    first.emitHookEvent({ kind: "elicitation", state: "started", server: "s" });
    first.emitHookEvent({ kind: "promote_request", summary: "promo" });
    first.emitHookEvent({ kind: "compact", state: "started" });
    first.emitHookEvent({ kind: "subagent", state: "started", agentId: "a1" });
    manager.kill("1"); // flushes the state file

    const restored = manager.getOrCreate(opts());
    await waitForSpawnAlive(restored);
    const info = restored.toInfo();
    expect(info).toMatchObject({
      permissionState: "pending",
      planState: "pending",
      elicitationState: "pending",
      promoteState: "pending",
      compactState: "compacting",
    });
    expect(restored.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now() + 600_001)).toBe(
      true,
    );
    expect(restored.toInfo()).toMatchObject({
      permissionState: "idle",
      planState: "idle",
      elicitationState: "idle",
      promoteState: "idle",
      compactState: "idle",
      subagentCount: 0,
    });
  });

  async function waitForSpawnAlive(session: { isAlive: boolean }) {
    for (let i = 0; i < 50 && !session.isAlive; i++) await flush(1);
    expect(session.isAlive).toBe(true);
  }

  it("M2: a late exit from a superseded pty does not clobber the live one", async () => {
    const session = manager.getOrCreate(opts());
    await waitForSpawnAlive(session);
    const events: string[] = [];
    session.onEvent((e) => events.push(`${e.kind}:${String(e.payload.reason)}`));
    const exits = vi.fn();
    session.onExit(exits);
    const replacement = new FakePty(80, 24);
    (session as unknown as { ptyProcess: unknown }).ptyProcess = replacement;
    for (const cb of fakePtyChildren[0].exitListeners) cb({ exitCode: 0 });
    expect((session as unknown as { ptyProcess: unknown }).ptyProcess).toBe(replacement);
    expect(exits).not.toHaveBeenCalled();
    expect(events).not.toContain("status_change:exited");
  });

  describe("exit attribution log", () => {
    let log: ReturnType<typeof vi.spyOn>;
    let debug: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      log = vi.spyOn(console, "log").mockImplementation(() => {});
      debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    });
    afterEach(() => {
      log.mockRestore();
      debug.mockRestore();
    });

    it("logs code and retired=false when the attach client dies on its own", async () => {
      const session = manager.getOrCreate(opts());
      await waitForSpawnAlive(session);
      for (const cb of fakePtyChildren[0].exitListeners) cb({ exitCode: 7 });
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/attach client exited \(code=7, signal=none, retired=false\)/),
      );
    });

    it.each([
      [15, "SIGTERM"],
      [6, "SIGABRT"], // not the SIGIOT alias
    ])("names the killing signal %i as %s", async (signal, name) => {
      const session = manager.getOrCreate(opts());
      await waitForSpawnAlive(session);
      for (const cb of fakePtyChildren[0].exitListeners) cb({ exitCode: 0, signal });
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`code=0, signal=${name}, retired=false\\)`)),
      );
    });

    it("logs retired=true when kill() ends the client", async () => {
      const session = manager.getOrCreate(opts());
      await waitForSpawnAlive(session);
      session.kill(); // the fake pty's kill() fires its exit listeners
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/retired=true\)/));
    });

    it("does not log a superseded client's late exit as the current one dying", async () => {
      const session = manager.getOrCreate(opts());
      await waitForSpawnAlive(session);
      (session as unknown as { ptyProcess: unknown }).ptyProcess = new FakePty(80, 24);
      for (const cb of fakePtyChildren[0].exitListeners) cb({ exitCode: 1 });
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/attach client exited/));
      expect(debug).toHaveBeenCalledWith(expect.stringMatching(/superseded attach client exited/));
    });
  });

  it("#1529: a duplicate exit callback from the same pty emits status_change:exited once", async () => {
    const session = manager.getOrCreate(opts());
    await waitForSpawnAlive(session);
    const events: string[] = [];
    session.onEvent((e) => events.push(`${e.kind}:${String(e.payload.reason)}`));
    const exits = vi.fn();
    session.onExit(exits);
    const pty = fakePtyChildren[0];
    for (const cb of pty.exitListeners) cb({ exitCode: 0 });
    for (const cb of pty.exitListeners) cb({ exitCode: 0 });
    expect(events.filter((e) => e === "status_change:exited")).toHaveLength(1);
    expect(exits).toHaveBeenCalledTimes(1);
  });

  it("#1521: a non-numeric id is rejected before any file is written", () => {
    for (const bad of ["../evil", "1e3", " 5", "", "12a"]) {
      expect(() => manager.getOrCreate(opts(bad))).toThrow(/must be numeric/);
    }
    for (const bad of ["1e3", " 5", "12a"]) {
      expect(fs.existsSync(path.join(sessionsDir, `${bad}.token`))).toBe(false);
    }
    expect(fs.existsSync(path.join(sessionsDir, "..", "evil.token"))).toBe(false);
  });

  it("M2: kill() unsubscribes the manager-level event fan-out", async () => {
    const session = manager.getOrCreate(opts());
    await waitForSpawnAlive(session);
    const seen = vi.fn();
    manager.onEvent(seen);
    manager.kill("1");
    seen.mockClear();
    session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
    expect(session.getEvents().some((e) => e.kind === "review_gate")).toBe(true);
    expect(seen).not.toHaveBeenCalled();
  });

  it("M3: a wedged systemd-run bootstrap times out and is killed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const bootstrap = hangNextBootstrap();
    const session = manager.getOrCreate(opts());
    const outcome = session.spawnOutcome();
    const assertion = expect(outcome).rejects.toThrow(/master bootstrap timed out/);
    // Let probeSocket (real fs/net I/O) settle so the bootstrap's timeout is
    // armed under the fake clock before advancing it.
    await flush();
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
    expect(bootstrap.kill).toHaveBeenCalled();
  });

  it("M4: the stale gate sweep also resolves pendingGates as lapsed", async () => {
    const session = manager.getOrCreate(opts());
    await waitForSpawnAlive(session);
    session.registerPendingGate("g1", "Deploy?");
    session.registerPendingGate("g2", "Again?");
    expect(session.pendingGateIds()).toEqual(["g1", "g2"]);
    expect(session.clearStaleBlockedIfOlderThan(600_000, 600_000, Date.now() + 600_001)).toBe(true);
    expect(session.pendingGateIds()).toEqual([]);
    const lapsed = session
      .getEvents()
      .filter((e) => e.kind === "review_gate" && e.payload.state === "lapsed");
    expect(lapsed).toHaveLength(2);
  });

  it("M9: a throwing data/exit/event listener does not starve later listeners", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const session = manager.getOrCreate(opts());
    await waitForSpawnAlive(session);
    const data = vi.fn();
    const exit = vi.fn();
    const ev = vi.fn();
    session.onData(() => {
      throw new Error("bad data listener");
    });
    session.onData(data);
    session.onExit(() => {
      throw new Error("bad exit listener");
    });
    session.onExit(exit);
    session.onEvent(() => {
      throw new Error("bad event listener");
    });
    session.onEvent(ev);
    fakePtyChildren[0].emitData("hello");
    expect(data).toHaveBeenCalledTimes(1);
    session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
    expect(ev).toHaveBeenCalled();
    fakePtyChildren[0].kill();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("M9: a throwing manager-level event subscriber does not starve later subscribers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const session = manager.getOrCreate(opts());
    await waitForSpawnAlive(session);
    const later = vi.fn();
    manager.onEvent(() => {
      throw new Error("bad manager listener");
    });
    manager.onEvent(later);
    session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
    expect(later).toHaveBeenCalled();
  });

  it("M9: a throwing redraw-nudge resize does not abort the attach", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(FakePty.prototype, "resize").mockImplementation(() => {
      throw new Error("EBADF");
    });
    const session = manager.getOrCreate(opts());
    await waitForSpawnAlive(session);
    await expect(session.spawnOutcome()).resolves.toBeUndefined();
  });
});
