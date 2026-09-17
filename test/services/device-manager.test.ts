import { describe, it, expect, vi, beforeEach } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see test/helpers/mock-pty.ts's header
// comment for the empirically confirmed hoisting/ordering failure mode.
// DeviceManager's spawn()/kill() paths shell out to systemd-run/systemctl
// exactly like PtyManager's own bootstrapMaster()/stopScope() — a test must
// never let a real one fire (AGENTS.md, issue #1137's mocking invariant).
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { EventEmitter } from "node:events";
import { spawn as spawnChildProcess } from "node:child_process";
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
const mockServerClient = {
  getDevices: vi.fn(async () => mockDeviceList),
  createAdb: vi.fn(async () => {
    if (mockCreateAdbShouldFail) throw new Error("createAdb failed");
    return { close: mockAdbClose };
  }),
};

vi.mock("@yume-chan/adb", () => ({
  // A plain function, not an arrow — `new AdbServerClient(...)` (device-
  // manager.ts's constructor) needs `new` support, which an arrow function
  // can never have regardless of vi.fn() wrapping. Returning an explicit
  // object from a `new`-invoked plain function makes `new` yield THAT
  // object instead of `this` (ordinary JS constructor semantics) — exactly
  // what's needed here, since every test wants the same shared
  // `mockServerClient` instance back.
  AdbServerClient: vi.fn(function AdbServerClient() {
    return mockServerClient;
  }),
}));

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

const SESSIONS_DIR = "/tmp/device-manager-test-sessions";
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
  mockPushServerShouldFail = false;
  mockStartShouldFail = false;
  mockExited = new Promise(() => {});
  mockVideoPackets = [{ type: "configuration", data: new Uint8Array([1, 2, 3]) }];
  systemdRunShouldFail = false;
  listUnitsReply = [];
  mockAdbClose.mockClear();
  mockScrcpyClose.mockClear();
  mockController.injectText.mockClear();
  mockController.resetVideo.mockClear();
  vi.mocked(spawnChildProcess).mockClear();
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

describe("DeviceManager", () => {
  it("throws on getOrCreate when disabled, per its own assertEnabled() posture (matches BrowserManager)", async () => {
    const manager = new DeviceManager(baseOpts({ enabled: false }));
    await expect(manager.getOrCreate({ id: "1", avdName: "dev35", label: null })).rejects.toThrow(
      /disabled/,
    );
  });

  it("getOrCreate spawns a device end to end and reaches status streaming", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(baseOpts());
    const device = await manager.getOrCreate({ id: "1", avdName: "dev35", label: "My Device" });
    expect(device.id).toBe("1");
    expect(device.avdName).toBe("dev35");
    await waitForStatus(manager, "1", "streaming");
    expect(manager.get("1")).toBe(device);
    expect(manager.list().map((d) => d.id)).toEqual(["1"]);
  });

  it("getOrCreate is idempotent — a second call for the same alive id returns the SAME Device, no second spawn", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(baseOpts());
    const first = await manager.getOrCreate({ id: "1", avdName: "dev35", label: null });
    await waitForStatus(manager, "1", "streaming");
    const systemdRunCallsBefore = vi
      .mocked(spawnChildProcess)
      .mock.calls.filter((c) => c[0] === "systemd-run").length;
    const second = await manager.getOrCreate({ id: "1", avdName: "dev35", label: null });
    expect(second).toBe(first);
    const systemdRunCallsAfter = vi
      .mocked(spawnChildProcess)
      .mock.calls.filter((c) => c[0] === "systemd-run").length;
    expect(systemdRunCallsAfter).toBe(systemdRunCallsBefore);
  });

  it("getOrCreate rejects with a clear, actionable error when a scope survived with no in-memory Device (the restart-collision guard)", async () => {
    const manager = new DeviceManager(baseOpts());
    const instanceId = deriveInstanceId(SESSIONS_DIR);
    const marker = deviceMarkerPath(SESSIONS_DIR, "7");
    listUnitsReply = [
      `${deviceScopeUnitName(instanceId, "7")}.scope loaded active running mullion-device -m ${marker}`,
    ];
    await expect(manager.getOrCreate({ id: "7", avdName: "dev35", label: null })).rejects.toThrow(
      /systemctl --user stop/,
    );
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
      manager.getOrCreate({ id: "1", avdName: "dev35", label: null }),
    ).resolves.toBeDefined(); // getOrCreate itself doesn't await spawn() — see its own doc comment
    await waitForStatus(manager, "1", "error");
    expect(manager.get("1")?.toInfo().error).toMatch(/createAdb failed/);

    // Marker file removed, not left behind.
    expect(fs.existsSync(deviceMarkerPath(SESSIONS_DIR, "1"))).toBe(false);
    // stopDeviceScope's own "systemctl stop <unit>" was issued.
    const stopCall = vi
      .mocked(spawnChildProcess)
      .mock.calls.find((c) => c[0] === "systemctl" && (c[1] as string[])[1] === "stop");
    expect(stopCall).toBeDefined();

    // The port is releasable again — a second attempt with the same id
    // doesn't run out of ports (a real regression this fix prevents: an
    // un-released port would eventually exhaust the fixed allocation range
    // across enough failed attempts).
    mockCreateAdbShouldFail = false;
    await manager.getOrCreate({ id: "1", avdName: "dev35", label: null });
    await waitForStatus(manager, "1", "streaming");
  });

  it("onSpawnError fires (not an unhandled rejection) when the fire-and-forget spawn() fails", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    mockCreateAdbShouldFail = true;
    const onSpawnError = vi.fn();
    const manager = new DeviceManager(baseOpts({ onSpawnError }));
    await manager.getOrCreate({ id: "1", avdName: "dev35", label: null });
    await waitForStatus(manager, "1", "error");
    expect(onSpawnError).toHaveBeenCalledWith("1", expect.any(Error));
  });

  it("kill() on a tracked, live device closes scrcpy/adb and stops its scope", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    const manager = new DeviceManager(baseOpts());
    await manager.getOrCreate({ id: "1", avdName: "dev35", label: null });
    await waitForStatus(manager, "1", "streaming");
    await manager.kill("1");
    expect(mockScrcpyClose).toHaveBeenCalled();
    expect(mockAdbClose).toHaveBeenCalled();
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
    await manager.kill("9");
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
    await manager.getOrCreate({ id: "1", avdName: "dev35", label: null });
    await waitForStatus(manager, "1", "streaming");
    await manager.terminate("1");
    expect(manager.get("1")).toBeUndefined();
  });

  it("onVideoPacket replays the cached configuration packet to a NEW subscriber that attaches after streaming already started", async () => {
    mockDeviceList = [{ serial: "emulator-5554" }];
    mockVideoPackets = [
      { type: "configuration", data: new Uint8Array([9, 9, 9]) },
      { type: "data", data: new Uint8Array([1]) },
    ];
    const manager = new DeviceManager(baseOpts());
    const device = await manager.getOrCreate({ id: "1", avdName: "dev35", label: null });

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
});
