import type { FastifyInstance } from "fastify";
import { access, constants as fsConstants, stat } from "node:fs/promises";
import type { DeviceKind, DevicePlatform } from "./device-drivers/types.js";
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

/**
 * Whether this host can run an iOS Simulator device right now (#1943). All four
 * must hold: the platform supports `ios-simulator` (macOS), the operator turned
 * it on (`DEVICE_IOS_ENABLED`), Xcode's simulator toolchain works here (the
 * `xcode` placement capability, reused rather than a new capability) and
 * `DEVICE_IDB_COMPANION_PATH` is an executable file.
 */
export async function iosSimulatorAvailable(app: FastifyInstance): Promise<boolean> {
  // The demo instance has no Xcode; it reports iOS so its fixtures can be seen.
  if (app.config.MULLION_DEMO) return true;
  if (!isDeviceKindSupported("ios-simulator")) return false;
  if (!app.config.DEVICE_IOS_ENABLED) return false;
  if (!(await getCachedCapabilities(app)).includes("xcode")) return false;
  const companion = app.config.DEVICE_IDB_COMPANION_PATH;
  if (!companion) return false;
  try {
    if (!(await stat(companion)).isFile()) return false;
    await access(companion, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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
