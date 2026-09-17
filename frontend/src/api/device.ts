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

  terminateDevice: (id: number) => request<void>(`/api/devices/${id}`, { method: "DELETE" }),
};
