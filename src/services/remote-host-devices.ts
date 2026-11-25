import type { WebSocket as NodeWebSocket } from "ws";
import type { AgentChannelStreamKind } from "../shared/agent-channel.js";
import { HostRequestError } from "./remote-host-errors.js";
import type {
  DeviceAction,
  DeviceActionResult,
  DeviceKind,
  DevicePlatform,
} from "./device-drivers/types.js";
import type {
  CreateSimulatorRequest,
  CreateSimulatorResponse,
  DeviceKindsResponse,
  DevicePairResponse,
  DeviceSpawnSpec,
  DeviceWsQuery,
  DiscoveredDevicesResponse,
  LiveDevicesResponse,
  SimulatorsResponse,
  SpawnDeviceResponse,
} from "./device-wire.js";
import type { DiscoveredDevice } from "./device-discovery.js";
import type { IosSimulator, SimulatorCatalog } from "./ios-simulators.js";
import type { DeviceUnavailable } from "../shared/types.js";

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
  /** Absent when the host reports no reason (or predates the field, #3510). */
  unavailable?: DeviceUnavailable;
}

/** The client's `request`, bound. An omitted timeout means the client default. */
export type DeviceRequest = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;

export interface DevicesClientDeps {
  request: DeviceRequest;
  openInbound: (requestTarget: string) => NodeWebSocket;
  /**
   * The outbound-channel stream opener (#2571) — null when this host is
   * reached inbound (a legacy peer), and a refusal (not a fallback) when its
   * channel is down.
   */
  openChannel: (
    kind: AgentChannelStreamKind,
    identity: string,
    query?: Record<string, string>,
  ) => NodeWebSocket | null;
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
  for (const key of ["avdName", "serial", "label", "port", "platform", "udid"] as const) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return `/internal/ws/device/${encodeURIComponent(id)}?${params.toString()}`;
}

/** The open head's query for a `device` stream: the route's query plus the
 * `id` the route takes from its path. */
function deviceStreamQuery(id: string, query: DeviceWsQuery): Record<string, string> {
  return {
    id,
    kind: query.kind,
    ...(query.avdName !== undefined ? { avdName: query.avdName } : {}),
    ...(query.serial !== undefined ? { serial: query.serial } : {}),
    ...(query.label !== undefined ? { label: query.label } : {}),
    ...(query.port !== undefined ? { port: query.port } : {}),
    ...(query.platform !== undefined ? { platform: query.platform } : {}),
    ...(query.udid !== undefined ? { udid: query.udid } : {}),
  };
}

export function createDevicesClient({ request, openInbound, openChannel }: DevicesClientDeps) {
  return {
    /** The device kinds and platforms this host can run, or null when the agent
     * predates the device routes (a 404), which a caller must tell apart from
     * "none". An agent that omits `platforms` is Android-only. */
    async kinds(): Promise<HostDeviceSupport | null> {
      try {
        const res = await request<DeviceKindsResponse>("/internal/devices/kinds");
        const ios = res.unavailable?.ios;
        return {
          deviceKinds: res.deviceKinds,
          platforms: res.platforms ?? (res.deviceKinds.length > 0 ? ["android"] : []),
          // Only a string is passed on: an agent's answer is not trusted to be well formed.
          ...(typeof ios === "string" && ios !== "" ? { unavailable: { ios } } : {}),
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

    live(): Promise<LiveDevicesResponse> {
      return request<LiveDevicesResponse>("/internal/devices/live");
    },

    async discovered(): Promise<DiscoveredDevice[]> {
      return (await request<DiscoveredDevicesResponse>("/internal/devices/discovered")).devices;
    },

    async pair(pairingAddress: string, pairingCode: string): Promise<void> {
      await request<DevicePairResponse>(
        "/internal/devices/pair",
        jsonPost({ pairingAddress, pairingCode }),
        DEVICE_REQUEST_TIMEOUT_MS,
      );
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

    /** Device types and iOS runtimes a simulator can be created from, or null when
     * the agent predates `GET /internal/simulators/catalog` (a 404). */
    async simulatorCatalog(): Promise<SimulatorCatalog | null> {
      try {
        return await request<SimulatorCatalog>(
          "/internal/simulators/catalog",
          undefined,
          DEVICE_REQUEST_TIMEOUT_MS,
        );
      } catch (err) {
        if (err instanceof HostRequestError && err.statusCode === 404) return null;
        throw err;
      }
    },

    /** Creates a simulator on the agent; null when the agent predates the route. */
    async createSimulator(input: CreateSimulatorRequest): Promise<IosSimulator | null> {
      try {
        return (
          await request<CreateSimulatorResponse>(
            "/internal/simulators",
            jsonPost(input),
            DEVICE_REQUEST_TIMEOUT_MS,
          )
        ).simulator;
      } catch (err) {
        if (err instanceof HostRequestError && err.statusCode === 404) return null;
        throw err;
      }
    },

    async terminate(
      id: string,
      kind: DeviceKind,
      platform: DevicePlatform = "android",
    ): Promise<void> {
      // `platform` rides only for a non-Android device, so an Android teardown is
      // byte-for-byte what an agent that predates the field already accepts.
      await request(
        devicePath(id, "terminate"),
        jsonPost(platform === "android" ? { kind } : { kind, platform }),
        DEVICE_REQUEST_TIMEOUT_MS,
      );
    },

    action(id: string, action: DeviceAction): Promise<DeviceActionResult> {
      return request(devicePath(id, "action"), jsonPost(action), DEVICE_REQUEST_TIMEOUT_MS);
    },

    /** The device panel's video/input socket on this host. Over the host's
     * outbound channel when it negotiated `channel-streams` (#3273); the
     * inbound transport for a legacy peer, and a refusal (never a fallback)
     * when a channel-bound host's channel is down. */
    openSocket(id: string, query: DeviceWsQuery): NodeWebSocket {
      const viaChannel = openChannel("device", id, deviceStreamQuery(id, query));
      if (viaChannel) return viaChannel;
      return openInbound(deviceWsTarget(id, query));
    },
  };
}

export type DevicesClient = ReturnType<typeof createDevicesClient>;
