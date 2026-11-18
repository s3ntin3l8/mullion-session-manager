// The device panel's API types, split out of types.ts to keep it under its
// size ceiling; types.ts re-exports everything here, so importers are unchanged.

// The device panel — routes/devices.ts's response shape: the `devices` DB
// row's own intent merged with DeviceManager's live status at the route
// layer, same "row is intent, manager is live truth" split as
// BridgeSummary/Host above.
export type DeviceLiveStatus = "starting" | "booting" | "streaming" | "exited" | "error";
export type DeviceKind = "emulator" | "physical";

export interface DeviceInfo {
  id: string;
  kind: DeviceKind;
  avdName: string | null;
  label: string | null;
  status: DeviceLiveStatus;
  serial: string | null;
  error: string | null;
}

export type DevicePlatform = "android" | "ios";

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
}

// A phone advertising Wireless debugging over mDNS (issue #1378,
// src/services/device-discovery.ts's own DiscoveredDevice) — returned by
// GET /api/devices/discovered. `id` round-trips back to
// POST /api/devices/pair-and-connect as `discoveryId`. Either address may be
// missing: Android only advertises the pairing service while its "Pair device
// with pairing code" screen is open.
export interface DiscoveredDevice {
  id: string;
  name: string;
  host: string;
  pairingAddress?: string;
  connectAddress?: string;
  device?: string;
  model?: string;
  product?: string;
  discoveredAt: string;
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
}

// Mirrors src/routes/devices.ts's DeviceHostEntry 1:1 — one host that could
// hold a device (`GET /api/devices/hosts`). "unsupported" is an agent that
// predates the device routes; "unreachable" is one that did not answer.
export interface DeviceHostEntry {
  hostId: string;
  name: string;
  status: "ok" | "unsupported" | "unreachable";
  deviceKinds: DeviceKind[];
}
