import type { FastifyInstance } from "fastify";
import type { DeviceKind } from "./device-drivers/types.js";

/** The device kinds this host can run right now: what `features.deviceKinds`
 * reports for the primary's own host, and what a primary reads before it places
 * a device here. Empty when the panel is off. */
export function localDeviceKinds(app: FastifyInstance): DeviceKind[] {
  if (!app.devicePanelEnabled) return [];
  return app.deviceKinds.filter((kind) => kind !== "emulator" || app.deviceEmulatorEnabled);
}
