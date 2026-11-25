// Shared API types for the device panel: emulators, simulators and physical devices (#2412).
//
// The single declaration of each API shape here, used by both workspaces.
// Most were hand-copied into frontend/src/api/ before #2412; the backend
// module that produces one re-exports it, so its importers are unchanged, and
// the frontend imports it through src/shared/types.ts, the one entry point.
// Type-only: no runtime code, and no import from outside src/shared/ (an
// import back from types.ts would be a cycle).

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

/** A device the scanner has seen advertising mDNS. Stable `id` is the SRV
 * target hostname (e.g. `Android.local`) — shared by the phone's pairing
 * and connect records, and stable across A-record resolution. */
export interface DiscoveredDevice {
  /** Stable per-device id (the SRV hostname, falling back to the dial host
   * only when the SRV target is empty) — used by the REST layer to
   * round-trip a selection from the modal back to `pair-and-connect`
   * without re-scanning. Not necessarily an IP. */
  id: string;
  /** Display name from the pairing TXT record (e.g. "Pixel 7"). Falls back
   * to the connect TXT name if the pairing record hasn't been seen yet. */
  name: string;
  /** The address `adb pair`/`adb connect` should dial — IPv4 when the A
   * record has resolved, else the hostname (adb resolves it via nss-mdns
   * if available). IPv4 preferred for now; bonjour-service will surface
   * AAAA records too but Android's adb-over-TCP only listens on IPv4. */
  host: string;
  /** `host:port` for the pairing listener, if seen. Until it's seen the UI
   * can't offer "Pair" against this entry yet — manual fallback remains. */
  pairingAddress?: string;
  /** `host:port` for the connect listener, if seen. Same UX caveat. */
  connectAddress?: string;
  /** Android device-serial from TXT, used as a fingerprint to match against
   * existing physical `devices` rows when prompting reconnect (issue #1380).
   * Best-effort — older Android versions omit it. */
  device?: string;
  /** `model` from TXT (e.g. "Pixel 7"). Optional, for UI labelling. */
  model?: string;
  /** `product` from TXT (e.g. "panther"). Optional, for UI labelling. */
  product?: string;
  /** ISO timestamp of the most recent `up` event for either service. */
  discoveredAt: string;
}

/** Why a host does not offer a device platform it could run (#3510): one
 * line naming the setting to change. Today only iOS, on a macOS host; absent
 * for a platform the host cannot run at all, and from an agent that predates it. */
export interface DeviceUnavailable {
  ios?: string;
}

export interface DeviceHostEntry {
  hostId: string;
  name: string;
  status: "ok" | "unsupported" | "unreachable";
  deviceKinds: DeviceKind[];
  platforms: DevicePlatform[];
  /** Present only when the host reports a reason (see {@link DeviceUnavailable}). */
  unavailable?: DeviceUnavailable;
}

export type IosSimulatorState = "Booted" | "Shutdown";

export interface SimulatorDeviceType {
  id: string;
  name: string;
}

export interface SimulatorRuntime {
  id: string;
  name: string;
}

export interface SimulatorCatalog {
  deviceTypes: SimulatorDeviceType[];
  runtimes: SimulatorRuntime[];
}

export interface IosSimulator {
  udid: string;
  name: string;
  runtime: string;
  state: IosSimulatorState;
  /** The simctl device type identifier, when it reports one. */
  deviceTypeId?: string;
  /** When the simulator last booted (ISO 8601), absent until it has. The only
   * signal that tells a simulator someone uses from one Xcode provisioned. */
  lastBootedAt?: string;
}

export interface SystemImage {
  // The `-k`/`--package` value `avdmanager create avd` accepts verbatim —
  // also this image's stable identifier (used for the POST /api/avds
  // allowlist check).
  packagePath: string;
  apiLevel: string | null;
  tagDisplay: string | null;
  abi: string | null;
}

export interface AvailableSystemImage {
  packagePath: string;
  apiLevel: string;
  tag: string;
  tagDisplay: string;
  abi: string;
  installed: boolean;
}

export interface CreateDeviceBody {
  kind?: DeviceKind;
  // Emulator form.
  avdName?: string;
  // Physical form — the adb connect address ("host:port").
  address?: string;
  projectId?: number;
  name?: string;
  /** The host to run the device on (#3200); defaults to the project's host. */
  hostId?: string;
  /** Which platform runs the device (#3202); defaults to "android". */
  platform?: DevicePlatform;
  /** An iOS Simulator's UDID; only for `platform: "ios"`. */
  udid?: string;
}
