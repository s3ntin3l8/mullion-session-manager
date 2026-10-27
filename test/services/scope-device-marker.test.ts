import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";

// Issue #1854 — the macOS device-scope backend: an emulator as a detached
// process identified by pid + start time in its marker file. Everything the host
// would supply (`ps`, `spawn`, `process.kill`) is faked so the suite runs on any
// platform and never starts a real process.

let psOutput = "";
let psFails = false;
let holdPs = false;
const heldPs: Array<() => void> = [];
let sigkillKills = true;
let spawnPid: number | undefined = 4242;
let spawnError: Error | null = null;
const spawnCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
let lastChild: MockChild | null = null;

interface MockChild extends EventEmitter {
  pid: number | undefined;
  unref: ReturnType<typeof vi.fn>;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        file: string,
        _args: string[],
        options: { env?: Record<string, string> },
        callback: (err: Error | null, stdout: string) => void,
      ) => {
        // The two env vars the lstart comparison depends on must be pinned.
        if (options.env?.TZ !== "UTC" || options.env?.LC_ALL !== "C") {
          callback(new Error("ps ran without TZ=UTC LC_ALL=C"), "");
          return;
        }
        const answer = () => callback(psFails ? new Error("ps: boom") : null, psOutput);
        if (holdPs) heldPs.push(answer);
        else answer();
      },
    ),
    spawn: vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ file, args, options });
      const child = new EventEmitter() as MockChild;
      child.pid = spawnPid;
      child.unref = vi.fn();
      lastChild = child;
      setImmediate(() => {
        if (spawnError) child.emit("error", spawnError);
        else child.emit("spawn");
      });
      return child;
    }),
  };
});

const { MarkerDeviceScopeBackend, DeviceScopeStopError, parseDeviceProcessTable } =
  await import("../../src/services/scope/device-marker.js");
const { deviceMarkerPath } = await import("../../src/services/device-process.js");
const { getDeviceScopeBackend, SystemdDeviceScopeBackend } =
  await import("../../src/services/scope/index.js");

let dir: string;
let killed: Array<{ pid: number; signal: string | number }>;
let aliveAfterSignal: Set<number>;
let killSpy: ReturnType<typeof vi.spyOn>;

const LSTART = "Tue Oct 27 10:29:32 2026";
const EMULATOR =
  "/Users/x/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless";

/** One `ps -o pid=,pgid=,lstart=,comm=` row. */
function row(pid: number, pgid: number, lstart: string, comm: string): string {
  return `${String(pid).padStart(6)} ${String(pgid).padStart(6)} ${lstart}  ${comm}`;
}

