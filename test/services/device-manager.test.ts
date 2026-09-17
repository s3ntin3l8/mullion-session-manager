import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Covers DeviceManager.getOrCreate()'s reattach path (issue #1325's own
// task) — a scope that survived a Mullion restart, with no in-memory Device
// left to represent it. A test must never let a real systemd-run fire
// (AGENTS.md) — faked below the same hand-rolled way
// device-process.test.ts fakes `systemctl` (that file's own header explains
// why a custom stdout-bearing fake is needed for `list-units`, which the
// generic mock-spawn.js helper doesn't provide). This file additionally
// fakes @yume-chan/adb's AdbServerClient and @yume-chan/adb-scrcpy's
// AdbScrcpyClient, since Device.attach()/spawn() talk to those directly
// (TCP/stream calls, not child_process) rather than shelling out.

const SESSIONS_DIR = mkdtempSync(path.join(tmpdir(), "device-manager-test-"));
afterAll(() => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
});

let listUnitsReply: string[] = [];
let listUnitsShouldError = false;
const systemdRunCalls: string[][] = [];
const stopCalls: string[][] = [];

type MockChild = EventEmitter & { stdout?: EventEmitter };
function createMockChild(): MockChild {
  return new EventEmitter() as MockChild;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[]) => {
      const ee = createMockChild();
      if (file === "systemctl" && args[1] === "list-units") {
        if (listUnitsShouldError) {
          setImmediate(() => ee.emit("error", new Error("ENOENT")));
          return ee;
        }
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            const lines = listUnitsReply.join("\n");
            ee.stdout?.emit("data", Buffer.from(lines ? `${lines}\n` : ""));
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      if (file === "systemctl" && args[1] === "stop") {
        stopCalls.push(args);
        setImmediate(() => ee.emit("exit", 0));
        return ee;
      }
      if (file === "systemd-run") {
        systemdRunCalls.push(args);
        setImmediate(() => ee.emit("exit", 0));
        return ee;
      }
      // "adb start-server" (DeviceManager's constructor) and anything else —
      // immediate no-op success.
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

// Fakes for the @yume-chan packages Device talks to directly (TCP/stream
// calls — no child_process involved, so mock-spawn.js's helper doesn't
// cover these). Each is the minimal surface device-manager.ts actually
// calls; controlled per-test via the mutable state below.
//
// getDevices() FAILS by default (mirrors the real behavior test/routes/
// devices.test.ts already relies on — no real adb server is listening in
// this test env, so a real AdbServerClient.getDevices() would reject
// quickly, not hang). This matters specifically for
// Device.spawn()'s waitForAdbSerial poll loop: if getDevices() resolved
// successfully-but-empty by default instead, a test that never explicitly
// satisfies the serial would poll every second for up to BOOT_TIMEOUT_MS
// (120s) in the background, well past the test's own completion. Tests
// that need a controlled, successful reattach opt in explicitly.
let mockAdbDevices: Array<{ serial: string }> = [];
let mockGetDevicesShouldFail = true;
let mockCreateAdbShouldFail = false;
const mockGetDevices = vi.fn(async () => {
  if (mockGetDevicesShouldFail) throw new Error("adb server connection refused");
  return mockAdbDevices;
});
const mockCreateAdb = vi.fn(async ({ serial }: { serial: string }) => {
  if (mockCreateAdbShouldFail) throw new Error("createAdb failed");
  return { serial, close: vi.fn(async () => {}) };
});

vi.mock("@yume-chan/adb", () => ({
  AdbServerClient: class {
    getDevices = mockGetDevices;
    createAdb = mockCreateAdb;
  },
}));

vi.mock("@yume-chan/adb-server-node-tcp", () => ({
  AdbServerNodeTcpConnector: class {},
}));

const mockPushServer = vi.fn(async () => {});
const mockStart = vi.fn(async () => ({
  // Never resolves during a test — nothing here should race
  // Device.handleExit() via this promise settling mid-assertion.
  exited: new Promise(() => {}),
  videoStream: Promise.resolve(null),
  controller: {},
  close: vi.fn(async () => {}),
}));

vi.mock("@yume-chan/adb-scrcpy", () => ({
  AdbScrcpyClient: { pushServer: mockPushServer, start: mockStart },
  AdbScrcpyOptionsLatest: class {
    constructor(opts: unknown) {
      Object.assign(this, opts as object);
    }
  },
}));

const { DeviceManager } = await import("../../src/services/device-manager.js");
const { deriveInstanceId, deviceMarkerPath } = await import("../../src/services/device-process.js");

const INSTANCE_ID = deriveInstanceId(SESSIONS_DIR);

function line(unit: string, description: string, state = "active"): string {
  return `${unit} loaded ${state} running ${description}`;
}

function scopeAliveFor(id: string): void {
  const marker = deviceMarkerPath(SESSIONS_DIR, id);
  listUnitsReply = [line(`crs-device-${INSTANCE_ID}-${id}.scope`, `mullion-device -m ${marker}`)];
}

function buildManager(overrides: { onPortAssigned?: ReturnType<typeof vi.fn> } = {}) {
  return new DeviceManager({
    enabled: true,
    adbPath: "/usr/bin/adb",
    adbServerPort: 5037,
    emulatorPath: "/opt/android/emulator/emulator",
    scrcpyServerPath: "/dev/null",
    sessionsDir: SESSIONS_DIR,
    onSpawnError: vi.fn(),
    onPortAssigned: overrides.onPortAssigned,
  });
}

beforeEach(() => {
  listUnitsReply = [];
  listUnitsShouldError = false;
  systemdRunCalls.length = 0;
  stopCalls.length = 0;
  mockAdbDevices = [];
  mockGetDevicesShouldFail = true;
  mockCreateAdbShouldFail = false;
  vi.mocked(spawnChildProcess).mockClear();
  mockGetDevices.mockClear();
  mockCreateAdb.mockClear();
  mockPushServer.mockClear();
  mockStart.mockClear();
});

describe("DeviceManager.getOrCreate() — reattach path", () => {
  it("reattaches to a scope that survived a restart when a persisted port is present and the emulator is still live on adb", async () => {
    scopeAliveFor("7");
    mockGetDevicesShouldFail = false;
    mockAdbDevices = [{ serial: "emulator-5556" }];
    const manager = buildManager();

    const device = await manager.getOrCreate({
      id: "7",
      avdName: "dev35",
      label: null,
      port: 5556,
    });

    // attach() is fire-and-forget (same shape as spawn()) — immediately
    // after getOrCreate() returns, it's still in flight.
    expect(device.toInfo().status).toBe("booting");

    await vi.waitFor(() => expect(device.toInfo().status).toBe("streaming"));
    expect(device.toInfo().serial).toBe("emulator-5556");
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockCreateAdb).toHaveBeenCalledWith({ serial: "emulator-5556" });
    // Never touches systemd-run — the emulator process is already running.
    expect(systemdRunCalls).toHaveLength(0);
  });

  it("rejects getOrCreate() itself, synchronously and without hanging, when the persisted port has no live adb devices entry (the emulator process itself died)", async () => {
    scopeAliveFor("7");
    mockGetDevicesShouldFail = false;
    mockAdbDevices = []; // nothing live on adb — process is gone, not just Mullion
    const manager = buildManager();

    // Awaited/rejected, not polled — this must be a synchronous failure
    // from getOrCreate() itself, the same as the no-persisted-port case:
    // routes/device.ts's attachSocketToDevice only has an error channel
    // back to the WS client for a getOrCreate() REJECTION, not for a
    // fire-and-forget attach() failure it never observes.
    await expect(
      manager.getOrCreate({ id: "7", avdName: "dev35", label: null, port: 5556 }),
    ).rejects.toThrow(/no longer reachable over adb/);
    // Must never have gotten as far as creating an adb connection or
    // starting scrcpy for a serial that was never confirmed live.
    expect(mockCreateAdb).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    // No Device was ever constructed/registered for this attempt.
    expect(manager.get("7")).toBeUndefined();
    // The process is CONFIRMED gone — safe (and necessary, so a future
    // spawn() for this id isn't wedged by the still-occupied unit name) to
    // stop the now-empty scope.
    expect(stopCalls.length).toBeGreaterThan(0);
  });

  it("does NOT stop the scope when the emulator is confirmed live but the reconnect itself fails (transient adb/scrcpy error)", async () => {
    scopeAliveFor("7");
    mockGetDevicesShouldFail = false;
    mockAdbDevices = [{ serial: "emulator-5556" }]; // process is confirmed alive
    mockCreateAdbShouldFail = true; // ...but establishing a NEW connection to it fails
    const manager = buildManager();

    const device = await manager.getOrCreate({
      id: "7",
      avdName: "dev35",
      label: null,
      port: 5556,
    });

    await vi.waitFor(() => expect(device.toInfo().status).toBe("error"));
    expect(device.toInfo().error).toMatch(/createAdb failed/);
    // Must NOT have stopped the scope — the emulator is still alive and
    // running; only this attempt's own (never-established) connection
    // failed. Stopping it here would destroy the exact thing reattach
    // exists to preserve, on a failure unrelated to the emulator's own
    // liveness.
    expect(stopCalls).toEqual([]);

    // A retry sees the scope still alive (never stopped) and the port still
    // persisted — this doesn't collide the way a fresh spawn() would.
    mockCreateAdbShouldFail = false;
    const retried = await manager.getOrCreate({
      id: "7",
      avdName: "dev35",
      label: null,
      port: 5556,
    });
    await vi.waitFor(() => expect(retried.toInfo().status).toBe("streaming"));
  });

  it("rejects getOrCreate() without stopping the scope when getDevices() itself rejects (adb server unreachable — 'unknown', not 'confirmed gone')", async () => {
    scopeAliveFor("7");
    mockGetDevicesShouldFail = true; // rejects, rather than resolving with an empty list
    const manager = buildManager();

    await expect(
      manager.getOrCreate({ id: "7", avdName: "dev35", label: null, port: 5556 }),
    ).rejects.toThrow(/adb server connection refused/);
    expect(stopCalls).toEqual([]);
    expect(manager.get("7")).toBeUndefined();
  });

  it("rejects immediately with the clear manual-stop error when the scope survived but no port was ever persisted", async () => {
    scopeAliveFor("7");
    const manager = buildManager();

    await expect(
      manager.getOrCreate({ id: "7", avdName: "dev35", label: null, port: null }),
    ).rejects.toThrow(/persisted port to reattach with/);
    await expect(
      manager.getOrCreate({ id: "7", avdName: "dev35", label: null, port: null }),
    ).rejects.toThrow(/systemctl --user stop/);

    // No Device was ever created for this id — the reject happens before
    // any construction/registration.
    expect(manager.get("7")).toBeUndefined();
  });

  it("does not call onPortAssigned on the reattach path — the port was already persisted", async () => {
    scopeAliveFor("7");
    mockGetDevicesShouldFail = false;
    mockAdbDevices = [{ serial: "emulator-5556" }];
    const onPortAssigned = vi.fn();
    const manager = buildManager({ onPortAssigned });

    const device = await manager.getOrCreate({
      id: "7",
      avdName: "dev35",
      label: null,
      port: 5556,
    });
    await vi.waitFor(() => expect(device.toInfo().status).toBe("streaming"));

    expect(onPortAssigned).not.toHaveBeenCalled();
  });
});

describe("DeviceManager.getOrCreate() — normal spawn path is unaffected", () => {
  it("still allocates a fresh port and bootstraps via systemd-run when no scope survived", async () => {
    listUnitsReply = []; // no surviving scope for this id
    const onPortAssigned = vi.fn();
    const manager = buildManager({ onPortAssigned });

    const device = await manager.getOrCreate({
      id: "8",
      avdName: "dev35",
      label: null,
      port: null,
    });
    expect(device.toInfo().status).toBe("starting");
    expect(systemdRunCalls).toHaveLength(1);
    expect(onPortAssigned).toHaveBeenCalledWith("8", expect.any(Number));

    // getDevices() fails fast (mocked, no real adb server) — spawn() ends
    // up in "error" quickly rather than polling waitForAdbSerial for up to
    // BOOT_TIMEOUT_MS in the background after this test completes.
    await vi.waitFor(() => expect(device.toInfo().status).toBe("error"));
  });

  it("still allocates a fresh port and bootstraps via systemd-run when the list-units query itself fails — 'unknown' liveness must not collapse to 'alive'", async () => {
    listUnitsShouldError = true; // systemctl itself errors (e.g. ENOENT), not just "no matching scope"
    const onPortAssigned = vi.fn();
    const manager = buildManager({ onPortAssigned });

    const device = await manager.getOrCreate({
      id: "9",
      avdName: "dev35",
      label: null,
      port: null,
    });
    expect(device.toInfo().status).toBe("starting");
    // isScopeAlive() must have treated the failed liveness check as "not
    // alive" (isDeviceAliveStateBatch maps a failed listing to "unknown",
    // and isScopeAlive() only returns true for "alive") rather than
    // throwing one of the reattach-path errors above or hanging — falls
    // through to a normal spawn exactly like the no-surviving-scope case.
    expect(systemdRunCalls).toHaveLength(1);
    expect(onPortAssigned).toHaveBeenCalledWith("9", expect.any(Number));

    await vi.waitFor(() => expect(device.toInfo().status).toBe("error"));
  });
});
