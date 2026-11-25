import type { FastifyInstance } from "fastify";
import { access, constants as fsConstants, stat } from "node:fs/promises";
import type { DeviceKind, DevicePlatform } from "./device-drivers/types.js";
import type { DeviceUnavailable } from "../shared/types.js";
import { ANDROID_NOT_CONFIGURED_MESSAGE, isDeviceKindSupported } from "./device-manager.js";
import { getCachedCapabilities } from "./host-capabilities.js";

/** The two kinds a device can be — an emulator or a physical device. The
 * guard every device route and every device wire shape uses, so "emulator" /
 * "physical" is spelled in one place. */
export function isDeviceKind(value: unknown): value is DeviceKind {
  return value === "emulator" || value === "physical";
}

/** The device kinds this host can run right now: what `features.deviceKinds`
 * reports for the primary's own host, and what a primary reads before it places
 * a device here. Empty when the panel is off. */
export function localDeviceKinds(app: FastifyInstance): DeviceKind[] {
  if (!app.devicePanelEnabled) return [];
  return app.deviceKinds.filter((kind) => kind !== "emulator" || app.deviceEmulatorEnabled);
}

/** Whether this host can add/start a physical (adb) device: the panel is on AND
 * Android is configured (an empty DEVICE_ADB_PATH is an iOS-only host, #3436). */
export function physicalDeviceEnabled(app: FastifyInstance): boolean {
  return app.devicePanelEnabled && app.deviceKinds.includes("physical");
}

/** Why {@link physicalDeviceEnabled} is false. */
export function physicalDeviceUnavailableMessage(app: FastifyInstance): string {
  return app.devicePanelEnabled
    ? ANDROID_NOT_CONFIGURED_MESSAGE
    : app.devicePanelUnavailableMessage;
}

/** Why this host cannot run an iOS Simulator, each naming the setting that
 * fixes it (#3510). Shown in Settings → Devices under the host's name. */
export const IOS_DISABLED_REASON = "iOS Simulator is off — set DEVICE_IOS_ENABLED=true.";
export const IOS_XCODE_REASON =
  "Xcode is not ready — install it, select it with xcode-select, finish its first launch and add an iOS runtime.";
export const IOS_COMPANION_UNSET_REASON =
  "idb_companion is not configured — set DEVICE_IDB_COMPANION_PATH to its path.";
export const IOS_COMPANION_NOT_EXECUTABLE_REASON =
  "idb_companion at DEVICE_IDB_COMPANION_PATH is missing or not executable.";

/** The platform cannot run iOS at all (not macOS): unavailable, with no reason to show. */
const IOS_UNSUPPORTED = Symbol("ios-unsupported");

/**
 * Why this host cannot run an iOS Simulator device right now, or null when it
 * can (#1943, #3510). All four must hold: the operator turned it on
 * (`DEVICE_IOS_ENABLED`), Xcode's simulator toolchain works here (the `xcode`
 * placement capability, reused rather than a new capability) and
 * `DEVICE_IDB_COMPANION_PATH` is an executable file — on a platform that
 * supports `ios-simulator` (macOS) at all. Off macOS the answer is
 * {@link IOS_UNSUPPORTED}: iOS is not a thing there, so there is nothing to fix.
 * Does not check the device panel; {@link localDeviceUnavailable} does.
 */
async function iosSimulatorUnavailableReason(
  app: FastifyInstance,
): Promise<string | typeof IOS_UNSUPPORTED | null> {
  // The demo instance has no Xcode; it reports iOS so its fixtures can be seen.
  if (app.config.MULLION_DEMO) return null;
  if (!isDeviceKindSupported("ios-simulator")) return IOS_UNSUPPORTED;
  if (!app.config.DEVICE_IOS_ENABLED) return IOS_DISABLED_REASON;
  if (!(await getCachedCapabilities(app)).includes("xcode")) return IOS_XCODE_REASON;
  const companion = app.config.DEVICE_IDB_COMPANION_PATH;
  if (!companion) return IOS_COMPANION_UNSET_REASON;
  try {
    if (!(await stat(companion)).isFile()) return IOS_COMPANION_NOT_EXECUTABLE_REASON;
    await access(companion, fsConstants.X_OK);
    return null;
  } catch {
    return IOS_COMPANION_NOT_EXECUTABLE_REASON;
  }
}

/** Whether this host can run an iOS Simulator device right now: see
 * {@link iosSimulatorUnavailableReason}, the one place the conditions live. */
export async function iosSimulatorAvailable(app: FastifyInstance): Promise<boolean> {
  return (await iosSimulatorUnavailableReason(app)) === null;
}

/** The device platforms this host can run right now: Android when any Android
 * kind is available, iOS when the simulator is. Empty when the panel is off. */
export async function localDevicePlatforms(app: FastifyInstance): Promise<DevicePlatform[]> {
  if (!app.devicePanelEnabled) return [];
  const platforms: DevicePlatform[] = [];
  if (localDeviceKinds(app).length > 0) platforms.push("android");
  if (await iosSimulatorAvailable(app)) platforms.push("ios");
  return platforms;
}

/** `{ unavailable }` to spread into a kinds answer, or nothing when there is no
 * reason: the key is omitted rather than sent empty. */
export function withUnavailable(unavailable: DeviceUnavailable | undefined): {
  unavailable?: DeviceUnavailable;
} {
  return unavailable && Object.keys(unavailable).length > 0 ? { unavailable } : {};
}

/** What this host can run, and why it does not offer a platform it could
 * (#3510): today only iOS, on a macOS host. One derivation feeds both
 * `platforms` and `unavailable`, so the iOS probe runs once per answer. No
 * reason is given when iOS is available, nor on a platform that cannot run it
 * at all — the platform is checked before the panel, so a Linux host with the
 * panel off reports nothing — nor on the demo instance. */
export interface LocalDeviceSupport {
  deviceKinds: DeviceKind[];
  platforms: DevicePlatform[];
  unavailable?: DeviceUnavailable;
}

export async function localDeviceSupport(app: FastifyInstance): Promise<LocalDeviceSupport> {
  const deviceKinds = localDeviceKinds(app);
  if (!app.devicePanelEnabled) {
    // The panel is the setting to change, and no probe runs while it is off.
    const iosPossible = !app.config.MULLION_DEMO && isDeviceKindSupported("ios-simulator");
    return {
      deviceKinds,
      platforms: [],
      ...(iosPossible ? { unavailable: { ios: app.devicePanelUnavailableMessage } } : {}),
    };
  }
  const reason = await iosSimulatorUnavailableReason(app);
  const platforms: DevicePlatform[] = [];
  if (deviceKinds.length > 0) platforms.push("android");
  if (reason === null) platforms.push("ios");
  return {
    deviceKinds,
    platforms,
    ...(typeof reason === "string" ? { unavailable: { ios: reason } } : {}),
  };
}
