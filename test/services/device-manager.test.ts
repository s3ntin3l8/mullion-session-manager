import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see test/helpers/mock-pty.ts's header
// comment for the empirically confirmed hoisting/ordering failure mode.
// DeviceManager's spawn()/kill() paths shell out to systemd-run/systemctl
// exactly like PtyManager's own bootstrapMaster()/stopScope() — a test must
// never let a real one fire (AGENTS.md, issue #1137's mocking invariant).
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
import { AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import type * as ChildProcess from "node:child_process";

// Hermes review on PR #1324 — device-manager.ts (the feature's other
// "highest-risk" module alongside device-process.ts) shipped with no test
// coverage at all. This file drives Device/DeviceManager through a
// realistic spawn lifecycle with @yume-chan/adb, @yume-chan/adb-server-
// node-tcp, and @yume-chan/adb-scrcpy all mocked at the module level — no
// real network, adb server, or systemd-run involved — covering the parts
// that are this repo's own logic (lifecycle bookkeeping, cleanup-on-
// failure, the config-packet replay, the port allocator) rather than
// re-testing the vetted Tango ADB library's own internals.

let mockDeviceList: Array<{ serial: string }> = [];
let mockCreateAdbShouldFail = false;
const mockAdbClose = vi.fn(async () => {});

// Mirrors @yume-chan/adb's own AdbServerClient.AlreadyConnectedError — the
// production code (Device.connectPhysical()) branches on `err instanceof
// AdbServerClient.AlreadyConnectedError`, a STATIC property on the real
// constructor, not a free-standing export — see this file's own
// `AdbServerClientCtor.AlreadyConnectedError = ...` assignment below for
// why a plain Error class here isn't enough on its own.
class MockAlreadyConnectedError extends Error {}

let mockWirelessConnectAlreadyConnected = false;
let mockWirelessConnectError: Error | null = null;
const mockWirelessPair = vi.fn(async () => {});
const mockWirelessConnect = vi.fn(async (address: string) => {
  if (mockWirelessConnectAlreadyConnected) {
    throw new MockAlreadyConnectedError(`already connected to ${address}`);
  }
  if (mockWirelessConnectError) throw mockWirelessConnectError;
});
const mockWirelessDisconnect = vi.fn(async () => {});

// Test-only injection points for the "scope dies while spawn() is between
// the adb race and `status = 'streaming'`" window (PR #1404 nit): a hook
// fires *inside* the mock, i.e. while spawn() is awaiting that very call, so
// the exit lands mid-await instead of at a point a test can reach directly.
// Reset in beforeEach so a test that bails before its hook ever fires can't
// leak it into the next one.
let mockCreateAdbHook: (() => void) | null = null;
let mockPushServerHook: (() => void) | null = null;

const mockServerClient = {
  getDevices: vi.fn(async () => mockDeviceList),
  createAdb: vi.fn(async () => {
    mockCreateAdbHook?.();
    if (mockCreateAdbShouldFail) throw new Error("createAdb failed");
    return { close: mockAdbClose };
  }),
  wireless: {
    pair: mockWirelessPair,
    connect: mockWirelessConnect,
    disconnect: mockWirelessDisconnect,
  },
};

vi.mock("@yume-chan/adb", () => {
  // A plain function, not an arrow — `new AdbServerClient(...)` (device-
  // manager.ts's constructor) needs `new` support, which an arrow function
  // can never have regardless of vi.fn() wrapping. Returning an explicit
  // object from a `new`-invoked plain function makes `new` yield THAT
  // object instead of `this` (ordinary JS constructor semantics) — exactly
  // what's needed here, since every test wants the same shared
  // `mockServerClient` instance back.
  const AdbServerClientCtor = vi.fn(function AdbServerClient() {
    return mockServerClient;
  }) as unknown as { new (): typeof mockServerClient } & {
    AlreadyConnectedError: typeof MockAlreadyConnectedError;
  };
  AdbServerClientCtor.AlreadyConnectedError = MockAlreadyConnectedError;
  return { AdbServerClient: AdbServerClientCtor };
});

vi.mock("@yume-chan/adb-server-node-tcp", () => ({
  AdbServerNodeTcpConnector: vi.fn(),
}));

let mockPushServerShouldFail = false;
let mockStartShouldFail = false;
const mockScrcpyClose = vi.fn(async () => {});
const mockController = {
  injectText: vi.fn(async () => {}),
  resetVideo: vi.fn(async () => {}),
};
// `exited` deliberately never resolves by default — a test that wants to
// exercise handleExit() replaces this before calling spawn().
let mockExited: Promise<void> = new Promise(() => {});
// A real ReadableStream (not a fake), so Device.pumpVideo's own
// `videoStream.stream.getReader()` + read-loop runs for real — this is
// what actually exercises the lastConfigPacket cache-and-replay logic
// (a private field pumpVideo alone writes to), not just a stub that skips
// straight past it. Each test that cares assigns a fresh queue before
// calling getOrCreate(); defaults to a single "configuration" packet then
// closes.
let mockVideoPackets: Array<{ type: "configuration" | "data"; data: Uint8Array }> = [
  { type: "configuration", data: new Uint8Array([1, 2, 3]) },
];
function makeMockVideoStream() {
  let i = 0;
  return {
    stream: new ReadableStream({
      pull(controller) {
        if (i < mockVideoPackets.length) {
          controller.enqueue(mockVideoPackets[i]);
          i++;
        } else {
          controller.close();
        }
      },
    }),
  };
}
const mockScrcpyClient = {
  get controller() {
    return mockController;
  },
  get videoStream() {
    return Promise.resolve(makeMockVideoStream());
  },
  get exited() {
    return mockExited;
  },
  close: mockScrcpyClose,
};

vi.mock("@yume-chan/adb-scrcpy", () => ({
  AdbScrcpyClient: {
    pushServer: vi.fn(async () => {
      mockPushServerHook?.();
      if (mockPushServerShouldFail) throw new Error("pushServer failed");
    }),
    start: vi.fn(async () => {
      if (mockStartShouldFail) throw new Error("scrcpy start failed");
      return mockScrcpyClient;
    }),
  },
  AdbScrcpyOptionsLatest: vi.fn(),
}));

type MockChild = EventEmitter & {
  stdout?: EventEmitter;
  kill: (signal?: string) => boolean;
  exitCode: number | null;
  signalCode: string | null;
};
function createMockChild(): MockChild {
  const ee = new EventEmitter() as MockChild;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = vi.fn(() => true);
  return ee;
}

let systemdRunShouldFail = false;
let listUnitsReply: string[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { fake: ["systemd-run", "systemctl"] });
});

