// Devices (Android emulator/phone panel) — CRUD + one-shot action
// execution. Split out the same way bridges.ts is: one file per backend
// route module (routes/devices.ts).
import { request } from "./client.js";
import type { Device } from "./types.js";

export const devicesApi = {
  listDevices: () => request<Device[]>("/api/devices"),

  getDevice: (id: number) => request<Device>(`/api/devices/${id}`),

  createDevice: (body: { avdName: string; projectId?: number; name?: string }) =>
    request<Device>("/api/devices", { method: "POST", body: JSON.stringify(body) }),

  // The `kind: "physical"` counterpart to createDevice — requires `address`
  // to already be paired (see pairDevice below); this is what actually
  // calls `adb connect`.
  connectPhysicalDevice: (body: { address: string; projectId?: number; name?: string }) =>
    request<Device>("/api/devices", {
      method: "POST",
      body: JSON.stringify({ kind: "physical", ...body }),
    }),

  // One-time `adb pair` against a phone's Wireless debugging pairing
  // address/code. Creates no device row — see routes/devices.ts's own
  // comment on why this is a separate, stateless endpoint.
  pairDevice: (body: { pairingAddress: string; pairingCode: string }) =>
    request<{ ok: true }>("/api/devices/pair", { method: "POST", body: JSON.stringify(body) }),

  terminateDevice: (id: number) => request<void>(`/api/devices/${id}`, { method: "DELETE" }),

  // Physical-only — edits a device's stored adb address in place and
  // reconnects against it, without losing the row's id/name/history. See
  // routes/devices.ts's own comment on why an emulator row rejects this.
  updateDeviceAddress: (id: number, address: string) =>
    request<Device>(`/api/devices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ address }),
    }),
};