function writeRecord(id: string, record: unknown): string {
  const file = deviceMarkerPath(dir, id);
  fs.writeFileSync(file, typeof record === "string" ? record : JSON.stringify(record));
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-devscope-"));
  psOutput = "";
  psFails = false;
  holdPs = false;
  heldPs.length = 0;
  sigkillKills = true;
  spawnPid = 4242;
  spawnError = null;
  spawnCalls.length = 0;
  lastChild = null;
  killed = [];
  aliveAfterSignal = new Set();
  killSpy = vi.spyOn(process, "kill").mockImplementation(((
    pid: number,
    signal: string | number = 0,
  ) => {
    if (signal === 0) {
      // liveness probe: alive only while nothing terminated it
      if (!aliveAfterSignal.has(Math.abs(pid))) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }
    killed.push({ pid, signal });
    if (signal === "SIGKILL" && sigkillKills) aliveAfterSignal.delete(Math.abs(pid));
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  killSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseDeviceProcessTable", () => {
  it("reads pid, pgid, a 5-token lstart (day space-padded) and a comm containing spaces", () => {
    const rows = parseDeviceProcessTable(
      [
        "    1     1 Sat Oct  3 10:58:39 2026  /sbin/launchd",
        row(77, 77, LSTART, "/Applications/Android Studio/emu/qemu-system-aarch64-headless"),
        "garbage line",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { pid: 1, pgid: 1, lstart: "Sat Oct 3 10:58:39 2026", comm: "/sbin/launchd" },
      {
        pid: 77,
        pgid: 77,
        lstart: LSTART,
        comm: "/Applications/Android Studio/emu/qemu-system-aarch64-headless",
      },
    ]);
  });
});

describe("MarkerDeviceScopeBackend.start", () => {
  const spec = (over: Record<string, unknown> = {}) => ({
    id: "7",
    argv: ["/sdk/emulator/emulator", "-avd", "dev35", "-port", "5584"],
    cwd: "/tmp",
    env: { PATH: "/usr/bin" },
    timeoutMs: 1000,
    label: "device bootstrap",
    ...over,
  });

  it("launches detached with no stdio, unrefs, and records pid + lstart in the marker", async () => {
    psOutput = row(4242, 4242, LSTART, EMULATOR);
    fs.writeFileSync(deviceMarkerPath(dir, "7"), ""); // the manager touches it first
    const backend = new MarkerDeviceScopeBackend({ sessionsDir: dir });

    await backend.start(spec());

    expect(spawnCalls[0]).toMatchObject({
      file: "/sdk/emulator/emulator",
      args: ["-avd", "dev35", "-port", "5584"],
      options: { detached: true, stdio: "ignore", cwd: "/tmp" },
    });
    expect(lastChild?.unref).toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(deviceMarkerPath(dir, "7"), "utf8"))).toEqual({
      v: 1,
      pid: 4242,
      lstart: LSTART,
    });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects on a spawn error and leaves the marker alone", async () => {
    spawnError = new Error("spawn /sdk/emulator/emulator ENOENT");
    const backend = new MarkerDeviceScopeBackend({ sessionsDir: dir });
    await expect(backend.start(spec())).rejects.toThrow(/ENOENT/);
    expect(fs.existsSync(deviceMarkerPath(dir, "7"))).toBe(false);
  });

  it("rejects when the process is already gone from the table by the time it is recorded", async () => {
    psOutput = row(1, 1, LSTART, "/sbin/launchd");
    const backend = new MarkerDeviceScopeBackend({ sessionsDir: dir });
    await expect(backend.start(spec())).rejects.toThrow(
      /device bootstrap exited before it could be recorded/,
    );
  });

  it("fails closed when ps stays unreadable: kills the group it just launched and records nothing", async () => {
    psFails = true;
    const backend = new MarkerDeviceScopeBackend({ sessionsDir: dir });
    await expect(backend.start(spec())).rejects.toThrow(/could not read the process table/);
    expect(killed).toEqual([{ pid: -4242, signal: "SIGKILL" }]);
    expect(JSON.stringify(fs.readdirSync(dir))).not.toContain("device");
  });

  it("retries an unreadable ps and records once it answers", async () => {
    let calls = 0;
    const cp = await import("node:child_process");
    vi.mocked(cp.execFile).mockImplementationOnce(((
      _f: string,
      _a: string[],
      _o: unknown,
      cb: (e: Error | null, out: string) => void,
    ) => {
      calls++;
      cb(new Error("transient"), "");
    }) as never);
    psOutput = row(4242, 4242, LSTART, EMULATOR);
    const backend = new MarkerDeviceScopeBackend({ sessionsDir: dir });
    await backend.start(spec());
    expect(calls).toBe(1);
    expect(JSON.parse(fs.readFileSync(deviceMarkerPath(dir, "7"), "utf8")).pid).toBe(4242);
    expect(killed).toEqual([]);
  });

  it("kills the group it launched and rethrows when the marker cannot be written", async () => {
    psOutput = row(4242, 4242, LSTART, EMULATOR);
    // A directory squatting on the temp name makes the exclusive create fail.
    fs.mkdirSync(`${deviceMarkerPath(dir, "7")}.${process.pid}.tmp`);
    const backend = new MarkerDeviceScopeBackend({ sessionsDir: dir });
    await expect(backend.start(spec())).rejects.toThrow();
    expect(killed).toEqual([{ pid: -4242, signal: "SIGKILL" }]);
  });

  it("reports a later exit of the held handle through onExit, with the marker as the scope name", async () => {
    psOutput = row(4242, 4242, LSTART, EMULATOR);
    const onExit = vi.fn();
    const backend = new MarkerDeviceScopeBackend({ sessionsDir: dir });
    await backend.start(spec({ onExit }));
    lastChild?.emit("exit", 1);
    expect(onExit).toHaveBeenCalledWith({ code: 1, scopeName: deviceMarkerPath(dir, "7") });
    lastChild?.emit("error", new Error("late"));
    expect(onExit).toHaveBeenLastCalledWith({
      code: null,
      error: expect.any(Error),
      scopeName: deviceMarkerPath(dir, "7"),
    });
  });

  it("delivers an exit that landed while the launch was being recorded, once, after start() succeeds", async () => {
    psOutput = row(4242, 4242, LSTART, EMULATOR);
    const onExit = vi.fn();
    holdPs = true;
    const backend = new MarkerDeviceScopeBackend({ sessionsDir: dir });
    const started = backend.start(spec({ onExit }));
    await vi.waitFor(() => expect(heldPs.length).toBe(1)); // spawned; ps read still pending
    lastChild?.emit("exit", 9);
    expect(onExit).not.toHaveBeenCalled();
    heldPs[0]();
    await started;
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith({ code: 9, scopeName: deviceMarkerPath(dir, "7") });
  });

  it("does NOT also report onExit when start() itself rejects (the caller would tear down twice)", async () => {
    psOutput = row(1, 1, LSTART, "/sbin/launchd"); // our pid is not in the table
    const onExit = vi.fn();
    holdPs = true;
    const backend = new MarkerDeviceScopeBackend({ sessionsDir: dir });
    const started = backend.start(spec({ onExit }));
    await vi.waitFor(() => expect(heldPs.length).toBe(1));
    lastChild?.emit("exit", 1);
    heldPs[0]();
    await expect(started).rejects.toThrow(/exited before it could be recorded/);
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe("MarkerDeviceScopeBackend.isAliveBatch — the liveness table", () => {
  const backend = () => new MarkerDeviceScopeBackend({ sessionsDir: dir });
  const live = async (id = "7") => (await backend().isAliveBatch([id]))[id];

  it("returns a total map, and an empty one for no ids", async () => {
    expect(await backend().isAliveBatch([])).toEqual({});
    const res = await backend().isAliveBatch(["1", "2"]);
    expect(Object.keys(res).sort()).toEqual(["1", "2"]);
  });

  it("ps cannot be read -> unknown for every id", async () => {
    writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
    psFails = true;
    expect(await live()).toBe("unknown");
  });

  it("marker absent -> dead", async () => {
    psOutput = row(10, 10, LSTART, EMULATOR);
    expect(await live()).toBe("dead");
  });

  it.each([
    ["empty (touched, no launch recorded)", ""],
    ["garbled JSON", "{nope"],
    ["wrong shape", { v: 2, pid: 10 }],
  ])("marker %s -> unknown", async (_name, content) => {
    writeRecord("7", content);
    psOutput = row(10, 10, LSTART, EMULATOR);
    expect(await live()).toBe("unknown");
  });

  it("an empty marker older than the launch window -> dead (no pid was ever recorded)", async () => {
    const file = writeRecord("7", "");
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(file, old, old);
    psOutput = row(10, 10, LSTART, EMULATOR);
    expect(await live()).toBe("dead");
  });

  it("finds a marker in a fallback root the instance owns (#1770), and answers for the current dir otherwise", async () => {
    const old = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-devscope-old-"));
    try {
      fs.writeFileSync(
        deviceMarkerPath(old, "7"),
        JSON.stringify({ v: 1, pid: 10, lstart: LSTART }),
      );
      psOutput = row(10, 10, LSTART, EMULATOR);
      const withOld = new MarkerDeviceScopeBackend({
        sessionsDir: dir,
        ownedDirs: new Set([dir, old]),
      });
      expect((await withOld.isAliveBatch(["7"]))["7"]).toBe("alive");
      // Not owning that dir: the same marker is invisible, so the id reads as absent.
      const without = new MarkerDeviceScopeBackend({ sessionsDir: dir });
      expect((await without.isAliveBatch(["7"]))["7"]).toBe("dead");
      // And stop() acts on the fallback-root marker.
      aliveAfterSignal.add(10);
      killSpy.mockImplementation(((pid: number, signal: string | number = 0) => {
        if (signal === 0) {
          if (!killed.length) return true;
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        killed.push({ pid, signal });
        return true;
      }) as typeof process.kill);
      await withOld.stop("7");
      expect(killed[0]).toEqual({ pid: -10, signal: "SIGTERM" });
    } finally {
      fs.rmSync(old, { recursive: true, force: true });
    }
  });

  it("pid absent from the table -> dead", async () => {
    writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
    psOutput = row(99, 99, LSTART, EMULATOR);
    expect(await live()).toBe("dead");
  });

  it("lstart and an emulator command match -> alive (emulator, qemu-system-*, headless or not)", async () => {
    writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
    for (const comm of [EMULATOR, "/sdk/emulator/emulator", "/q/qemu-system-x86_64"]) {
      psOutput = row(10, 10, LSTART, comm);
      expect(await live()).toBe("alive");
    }
  });

  it("lstart matches but the command is not an emulator -> unknown", async () => {
    writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
    psOutput = row(10, 10, LSTART, "/usr/bin/vim");
    expect(await live()).toBe("unknown");
  });

  it("lstart differs and the command is something else -> dead (genuine pid reuse)", async () => {
    writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
    psOutput = row(10, 10, "Wed Oct 28 01:00:00 2026", "/usr/bin/vim");
    expect(await live()).toBe("dead");
  });

  it("lstart differs but the command IS an emulator -> unknown, never dead", async () => {
    writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
    psOutput = row(10, 10, "Wed Oct 28 01:00:00 2026", EMULATOR);
    expect(await live()).toBe("unknown");
  });
});

describe("MarkerDeviceScopeBackend.stop", () => {
  const backend = () => new MarkerDeviceScopeBackend({ sessionsDir: dir });

  it("signals the process GROUP of a confirmed emulator that leads one, then waits for it to go", async () => {
    writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
    psOutput = row(10, 10, LSTART, EMULATOR);
    aliveAfterSignal.add(10);
    killSpy.mockImplementation(((pid: number, signal: string | number = 0) => {
      if (signal === 0) {
        if (!killed.length) return true;
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      killed.push({ pid, signal });
      return true;
    }) as typeof process.kill);

    await backend().stop("7");

    expect(killed).toEqual([{ pid: -10, signal: "SIGTERM" }]);
  });

  it("signals just the pid when it does not lead its own group", async () => {
    writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
    psOutput = row(10, 3, LSTART, EMULATOR);
    await backend().stop("7");
    expect(killed[0]).toEqual({ pid: 10, signal: "SIGTERM" });
  });

  it("escalates to SIGKILL when the emulator ignores SIGTERM past the grace period", async () => {
    vi.useFakeTimers();
    try {
      writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
      psOutput = row(10, 10, LSTART, EMULATOR);
      aliveAfterSignal.add(10); // never exits
      const done = backend().stop("7");
      await vi.advanceTimersByTimeAsync(10_500);
      await vi.advanceTimersByTimeAsync(2_500);
      await done;
      expect(killed.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["no marker", () => undefined, row(10, 10, LSTART, EMULATOR)],
    [
      "an empty marker (nothing was recorded)",
      () => writeRecord("7", ""),
      row(10, 10, LSTART, EMULATOR),
    ],
    ["a pid that is gone", () => writeRecord("7", { v: 1, pid: 10, lstart: LSTART }), ""],
    [
      "a recycled pid (another program, other start time)",
      () => writeRecord("7", { v: 1, pid: 10, lstart: LSTART }),
      row(10, 10, "Wed Oct 28 01:00:00 2026", "/usr/bin/vim"),
    ],
  ])(
    "resolves WITHOUT signalling when there is nothing of ours to stop: %s",
    async (_n, setup, table) => {
      setup();
      psOutput = table;
      await backend().stop("7");
      expect(killed).toEqual([]);
    },
  );

  it.each([
    ["an unreadable marker", () => writeRecord("7", "{nope"), row(10, 10, LSTART, EMULATOR)],
    [
      "an emulator whose start time does not match",
      () => writeRecord("7", { v: 1, pid: 10, lstart: LSTART }),
      row(10, 10, "Wed Oct 28 01:00:00 2026", EMULATOR),
    ],
    [
      "a marker with no start time (never written by start(), so treated as unreadable)",
      () => writeRecord("7", { v: 1, pid: 10, lstart: null }),
      row(10, 10, LSTART, EMULATOR),
    ],
    [
      "a non-emulator command with a matching start time",
      () => writeRecord("7", { v: 1, pid: 10, lstart: LSTART }),
      row(10, 10, LSTART, "/usr/bin/vim"),
    ],
  ])(
    "THROWS (so the caller keeps the marker and the port) and signals nothing for %s",
    async (_n, setup, table) => {
      setup();
      psOutput = table;
      await expect(backend().stop("7")).rejects.toBeInstanceOf(DeviceScopeStopError);
      expect(killed).toEqual([]);
    },
  );

  it("throws, signalling nothing, when ps cannot be read", async () => {
    writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
    psFails = true;
    await expect(backend().stop("7")).rejects.toBeInstanceOf(DeviceScopeStopError);
    expect(killed).toEqual([]);
  });

  it("throws when the emulator survives SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
      psOutput = row(10, 10, LSTART, EMULATOR);
      aliveAfterSignal.add(10);
      sigkillKills = false;
      const done = backend().stop("7");
      const assertion = expect(done).rejects.toThrow(/survived SIGKILL/);
      await vi.advanceTimersByTimeAsync(13_000);
      await assertion;
      expect(killed.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not SIGKILL when the process is no longer ours after the grace period", async () => {
    vi.useFakeTimers();
    try {
      writeRecord("7", { v: 1, pid: 10, lstart: LSTART });
      const cp = await import("node:child_process");
      psOutput = row(10, 10, LSTART, EMULATOR);
      aliveAfterSignal.add(10);
      const done = backend().stop("7");
      // After SIGTERM the pid is recycled by another program before the re-check.
      await vi.advanceTimersByTimeAsync(9_000);
      psOutput = row(10, 10, "Wed Oct 28 01:00:00 2026", "/usr/bin/vim");
      await vi.advanceTimersByTimeAsync(2_000);
      await done;
      expect(killed.map((k) => k.signal)).toEqual(["SIGTERM"]);
      expect(vi.mocked(cp.execFile)).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists no processes (an empty inventory is a legitimate answer)", async () => {
    expect(await backend().listProcesses()).toEqual([]);
  });
});

describe("getDeviceScopeBackend", () => {
  const withPlatform = (platform: NodeJS.Platform, fn: () => void) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      fn();
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  };

  it("picks the marker backend on darwin, systemd on linux, and refuses anything else", () => {
    withPlatform("darwin", () =>
      expect(getDeviceScopeBackend({ sessionsDir: dir }).kind).toBe("marker-device"),
    );
    withPlatform("linux", () =>
      expect(getDeviceScopeBackend({ sessionsDir: dir })).toBeInstanceOf(SystemdDeviceScopeBackend),
    );
    withPlatform("win32", () =>
      expect(() => getDeviceScopeBackend({ sessionsDir: dir })).toThrow(
        /no device scope backend for platform "win32"/,
      ),
    );
  });
});
