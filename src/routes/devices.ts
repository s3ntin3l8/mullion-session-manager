import type { FastifyInstance } from "fastify";
import {
  deleteDeviceRow,
  findActiveIosOwner,
  findActivePhysicalOwner,
  getDeviceRow,
  insertDevice,
  listDeviceRows,
  setDeviceStatus,
  updateDeviceSerial,
  type DeviceRow,
} from "../services/device-store.js";
import type { DeviceInfo, DeviceKind } from "../services/device-manager.js";
import { isDeviceAction } from "../services/device-drivers/actions.js";
import { DeviceActionError } from "../services/device-drivers/types.js";
import type { DeviceAction, DevicePlatform } from "../services/device-drivers/types.js";
import {
  DevicePlacementError,
  getDeviceHost,
  liveInfoForRows,
  type DeviceHost,
} from "../services/device-host.js";
import { SimctlError } from "../services/ios-simulators.js";
import { getHostRow, listHosts, LOCAL_HOST_ID } from "../services/host-registry.js";
import { iosSimulatorAvailable, localDeviceKinds } from "../services/device-kinds.js";
import { resolveProjectHostId } from "../services/session-host.js";
import { HostRequestError } from "../services/remote-host-client.js";
import { forwardHostRequestError, replyHostUnreachable } from "../services/host-error-reply.js";
import type { FastifyReply } from "fastify";

// CRUD + one-shot action execution for devices (the `devices` DB table's
// own route — routes/device.ts, singular, is the separate live WS video/
// input route). Two distinct consumption modes, deliberately kept apart:
//
//   - The live WS panel (routes/device.ts) drives input through the scrcpy
//     control channel while a human/agent is actively watching the stream.
//   - `mullion device <verb>` (this route, via control-socket.ts's
//     "device.action" op) is request/response, plain `adb shell` commands
//     against Device.adbConnection (via the DeviceDriver seam,
//     services/device-drivers/) — works whether or not anyone has the
//     panel open, same "CLI doesn't need a live viewer" posture
//     browser-automation.ts's executeBrowserAction has for the Controllable
//     Browser feature.
//
// Same "DB row is intent, DeviceManager is live truth" merge every other
// route in this app applies to sessions/previews — see AGENTS.md's own
// "non-obvious session model" note.

interface DeviceListItem {
  id: number;
  hostId: string;
  projectId: number | null;
  name: string | null;
  platform: DevicePlatform;
  kind: DeviceKind;
  avdName: string | null;
  serial: string | null;
  /** The iOS Simulator's UDID; null for an Android device. */
  udid: string | null;
  status: "active" | "killed";
  createdAt: string;
  live: DeviceInfo | null;
  /** True when the device's host is an agent that did not answer, so `live`
   * is unknown rather than "not running" (#3200). Absent otherwise. */
  hostUnreachable?: true;
}

/** How long one host's kinds answer is reused by `GET /api/devices/hosts`, so a
 * Settings page that polls does not hit every agent each time. */
export const DEVICE_HOSTS_CACHE_MS = 10_000;
/** The longest one agent may take to answer before it counts as unreachable. */
export const DEVICE_HOSTS_TIMEOUT_MS = 5_000;

export interface DeviceHostEntry {
  hostId: string;
  name: string;
  status: "ok" | "unsupported" | "unreachable";
  deviceKinds: DeviceKind[];
}

type RemoteKindsAnswer = Pick<DeviceHostEntry, "status" | "deviceKinds">;

// Per app instance, so two apps in one process (tests) never share an answer.
// The cached value is the in-flight promise: concurrent callers share one
// request, and it never rejects (a failure is stored as "unreachable").
const deviceHostsCache = new WeakMap<
  FastifyInstance,
  Map<string, { at: number; answer: Promise<RemoteKindsAnswer> }>
>();

async function askRemoteKinds(app: FastifyInstance, hostId: string): Promise<RemoteKindsAnswer> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), DEVICE_HOSTS_TIMEOUT_MS);
    });
    const support = await Promise.race([getDeviceHost(app, hostId).kinds(), timeout]);
    return support === null
      ? { status: "unsupported", deviceKinds: [] }
      : { status: "ok", deviceKinds: support.deviceKinds };
  } catch {
    return { status: "unreachable", deviceKinds: [] };
  } finally {
    clearTimeout(timer);
  }
}

function cachedRemoteKinds(
  app: FastifyInstance,
  cache: Map<string, { at: number; answer: Promise<RemoteKindsAnswer> }>,
  hostId: string,
): Promise<RemoteKindsAnswer> {
  const now = Date.now();
  const hit = cache.get(hostId);
  if (hit && now - hit.at < DEVICE_HOSTS_CACHE_MS) return hit.answer;
  const answer = askRemoteKinds(app, hostId);
  cache.set(hostId, { at: now, answer });
  return answer;
}

/** Every host that could hold a device: the primary and each registered agent. */
async function listDeviceHosts(app: FastifyInstance): Promise<DeviceHostEntry[]> {
  const all = listHosts(app);
  const remotes = all.filter((host) => !host.isLocal && host.id !== LOCAL_HOST_ID);
  let cache = deviceHostsCache.get(app);
  if (!cache) deviceHostsCache.set(app, (cache = new Map()));
  // Forget a removed host's answer, so the map cannot grow without bound.
  const live = new Set(remotes.map((host) => host.id));
  for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  const perHostCache = cache;

  const remoteEntries = await Promise.all(
    remotes.map(async (host): Promise<DeviceHostEntry> => ({
      hostId: host.id,
      name: host.name,
      ...(await cachedRemoteKinds(app, perHostCache, host.id)),
    })),
  );
  const local = all.find((host) => host.isLocal || host.id === LOCAL_HOST_ID);
  return [
    {
      hostId: LOCAL_HOST_ID,
      name: local?.name ?? "Local",
      status: "ok",
      deviceKinds: localDeviceKinds(app),
    },
    ...remoteEntries,
  ];
}

