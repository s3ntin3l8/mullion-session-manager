// AVD (Android Virtual Device) provisioning — the counterpart to device.ts
// (which only RUNS an AVD that already exists on the host). Split out the
// same way device.ts is: one file per backend route module (routes/avds.ts).
import { request } from "./client.js";
import type { SystemImage } from "./types.js";

export const avdsApi = {
  listAvds: () => request<{ avds: string[] }>("/api/avds"),

  listSystemImages: () => request<{ systemImages: SystemImage[] }>("/api/system-images"),

  listDeviceProfiles: () => request<{ deviceProfiles: string[] }>("/api/device-profiles"),

  createAvd: (body: { name: string; systemImage: string; deviceProfile: string }) =>
    request<{ name: string }>("/api/avds", { method: "POST", body: JSON.stringify(body) }),
};
