// The device panel's API types, split out of types.ts to keep it under its
// size ceiling; types.ts re-exports everything here, so importers are unchanged.

import type { DeviceKind, DeviceInfo, DevicePlatform } from "../../../src/shared/types.js";
export type {
  DeviceLiveStatus,
  DeviceKind,
  DeviceInfo,
  DevicePlatform,
  DiscoveredDevice,
  DeviceHostEntry,
  IosSimulatorState,
  SimulatorDeviceType,
  SimulatorRuntime,
  SimulatorCatalog,
  IosSimulator,
} from "../../../src/shared/types.js";

export interface Device {
  id: number;
  hostId: string;
  projectId: number | null;
  name: string | null;
  // Which platform's engine runs the device. `kind`, `avdName` and `serial`
  // below are Android-shaped; an iOS Simulator is identified by `udid`. The
  // server always sends it; it is optional here so a Device built without it (a
  // fixture, an older cached response) still type-checks. Absent means "android".
  platform?: DevicePlatform;
  kind: DeviceKind;
  // Set for `kind: "emulator"`, null for `kind: "physical"`.
  avdName: string | null;
  // Set for `kind: "physical"` (its adb TCP address), null for
  // `kind: "emulator"`.
  serial: string | null;
  // The iOS Simulator's UDID; null (or absent) for an Android device.
  udid?: string | null;
  status: "active" | "killed";
  createdAt: string;
  live: DeviceInfo | null;
  // True when the device's agent host did not answer; `live` is then null for
  // lack of an answer, not because the device is stopped. Absent otherwise.
  hostUnreachable?: boolean;
}

// POST /api/devices/pair-and-connect's body — either `discoveryId` (a cached
// mDNS entry, `connectAddress` then an optional override) or the manual
// `pairingAddress` + `connectAddress` pair. `pairingCode` is always required.
export interface PairAndConnectBody {
  discoveryId?: string;
  pairingAddress?: string;
  connectAddress?: string;
  pairingCode: string;
  name?: string;
  // The agent host whose adb server pairs the phone; omitted = the primary.
  hostId?: string;
}

export interface CreateSimulatorBody {
  name: string;
  deviceTypeId: string;
  runtimeId: string;
  hostId?: string;
}
