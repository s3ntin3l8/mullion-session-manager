import type { FastifyInstance } from "fastify";
import type { DeviceRow } from "./device-store.js";
import { listDeviceRows, setDevicePort } from "./device-store.js";
import {
  DeviceActionError,
  type DevicePlatform,
  type DeviceAction,
  type DeviceActionResult,
  type DeviceInfo,
  type DeviceKind,
} from "./device-drivers/types.js";
import { localDeviceKinds, localDevicePlatforms } from "./device-kinds.js";
import type { HostDeviceSupport } from "./remote-host-devices.js";
import { performDeviceAction } from "./device-drivers/actions.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { HostRequestError } from "./remote-host-errors.js";
import type { DeviceSpawnSpec, LiveDevicesResponse } from "./device-wire.js";
import type { DiscoveredDevice } from "./device-discovery.js";
import { listIosSimulators, type IosSimulator } from "./ios-simulators.js";

// The primary's view of "the machine a device runs on" (issue #3200). A device's
// `devices` row names its host (`hostId`); every operation on the live device
// goes through the DeviceHost for that id, so the routes do not branch on
// local-versus-agent themselves:
//
//   - LocalDeviceHost drives this process's own DeviceManager.
//   - RemoteDeviceHost drives an agent's DeviceManager through the agent's
//     `/internal/devices*` routes (routes/internal-devices.ts) with the same
//     arguments, because the agent has no database to read them from.
//
// Errors differ in kind, deliberately: a local failure is an Error with a
// message the route answers as a 400 (as before), a remote one is a
// HostRequestError (the agent answered, and its status is forwarded) or a
// transport error (the host is unreachable). See routes/devices.ts's
// `replyDeviceError`.

/** What a spawn answers with: the live info, and the emulator port to persist. */
export interface SpawnedDevice {
  info: DeviceInfo | undefined;
  port: number | null;
}

/** A host the device must not be placed on (answered as a 400, not as an
 * unreachable host): nothing was sent to it. */
export class DevicePlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevicePlacementError";
  }
}

export interface DeviceHost {
  readonly hostId: string;
  readonly isLocal: boolean;
  /** The kinds this host can run, or null when it predates the device routes. */
  kinds(): Promise<HostDeviceSupport | null>;
  /** Get-or-create the row's device (idempotent; reattaches a surviving scope). */
  getOrCreate(row: DeviceRow): Promise<SpawnedDevice>;
  /** Tears the live device down; never touches the row. An iOS device is stopped
   * through its driver, never through the scope backend, so its platform rides. */
  terminate(id: number, kind: DeviceKind, platform?: DevicePlatform): Promise<void>;
  /** One device's live info, undefined when nothing is running under that id. */
  info(id: number): Promise<DeviceInfo | undefined>;
  action(id: number, action: DeviceAction): Promise<DeviceActionResult>;
  /** Available iOS simulators on this host, or null when a remote agent predates `/internal/simulators`. */
  simulators(): Promise<IosSimulator[] | null>;
  /** Pair a physical Android device with this host's adb server. */
  pair(pairingAddress: string, pairingCode: string): Promise<void>;
  /** mDNS-discovered Android phones on this host's LAN. */
  discovered(): Promise<DiscoveredDevice[]>;
}

class LocalDeviceHost implements DeviceHost {
  readonly hostId = LOCAL_HOST_ID;
  readonly isLocal = true;
  constructor(private readonly app: FastifyInstance) {}

  async kinds(): Promise<HostDeviceSupport> {
    return {
      deviceKinds: localDeviceKinds(this.app),
      platforms: await localDevicePlatforms(this.app),
    };
  }

  async getOrCreate(row: DeviceRow): Promise<SpawnedDevice> {
    await this.app.device.getOrCreate({
      id: String(row.id),
      kind: row.kind,
      avdName: row.avdName,
      serial: row.serial,
      label: row.name,
      port: row.kind === "emulator" ? row.port : null,
      // Only for iOS, so an Android spawn keeps exactly the options it always had.
      ...(row.platform === "ios" ? { platform: row.platform, udid: row.udid } : {}),
    });
    // Read back from the manager, as the routes always did, rather than from
    // getOrCreate's return: the live device is the truth, and a local port is
    // already persisted by DeviceManager's `onPortAssigned`.
    const device = this.app.device.get(String(row.id));
    return { info: device?.toInfo(), port: device?.port ?? null };
  }

