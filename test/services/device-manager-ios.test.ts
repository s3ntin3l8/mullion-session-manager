import { describe, it, expect, vi, beforeEach } from "vitest";
// Before anything that could load "node:child_process": the manager's
// constructor spawns `adb start-server`, and a test must never let one fire.
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import {
  DeviceManager,
  type DeviceManagerOptions,
  deviceCapabilities,
} from "../../src/services/device-manager.js";
import { IosDevice, createIdbIosEngine } from "../../src/services/ios-device.js";
import type { IosEngine, IosEngineFactory } from "../../src/services/ios-device.js";
import { IdbCompanion } from "../../src/services/device-drivers/idb-companion.js";
import {
  IosSimulatorDriver,
  type IdbCompanionHandle,
  type SimctlRunner,
} from "../../src/services/device-drivers/ios-simulator.js";
import type { ScopeBackend } from "../../src/services/scope/types.js";

// execFile is simctl's runner: a real `xcrun` must never fire from a test.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...mockChildProcessSpawn(actual), execFile: execFileMock };
});

// The iOS half of DeviceManager (#1943): the registry covers both engines, an
// iOS device is stopped through its driver and companion, and NOTHING here may
// reach the scope backend. The real IosSimulatorDriver runs against a scripted
// simctl and a fake companion, so no simulator is involved.

const UDID = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9";

function scriptedSimctl(initial: "Booted" | "Shutdown") {
  const calls: string[][] = [];
  const res = { state: initial as string, failBoot: null as Error | null };
  const simctl: SimctlRunner = async (args) => {
    calls.push(args);
    const verb = args[0]!;
    if (verb === "boot") {
      if (res.failBoot) throw res.failBoot;
      res.state = "Booted";
    }
    if (verb === "shutdown") res.state = "Shutdown";
    if (verb === "list") {
      return Buffer.from(
        JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ udid: UDID, state: res.state }],
          },
        }),
      );
    }
    return Buffer.alloc(0);
  };
  return { simctl, calls, res, verbs: () => calls.map((c) => c[0]) };
}

function fakeCompanion() {
  // A stream that never delivers a frame: the device stays `booting`, alive.
  const client = {
    videoStream: () => Object.assign(new EventEmitter(), { cancel: () => undefined }),
  };
  const handle = {
    client,
    isRunning: false,
    start: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    onExit: vi.fn(() => () => undefined),
  };
  return handle as IdbCompanionHandle & typeof handle;
}

/** The real driver over a scripted simctl, with the same companion-stopping
 * lifecycle createIdbIosEngine gives it. */
function realDriverEngine(sim: ReturnType<typeof scriptedSimctl>, companion = fakeCompanion()) {
  const factory: IosEngineFactory = (spec) => {
    const driver = new IosSimulatorDriver({
      id: spec.id,
      udid: spec.udid,
      label: spec.label,
      simctl: sim.simctl,
      companion,
    });
    const engine: IosEngine = {
      driver,
      start: () => driver.start(),
      async stop() {
        try {
          await driver.stop();
        } finally {
          await companion.stop();
        }
      },
    };
    return engine;
  };
  return { factory, companion };
}

/** A scope backend that records every member read from it and refuses to run. */
function untouchableScope() {
  const touched: string[] = [];
  const scope = new Proxy({} as ScopeBackend, {
    get: (_t, prop) => {
      touched.push(String(prop));
      return () => {
        throw new Error(`scope backend ${String(prop)}() must not be reached by an iOS device`);
      };
    },
  });
  return { scope, touched };
}

function makeManager(over: Partial<DeviceManagerOptions> = {}) {
  const { scope, touched } = untouchableScope();
  const onSpawnError = vi.fn();
  const manager = new DeviceManager({
    enabled: true,
    capabilities: deviceCapabilities("darwin"),
    adbPath: "adb",
    adbServerPort: 5037,
    emulatorPath: "emulator",
    scrcpyServerPath: "/nonexistent",
    sessionsDir: "/tmp/mullion-ios-manager-test",
    scopeBackend: scope,
    onSpawnError,
    ...over,
  });
  return { manager, touched, onSpawnError };
}

