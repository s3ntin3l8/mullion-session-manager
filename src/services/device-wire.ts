import type { DeviceInfo, DeviceKind, DevicePlatform } from "./device-drivers/types.js";
import type { DiscoveredDevice } from "./device-discovery.js";
import type { CreateSimulatorInput, IosSimulator, SimulatorCatalog } from "./ios-simulators.js";

// The request/response shapes of the agent's `/internal/devices*` routes
// (routes/internal-devices.ts), shared by the agent that serves them and the
// primary's RemoteHostClient that calls them (#3200). A device's row lives on
// the primary; the agent has no database, so everything it needs to run the
// device rides in the request.

/** Everything an agent needs to get-or-create one device. Mirrors
 * `DeviceSpawnOptions` (device-manager.ts) plus the ports the agent cannot
 * learn for itself. */
export interface DeviceSpawnSpec {
  /** The primary's `devices.id`, as a string: the agent keys its manager by it. */
  id: string;
  kind: DeviceKind;
  avdName: string | null;
  serial: string | null;
  label: string | null;
  /** The emulator port the row already persists (reattach after an agent or
   * primary restart); null for a first spawn and for a physical device. */
  port: number | null;
  /** Which platform runs the device. Absent means "android": an agent that
   * predates the field only knows Android, and the primary sends it only for a
   * device that is not one (#3202). */
  platform?: DevicePlatform;
  /** An iOS Simulator's UDID; only with `platform: "ios"`. */
  udid?: string | null;
  /** The ports of this host's OTHER active devices. The agent keeps no record
   * of them across a restart, so without this a fresh emulator could be
   * handed a port a still-running one holds. */
  reservedPorts: number[];
}

export interface SpawnDeviceResponse {
  info: DeviceInfo;
  /** The port the agent's emulator holds, for the primary to persist. */
  port: number | null;
}

export interface LiveDevicesResponse {
  devices: DeviceInfo[];
  /** Emulator ports keyed by device id. Absent from an agent that predates
   * the field (#3290). */
  ports?: Record<string, number>;
}

export interface SimulatorsResponse {
  simulators: IosSimulator[];
}

export type SimulatorCatalogResponse = SimulatorCatalog;

export type CreateSimulatorRequest = CreateSimulatorInput;

export interface CreateSimulatorResponse {
  simulator: IosSimulator;
}

export interface DevicePairRequest {
  pairingAddress: string;
  pairingCode: string;
}

export interface DevicePairResponse {
  ok: true;
}

export interface DiscoveredDevicesResponse {
  devices: DiscoveredDevice[];
}

export interface DeviceKindsResponse {
  /** The device kinds this host can run right now; empty when the panel is off. */
  deviceKinds: DeviceKind[];
  /** The device platforms this host can run right now. Absent from an agent that
   * predates iOS support, which is Android-only. */
  platforms?: DevicePlatform[];
}

/** The device id a device socket names: the route's path param
 * (`/internal/ws/device/:id`) and the channel stream's `id` query. One
 * pattern for both, so the two transports cannot drift on what an id is. */
export const DEVICE_ID_PATTERN = "^[0-9]{1,18}$";

/** The query of `/internal/ws/device/:id` (every value is a string on the wire).
 * A type alias, not an interface: it is read as a plain
 * `Record<string, string | undefined>` (the shape every query on the wire
 * has), and only an alias carries that implicit index signature. */
export type DeviceWsQuery = {
  kind: DeviceKind;
  avdName?: string;
  serial?: string;
  label?: string;
  port?: string;
  /** Absent means "android". */
  platform?: DevicePlatform;
  udid?: string;
};