// The generic mockChildProcessSpawn fake above (an immediate blanket
// success) is replaced per-command right after import, below, the same
// "start from the generic fake, override specific commands" shape
// device-process.test.ts uses — systemd-run needs to be able to FAIL on
// demand (spawn() failure tests) and systemctl list-units needs to return
// controllable content (the isScopeAlive()/getOrCreate() collision-guard
// tests), neither of which the blanket fake supports.
vi.mocked(spawnChildProcess).mockImplementation(((file: string, args: readonly string[]) => {
  const ee = createMockChild();
  if (file === "systemd-run") {
    setImmediate(() => {
      if (systemdRunShouldFail) {
        ee.exitCode = 1;
        ee.emit("exit", 1);
      } else {
        // Simulate the scope actually becoming visible to a later
        // `systemctl list-units` call — buildDeviceLaunchPlan's own argv
        // shape (device-process.ts) is fixed: [...,"-u",unitName,
        // "--description",description,"--",...], so index 4/6 are always
        // the unit name / full Description string. Without this, a test
        // exercising teardown-after-spawn-failure would find NOTHING
        // owning the id it just "created" and stopDeviceScope would
        // (correctly, per its own ownership-only contract) skip the stop.
        listUnitsReply.push(`${args[4]}.scope loaded active running ${args[6]}`);
        ee.exitCode = 0;
        ee.emit("exit", 0);
      }
    });
    return ee as unknown as ChildProcess.ChildProcess;
  }
  if (file === "systemctl" && args[1] === "list-units") {
    ee.stdout = new EventEmitter();
    setImmediate(() => {
      ee.exitCode = 0;
      ee.emit("exit", 0);
      setImmediate(() => {
        const lines = listUnitsReply.join("\n");
        ee.stdout?.emit("data", Buffer.from(lines ? `${lines}\n` : ""));
        ee.emit("close", 0);
      });
    });
    return ee as unknown as ChildProcess.ChildProcess;
  }
  if (file === "systemctl" && args[1] === "stop") {
    // Mirrors real systemd: a stopped scope no longer appears in a later
    // list-units call. `args[2]` is "<unit>.scope".
    const unit = (args[2] as string)?.replace(/\.scope$/, "");
    listUnitsReply = listUnitsReply.filter((line) => !line.startsWith(`${unit}.scope `));
    setImmediate(() => {
      ee.exitCode = 0;
      ee.emit("exit", 0);
    });
    return ee as unknown as ChildProcess.ChildProcess;
  }
  // Anything else — immediate success, mirroring the generic fake.
  setImmediate(() => {
    ee.exitCode = 0;
    ee.emit("exit", 0);
  });
  return ee as unknown as ChildProcess.ChildProcess;
}) as typeof spawnChildProcess);

const { DeviceManager } = await import("../../src/services/device-manager.js");
const { deviceScopeUnitName, deriveInstanceId, deviceMarkerPath } =
  await import("../../src/services/device-process.js");
const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

// A random, per-run directory rather than a hardcoded "/tmp/..." literal —
// besides avoiding a collision between parallel test runs/shards sharing a
// fixed path, a literal "/tmp/..." string is exactly what CodeQL's
// js/insecure-temporary-file query treats as an insecure-temp-file taint
// SOURCE; it then flags touchDeviceMarker()'s own openSync() call (a real,
// already-hardened production sink — see that function's own comment) as
// reachable from it, purely because this test happens to pass such a path
// in. mkdtempSync(path.join(os.tmpdir(), ...)) is the query's own
// documented-safe pattern (a fresh, unpredictable directory name), which is
// why the sibling device-manager-reattach.test.ts's identical idiom doesn't
// trigger it.
const SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "device-manager-test-"));
afterAll(() => {
  fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
});
// AdbScrcpyClient.pushServer is mocked and never actually reads this file's
// contents, but `createReadStream` (device-manager.ts) still tries to OPEN
// it eagerly — a nonexistent path throws an unhandled 'error' event since
// nothing consumes the stream in this mock. A real, empty fixture file
// sidesteps that without needing to mock node:fs itself.
const SCRCPY_SERVER_FIXTURE = path.join(SESSIONS_DIR, "fixture-scrcpy-server");