  terminate(id: number, kind: DeviceKind, platform?: DevicePlatform): Promise<void> {
    const manager = this.app.device;
    return platform === "ios"
      ? manager.terminate(String(id), kind, platform)
      : manager.terminate(String(id), kind);
  }

  async info(id: number): Promise<DeviceInfo | undefined> {
    return this.app.device.get(String(id))?.toInfo();
  }

  async action(id: number, action: DeviceAction): Promise<DeviceActionResult> {
    const driver = this.app.device.getDriver(String(id));
    if (!driver) {
      // The wording is the same on an agent (routes/internal-devices.ts) so a
      // caller sees one message wherever the device lives.
      throw new DeviceActionError(
        400,
        `device ${id} has no live adb connection (status: not running)`,
      );
    }
    return performDeviceAction(driver, action);
  }

  simulators(): Promise<IosSimulator[]> {
    return listIosSimulators();
  }

  pair(pairingAddress: string, pairingCode: string): Promise<void> {
    return this.app.device.pair(pairingAddress, pairingCode);
  }

  async discovered(): Promise<DiscoveredDevice[]> {
    if (!this.app.bootDeviceDiscoveryEnabled) return [];
    return this.app.deviceDiscovery.getDiscovered();
  }
}

/**
 * Unwraps an agent's 424 Failed Dependency response back into a
 * DeviceActionError with a clamped 5xx status (defaulting to `fallbackStatus`
 * when `deviceStatus` is missing or not an integer in 500..599) and a string
 * message (falling back to a generic message if unparseable or non-string).
 * Any other HostRequestError or HostUnreachableError passes through unchanged.
 */
function unwrapDeviceFailure(err: unknown, hostId: string, fallbackStatus: number): unknown {
  if (!(err instanceof HostRequestError) || err.statusCode !== 424) return err;
  let status = fallbackStatus;
  let message = `the device failed on host ${hostId}`;
  try {
    const parsed: unknown = JSON.parse(err.body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { deviceStatus, message: rawMessage } = parsed as {
        deviceStatus?: unknown;
        message?: unknown;
      };
      if (
        typeof deviceStatus === "number" &&
        Number.isInteger(deviceStatus) &&
        deviceStatus >= 500 &&
        deviceStatus <= 599
      ) {
        status = deviceStatus;
      }
      if (typeof rawMessage === "string") {
        message = rawMessage;
      }
    }
  } catch {
    // Unparseable body: keep generic message and fallbackStatus.
  }
  return new DeviceActionError(status, message);
}

class RemoteDeviceHost implements DeviceHost {
  readonly isLocal = false;
  constructor(
    private readonly app: FastifyInstance,
    readonly hostId: string,
  ) {}

  private get client() {
    return getRemoteHostClient(this.app, this.hostId);
  }

  kinds(): Promise<HostDeviceSupport | null> {
    return this.client.devices.kinds();
  }

  async getOrCreate(row: DeviceRow): Promise<SpawnedDevice> {
    // An agent that predates the `platform` field strips it from the spawn and
    // would run its Android path against an iOS row, so never send one to a
    // host that does not report `ios` (an absent report reads as Android-only).
    if (row.platform === "ios") {
      const support = await this.kinds();
      if (!support?.platforms.includes("ios")) {
        throw new DevicePlacementError(
          `Host ${this.hostId} does not support iOS simulators (supported platforms: ${support?.platforms.join(", ") || "none"}).`,
        );
      }
    }
    const spec: DeviceSpawnSpec = {
      id: String(row.id),
      kind: row.kind,
      avdName: row.avdName,
      serial: row.serial,
      label: row.name,
      port: row.kind === "emulator" ? row.port : null,
      reservedPorts: reservedPortsOnHost(this.app, this.hostId, row.id),
      // Sent only for a non-Android device, so a request for an Android one is
      // byte-for-byte what an agent that predates the field already accepts.
      ...(row.platform !== "android" ? { platform: row.platform, udid: row.udid } : {}),
    };
    const res = await this.client.devices.spawn(spec);
    // The agent has no database: the port its emulator holds is persisted here,
    // from the answer, so a later spawn (after an agent restart) can reattach.
    if (row.kind === "emulator" && res.port !== null && res.port !== row.port) {
      if (row.port !== null) {
        this.app.log.warn(
          { deviceId: row.id, hostId: this.hostId, persistedPort: row.port, livePort: res.port },
          "remote emulator spawn returned a different port than persisted",
        );
      }
      setDevicePort(this.app, row.id, res.port);
    }
    return res;
  }

