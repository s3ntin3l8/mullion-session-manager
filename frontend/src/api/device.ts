// Devices (Android emulator/phone panel) — CRUD + one-shot action
// execution. Split out the same way bridges.ts is: one file per backend
// route module (routes/devices.ts).
import { request } from "./client.js";
import type { Device, DiscoveredDevice, PairAndConnectBody } from "./types.js";

export const devicesApi = {
  listDevices: () => request<Device[]>("/api/devices"),

  getDevice: (id: number) => request<Device>(`/api/devices/${id}`),

  createDevice: (body: { avdName: string; projectId?: number; name?: string }) =>
    request<Device>("/api/devices", { method: "POST", body: JSON.stringify(body) }),

  // Issue #1378's mDNS snapshot of nearby phones in Wireless debugging mode.
  // Always a list — empty (never an error) when DEVICE_DISCOVERY_ENABLED is
  // off or nothing is in range.
  listDiscoveredDevices: () => request<DiscoveredDevice[]>("/api/devices/discovered"),

  // Atomic `adb pair` + `adb connect` + device-row insert (issue #1378) —
  // the single call behind PairDeviceDialog's "Pair & Connect" button. The
  // legacy two-step POST /api/devices/pair + POST /api/devices {kind:
  // "physical"} endpoints stay on the backend for the CLI only.
  pairAndConnectDevice: (body: PairAndConnectBody) =>
    request<Device>("/api/devices/pair-and-connect", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Stops the device but keeps its row (`status: "killed"`) so it can be
  // started again — the reversible half of the lifecycle. `deleteDevice`
  // below is the one that drops the row.
  stopDevice: (id: number) => request<void>(`/api/devices/${id}/stop`, { method: "POST" }),

  // Flips a stopped row back to `active` and makes sure something is
  // actually running behind it (spawn/reconnect/reattach — all inside
  // getOrCreate). Returns the refreshed row so a caller can read the new
  // `status`/`live` without a second GET.
  startDevice: (id: number) => request<Device>(`/api/devices/${id}/start`, { method: "POST" }),

  takeScreenshot: (id: number) =>
    request<{ screenshot: string }>(`/api/devices/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "screenshot" }),
    }),

  // Irreversible: tears the device down and removes its row. Distinct from
  // stopDevice by intent, not by effect — a stopped device is still listed,
  // a deleted one is gone from every surface. Named for DELETE on purpose:
  // the MCP client's own `terminateDevice` (src/mcp/client.mjs) maps to the
  // published `device.terminate` op, which is a STOP and keeps the row —
  // two same-named methods with opposite meanings in one product was the
  // trap this name avoids.
  deleteDevice: (id: number) => request<void>(`/api/devices/${id}`, { method: "DELETE" }),

  // Physical-only — edits a device's stored adb address in place and
  // reconnects against it, without losing the row's id/name/history. See
  // routes/devices.ts's own comment on why an emulator row rejects this.
  updateDeviceAddress: (id: number, address: string) =>
    request<Device>(`/api/devices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ address }),
    }),
};