/** Appends a `systemctl --user list-units`-shaped line to `listUnitsReply`
 * claiming device `id`'s scope is alive — the mock harness's own
 * `systemctl list-units` handler returns whatever's in that array
 * verbatim, and stopDeviceScope()/isDeviceAliveState() (device-process.ts)
 * only ever act on an id they can confirm OWNERSHIP of via this listing,
 * never on the mere fact that `systemd-run` itself "succeeded" — see
 * listOwnedDeviceScopes' own doc comment. Tests that need `stopDeviceScope`
 * to actually reach a `systemctl stop` call must populate this first. */
function registerLiveScope(id: string): void {
  const instanceId = deriveInstanceId(SESSIONS_DIR);
  const marker = deviceMarkerPath(SESSIONS_DIR, id);
  listUnitsReply.push(
    `${deviceScopeUnitName(instanceId, id)}.scope loaded active running mullion-device -m ${marker}`,
  );
}

function baseOpts(overrides: Partial<ConstructorParameters<typeof DeviceManager>[0]> = {}) {
  return {
    enabled: true,
    adbPath: "/usr/bin/adb",
    adbServerPort: 5037,
    emulatorPath: "/opt/android/emulator/emulator",
    scrcpyServerPath: SCRCPY_SERVER_FIXTURE,
    sessionsDir: SESSIONS_DIR,
    ...overrides,
  };
}

beforeEach(() => {
  mockDeviceList = [];
  mockCreateAdbShouldFail = false;
  mockCreateAdbHook = null;
  mockPushServerShouldFail = false;
  mockPushServerHook = null;
  mockStartShouldFail = false;
  mockExited = new Promise(() => {});
  mockVideoPackets = [{ type: "configuration", data: new Uint8Array([1, 2, 3]) }];
  systemdRunShouldFail = false;
  listUnitsReply = [];
  mockAdbClose.mockClear();
  mockScrcpyClose.mockClear();
  mockController.injectText.mockClear();
  mockController.resetVideo.mockClear();
  mockWirelessConnectAlreadyConnected = false;
  mockWirelessConnectError = null;
  mockWirelessPair.mockClear();
  mockWirelessConnect.mockClear();
  mockWirelessDisconnect.mockClear();
  vi.mocked(spawnChildProcess).mockClear();
  vi.mocked(AdbScrcpyOptionsLatest).mockClear();
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(SCRCPY_SERVER_FIXTURE, "");
});