const spawnOpts = (id = "7") => ({
  id,
  kind: "emulator" as const,
  avdName: null,
  serial: null,
  label: "iPhone",
  port: null,
  platform: "ios" as const,
  udid: UDID,
});

async function settled(device: IosDevice, status: string) {
  await vi.waitFor(() => expect(device.toInfo().status).toBe(status));
}

describe("DeviceManager iOS Simulator devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args.at(-1) as (err: Error) => void;
      cb(new Error("simctl is faked out in this test"));
      return {};
    });
  });

  it("covers iOS devices in get, getDriver, getOrCreateDriver, list and killAll", async () => {
    const sim = scriptedSimctl("Shutdown");
    const { factory, companion } = realDriverEngine(sim);
    const { manager } = makeManager({ iosEngineFactory: factory });

    const device = await manager.getOrCreate(spawnOpts());
    expect(device).toBeInstanceOf(IosDevice);
    await vi.waitFor(() => expect(companion.restart).toHaveBeenCalled());
    expect(manager.get("7")).toBe(device);
    expect(manager.getDriver("7")).toBe((device as IosDevice).driver);
    expect(manager.getDriver("7")?.platform).toBe("ios");
    expect(await manager.getOrCreateDriver(spawnOpts())).toBe((device as IosDevice).driver);
    expect(manager.list()).toEqual([
      expect.objectContaining({ id: "7", status: "booting", serial: UDID }),
    ]);
    expect(manager.getDriver("nope")).toBeUndefined();

    await manager.killAll();
    expect(sim.verbs()).toContain("shutdown");
    expect(manager.get("7")?.isAlive).toBe(false);
  });

  it("is idempotent while the simulator is still booting", async () => {
    const sim = scriptedSimctl("Shutdown");
    const { factory } = realDriverEngine(sim);
    const spy = vi.fn(factory);
    const { manager } = makeManager({ iosEngineFactory: spy });

    const first = await manager.getOrCreate(spawnOpts());
    const second = await manager.getOrCreate(spawnOpts());
    expect(second).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    await settled(first as IosDevice, "booting");
  });

  it("reattaches a simulator that is still Booted: no boot, a fresh companion, never shut down", async () => {
    const sim = scriptedSimctl("Booted");
    const { factory, companion } = realDriverEngine(sim);
    const { manager } = makeManager({ iosEngineFactory: factory });

    const device = (await manager.getOrCreate(spawnOpts())) as IosDevice;
    await settled(device, "booting");
    await vi.waitFor(() => expect(companion.restart).toHaveBeenCalledTimes(1));
    expect(sim.verbs()).toEqual(["list", "bootstatus"]);

    await manager.terminate("7", "emulator", "ios");
    expect(sim.verbs()).not.toContain("shutdown");
    expect(sim.verbs()).not.toContain("boot");
    expect(companion.stop).toHaveBeenCalledTimes(1);
    expect(manager.get("7")).toBeUndefined();
  });

  it("boots a Shutdown simulator and shuts it down again on terminate", async () => {
    const sim = scriptedSimctl("Shutdown");
    const { factory, companion } = realDriverEngine(sim);
    const { manager } = makeManager({ iosEngineFactory: factory });

    const device = (await manager.getOrCreate(spawnOpts())) as IosDevice;
    await settled(device, "booting");
    await vi.waitFor(() => expect(sim.verbs()).toContain("bootstatus"));
    expect(sim.verbs()).toContain("boot");

    await manager.terminate("7", "emulator", "ios");
    expect(sim.verbs()).toContain("shutdown");
    expect(companion.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["boot", "bootstatus"] as const)(
    "a terminate that lands during %s never starts the companion or leaves the simulator booted",
    async (gateVerb) => {
      const sim = scriptedSimctl("Shutdown");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const gated: typeof sim = {
        ...sim,
        simctl: async (args, options) => {
          const out = await sim.simctl(args, options);
          if (args[0] === gateVerb) await gate;
          return out;
        },
      };
      const { factory, companion } = realDriverEngine(gated);
      const { manager } = makeManager({ iosEngineFactory: factory });

      const device = (await manager.getOrCreate(spawnOpts())) as IosDevice;
      await vi.waitFor(() => expect(sim.verbs()).toContain(gateVerb));
      await manager.terminate("7", "emulator", "ios");
      release();
      await vi.waitFor(() => expect(sim.res.state).toBe("Shutdown"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(companion.restart).not.toHaveBeenCalled();
      expect(companion.start).not.toHaveBeenCalled();
      expect(device.isAlive).toBe(false);
      expect(manager.get("7")).toBeUndefined();
    },
  );

  it("never reaches the scope backend: not on start, stop, terminate or killAll", async () => {
    const sim = scriptedSimctl("Booted");
    const { factory } = realDriverEngine(sim);
    const { manager, touched } = makeManager({ iosEngineFactory: factory });

    await manager.getOrCreate(spawnOpts("1"));
    await manager.terminate("1", "emulator", "ios");
    await manager.getOrCreate(spawnOpts("2"));
    await manager.killAll();
    // An iOS row with nothing in memory (a stop after a restart): nothing to
    // stop, and certainly no scope to resolve for an id that never had one.
    await manager.terminate("99", "emulator", "ios");
    await manager.kill("98", "emulator", "ios");

    expect(touched).toEqual([]);
  });

  it("replaces a failed device and stops what it left behind", async () => {
    const sim = scriptedSimctl("Shutdown");
    sim.res.failBoot = new Error("Unable to boot device: no runtime");
    const { factory, companion } = realDriverEngine(sim);
    const { manager, onSpawnError } = makeManager({ iosEngineFactory: factory });

    const failed = (await manager.getOrCreate(spawnOpts())) as IosDevice;
    await vi.waitFor(() => expect(onSpawnError).toHaveBeenCalled());
    expect(failed.toInfo()).toMatchObject({ status: "error" });
    expect(failed.isAlive).toBe(false);

    sim.res.failBoot = null;
    const next = (await manager.getOrCreate(spawnOpts())) as IosDevice;
    expect(next).not.toBe(failed);
    await vi.waitFor(() => expect(companion.stop).toHaveBeenCalled());
    await settled(next, "booting");
  });

  it("refuses an iOS spawn with no udid, no engine, or no iOS capability", async () => {
    const { manager } = makeManager({ idbCompanionPath: undefined });
    await expect(manager.getOrCreate({ ...spawnOpts(), udid: null })).rejects.toThrow(/UDID/);
    await expect(manager.getOrCreate(spawnOpts())).rejects.toThrow(/DEVICE_IDB_COMPANION_PATH/);

    const linux = makeManager({ capabilities: deviceCapabilities("linux") });
    await expect(linux.manager.getOrCreate(spawnOpts())).rejects.toThrow(/not supported/);
    const off = makeManager({ enabled: false });
    await expect(off.manager.getOrCreate(spawnOpts())).rejects.toThrow(/disabled/);
  });

  it("builds the real engine from the companion path, and stops the companion with the driver", async () => {
    const stop = vi.spyOn(IdbCompanion.prototype, "stop").mockResolvedValue(undefined);
    try {
      const { manager } = makeManager({ idbCompanionPath: "/opt/idb_companion" });
      const device = (await manager.getOrCreate(spawnOpts())) as IosDevice;
      expect(device.driver.platform).toBe("ios");
      // start() runs against the faked-out simctl; the point here is stop's wiring.
      await manager.terminate("7", "emulator", "ios").catch(() => undefined);
      expect(stop).toHaveBeenCalled();

      const engine = createIdbIosEngine("/opt/idb_companion")({ id: "3", udid: UDID, label: null });
      await engine.stop();
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      stop.mockRestore();
    }
  });
});
