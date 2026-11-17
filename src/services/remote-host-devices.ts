import { HostRequestError } from "./remote-host-errors.js";
import type {
  DeviceAction,
  DeviceActionResult,
  DeviceInfo,
  DeviceKind,
} from "./device-drivers/types.js";
import type {
  DeviceKindsResponse,
  DeviceSpawnSpec,
  DeviceWsQuery,
  LiveDevicesResponse,
  SpawnDeviceResponse,
} from "./device-wire.js";

// The `/internal/devices*` request builders of RemoteHostClient (issue #3200).
// Each takes the client's own `request` (bound), so every call still goes
// through RemoteHostTransport — signing, assertAllowedUrl and
// redirect:"manual" live there and nowhere in this file. The client's device
// methods stay one-line delegators, so no caller changes. Same split as
// remote-host-git.ts.

/** The client's `request`, bound. An omitted timeout means the client default. */
export type DeviceRequest = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

/** The agent's own budget for one of these calls is longer than the client's
 * 5 s default: `systemctl` / `ps` (5 s each) for the scope check, then an adb
 * `getDevices()` on the reattach path, and kill-escalation on a teardown. Giving
 * up at 5 s reports "unreachable" for a spawn or stop that did land, and the
 * port the agent allocated is never persisted (#3290). */
export const DEVICE_REQUEST_TIMEOUT_MS = 30_000;

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const devicePath = (id: string, op: string) => `/internal/devices/${encodeURIComponent(id)}/${op}`;

/** The device kinds this host can run, or null when the agent predates the
 * device routes (a 404), which a caller must tell apart from "none". */
export async function resolveDeviceKinds(request: DeviceRequest): Promise<DeviceKind[] | null> {
  try {
    return (await request<DeviceKindsResponse>("/internal/devices/kinds")).deviceKinds;
  } catch (err) {
    if (err instanceof HostRequestError && err.statusCode === 404) return null;
    throw err;
  }
}

export function spawnDevice(
  request: DeviceRequest,
  spec: DeviceSpawnSpec,
): Promise<SpawnDeviceResponse> {
  return request("/internal/devices", jsonPost(spec), DEVICE_REQUEST_TIMEOUT_MS);
}

export async function liveDevices(request: DeviceRequest): Promise<DeviceInfo[]> {
  return (await request<LiveDevicesResponse>("/internal/devices/live")).devices;
}

export async function terminateDevice(
  request: DeviceRequest,
  id: string,
  kind: DeviceKind,
): Promise<void> {
  await request(devicePath(id, "terminate"), jsonPost({ kind }), DEVICE_REQUEST_TIMEOUT_MS);
}

export function deviceAction(
  request: DeviceRequest,
  id: string,
  action: DeviceAction,
): Promise<DeviceActionResult> {
  return request(devicePath(id, "action"), jsonPost(action), DEVICE_REQUEST_TIMEOUT_MS);
}

/** The request target of an agent's `/internal/ws/device/:id`. */
export function deviceWsTarget(id: string, query: DeviceWsQuery): string {
  const params = new URLSearchParams({ kind: query.kind });
  for (const key of ["avdName", "serial", "label", "port"] as const) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return `/internal/ws/device/${encodeURIComponent(id)}?${params.toString()}`;
}