function toListItem(
  row: DeviceRow,
  live: DeviceInfo | undefined,
  hostUnreachable = false,
): DeviceListItem {
  return {
    id: row.id,
    hostId: row.hostId,
    projectId: row.projectId,
    name: row.name,
    platform: row.platform,
    kind: row.kind,
    avdName: row.avdName,
    serial: row.serial,
    udid: row.udid,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    live: live ?? null,
    ...(hostUnreachable ? { hostUnreachable: true as const } : {}),
  };
}

/** Answers a failed device-host call: a local failure is the 400 it always was;
 * an agent's own refusal is forwarded with its status; a host that did not
 * answer is 503 (or 502 when the request may have landed). */
function replyDeviceError(reply: FastifyReply, host: DeviceHost, err: unknown, what: string) {
  if (host.isLocal || err instanceof DevicePlacementError) {
    return reply.badRequest(err instanceof Error ? err.message : String(err));
  }
  if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
  return replyHostUnreachable(reply, host.hostId, err, what);
}

/** The host a new device is placed on: the one asked for, else its project's,
 * else this one. Null when the asked-for host is not registered. */
function resolvePlacementHostId(
  app: FastifyInstance,
  requested: string | undefined,
  projectId: number | undefined,
): string | null {
  if (requested !== undefined) {
    if (requested === LOCAL_HOST_ID) return LOCAL_HOST_ID;
    return getHostRow(app, requested) ? requested : null;
  }
  return projectId === undefined ? LOCAL_HOST_ID : resolveProjectHostId(app, projectId);
}

/** Why a host cannot run a device of this kind, or null when it can. */
async function kindRefusal(host: DeviceHost, kind: DeviceKind): Promise<string | null> {
  const support = await host.kinds();
  if (support === null) {
    return `Host ${host.hostId} does not report device support — update its agent.`;
  }
  const kinds = support.deviceKinds;
  if (kinds.includes(kind)) return null;
  return kinds.length === 0
    ? `Host ${host.hostId} cannot run devices right now: its device panel is off (DEVICE_ENABLED=true) or its platform supports none.`
    : `Host ${host.hostId} cannot run ${kind} devices (it supports: ${kinds.join(", ")}).`;
}

const IOS_UNAVAILABLE_MESSAGE =
  "iOS Simulator is not available on this host (needs macOS with Xcode, DEVICE_IOS_ENABLED=true and DEVICE_IDB_COMPANION_PATH).";

/**
 * Creates an iOS Simulator device (#1943). Placement is checked before a row
 * exists: the host must report `ios` (an agent that predates the field would
 * strip it from the spawn and run its Android path), and the UDID must be one
 * of that host's own simulators. The duplicate check and the insert share one
 * synchronous stretch, after the awaits, so two requests cannot both pass it.
 */
async function createIosDevice(
  app: FastifyInstance,
  reply: FastifyReply,
  host: DeviceHost,
  input: { udid: string; projectId: number | undefined; name: string | undefined },
) {
  const { udid } = input;
  try {
    const support = await host.kinds();
    if (support === null) {
      return reply.badRequest(
        `Host ${host.hostId} does not report device support — update its agent.`,
      );
    }
    if (!support.platforms.includes("ios")) {
      // The panel being off is its own cause: say so, as the Android branch does.
      if (host.isLocal && !app.devicePanelEnabled) {
        return reply.badRequest(app.devicePanelUnavailableMessage);
      }
      return reply.badRequest(
        host.isLocal
          ? IOS_UNAVAILABLE_MESSAGE
          : `Host ${host.hostId} does not support iOS simulators (supported platforms: ${support.platforms.join(", ") || "none"}).`,
      );
    }
    const simulators = await host.simulators();
    if (simulators === null) {
      return reply.badRequest(
        `Host ${host.hostId} does not report simulator support — update its agent.`,
      );
    }
    if (!simulators.some((simulator) => simulator.udid === udid)) {
      return reply.badRequest(`Simulator ${udid} was not found on host ${host.hostId}`);
    }
  } catch (err) {
    if (err instanceof SimctlError) return reply.badGateway(err.message);
    if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
    return replyHostUnreachable(reply, host.hostId, err, "checking the host's simulators");
  }

  // Synchronous from here to the insert (better-sqlite3): no await between them.
  const existingActive = findActiveIosOwner(app, udid, host.hostId);
  if (existingActive) {
    return reply.conflict(`device ${existingActive.id} is already active for simulator ${udid}`);
  }
  const row = insertDevice(app, {
    kind: "emulator",
    platform: "ios",
    udid,
    avdName: null,
    serial: null,
    projectId: input.projectId ?? null,
    name: input.name ?? null,
    hostId: host.hostId,
  });

  let spawned;
  try {
    spawned = await host.getOrCreate(row);
  } catch (err) {
    return replyDeviceError(reply, host, err, "starting the device");
  }
  reply.code(201);
  return toListItem(getDeviceRow(app, row.id) ?? row, spawned.info);
}