  async terminate(id: number, kind: DeviceKind, platform?: DevicePlatform): Promise<void> {
    const devices = this.client.devices;
    try {
      await (platform === "ios"
        ? devices.terminate(String(id), kind, platform)
        : devices.terminate(String(id), kind));
    } catch (err) {
      throw unwrapDeviceFailure(err, this.hostId, 500);
    }
  }

  async info(id: number): Promise<DeviceInfo | undefined> {
    const { devices } = await this.client.devices.live();
    return devices.find((d) => d.id === String(id));
  }

  async action(id: number, action: DeviceAction): Promise<DeviceActionResult> {
    try {
      return await this.client.devices.action(String(id), action);
    } catch (err) {
      throw unwrapDeviceFailure(err, this.hostId, 502);
    }
  }

  simulators(): Promise<IosSimulator[] | null> {
    return this.client.devices.simulators();
  }

  async pair(pairingAddress: string, pairingCode: string): Promise<void> {
    try {
      await this.client.devices.pair(pairingAddress, pairingCode);
    } catch (err) {
      if (err instanceof HostRequestError && err.statusCode === 404) {
        throw new DevicePlacementError(
          `Host ${this.hostId} does not support pairing — update its agent.`,
        );
      }
      throw err;
    }
  }

  async discovered(): Promise<DiscoveredDevice[]> {
    try {
      return await this.client.devices.discovered();
    } catch (err) {
      if (err instanceof HostRequestError && err.statusCode === 404) {
        throw new DevicePlacementError(
          `Host ${this.hostId} does not support device discovery — update its agent.`,
        );
      }
      throw err;
    }
  }
}

/** The ports of every OTHER active emulator row on this host: the agent cannot
 * know them across a restart, so each spawn request names them. */
function reservedPortsOnHost(app: FastifyInstance, hostId: string, exceptId: number): number[] {
  return listDeviceRows(app)
    .filter(
      (r) => r.hostId === hostId && r.id !== exceptId && r.status === "active" && r.port !== null,
    )
    .map((r) => r.port as number);
}

export function getDeviceHost(app: FastifyInstance, hostId: string): DeviceHost {
  return hostId === LOCAL_HOST_ID ? new LocalDeviceHost(app) : new RemoteDeviceHost(app, hostId);
}

/** A device row's live info, with whether its host could be asked. */
export interface LiveLookup {
  live: DeviceInfo | undefined;
  /** True when the row's host is an agent that did not answer. */
  unreachable: boolean;
}

/**
 * Live info for many rows at once: one `devices.live()` per agent host rather
 * than one request per row, and a host that is down marks its rows unreachable
 * instead of failing the whole listing.
 */
export async function liveInfoForRows(
  app: FastifyInstance,
  rows: DeviceRow[],
): Promise<Map<number, LiveLookup>> {
  const out = new Map<number, LiveLookup>();
  const remoteHosts = new Set<string>();
  for (const row of rows) {
    if (row.hostId === LOCAL_HOST_ID) {
      out.set(row.id, { live: app.device.get(String(row.id))?.toInfo(), unreachable: false });
    } else {
      remoteHosts.add(row.hostId);
    }
  }
  await Promise.all(
    [...remoteHosts].map(async (hostId) => {
      let snapshot: LiveDevicesResponse | null = null;
      try {
        snapshot = await getRemoteHostClient(app, hostId).devices.live();
      } catch (err) {
        app.log.warn({ err, hostId }, "device list: host did not answer");
      }
      for (const row of rows) {
        if (row.hostId !== hostId) continue;
        if (snapshot?.ports && row.kind === "emulator" && row.platform !== "ios") {
          const livePort = snapshot.ports[String(row.id)];
          if (
            typeof livePort === "number" &&
            Number.isInteger(livePort) &&
            livePort >= 1 &&
            livePort <= 65535
          ) {
            if (row.port === null) {
              setDevicePort(app, row.id, livePort);
              app.log.info(
                { deviceId: row.id, hostId, port: livePort },
                "device list: recovered a remote emulator port",
              );
            } else if (row.port !== livePort) {
              app.log.warn(
                { deviceId: row.id, hostId, persistedPort: row.port, livePort },
                "device list: remote emulator live port differs from persisted port",
              );
            }
          }
        }
        out.set(row.id, {
          live: snapshot?.devices.find((d) => d.id === String(row.id)),
          unreachable: snapshot === null,
        });
      }
    }),
  );
  return out;
}
