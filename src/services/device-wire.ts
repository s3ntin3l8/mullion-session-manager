import type { DeviceInfo, DeviceKind, DevicePlatform } from "./device-drivers/types.js";

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
}

export interface DeviceKindsResponse {
  /** The device kinds this host can run right now; empty when the panel is off. */
  deviceKinds: DeviceKind[];
  /** The device platforms this host can run right now. Absent from an agent that
   * predates iOS support, which is Android-only. */
  platforms?: DevicePlatform[];
}

/** The query of `/internal/ws/device/:id` (every value is a string on the wire). */
export interface DeviceWsQuery {
  kind: DeviceKind;
  avdName?: string;
  serial?: string;
  label?: string;
  port?: string;
}