// A physical device's adb TCP address, as both the one-time pairing address
// (`adb pair <host:port>`) and the ongoing connect address (`adb connect
// <host:port>`) — Android shows a DIFFERENT port for each, but both are the
// same "host:port" shape. Validated as an allowlist, not shell-escaped:
// DeviceManager.pair()/getOrCreate() pass this straight into
// AdbServerClient.wireless.pair()/connect(), which builds an adb SERVICE
// STRING (`host:pair:<password>:<address>`), not a shell command — a stray
// `:` or newline here corrupts that framing, so shellQuoteArg (in
// services/device-drivers/android.ts, used only for the on-device `adb shell`
// actions) is the wrong tool for
// this input.
const DEVICE_ADDRESS_PATTERN = /^([A-Za-z0-9.-]+):(\d{1,5})$/;

function isValidDeviceAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  const match = DEVICE_ADDRESS_PATTERN.exec(address);
  if (!match) return false;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535;
}

// The 6-digit code Android's Wireless debugging screen shows during
// pairing.
const PAIRING_CODE_PATTERN = /^\d{6}$/;

function isValidPairingCode(code: unknown): code is string {
  return typeof code === "string" && PAIRING_CODE_PATTERN.test(code);
}

interface CreateDeviceBody {
  kind?: DeviceKind;
  // Emulator form.
  avdName?: string;
  // Physical form — the adb connect address ("host:port").
  address?: string;
  projectId?: number;
  name?: string;
  /** The host to run the device on (#3200); defaults to the project's host. */
  hostId?: string;
  /** Which platform runs the device (#3202); defaults to "android". */
  platform?: DevicePlatform;
  /** An iOS Simulator's UDID; only for `platform: "ios"`. */
  udid?: string;
}

