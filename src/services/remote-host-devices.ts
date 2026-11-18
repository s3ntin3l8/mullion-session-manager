import type { WebSocket as NodeWebSocket } from "ws";
import { HostRequestError } from "./remote-host-errors.js";
import type {
  DeviceAction,
  DeviceActionResult,
  DeviceInfo,
  DeviceKind,
  DevicePlatform,
} from "./device-drivers/types.js";
import type {
  DeviceKindsResponse,
  DeviceSpawnSpec,
  DeviceWsQuery,
  LiveDevicesResponse,
  SimulatorsResponse,
  SpawnDeviceResponse,
} from "./device-wire.js";
import type { IosSimulator } from "./ios-simulators.js";

// RemoteHostClient facet convention (issue #3289 / #3301):
// - Each domain lives in `src/services/remote-host-<domain>.ts` and exports a
//   `create<Domain>Client({ request, openInbound })` factory (omit `openInbound`
//   if the domain has no WebSocket routes). `request` and `openInbound` are
//   bound on RemoteHostClient so every call still goes through
//   RemoteHostTransport (signing, assertAllowedUrl, redirect:"manual").
// - Facet methods drop the domain prefix (e.g. `devices.spawn(spec)`,
//   `devices.openSocket(id, query)` instead of `spawnDevice` / `openDeviceWs`).
// - RemoteHostClient exposes one `readonly <domain> = create<Domain>Client(...)`
//   property and no delegating methods on the core class.

/** What a host can run: the Android kinds and the device platforms. */
export interface HostDeviceSupport {
  deviceKinds: DeviceKind[];
  platforms: DevicePlatform[];
}

/** The client's `request`, bound. An omitted timeout means the client default. */
export type DeviceRequest = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

export interface DevicesClientDeps {
  request: DeviceRequest;
  openInbound: (requestTarget: string) => NodeWebSocket;
}

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

/** The request target of an agent's `/internal/ws/device/:id`. */
function deviceWsTarget(id: string, query: DeviceWsQuery): string {
  const params = new URLSearchParams({ kind: query.kind });
  for (const key of ["avdName", "serial", "label", "port"] as const) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return `/internal/ws/device/${encodeURIComponent(id)}?${params.toString()}`;
}

export function createDevicesClient({ request, openInbound }: DevicesClientDeps) {
  return {
    /** The device kinds and platforms this host can run, or null when the agent
     * predates the device routes (a 404), which a caller must tell apart from
     * "none". An agent that omits `platforms` is Android-only. */
    async kinds(): Promise<HostDeviceSupport | null> {
      try {
        const res = await request<DeviceKindsResponse>("/internal/devices/kinds");
        return {
          deviceKinds: res.deviceKinds,
          platforms: res.platforms ?? (res.deviceKinds.length > 0 ? ["android"] : []),
        };
      } catch (err) {
        if (err instanceof HostRequestError && err.statusCode === 404) return null;
        throw err;
      }
    },

    /** Get-or-create one device on this host (idempotent; routes/internal-devices.ts). */
    spawn(spec: DeviceSpawnSpec): Promise<SpawnDeviceResponse> {
      return request("/internal/devices", jsonPost(spec), DEVICE_REQUEST_TIMEOUT_MS);
    },

    async live(): Promise<DeviceInfo[]> {
      return (await request<LiveDevicesResponse>("/internal/devices/live")).devices;
    },

    /** Available iOS simulators on this host, or null when the agent predates
     * `GET /internal/simulators` (a 404). */
    async simulators(): Promise<IosSimulator[] | null> {
      try {
        return (
          await request<SimulatorsResponse>(
            "/internal/simulators",
            undefined,
            DEVICE_REQUEST_TIMEOUT_MS,
          )
        ).simulators;
      } catch (err) {
        if (err instanceof HostRequestError && err.statusCode === 404) return null;
        throw err;
      }
    },

    async terminate(id: string, kind: DeviceKind): Promise<void> {
      await request(devicePath(id, "terminate"), jsonPost({ kind }), DEVICE_REQUEST_TIMEOUT_MS);
    },

    action(id: string, action: DeviceAction): Promise<DeviceActionResult> {
      return request(devicePath(id, "action"), jsonPost(action), DEVICE_REQUEST_TIMEOUT_MS);
    },

    /** The device panel's video/input socket on this host. Always the inbound
     * transport for now: an agent reached only over the outbound channel has no
     * device stream kind yet (#3273). */
    openSocket(id: string, query: DeviceWsQuery): NodeWebSocket {
      return openInbound(deviceWsTarget(id, query));
    },
  };
}

export type DevicesClient = ReturnType<typeof createDevicesClient>;