async function waitForStatus(
  manager: InstanceType<typeof DeviceManager>,
  id: string,
  status: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = manager.get(id)?.toInfo();
    if (info?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for device ${id} to reach status "${status}" (last: ${info?.status})`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** spawn()'s own catch block flips `status` to "error" BEFORE awaiting
 * teardownProcess() (see that method's own comment) — so a test that has
 * only awaited waitForStatus(..., "error") has no guarantee teardown
 * (marker removal, the stopDeviceScope() call) has actually finished yet.
 * Usually fast enough not to matter, but under heavy parallel-suite load
 * the gap is observable — poll rather than assert once. */
async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${description}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("DeviceManager", () => {
  it("throws on getOrCreate when disabled, per its own assertEnabled() posture (matches BrowserManager)", async () => {
    const manager = new DeviceManager(baseOpts({ enabled: false }));
    await expect(
      manager.getOrCreate({
        id: "1",
        kind: "emulator" as const,
        avdName: "dev35",
        serial: null,
        label: null,
        port: null,
      }),
    ).rejects.toThrow(/disabled/);
  });

  it("getOrCreate spawns a device end to end and reaches status streaming", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(baseOpts());
    const device = await manager.getOrCreate({
      id: "1",
      kind: "emulator",
      avdName: "dev35",
      serial: null,
      label: "My Device",
      port: null,
    });
    expect(device.id).toBe("1");
    expect(device.avdName).toBe("dev35");
    await waitForStatus(manager, "1", "streaming");
    expect(manager.get("1")).toBe(device);
    expect(manager.list().map((d) => d.id)).toEqual(["1"]);
  });

  it("passes the stream-tuning options to scrcpy and the -gpu mode to the emulator", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(
      baseOpts({
        videoMaxSize: 720,
        videoMaxFps: 30,
        videoBitRate: 2_000_000,
        emulatorGpu: "host",
      }),
    );
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");

    expect(vi.mocked(AdbScrcpyOptionsLatest)).toHaveBeenCalledWith(
      expect.objectContaining({ maxSize: 720, maxFps: 30, videoBitRate: 2_000_000 }),
    );
    const systemdRun = vi.mocked(spawnChildProcess).mock.calls.find((c) => c[0] === "systemd-run");
    const argv = systemdRun?.[1] as string[];
    expect(argv[argv.indexOf("-gpu") + 1]).toBe("host");
  });

  it("falls back to a 1280px / 60fps / 8Mbps stream and swiftshader_indirect when unconfigured", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");

    expect(vi.mocked(AdbScrcpyOptionsLatest)).toHaveBeenCalledWith(
      expect.objectContaining({ maxSize: 1280, maxFps: 60, videoBitRate: 8_000_000 }),
    );
    const systemdRun = vi.mocked(spawnChildProcess).mock.calls.find((c) => c[0] === "systemd-run");
    const argv = systemdRun?.[1] as string[];
    expect(argv[argv.indexOf("-gpu") + 1]).toBe("swiftshader_indirect");
  });

  it("getOrCreate is idempotent — a second call for the same alive id returns the SAME Device, no second spawn", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(baseOpts());
    const first = await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");
    const systemdRunCallsBefore = vi
      .mocked(spawnChildProcess)
      .mock.calls.filter((c) => c[0] === "systemd-run").length;
    const second = await manager.getOrCreate({
      id: "1",
      kind: "emulator",
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    expect(second).toBe(first);
    const systemdRunCallsAfter = vi
      .mocked(spawnChildProcess)
      .mock.calls.filter((c) => c[0] === "systemd-run").length;
    expect(systemdRunCallsAfter).toBe(systemdRunCallsBefore);
  });

  it("allocatePort() skips a port reserved via initialPorts at construction — a restart-surviving, not-yet-reattached device's port isn't handed to a fresh spawn()", async () => {
    // The port a fresh spawn() should now be forced onto (5556, the next
    // even port after EMULATOR_PORT_BASE) has to already be the one
    // waitForAdbSerial() sees on adb, or spawn() would poll forever waiting
    // for a serial (emulator-5556) that never appears.
    mockDeviceList = [{ serial: "emulator-5556" }];
    // Simulates devicePlugin's own construction-time read of every
    // `status: "active"` row's persisted port (issue #1328) — this device
    // (say, id "7") hasn't had getOrCreate() called for it yet since boot,
    // so nothing has reservePort()'d 5554 the "normal" way; initialPorts is
    // the only thing standing between it and a collision.
    const onPortAssigned = vi.fn();
    const manager = new DeviceManager(baseOpts({ initialPorts: [5554], onPortAssigned }));

    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");

    // EMULATOR_PORT_BASE (5554) was pre-reserved, so the round-robin scan
    // must have skipped straight to the next even port instead.
    expect(onPortAssigned).toHaveBeenCalledWith("1", 5556);
  });

  it("getOrCreate rejects with a clear, actionable error when a scope survived with no in-memory Device (the restart-collision guard)", async () => {
    const manager = new DeviceManager(baseOpts());
    const instanceId = deriveInstanceId(SESSIONS_DIR);
    const marker = deviceMarkerPath(SESSIONS_DIR, "7");
    listUnitsReply = [
      `${deviceScopeUnitName(instanceId, "7")}.scope loaded active running mullion-device -m ${marker}`,
    ];
    await expect(
      manager.getOrCreate({
        id: "7",
        kind: "emulator" as const,
        avdName: "dev35",
        serial: null,
        label: null,
        port: null,
      }),
    ).rejects.toThrow(/systemctl --user stop/);
    // Never actually attempted to spawn a colliding scope.
    expect(vi.mocked(spawnChildProcess).mock.calls.some((c) => c[0] === "systemd-run")).toBe(false);
  });

  it("spawn() failure after the adb serial appears (createAdb rejects) tears down the scope/marker/port rather than leaking them", async () => {
    // waitForAdbSerial's own timeout path (the serial never appearing at
    // all) exercises the identical catch/teardown branch but takes
    // BOOT_TIMEOUT_MS to fail — too slow for a unit test. Failing one step
    // later instead (serial present, createAdb() itself rejects) reaches
    // the same code path this test actually cares about.
    mockDeviceList = [{ serial: "emulator-5554" }];
    mockCreateAdbShouldFail = true;
    // No manual registerLiveScope() needed here — the systemd-run mock
    // handler itself records the scope as "now visible to a listing" the
    // moment it reports success (see its own comment), the same causality
    // a real systemctl list-units would have. teardownProcess()'s own
    // stopDeviceScope() call, once createAdb fails below, finds it there.
    const manager = new DeviceManager(baseOpts());
    await expect(
      manager.getOrCreate({
        id: "1",
        kind: "emulator" as const,
        avdName: "dev35",
        serial: null,
        label: null,
        port: null,
      }),
    ).resolves.toBeDefined(); // getOrCreate itself doesn't await spawn() — see its own doc comment
    await waitForStatus(manager, "1", "error");
    expect(manager.get("1")?.toInfo().error).toMatch(/createAdb failed/);

    // Marker file removed, not left behind — polled (see waitForCondition's
    // own comment): status flips to "error" before teardownProcess() is
    // awaited, so it isn't guaranteed to have finished the instant
    // waitForStatus above resolves.
    await waitForCondition(
      () => !fs.existsSync(deviceMarkerPath(SESSIONS_DIR, "1")),
      "device 1's marker file to be removed",
    );
    // stopDeviceScope's own "systemctl stop <unit>" was issued.
    await waitForCondition(
      () =>
        vi
          .mocked(spawnChildProcess)
          .mock.calls.some((c) => c[0] === "systemctl" && (c[1] as string[])[1] === "stop"),
      "a systemctl stop call for device 1",
    );

    // The port is releasable again — a second attempt with the same id
    // doesn't run out of ports (a real regression this fix prevents: an
    // un-released port would eventually exhaust the fixed allocation range
    // across enough failed attempts).
    mockCreateAdbShouldFail = false;
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");
  });

  it("spawn() failure when systemd-run itself exits non-zero tears down cleanly (CodeQL: exercises systemdRunShouldFail)", async () => {
    systemdRunShouldFail = true;
    const createAdbCallsBefore = mockServerClient.createAdb.mock.calls.length;
    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "error");
    expect(manager.get("1")?.toInfo().error).toMatch(/device bootstrap exited with code 1/);
    await waitForCondition(
      () => !fs.existsSync(deviceMarkerPath(SESSIONS_DIR, "1")),
      "device 1's marker file to be removed",
    );
    // Never got far enough to even attempt an adb connection.
    expect(mockServerClient.createAdb.mock.calls.length).toBe(createAdbCallsBefore);

    // Port is releasable again — a second attempt doesn't collide.
    systemdRunShouldFail = false;
    mockDeviceList = [{ serial: "emulator-5554" }];
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");
  });

  it("spawn() failure when the scope exits during boot (post-settle, pre-streaming) surfaces the specific error immediately rather than falling through to the 2-minute adb timeout", async () => {
    // Simulates a real production failure mode: systemd-run starts and
    // returns control (setImmediate resolves the bootstrap promise), but the
    // scope exits non-zero a few macrotasks later — D-Bus errors, a unit
    // name that became occupied between the TOCTOU check and the actual run,
    // or an immediate emulator crash before it even writes to adb.
    // Without the bootstrapFailed race, spawn() would stay in
    // waitForAdbSerial for the full BOOT_TIMEOUT_MS (120 s) and then report
    // only the generic "did not appear on adb within 120000ms" — losing the
    // exit code and unit name that would have identified the real cause.
    let spawnedChild: ReturnType<typeof createMockChild> | undefined;
    const baseImpl = vi.mocked(spawnChildProcess).getMockImplementation()!;
    vi.mocked(spawnChildProcess).mockImplementation(((
      file: string,
      args: readonly string[],
      ...rest: unknown[]
    ) => {
      if (file === "systemd-run" && spawnedChild === undefined) {
        const ee = createMockChild();
        spawnedChild = ee;
        listUnitsReply.push(`${args[4]}.scope loaded active running ${args[6]}`);
        // Do NOT emit exit in this tick — the setImmediate below fires first,
        // settling the bootstrap promise. The exit (simulating a D-Bus error)
        // arrives afterwards, in the boot window.
        return ee as unknown as ChildProcess.ChildProcess;
      }
      return baseImpl(file, args, ...(rest as []));
    }) as typeof spawnChildProcess);

    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });

    // Device is now in "booting" (setImmediate settled, waitForAdbSerial
    // running). Flush macrotasks so settled=true, then emit the crash exit.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(spawnedChild).toBeDefined();
    spawnedChild!.emit("exit", 1);

    // Must surface as "error" with the specific message — NOT hang for 120s.
    await waitForStatus(manager, "1", "error");
    expect(manager.get("1")?.toInfo().error).toMatch(/scope exited during boot with code 1/);

    // PR #1404 nit: bootstrapFailed won the race above, which leaves the
    // losing waitForAdbSerial loop alive — without the shared scopeExit flag
    // it keeps calling getDevices() once per BOOT_POLL_INTERVAL_MS (1000ms)
    // until BOOT_TIMEOUT_MS (120s) expires. Wait past two poll intervals and
    // assert the count is untouched: with the flag the loop checks it before
    // every getDevices() and stops dead, so no call can be registered after
    // capture (the flag was set synchronously, before status flipped to
    // "error", and the loop only ever resumes from a sleep() macrotask).
    const pollsAfterError = mockServerClient.getDevices.mock.calls.length;
    await new Promise<void>((r) => setTimeout(r, 1500));
    expect(mockServerClient.getDevices.mock.calls.length).toBe(pollsAfterError);
  });

  it.each(["createAdb", "pushServer"] as const)(
    "scope exit while spawn() is between the adb race and status=streaming (during %s) aborts with the specific error instead of reporting streaming",
    async (phase) => {
      // PR #1404 nit: Promise.race can settle via adb while the scope dies
      // during the awaits that follow — bootstrapFailed's rejection is then
      // unobservable (the race is already decided), so spawn() must re-check
      // the recorded scopeExit error itself. Without that re-check this test
      // ends at status "streaming" on an emulator that has already gone
      // through handleExit(), which is exactly the status clobber the review
      // flagged.
      mockDeviceList = [{ serial: "emulator-5554" }];
      let spawnedChild: ReturnType<typeof createMockChild> | undefined;
      const baseImpl = vi.mocked(spawnChildProcess).getMockImplementation()!;
      vi.mocked(spawnChildProcess).mockImplementation(((
        file: string,
        args: readonly string[],
        ...rest: unknown[]
      ) => {
        if (file === "systemd-run" && spawnedChild === undefined) {
          const ee = createMockChild();
          spawnedChild = ee;
          listUnitsReply.push(`${args[4]}.scope loaded active running ${args[6]}`);
          // Never emits exit on its own — the scope "dies" only when the
          // hook below fires, i.e. while spawn() is awaiting createAdb or
          // pushServer. The setImmediate in Device.spawn() settles the
          // bootstrap promise first, so the exit is post-settle by definition.
          return ee as unknown as ChildProcess.ChildProcess;
        }
        return baseImpl(file, args, ...(rest as []));
      }) as typeof spawnChildProcess);

      const emitScopeExit = () => spawnedChild?.emit("exit", 1);
      if (phase === "createAdb") mockCreateAdbHook = emitScopeExit;
      else mockPushServerHook = emitScopeExit;

      const manager = new DeviceManager(baseOpts());
      await manager.getOrCreate({
        id: "1",
        kind: "emulator" as const,
        avdName: "dev35",
        serial: null,
        label: null,
        port: null,
      });

      // adb saw the serial, so the race resolved via waitForAdbSerial and the
      // hook fires while spawn() is inside the named call — the post-race gap.
      await waitForStatus(manager, "1", "error");
      expect(manager.get("1")?.toInfo().error).toMatch(/scope exited during boot with code 1/);
      expect(manager.get("1")?.toInfo().status).not.toBe("streaming");
    },
  );

  it("a post-settle systemd-run 'error' event during boot aborts immediately instead of falling through to the 120s adb timeout", async () => {
    // Same defect class as the exit path above: a real child 'error' after
    // setImmediate has settled the bootstrap promise used to call handleExit()
    // without recording anything, so spawn() stayed in waitForAdbSerial for
    // the full BOOT_TIMEOUT_MS and reported only the generic adb timeout.
    mockDeviceList = [];
    let spawnedChild: ReturnType<typeof createMockChild> | undefined;
    const baseImpl = vi.mocked(spawnChildProcess).getMockImplementation()!;
    vi.mocked(spawnChildProcess).mockImplementation(((
      file: string,
      args: readonly string[],
      ...rest: unknown[]
    ) => {
      if (file === "systemd-run" && spawnedChild === undefined) {
        const ee = createMockChild();
        spawnedChild = ee;
        listUnitsReply.push(`${args[4]}.scope loaded active running ${args[6]}`);
        return ee as unknown as ChildProcess.ChildProcess;
      }
      return baseImpl(file, args, ...(rest as []));
    }) as typeof spawnChildProcess);

    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    // Flush macrotasks so the bootstrap promise has settled (settled=true)
    // before the error arrives — post-settle, i.e. the branch under test.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(spawnedChild).toBeDefined();
    spawnedChild!.emit("error", new Error("dbus connection refused"));

    await waitForStatus(manager, "1", "error");
    expect(manager.get("1")?.toInfo().error).toMatch(/dbus connection refused/);
  });

  it("spawn() failure when pushing the scrcpy server rejects tears down cleanly (CodeQL: exercises mockPushServerShouldFail)", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    mockPushServerShouldFail = true;
    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "error");
    expect(manager.get("1")?.toInfo().error).toMatch(/pushServer failed/);
    await waitForCondition(
      () => !fs.existsSync(deviceMarkerPath(SESSIONS_DIR, "1")),
      "device 1's marker file to be removed",
    );
    await waitForCondition(
      () =>
        vi
          .mocked(spawnChildProcess)
          .mock.calls.some((c) => c[0] === "systemctl" && (c[1] as string[])[1] === "stop"),
      "a systemctl stop call for device 1",
    );

    mockPushServerShouldFail = false;
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");
  });

  it("spawn() with DEVICE_SCRCPY_SERVER_PATH unset fails as a normal spawn error, not an uncaught createReadStream ENOENT", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(baseOpts({ scrcpyServerPath: "" }));
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "error");
    expect(manager.get("1")?.toInfo().error).toBe("DEVICE_SCRCPY_SERVER_PATH is not configured");
    await waitForCondition(
      () => !fs.existsSync(deviceMarkerPath(SESSIONS_DIR, "1")),
      "device 1's marker file to be removed",
    );
  });

  it("spawn() failure when starting the scrcpy server rejects tears down cleanly (CodeQL: exercises mockStartShouldFail)", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    mockStartShouldFail = true;
    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "error");
    expect(manager.get("1")?.toInfo().error).toMatch(/scrcpy start failed/);
    await waitForCondition(
      () => !fs.existsSync(deviceMarkerPath(SESSIONS_DIR, "1")),
      "device 1's marker file to be removed",
    );
    await waitForCondition(
      () =>
        vi
          .mocked(spawnChildProcess)
          .mock.calls.some((c) => c[0] === "systemctl" && (c[1] as string[])[1] === "stop"),
      "a systemctl stop call for device 1",
    );

    mockStartShouldFail = false;
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");
  });

  it("onSpawnError fires (not an unhandled rejection) when the fire-and-forget spawn() fails", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    mockCreateAdbShouldFail = true;
    const onSpawnError = vi.fn();
    const manager = new DeviceManager(baseOpts({ onSpawnError }));
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "error");
    // Race-prone assertion: Device.spawn() flips `status` to "error"
    // BEFORE awaiting teardown/throw, and the `.catch()` that fires
    // `onSpawnError` is a microtask scheduled by that throw — under
    // CI load, the immediate `expect(...)` below occasionally runs
    // before the microtask has fired. waitForStatus only polls
    // `status === "error"`, so it doesn't gate the callback. Pin the
    // assertion with vi.waitFor() the same way waitForCondition (above)
    // gates the marker-removal/scope-stop assertions — same shape, same
    // timeout, just on the mock call rather than a state value.
    await vi.waitFor(() => expect(onSpawnError).toHaveBeenCalledWith("1", expect.any(Error)), {
      timeout: 2000,
    });
  });

  it("kill() on a tracked, live device closes scrcpy/adb and stops its scope", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");
    await manager.kill("1", "emulator");
    expect(mockScrcpyClose).toHaveBeenCalled();
    expect(mockAdbClose).toHaveBeenCalled();
    expect(manager.get("1")?.toInfo().status).toBe("exited");
  });

  it("handles child process exit after streaming by transitioning status to exited", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    let spawnedChild: ReturnType<typeof createMockChild> | undefined;

    // Override the default mockImplementation so that for `systemd-run` we
    // capture the child but NEVER emit exit — simulating a long-running scope.
    // Other commands (adb start-server, systemctl) fall through to the base.
    const baseImpl = vi.mocked(spawnChildProcess).getMockImplementation()!;
    vi.mocked(spawnChildProcess).mockImplementation(((
      file: string,
      args: readonly string[],
      ...rest: unknown[]
    ) => {
      if (file === "systemd-run" && spawnedChild === undefined) {
        const ee = createMockChild();
        spawnedChild = ee;
        listUnitsReply.push(`${args[4]}.scope loaded active running ${args[6]}`);
        // Do NOT emit exit — simulates systemd-run staying alive for the full
        // emulator lifespan. The setImmediate in Device.spawn() settles the
        // bootstrap promise; only AFTER that should the emulator "die".
        return ee as unknown as ChildProcess.ChildProcess;
      }
      return baseImpl(file, args, ...(rest as []));
    }) as typeof spawnChildProcess);

    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");
    expect(spawnedChild).toBeDefined();

    // Let any remaining macrotasks flush so Device.spawn()'s setImmediate has
    // already fired and `settled = true` — only then does a late exit take the
    // `else { this.handleExit() }` branch.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Simulate the emulator process dying while already streaming.
    spawnedChild!.emit("exit", 0);
    expect(manager.get("1")?.toInfo().status).toBe("exited");
  });

  it("kill() on an id with NO in-memory Device still stops the scope by derived unit name — the orphan-scope fix (Hermes review)", async () => {
    // Simulates the post-restart case: nothing in the in-memory map, but a
    // scope for id "9" is still alive. Before this fix, kill()/terminate()
    // silently no-op'd here, leaving the row "killed" while the real
    // emulator kept running with no way to ever stop it again.
    const manager = new DeviceManager(baseOpts());
    expect(manager.get("9")).toBeUndefined();
    registerLiveScope("9");
    await manager.kill("9", "emulator");
    const stopCall = vi
      .mocked(spawnChildProcess)
      .mock.calls.find(
        (c) =>
          c[0] === "systemctl" &&
          (c[1] as string[])[1] === "stop" &&
          (c[1] as string[])[2]?.includes("-9.scope"),
      );
    expect(stopCall).toBeDefined();
  });

  it("terminate() removes the device from the manager's own map", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({
      id: "1",
      kind: "emulator" as const,
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    await waitForStatus(manager, "1", "streaming");
    await manager.terminate("1", "emulator");
    expect(manager.get("1")).toBeUndefined();
  });

  it("onVideoPacket replays the cached configuration packet to a NEW subscriber that attaches after streaming already started", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    mockVideoPackets = [
      { type: "configuration", data: new Uint8Array([9, 9, 9]) },
      { type: "data", data: new Uint8Array([1]) },
    ];
    const manager = new DeviceManager(baseOpts());
    const device = await manager.getOrCreate({
      id: "1",
      kind: "emulator",
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });

    // An early subscriber sees the real fan-out from pumpVideo's own read
    // loop (a real ReadableStream this time, not a stub) — used here only
    // to detect the moment the configuration packet has actually been
    // pumped through and cached (a private field pumpVideo alone writes
    // to), since polling `toInfo()`'s public status doesn't tell us that.
    const seenTypes: string[] = [];
    device.onVideoPacket((packet) => seenTypes.push(packet.type));
    const deadline = Date.now() + 2000;
    while (!seenTypes.includes("configuration") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(seenTypes).toContain("configuration");

    // The actual assertion: a listener that subscribes AFTER the
    // configuration packet already went out gets it replayed
    // SYNCHRONOUSLY, inside the onVideoPacket() call itself — this is what
    // lets a second panel (or a reconnect) configure its WebCodecs decoder
    // without ever seeing raw "data" packets first.
    const lateListener = vi.fn();
    device.onVideoPacket(lateListener);
    expect(lateListener).toHaveBeenCalledTimes(1);
    expect(lateListener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "configuration", data: new Uint8Array([9, 9, 9]) }),
    );
  });

  // A physical device is never spawned (no systemd-run, no marker, no port
  // pool slot) — the load-bearing assertions here are all NEGATIVE, proving
  // getOrCreate()'s `kind: "physical"` branch really does short-circuit
  // BEFORE any of the emulator machinery, not merely that connectPhysical()
  // itself behaves.
  describe("physical devices", () => {
    const PHYSICAL_ADDRESS = "192.168.1.23:37251";

    it("getOrCreate connects a physical device — zero systemd-run invocations, port allocator untouched", async () => {
      mockDeviceList = [{ serial: PHYSICAL_ADDRESS }];
      const onPortAssigned = vi.fn();
      const manager = new DeviceManager(baseOpts({ onPortAssigned }));
      const device = await manager.getOrCreate({
        id: "1",
        kind: "physical",
        avdName: null,
        serial: PHYSICAL_ADDRESS,
        label: null,
        port: null,
      });
      await waitForStatus(manager, "1", "streaming");

      expect(device.toInfo()).toMatchObject({
        kind: "physical",
        avdName: null,
        serial: PHYSICAL_ADDRESS,
      });
      expect(mockWirelessConnect).toHaveBeenCalledWith(PHYSICAL_ADDRESS);
      expect(vi.mocked(spawnChildProcess).mock.calls.some((c) => c[0] === "systemd-run")).toBe(
        false,
      );
      // onPortAssigned is spawn()'s own hook (device-manager.ts) — never
      // fired for a device that was never spawned.
      expect(onPortAssigned).not.toHaveBeenCalled();
    });

    it("getOrCreate on a physical device treats wireless.connect()'s AlreadyConnectedError as success, not a failure", async () => {
      mockDeviceList = [{ serial: PHYSICAL_ADDRESS }];
      mockWirelessConnectAlreadyConnected = true;
      const manager = new DeviceManager(baseOpts());
      await manager.getOrCreate({
        id: "1",
        kind: "physical",
        avdName: null,
        serial: PHYSICAL_ADDRESS,
        label: null,
        port: null,
      });
      await waitForStatus(manager, "1", "streaming");
      expect(mockWirelessConnect).toHaveBeenCalledWith(PHYSICAL_ADDRESS);
    });

    it("getOrCreate on a physical device surfaces a genuine wireless.connect() failure (e.g. UnauthorizedError) as status error", async () => {
      mockWirelessConnectError = new Error("failed to connect to " + PHYSICAL_ADDRESS);
      const manager = new DeviceManager(baseOpts());
      await manager.getOrCreate({
        id: "1",
        kind: "physical",
        avdName: null,
        serial: PHYSICAL_ADDRESS,
        label: null,
        port: null,
      });
      await waitForStatus(manager, "1", "error");
      expect(manager.get("1")?.toInfo().error).toMatch(/failed to connect/);
    });

    it("kill() on a physical id with NO in-memory Device issues no systemctl call — there was never a scope to stop", async () => {
      const manager = new DeviceManager(baseOpts());
      expect(manager.get("1")).toBeUndefined();
      await manager.kill("1", "physical");
      expect(vi.mocked(spawnChildProcess).mock.calls.some((c) => c[0] === "systemctl")).toBe(false);
    });

    it("kill() on a tracked, live physical device closes adb/scrcpy but never touches systemd/systemctl", async () => {
      mockDeviceList = [{ serial: PHYSICAL_ADDRESS }];
      const manager = new DeviceManager(baseOpts());
      await manager.getOrCreate({
        id: "1",
        kind: "physical",
        avdName: null,
        serial: PHYSICAL_ADDRESS,
        label: null,
        port: null,
      });
      await waitForStatus(manager, "1", "streaming");
      await manager.kill("1", "physical");
      expect(mockScrcpyClose).toHaveBeenCalled();
      expect(mockAdbClose).toHaveBeenCalled();
      expect(manager.get("1")?.toInfo().status).toBe("exited");
      expect(vi.mocked(spawnChildProcess).mock.calls.some((c) => c[0] === "systemctl")).toBe(false);
    });

    it("pair() delegates to wireless.pair(address, password) in that argument order", async () => {
      const manager = new DeviceManager(baseOpts());
      await manager.pair(PHYSICAL_ADDRESS, "123456");
      expect(mockWirelessPair).toHaveBeenCalledWith(PHYSICAL_ADDRESS, "123456");
    });

    it("pair() throws when disabled, same assertEnabled() posture as getOrCreate", async () => {
      const manager = new DeviceManager(baseOpts({ enabled: false }));
      await expect(manager.pair(PHYSICAL_ADDRESS, "123456")).rejects.toThrow(/disabled/);
      expect(mockWirelessPair).not.toHaveBeenCalled();
    });
  });
});