export async function devicesRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateDeviceBody }>("/api/devices", async (request, reply) => {
    const {
      kind = "emulator",
      avdName,
      address,
      projectId,
      name,
      hostId: requestedHostId,
      platform = "android",
      udid,
    } = request.body ?? {};
    // Validate before gating: an unknown kind would pass the physical-level
    // gate below and then fall through to the emulator path (and its row).
    if (kind !== "emulator" && kind !== "physical") {
      return reply.badRequest('kind must be "emulator" or "physical"');
    }
    if (platform !== "android" && platform !== "ios") {
      return reply.badRequest('platform must be "android" or "ios"');
    }
    // `kind`, `avdName` and `address` are adb concepts and `udid` is a
    // Simulator's: each platform takes only its own (#3202). A null `udid` is
    // not a value: the list item always returns `udid: null` for an Android
    // device, so a client re-posting a GET body must not be refused for it.
    if (platform === "android" && udid !== undefined && udid !== null) {
      return reply.badRequest("udid must not be set for an android device");
    }
    if (platform === "ios") {
      if (kind === "physical") {
        return reply.badRequest('kind "physical" is not valid for an ios device');
      }
      if (avdName !== undefined)
        return reply.badRequest("avdName must not be set for an ios device");
      if (address !== undefined)
        return reply.badRequest("address must not be set for an ios device");
      if (typeof udid !== "string" || udid.length === 0) {
        return reply.badRequest("udid is required for an ios device");
      }
    }
    const hostId = resolvePlacementHostId(app, requestedHostId, projectId);
    if (hostId === null) return reply.badRequest(`Unknown host ${requestedHostId}`);
    const host = getDeviceHost(app, hostId);
    if (platform === "ios") {
      return createIosDevice(app, reply, host, {
        udid: udid as string,
        projectId,
        name,
      });
    }
    // Gate on the KIND (issue #1854): physical works wherever the panel does,
    // an emulator additionally needs a platform device scope. A device placed
    // on an agent host is gated on what THAT host reports it can run (#3200),
    // before a row exists for something it cannot.
    if (host.isLocal) {
      if (kind === "emulator" ? !app.deviceEmulatorEnabled : !app.devicePanelEnabled) {
        return reply.badRequest(
          kind === "emulator"
            ? app.deviceEmulatorUnavailableMessage
            : app.devicePanelUnavailableMessage,
        );
      }
    } else {
      try {
        const refusal = await kindRefusal(host, kind);
        if (refusal) return reply.badRequest(refusal);
      } catch (err) {
        return replyDeviceError(reply, host, err, "checking the host's device support");
      }
    }

    if (kind === "physical") {
      if (avdName !== undefined) {
        return reply.badRequest("avdName must not be set for a physical device");
      }
      if (!isValidDeviceAddress(address)) {
        return reply.badRequest("address must be host:port (e.g. 192.168.1.23:37251)");
      }

      // Guard against two `devices` rows racing to own the same adb
      // address — Device.connectPhysical() deliberately treats
      // AlreadyConnectedError as success (needed for the restart-reattach
      // case, where the adb server already has this address connected from
      // before a Mullion restart), so a second insert for the same address
      // would otherwise succeed too and produce a second in-memory Device
      // independently pushing/starting its own scrcpy server against the
      // same live serial. Emulators get an equivalent guard for free via
      // allocatePort() (see readActiveDevicePorts()); physical devices have
      // no port to collide on, so this checks the address directly (per
      // host: an address names a phone on ONE host's network).
      // Synchronous, no `await` in between, and better-sqlite3 is
      // synchronous too — this check-then-insert can't interleave with
      // another request's.
      const existingActive = findActivePhysicalOwner(app, address, hostId);
      if (existingActive) {
        return reply.conflict(
          `device ${existingActive.id} is already active for address ${address}`,
        );
      }

      const row = insertDevice(app, {
        kind: "physical",
        serial: address,
        avdName: null,
        projectId: projectId ?? null,
        name: name ?? null,
        hostId,
      });

      // Same fire-and-forget-past-the-quick-check shape as the emulator
      // branch below — see that branch's own comment.
      let spawned;
      try {
        spawned = await host.getOrCreate(row);
      } catch (err) {
        return replyDeviceError(reply, host, err, "starting the device");
      }

      reply.code(201);
      return toListItem(getDeviceRow(app, row.id) ?? row, spawned.info);
    }

    if (address !== undefined) {
      return reply.badRequest("address must not be set for an emulator device");
    }
    if (!avdName) return reply.badRequest("avdName is required");

    const row = insertDevice(app, {
      kind: "emulator",
      avdName,
      serial: null,
      projectId: projectId ?? null,
      name: name ?? null,
      hostId,
    });

    // Only the isScopeAlive() pre-check inside getOrCreate is awaited
    // here — the emulator's actual boot is still fire-and-forget, same
    // shape as PtyManager.getOrCreate: the caller gets the row back once
    // that quick check clears, live status is polled via GET afterward
    // (or observed by connecting the WS route, which naturally blocks
    // until streaming or error).
    let spawned;
    try {
      spawned = await host.getOrCreate(row);
    } catch (err) {
      return replyDeviceError(reply, host, err, "starting the device");
    }

    reply.code(201);
    return toListItem(getDeviceRow(app, row.id) ?? row, spawned.info);
  });

  // Stateless — pairing writes a key into the adb SERVER's own keystore,
  // outside Mullion's ownership (see the schema's own comment on
  // `devices.kind`), so this creates no `devices` row. A separate
  // `POST /api/devices` call (kind: "physical") does the actual `adb
  // connect` afterward. Deliberately off the CRUD resource rather than a
  // sub-route of it, since it doesn't touch one.
  app.post<{ Body: { pairingAddress?: string; pairingCode?: string } }>(
    "/api/devices/pair",
    async (request, reply) => {
      if (!app.devicePanelEnabled) {
        return reply.badRequest(app.devicePanelUnavailableMessage);
      }
      const { pairingAddress, pairingCode } = request.body ?? {};
      if (!isValidDeviceAddress(pairingAddress)) {
        return reply.badRequest("pairingAddress must be host:port (e.g. 192.168.1.23:41234)");
      }
      if (!isValidPairingCode(pairingCode)) {
        return reply.badRequest("pairingCode must be the 6-digit code shown on the device");
      }
      try {
        await app.device.pair(pairingAddress, pairingCode);
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }
      reply.code(200);
      return { ok: true };
    },
  );

  // Atomic pair-then-connect-and-insert for the new "Pair a phone" modal
  // (issue #1378). The phone-discovery UX shows the user one button; behind
  // it, two adb wire-protocol calls plus a DB row insert. Exactly one of
  // `discoveryId` or `pairingAddress` is required — the former looks the
  // cached mDNS entry up for both pairing + connect addresses, the latter
  // is the manual fallback for networks where mDNS doesn't reach.
  //
  // `connectAddress` is REQUIRED when going the manual route (the user has
  // to type both ports, same as the legacy two-form flow, but in a single
  // POST). With a `discoveryId` it's optional — the cache normally has it,
  // and we only ask for it as a manual override if it doesn't.
  //
  // Same full-scope-only blast-radius reasoning as the existing
  // `device.pair` op (control-socket.ts:1100) — this dials an arbitrary
  // network address a caller supplies. The route itself does NOT gate on
  // scope; the control-socket handler does, when called via CLI/MCP.
  app.post<{
    Body: {
      discoveryId?: string;
      pairingAddress?: string;
      connectAddress?: string;
      pairingCode?: string;
      name?: string;
    };
  }>("/api/devices/pair-and-connect", async (request, reply) => {
    if (!app.devicePanelEnabled) {
      return reply.badRequest(app.devicePanelUnavailableMessage);
    }
    const { discoveryId, pairingAddress, connectAddress, pairingCode, name } = request.body ?? {};

    if (!isValidPairingCode(pairingCode)) {
      return reply.badRequest("pairingCode must be the 6-digit code shown on the device");
    }

    // Resolve the two adb addresses. `discoveryId` wins if both are set —
    // the cache is always fresher than what the user typed, and silently
    // mixing the two (e.g. typed pairing address + discovered connect
    // address for a DIFFERENT phone) would be a confusing failure mode.
    let resolvedPairing: string | undefined;
    let resolvedConnect: string | undefined;

    if (typeof discoveryId === "string" && discoveryId.length > 0) {
      const cached = app.deviceDiscovery.getById(discoveryId);
      if (!cached) {
        return reply.badRequest(
          `discoveryId ${JSON.stringify(discoveryId)} is no longer in the discovery cache — re-open the picker`,
        );
      }
      // DeviceManager.pair()'s own doc states "address/password are
      // validated by the route before this is reached" — that invariant
      // must hold on the cached branch too, not just the manual one below.
      // A poisoned cache entry (e.g. an IPv6 literal that slipped past
      // resolveHost, or a stale hostname:port that no longer parses) would
      // otherwise reach wireless.pair()'s `host:pair:<code>:<address>`
      // framing and corrupt it on the `:` separators. Evict so the next
      // picker open gets a fresh scan rather than the same bad data.
      if (cached.pairingAddress !== undefined && !isValidDeviceAddress(cached.pairingAddress)) {
        app.deviceDiscovery.evict(discoveryId);
        app.log.warn(
          { discoveryId, pairingAddress: cached.pairingAddress },
          "discovery cache contained an invalid pairingAddress — evicted",
        );
        return reply.badRequest(
          "discovery cache contains an invalid address — re-open the picker to refresh",
        );
      }
      if (cached.connectAddress !== undefined && !isValidDeviceAddress(cached.connectAddress)) {
        app.deviceDiscovery.evict(discoveryId);
        app.log.warn(
          { discoveryId, connectAddress: cached.connectAddress },
          "discovery cache contained an invalid connectAddress — evicted",
        );
        return reply.badRequest(
          "discovery cache contains an invalid address — re-open the picker to refresh",
        );
      }
      resolvedPairing = cached.pairingAddress;
      resolvedConnect = cached.connectAddress;
      // User-supplied `connectAddress` overrides the cached one — useful
      // when discovery sees the wrong port (e.g. mDNS reached a different
      // transport than the one Mullion's adb server can actually use).
      if (typeof connectAddress === "string" && connectAddress.length > 0) {
        if (!isValidDeviceAddress(connectAddress)) {
          return reply.badRequest("connectAddress must be host:port");
        }
        resolvedConnect = connectAddress;
      }
    } else if (typeof pairingAddress === "string" && pairingAddress.length > 0) {
      if (!isValidDeviceAddress(pairingAddress)) {
        return reply.badRequest("pairingAddress must be host:port (e.g. 192.168.1.23:41234)");
      }
      resolvedPairing = pairingAddress;
      if (!isValidDeviceAddress(connectAddress)) {
        return reply.badRequest(
          "connectAddress is required in manual mode — both Android's pairing port and connect port must be supplied",
        );
      }
      resolvedConnect = connectAddress;
    } else {
      return reply.badRequest("either discoveryId or pairingAddress is required");
    }

    if (!resolvedConnect) {
      return reply.badRequest(
        "this device's connect service was not advertised — supply connectAddress manually",
      );
    }

    // Address-collision guard — same reasoning as POST /api/devices's own
    // kind:"physical" branch above: two rows racing for the same serial
    // would each spin up their own scrcpy against the same live device,
    // since connectPhysical()'s AlreadyConnectedError handling is
    // correct-but-permissive for the restart-reattach case. The INSERT
    // below is synchronous (better-sqlite3) with no `await` between this
    // check and it, so a concurrent double-click can't interleave — the
    // second request finds the row and gets 409. Insert the row FIRST
    // (intent), then attempt pair(): if pair() fails the row stays (same
    // no-rollback posture as POST /api/devices), and the collision guard
    // remains airtight because there's still no `await` between check and
    // insert.
    const existingActive = findActivePhysicalOwner(app, resolvedConnect);
    if (existingActive) {
      return reply.conflict(
        `device ${existingActive.id} is already active for address ${resolvedConnect}`,
      );
    }

    const row = insertDevice(app, {
      kind: "physical",
      serial: resolvedConnect,
      avdName: null,
      projectId: null,
      name: name ?? null,
    });

    // Pairing is attempted UNLESS we have evidence the phone is NOT in
    // pairing mode: the discovery cache saw the connect service for this
    // host but never the pairing one. Android stops advertising the
    // pairing port the moment the user navigates off the "Pair device with
    // pairing code" screen, and again after a successful pair (the
    // keystore now has a key for this host, so re-pairing would fail
    // anyway). In both those cases skipping pair() and going straight to
    // connect is correct.
    //
    // In manual mode (`discoveryId` absent) we have no idea whether the
    // phone is in pairing mode — the modal's user just typed both ports —
    // so we always try pair() there. If it fails (wrong code, host
    // unreachable, port-closed-because-already-paired, etc.) we surface
    // the error directly; the modal renders it and the user can re-open
    // the phone's pairing screen and retry. We deliberately don't fall
    // through to a "blind connect" attempt on pair-failure: that hides the
    // most common user error (typo'd code) behind a different confusing
    // downstream error, and a fresh pair attempt is cheap.
    //
    // `resolvedPairing` is `string | undefined` because it can be unset in
    // the cached connect-only case, but we only reach the pair() call when
    // it's been validated upstream — the narrowing is per-branch:
    const skipPairBecauseCachedConnectOnly =
      resolvedPairing === undefined && typeof discoveryId === "string" && discoveryId.length > 0;
    if (!skipPairBecauseCachedConnectOnly) {
      // Both branches leading here guarantee a pairing address:
      //   - manual mode → resolvedPairing came from the user's
      //     `pairingAddress` (validated at the top of this handler)
      //   - discovery mode with a pairing service → resolvedPairing came
      //     from the cache's `pairingAddress`, which was validated by
      //     isValidDeviceAddress above before being assigned.
      try {
        await app.device.pair(resolvedPairing as string, pairingCode);
      } catch (err) {
        // Roll back the row we just inserted: a wrong code is the most
        // common failure (typo) and the user will immediately retry —
        // leaving the row would make that retry hit the collision guard
        // with a confusing 409 instead of re-attempting pair(). The
        // delete is synchronous; by the time pair() has rejected, any
        // concurrent request has already either received 409 (the row
        // existed when its synchronous guard ran) or inserted its own row
        // before ours landed — either way this delete only removes OUR
        // row and doesn't reopen the race the insert-before-pair ordering
        // closed.
        deleteDeviceRow(app, row.id);
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }
    }

    // Fire-and-forget past getOrCreate's synchronous guards (assertEnabled /
    // serial===null — both already ruled out by this handler): the physical
    // branch returns as soon as the Device is constructed, before
    // connectPhysical() settles, so a connect failure never rejects here
    // and must not be reported as 400. Callers get 201 + the row and learn
    // about a failed connect from the device's own `status`/`error`.
    await app.device.getOrCreate({
      id: String(row.id),
      kind: "physical",
      avdName: null,
      serial: resolvedConnect,
      label: row.name,
      port: null,
    });

    reply.code(201);
    return toListItem(row, app.device.get(String(row.id))?.toInfo());
  });

  app.get("/api/devices", async () => {
    const rows = listDeviceRows(app);
    // One request per agent host, and a host that is down marks ITS devices
    // unreachable instead of failing the whole list (#3200).
    const lives = await liveInfoForRows(app, rows);
    return rows.map((row) => {
      const found = lives.get(row.id);
      return toListItem(row, found?.live, found?.unreachable);
    });
  });

  // Which hosts could hold a device, and of what kind (#3270). Registered
  // before `/api/devices/:id`. A down agent is an "unreachable" entry, never a
  // 5xx for the whole answer.
  app.get("/api/devices/hosts", async () => listDeviceHosts(app));

  // Issue #1378 — read-only mDNS snapshot of nearby Android phones that
  // are currently advertising `_adb-tls-pairing._tcp` and/or
  // `_adb-tls-connect._tcp`. Empty array when discovery is disabled or
  // nothing is in range — never an error, so a disabled-discovery deploy
  // can still render the empty-list UI cleanly. Returned alongside the
  // matching connect address when both are known, so the modal can offer
  // a single-click "Pair & Connect" without re-fetching.
  app.get("/api/devices/discovered", async () => {
    if (!app.bootDeviceDiscoveryEnabled) return [];
    return app.deviceDiscovery.getDiscovered();
  });

  app.get<{ Querystring: { hostId?: string } }>("/api/simulators", async (request, reply) => {
    const requestedHostId = request.query?.hostId;
    const hostId = requestedHostId && requestedHostId.length > 0 ? requestedHostId : LOCAL_HOST_ID;
    if (hostId !== LOCAL_HOST_ID && !getHostRow(app, hostId)) {
      return reply.badRequest(`Unknown host ${hostId}`);
    }
    const host = getDeviceHost(app, hostId);
    try {
      const support = await host.kinds();
      if (support === null) {
        return reply.badRequest(
          `Host ${host.hostId} does not report device support — update its agent.`,
        );
      }
      if (!support.platforms.includes("ios")) {
        return reply.badRequest(
          `Host ${host.hostId} does not support iOS simulators (supported platforms: ${support.platforms.join(", ") || "none"}).`,
        );
      }
      const simulators = await host.simulators();
      if (simulators === null) {
        return reply.badRequest(
          `Host ${host.hostId} does not report simulator support — update its agent.`,
        );
      }
      return simulators;
    } catch (err) {
      if (err instanceof SimctlError) return reply.badGateway(err.message);
      if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
      return replyHostUnreachable(reply, host.hostId, err, "listing iOS simulators");
    }
  });

  app.get<{ Params: { id: string } }>("/api/devices/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
    const row = getDeviceRow(app, id);
    if (!row) return reply.notFound(`No device ${id}`);
    const found = (await liveInfoForRows(app, [row])).get(row.id);
    return toListItem(row, found?.live, found?.unreachable);
  });

  // Edits a physical device's stored adb address in place — issue #1347,
  // the follow-up to the v1 wireless-debugging support (kind: "physical"
  // above): Android randomizes the wireless-debugging port every time the
  // toggle is cycled, and a reboot drops the connection entirely, so the
  // persisted `serial` routinely goes stale. Without this, the only fix was
  // delete-and-recreate, losing the row's `id`/history. Physical only — an
  // emulator's `serial` is synthesized (`emulator-<port>`) from its own
  // `port` column, not user-supplied, so there is nothing here for an
  // emulator row to edit.
  app.patch<{ Params: { id: string }; Body: { address?: string } }>(
    "/api/devices/:id",
    async (request, reply) => {
      if (!app.devicePanelEnabled) {
        return reply.badRequest(app.devicePanelUnavailableMessage);
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
      const row = getDeviceRow(app, id);
      if (!row) return reply.notFound(`No device ${id}`);
      if (row.kind !== "physical") {
        return reply.badRequest("only a physical device's address can be edited");
      }
      const host = getDeviceHost(app, row.hostId);
      const { address } = request.body ?? {};
      if (!isValidDeviceAddress(address)) {
        return reply.badRequest("address must be host:port (e.g. 192.168.1.23:37251)");
      }

      // Same guard POST's create path applies (issue #1350), on the same
      // "an adb address is a single live connection, not a label" reasoning:
      // without it this PATCH can repoint a row at an address some OTHER
      // active row already owns, leaving two rows claiming one phone — the
      // second one to connect would push a competing scrcpy session against
      // the same serial. Only ACTIVE rows are checked, so re-using the
      // address of a stopped row stays allowed (POST's own rule — one at a
      // time can hold it, which is what makes stop/start on two rows for
      // one phone work at all). Synchronous, no `await` in between, and
      // better-sqlite3 is synchronous too — this check-then-write can't
      // interleave with another request's.
      const owner = findActivePhysicalOwner(app, address, row.hostId);
      if (owner && owner.id !== id) {
        return reply.conflict(`device ${owner.id} is already active for address ${address}`);
      }

      // Row records intent BEFORE the reconnect below — same ordering
      // DELETE uses (see its own comment) — and is never rolled back if the
      // reconnect fails: a transient adb hiccup must not discard the user's
      // edit, same reasoning Device.attach()'s own comment gives for why a
      // connection failure there doesn't tear down what it didn't create.
      const updated = updateDeviceSerial(app, id, address);

      // A STOPPED row's edit persists only — no terminate(), no
      // getOrCreate(). Editing a phone's stale address is exactly what you
      // do while it's down (the port rotated, the reboot dropped it), and
      // silently booting/reconnecting it here would start a device the user
      // deliberately stopped. `POST /api/devices/:id/start` is the explicit
      // next step; the sidebar/Settings Start button and the device panel's
      // own Start affordance both route through it.
      if (updated.status !== "active") {
        return toListItem(updated, undefined);
      }

      // The existing live Device (if any) is still connected at the OLD,
      // now-stale address — getOrCreate() below is a no-op against it
      // (existing.isAlive is true for "booting"/"streaming", same guard
      // POST's create path relies on), so it must be torn down first or
      // this PATCH would silently persist the new address while leaving
      // the live connection pointed at the dead one. terminate() never
      // touches the DB row (only the in-memory map), so `updated.status`
      // stays "active" throughout.
      try {
        await host.terminate(id, "physical");
      } catch (err) {
        // A failed LOCAL teardown has always surfaced as a 500 (not caught); an
        // agent's failure is answered like any other host error.
        if (host.isLocal) throw err;
        return replyDeviceError(reply, host, err, "reconnecting the device");
      }
      let spawned;
      try {
        spawned = await host.getOrCreate(updated);
      } catch (err) {
        return replyDeviceError(reply, host, err, "reconnecting the device");
      }

      return toListItem(updated, spawned.info);
    },
  );

  // Explicit "make sure this device is running" — the reverse of stop, and
  // the one path that flips a row's status BACK from "killed" to "active"
  // (an emulator's spawn, a physical row's adb reconnect, or a reattach to
  // a restart-surviving scope all live inside getOrCreate()). Deliberately
  // its own endpoint rather than folded into the WS panel's connect path:
  // the panel opening on a stopped device (usePanelOpener's start-then-open),
  // a Start click in the sidebar/Settings, and an agent running `mullion
  // device start` all funnel through here, but only the last two ever want
  // to start a device with no viewer attached.
  // Unlike /stop and DELETE below (both deliberately unguarded, same as
  // DELETE always was), this one IS gated on DEVICE_ENABLED: starting is
  // the only lifecycle verb that brings a device UP, so it's the same
  // operation — and the same "the server's own 400 message is the disabled-
  // state UI" posture — as POST /api/devices creating one. Tearing a device
  // down must keep working while the feature is off.
  app.post<{ Params: { id: string } }>("/api/devices/:id/start", async (request, reply) => {
    // The local gates are this host's own config; a device on an agent host is
    // gated by that agent when the spawn reaches it (#3200).
    const id = Number(request.params.id);
    const row = Number.isInteger(id) ? getDeviceRow(app, id) : undefined;
    if (!app.devicePanelEnabled && (!row || row.hostId === LOCAL_HOST_ID)) {
      return reply.badRequest(app.devicePanelUnavailableMessage);
    }
    if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
    if (!row) return reply.notFound(`No device ${id}`);
    const host = getDeviceHost(app, row.hostId);
    // An iOS row is gated by iOS availability, never by the Android emulator gate.
    if (host.isLocal && row.platform === "ios") {
      if (!(await iosSimulatorAvailable(app))) return reply.badRequest(IOS_UNAVAILABLE_MESSAGE);
    } else if (host.isLocal && row.kind !== "physical" && !app.deviceEmulatorEnabled) {
      return reply.badRequest(app.deviceEmulatorUnavailableMessage);
    }

    // The "at most one ACTIVE physical row per adb address" guard (#1350)
    // that POST create, pair-and-connect, and PATCH below all apply — start
    // is the one write path left that flips a row back to active, so without
    // this the exact sequence Hermes flagged was possible: stop row A, add
    // row B at A's address (allowed — only ACTIVE rows are checked), then
    // Start A. Both rows end up active at one serial, and connectPhysical()
    // treats AlreadyConnectedError as success, so the loser quietly runs a
    // competing scrcpy session. Same synchronous check-then-write shape as
    // PATCH's own copy — no `await` between the select and the update below,
    // so it can't interleave with another request's.
    if (row.kind === "physical" && row.serial !== null) {
      const owner = findActivePhysicalOwner(app, row.serial, row.hostId);
      if (owner && owner.id !== id) {
        return reply.conflict(`device ${owner.id} is already active for address ${row.serial}`);
      }
    }

    // The iOS counterpart of the guard above: one ACTIVE row per simulator on a
    // host, or two companions would fight over its HID connection.
    if (row.platform === "ios" && row.udid !== null) {
      const owner = findActiveIosOwner(app, row.udid, row.hostId);
      if (owner && owner.id !== id) {
        return reply.conflict(`device ${owner.id} is already active for simulator ${row.udid}`);
      }
    }

    // Record intent BEFORE awaiting getOrCreate, same TOCTOU-avoidance
    // ordering DELETE/stop use: a WS connect landing while we're still
    // starting must see an "active" row and attach, not reject on "killed".
    const wasKilled = row.status !== "active";
    setDeviceStatus(app, id, "active");

    let spawned;
    try {
      spawned = await host.getOrCreate(row);
    } catch (err) {
      // A synchronously-rejected start (a scope left over from before a
      // restart with no persisted port, a confirmed-gone emulator) must not
      // strand the row as "active" with nothing running behind it — that
      // would hide the Stop button the user needs to recover. Only rows
      // that were stopped get their status reverted: a row that was already
      // active keeps POST's own create-path posture (its live status/error
      // reports the failure from here on).
      //
      // Deliberately covers only the SYNCHRONOUS half. A physical row's
      // connect failure never lands here: getOrCreate() resolves as soon as
      // it has kicked connectPhysical() off (fire-and-forget, see
      // device-manager.ts), so a wasKilled physical row ends up "active"
      // with the error on its live state instead of reverting — exactly the
      // posture POST /api/devices already has for a physical create (see its
      // own comment), so the two agree rather than start/stop behaving
      // differently from create for the same phone.
      if (wasKilled) {
        setDeviceStatus(app, id, "killed");
      }
      return replyDeviceError(reply, host, err, "starting the device");
    }

    // Re-read AFTER the await: getOrCreate() awaits isScopeAlive()/
    // allocatePort() before it resolves (an emulator row additionally kicks
    // spawn() off), and that window is enough for a whole DELETE or /stop to
    // land — the two endpoints that used to leave a ghost scope behind a row
    // this handler has just flipped. Both lose here, deliberately (the later
    // write wins): a scope spawned against a row that no longer exists has
    // no handle left to ever stop it, and a scope spawned behind a "killed"
    // row would be invisible state.
    const fresh = getDeviceRow(app, id);
    if (!fresh) {
      // DELETE won: the row identifying the scope we just made is gone, so
      // tear the scope down rather than orphan it, then report what the API
      // now says about this id.
      await host.terminate(id, row.kind, row.platform).catch((err) => {
        app.log.warn({ err, deviceId: id }, "start: row deleted mid-start; teardown failed");
      });
      return reply.notFound(`No device ${id}`);
    }
    if (fresh.status !== "active") {
      // /stop won: roll back what we just brought up so the stopped row the
      // caller asked for stays stopped (a Stop click racing a Start click is
      // a normal thing for the sidebar's two buttons to do).
      await host.terminate(id, row.kind, row.platform).catch((err) => {
        app.log.warn({ err, deviceId: id }, "start: row stopped mid-start; rollback failed");
      });
      return reply.conflict("device was stopped while starting");
    }

    return toListItem(fresh, spawned.info);
  });

  // Stops a device WITHOUT discarding its row — what `mullion device stop`,
  // `device.terminate`, and the sidebar/Settings Stop button all do. The row
  // stays (status "killed") so it can be started again, its address edited,
  // and its final state read; `DELETE` below is the irreversible remove.
  app.post<{ Params: { id: string } }>("/api/devices/:id/stop", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
    const row = getDeviceRow(app, id);
    if (!row) return reply.notFound(`No device ${id}`);

    // Flip intent BEFORE awaiting the live teardown — same TOCTOU-avoidance
    // shape session-lifecycle.ts's killSession uses (see its own comment):
    // a concurrent WS connect that lands mid-terminate must see "killed",
    // not a stale "active" row.
    setDeviceStatus(app, id, "killed");

    // Deliberately NOT swallowed: a failed teardown leaves the row "killed"
    // (retryable — it's still the only handle to a possibly-surviving
    // scope), and the caller gets the failure instead of a silent success.
    const host = getDeviceHost(app, row.hostId);
    try {
      await host.terminate(id, row.kind, row.platform);
    } catch (err) {
      // A local failure is thrown (a 500) as it always was; an agent's is
      // answered as that host's error (a 503 when it did not answer).
      if (host.isLocal) throw err;
      return replyDeviceError(reply, host, err, "stopping the device");
    }

    reply.code(204);
  });

  // Removes the row outright. Two phases, deliberately: stop first (same
  // ordering + TOCTOU reasoning as /stop above), THEN delete. A teardown
  // that throws must not discard the row — the `devices` row is what
  // identifies the systemd scope (`crs-device-<instanceId>-<id>.scope`) if
  // it's still running, so deleting it first would strand a live emulator
  // with no API path left to ever stop it (device-manager.ts's terminate()
  // doc comment describes exactly that failure). Hence 500 + row kept on
  // failure, 204 + row gone on success.
  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
    const row = getDeviceRow(app, id);
    if (!row) return reply.notFound(`No device ${id}`);

    setDeviceStatus(app, id, "killed");

    const host = getDeviceHost(app, row.hostId);
    try {
      await host.terminate(id, row.kind, row.platform);
    } catch (err) {
      app.log.warn({ err, deviceId: id }, "device delete: teardown failed, keeping the row");
      if (!host.isLocal) return replyDeviceError(reply, host, err, "deleting the device");
      return reply.internalServerError(
        err instanceof Error ? err.message : "could not tear down this device",
      );
    }

    deleteDeviceRow(app, id);

    reply.code(204);
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/devices/:id/action",
    async (request, reply) => {
      const id = Number(request.params.id);
      const row = Number.isInteger(id) ? getDeviceRow(app, id) : undefined;
      // The panel gate is this host's own config; a device on an agent host is
      // gated by that agent (#3200). "Regardless of row existence" stays true
      // for the local gate.
      if (!app.devicePanelEnabled && (!row || row.hostId === LOCAL_HOST_ID)) {
        return reply.badRequest(app.devicePanelUnavailableMessage);
      }
      if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
      if (!row) return reply.notFound(`No device ${id}`);
      if (!isDeviceAction(request.body)) return reply.badRequest("invalid action body");

      const host = getDeviceHost(app, row.hostId);
      const action: DeviceAction = request.body;
      try {
        return await host.action(id, action);
      } catch (err) {
        // A driver's own "clear status" failures (no live connection, bad
        // screenshot, unsupported action) answer as that status; anything
        // else is unexpected and stays a 500 — unless it came from an agent,
        // whose refusal is forwarded and whose silence is a 503.
        if (err instanceof DeviceActionError) {
          return reply.send(app.httpErrors.createError(err.statusCode, err.message));
        }
        if (!host.isLocal) return replyDeviceError(reply, host, err, "running the device action");
        throw err;
      }
    },
  );
}
