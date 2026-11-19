import type { DeviceDriver, DeviceInfo } from "./device-drivers/types.js";
import { IdbCompanion } from "./device-drivers/idb-companion.js";
import { IosSimulatorDriver } from "./device-drivers/ios-simulator.js";

// The iOS half of DeviceManager's registry (#1943). An Android `Device` owns a
// scope and a port; an iOS one owns a driver (simctl + idb) and its companion
// process, and NOTHING else: CoreSimulator supervises the simulator itself, so
// no code here may reach the scope backend.

/** What the manager needs to run one simulator: the driver, and a lifecycle
 * that also covers the companion process the driver does not stop itself. */
export interface IosEngine {
  readonly driver: DeviceDriver;
  /** Boots the simulator if needed (a Booted one is reattached) and starts a
   * fresh companion. Rejects on failure; the driver records it in its own status. */
  start(): Promise<void>;
  /** Stops the driver and its companion. Shuts the simulator down only when
   * this process booted it (the driver's own rule). */
  stop(): Promise<void>;
}

export interface IosEngineSpec {
  id: string;
  udid: string;
  label: string | null;
}

/** Builds the engine for one simulator; tests substitute a fake. */
export type IosEngineFactory = (spec: IosEngineSpec) => IosEngine;

/** The real engine: an IosSimulatorDriver with an IdbCompanion of its own. */
export function createIdbIosEngine(executablePath: string): IosEngineFactory {
  return (spec) => {
    const companion = new IdbCompanion({ udid: spec.udid, executablePath });
    const driver = new IosSimulatorDriver({
      id: spec.id,
      udid: spec.udid,
      label: spec.label,
      companion,
    });
    return {
      driver,
      start: () => driver.start(),
      async stop() {
        try {
          await driver.stop();
        } finally {
          // The driver never stops the companion itself; leaving it running
          // would leak a gRPC server per stopped device.
          await companion.stop();
        }
      },
    };
  };
}

/** A live iOS Simulator device in DeviceManager's registry. Shaped like the
 * parts of the Android `Device` the routes read (`toInfo`, `port`, `isAlive`). */
export class IosDevice {
  readonly platform = "ios" as const;
  readonly kind = "emulator" as const;
  /** An iOS device holds no emulator port. */
  readonly port: number | null = null;

  /** True from start() until it settles: the driver is not `alive` while the
   * simulator boots, and a second getOrCreate must not replace a device that is
   * still on its way up. */
  private starting = false;

  constructor(private readonly engine: IosEngine) {}

  get driver(): DeviceDriver {
    return this.engine.driver;
  }

  get isAlive(): boolean {
    return this.starting || this.engine.driver.isAlive;
  }

  toInfo(): DeviceInfo {
    return this.engine.driver.toInfo();
  }

  async start(): Promise<void> {
    this.starting = true;
    try {
      await this.engine.start();
    } finally {
      this.starting = false;
    }
  }

  kill(): Promise<void> {
    return this.engine.stop();
  }
}
