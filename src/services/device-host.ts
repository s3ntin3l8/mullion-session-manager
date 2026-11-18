import type { FastifyInstance } from "fastify";
import type { DeviceRow } from "./device-store.js";
import { listDeviceRows, setDevicePort } from "./device-store.js";
import {
  DeviceActionError,
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
import type { DeviceSpawnSpec } from "./device-wire.js";
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

export interface DeviceHost {
  readonly hostId: string;
  readonly isLocal: boolean;
  /** The kinds this host can run, or null when it predates the device routes. */
  kinds(): Promise<HostDeviceSupport | null>;
  /** Get-or-create the row's device (idempotent; reattaches a surviving scope). */
  getOrCreate(row: DeviceRow): Promise<SpawnedDevice>;
  /** Tears the live device down; never touches the row. */
  terminate(id: number, kind: DeviceKind): Promise<void>;
  /** One device's live info, undefined when nothing is running under that id. */
  info(id: number): Promise<DeviceInfo | undefined>;
  action(id: number, action: DeviceAction): Promise<DeviceActionResult>;
  /** Available iOS simulators on this host. */
  simulators(): Promise<IosSimulator[]>;
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
    });
    // Read back from the manager, as the routes always did, rather than from
    // getOrCreate's return: the live device is the truth, and a local port is
    // already persisted by DeviceManager's `onPortAssigned`.
    const device = this.app.device.get(String(row.id));
    return { info: device?.toInfo(), port: device?.port ?? null };
  }

  terminate(id: number, kind: DeviceKind): Promise<void> {
    return this.app.device.terminate(String(id), kind);
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
      setDevicePort(this.app, row.id, res.port);
    }
    return res;
  }

  terminate(id: number, kind: DeviceKind): Promise<void> {
    return this.client.devices.terminate(String(id), kind);
  }

  async info(id: number): Promise<DeviceInfo | undefined> {
    const live = await this.client.devices.live();
    return live.find((d) => d.id === String(id));
  }

  action(id: number, action: DeviceAction): Promise<DeviceActionResult> {
    return this.client.devices.action(String(id), action);
  }

  simulators(): Promise<IosSimulator[]> {
    return this.client.devices.simulators();
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
      let live: DeviceInfo[] | null = null;
      try {
        live = await getRemoteHostClient(app, hostId).devices.live();
      } catch (err) {
        app.log.warn({ err, hostId }, "device list: host did not answer");
      }
      for (const row of rows) {
        if (row.hostId !== hostId) continue;
        out.set(row.id, {
          live: live?.find((d) => d.id === String(row.id)),
          unreachable: live === null,
        });
      }
    }),
  );
  return out;
}
