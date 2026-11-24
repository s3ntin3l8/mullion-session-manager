import type { FastifyInstance, FastifyReply } from "fastify";
import { attachSocketToDevice } from "../services/device-attach.js";
import { deviceQueryError, deviceStreamParams } from "../services/internal-streams.js";
import { DEVICE_PAIR_RATE_LIMIT } from "./internal-rate-limits.js";
import {
  DEVICE_ID_PARAMS_SCHEMA,
  DEVICE_PAIR_SCHEMA,
  DEVICE_SPAWN_SCHEMA,
  SIMULATOR_CREATE_SCHEMA,
  DEVICE_TERMINATE_SCHEMA,
} from "./internal-schemas.js";
import { isValidDeviceAddress, isValidPairingCode } from "../services/device-address.js";
import {
  iosSimulatorAvailable,
  localDeviceKinds,
  physicalDeviceEnabled,
  physicalDeviceUnavailableMessage,
  localDevicePlatforms,
} from "../services/device-kinds.js";
import {
  createIosSimulator,
  listIosSimulators,
  listSimulatorCatalog,
  SimctlError,
  SimulatorRequestError,
} from "../services/ios-simulators.js";
import { isDeviceAction, performDeviceAction } from "../services/device-drivers/actions.js";
import { DeviceActionError } from "../services/device-drivers/types.js";
import type { DeviceKind, DevicePlatform } from "../services/device-drivers/types.js";
import type {
  DeviceKindsResponse,
  DevicePairRequest,
  DevicePairResponse,
  DeviceSpawnSpec,
  DeviceWsQuery,
  DiscoveredDevicesResponse,
  LiveDevicesResponse,
  CreateSimulatorRequest,
  CreateSimulatorResponse,
  SimulatorCatalogResponse,
  SimulatorsResponse,
  SpawnDeviceResponse,
} from "../services/device-wire.js";

/**
 * Answers a deliberate device/teardown failure with 424 Failed Dependency so
 * RemoteHostTransport forwards it instead of flattening a 5xx into
 * HostUnreachableError; the primary's RemoteDeviceHost maps it back to the
 * original status and message.
 */
function replyFailedDependency(reply: FastifyReply, message: string, deviceStatus: number) {
  return reply.code(424).send({
    statusCode: 424,
    error: "Failed Dependency",
    message,
    deviceStatus,
  });
}

/**
 * The agent's device routes (issue #3200): a primary running a device on this
 * host drives it through these instead of through its own DeviceManager.
 * Registered from `internalRoutes` so they sit behind its auth hook and share
 * its rate limit. The agent has no database: the primary's `devices` row is the
 * record, and every request carries what the agent needs (see device-wire.ts).
 * Gating mirrors the primary's own `/api/devices*` routes, answered from this
 * host's own DEVICE_* config and platform.
 */
export function registerDeviceRoutes(app: FastifyInstance, rateLimit: { config: object }): void {
  app.get<{ Reply: DeviceKindsResponse }>("/internal/devices/kinds", rateLimit, async () => ({
    deviceKinds: localDeviceKinds(app),
    platforms: await localDevicePlatforms(app),
  }));

  app.get<{ Reply: SimulatorsResponse }>(
    "/internal/simulators",
    rateLimit,
    async (_request, reply) => {
      if (!app.devicePanelEnabled) return reply.badRequest(app.devicePanelUnavailableMessage);
      if (!(await iosSimulatorAvailable(app))) {
        return reply.badRequest("iOS Simulator is not available on this host");
      }
      try {
        return { simulators: await listIosSimulators() };
      } catch (err) {
        if (err instanceof SimctlError) return reply.badGateway(err.message);
        throw err;
      }
    },
  );

  app.get<{ Reply: SimulatorCatalogResponse }>(
    "/internal/simulators/catalog",
    rateLimit,
    async (_request, reply) => {
      if (!app.devicePanelEnabled) return reply.badRequest(app.devicePanelUnavailableMessage);
      if (!(await iosSimulatorAvailable(app))) {
        return reply.badRequest("iOS Simulator is not available on this host");
      }
      try {
        return await listSimulatorCatalog();
      } catch (err) {
        if (err instanceof SimctlError) return reply.badGateway(err.message);
        throw err;
      }
    },
  );

  app.post<{ Body: CreateSimulatorRequest; Reply: CreateSimulatorResponse }>(
    "/internal/simulators",
    { ...rateLimit, schema: { body: SIMULATOR_CREATE_SCHEMA } },
    async (request, reply) => {
      if (!app.devicePanelEnabled) return reply.badRequest(app.devicePanelUnavailableMessage);
      if (!(await iosSimulatorAvailable(app))) {
        return reply.badRequest("iOS Simulator is not available on this host");
      }
      try {
        return { simulator: await createIosSimulator(request.body) };
      } catch (err) {
        if (err instanceof SimulatorRequestError) return reply.badRequest(err.message);
        if (err instanceof SimctlError) return reply.badGateway(err.message);
        throw err;
      }
    },
  );

  // Idempotent get-or-create: a device already live under this id is returned as
  // is, a scope that survived an agent restart is reattached (DeviceManager's
  // own getOrCreate), anything else is spawned. Answers once getOrCreate's quick
  // pre-checks clear; the emulator's boot continues in the background and the
  // caller reads its status from /internal/devices/live.
  app.post<{ Body: DeviceSpawnSpec; Reply: SpawnDeviceResponse }>(
    "/internal/devices",
    { ...rateLimit, schema: { body: DEVICE_SPAWN_SCHEMA } },
    async (request, reply) => {
      const spec = request.body;
      // An iOS device is gated by iOS availability here, never by the Android
      // emulator gate; without it the spec must not reach the Android manager.
      if (spec.platform === "ios") {
        if (!(await iosSimulatorAvailable(app))) {
          return reply.badRequest("iOS Simulator is not available on this host");
        }
        if (!spec.udid) return reply.badRequest("udid is required for an ios device");
      } else if (
        spec.kind === "emulator" ? !app.deviceEmulatorEnabled : !physicalDeviceEnabled(app)
      ) {
        return reply.badRequest(
          spec.kind === "emulator"
            ? app.deviceEmulatorUnavailableMessage
            : physicalDeviceUnavailableMessage(app),
        );
      }
      if (
        spec.platform !== "ios" &&
        spec.kind === "physical" &&
        !isValidDeviceAddress(spec.serial)
      ) {
        return reply.badRequest("serial must be host:port (e.g. 192.168.1.23:37251)");
      }
      app.device.setReservedPorts(spec.reservedPorts);
      try {
        const device = await app.device.getOrCreate({
          id: spec.id,
          kind: spec.kind,
          avdName: spec.avdName,
          serial: spec.serial,
          label: spec.label,
          port: spec.port,
          ...(spec.platform === "ios" ? { platform: spec.platform, udid: spec.udid } : {}),
        });
        return { info: device.toInfo(), port: device.port };
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }
    },
  );

  app.get<{ Reply: LiveDevicesResponse }>("/internal/devices/live", rateLimit, async () => {
    const devices = app.device.list();
    const ports: Record<string, number> = {};
    for (const d of devices) {
      const port = app.device.get(d.id)?.port ?? null;
      if (port !== null) ports[d.id] = port;
    }
    return { devices, ports };
  });

  app.get<{ Reply: DiscoveredDevicesResponse }>(
    "/internal/devices/discovered",
    rateLimit,
    async () => ({
      devices: app.bootDeviceDiscoveryEnabled ? app.deviceDiscovery.getDiscovered() : [],
    }),
  );

  // Dials an arbitrary network address a caller supplies: same full-scope-only
  // blast-radius reasoning as the primary's `device.pair` control-socket op,
  // and gated behind the agent bearer token here. Both address and code are
  // re-validated on the agent because `adb pair` builds the adb service string.
  app.post<{ Body: DevicePairRequest; Reply: DevicePairResponse }>(
    "/internal/devices/pair",
    { ...DEVICE_PAIR_RATE_LIMIT, schema: { body: DEVICE_PAIR_SCHEMA } },
    async (request, reply) => {
      if (!app.devicePanelEnabled) return reply.badRequest(app.devicePanelUnavailableMessage);
      const { pairingAddress, pairingCode } = request.body;
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
      return { ok: true };
    },
  );

  // Same teardown the primary's own stop/delete runs locally. Not gated on
  // DEVICE_ENABLED: tearing a device down must keep working while the panel is
  // off. Idempotent: nothing running is ok.
  app.post<{ Params: { id: string }; Body: { kind: DeviceKind; platform?: DevicePlatform } }>(
    "/internal/devices/:id/terminate",
    {
      ...rateLimit,
      schema: { params: DEVICE_ID_PARAMS_SCHEMA, body: DEVICE_TERMINATE_SCHEMA },
    },
    async (request, reply) => {
      // A failed teardown is answered 424 (rather than 500, which
      // RemoteHostTransport turns into HostUnreachableError) so the primary
      // forwards 500 + message and keeps the row as the only handle to a
      // possibly-surviving scope.
      const { kind, platform } = request.body;
      try {
        await (platform === "ios"
          ? app.device.terminate(request.params.id, kind, platform)
          : app.device.terminate(request.params.id, kind));
      } catch (err) {
        return replyFailedDependency(reply, err instanceof Error ? err.message : String(err), 500);
      }
      reply.code(204);
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/internal/devices/:id/action",
    {
      ...rateLimit,
      // The body is validated by isDeviceAction below, not by a schema: its
      // shape is a discriminated union Fastify's default ajv would strip.
      schema: { params: DEVICE_ID_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      if (!app.devicePanelEnabled) return reply.badRequest(app.devicePanelUnavailableMessage);
      if (!isDeviceAction(request.body)) return reply.badRequest("invalid action body");
      const driver = app.device.getDriver(request.params.id);
      if (!driver) {
        return reply.badRequest(
          `device ${request.params.id} has no live adb connection (status: not running)`,
        );
      }
      try {
        return await performDeviceAction(driver, request.body);
      } catch (err) {
        if (err instanceof DeviceActionError) {
          if (err.statusCode >= 500) {
            return replyFailedDependency(reply, err.message, err.statusCode);
          }
          return reply.send(app.httpErrors.createError(err.statusCode, err.message));
        }
        throw err;
      }
    },
  );

  // The agent's half of the device panel's video/input socket. The primary's
  // proxy (routes/device.ts) relays frames both ways; the keyframe gating and
  // the backpressure drop live in attachSocketToDevice, so they stay agent-side.
  // The gating below is the device socket's own (services/internal-streams.ts),
  // shared with the `device` stream over the outbound channel (#3273).
  app.get<{ Params: { id: string }; Querystring: DeviceWsQuery }>(
    "/internal/ws/device/:id",
    {
      websocket: true,
      config: rateLimit.config,
      schema: { params: DEVICE_ID_PARAMS_SCHEMA },
      preValidation: async (request, reply) => {
        const error = await deviceQueryError(
          app,
          request.query as Record<string, string | undefined>,
          request.params.id,
        );
        if (error !== null) return reply.badRequest(error);
      },
    },
    (socket, req) => {
      void attachSocketToDevice(
        app,
        socket,
        deviceStreamParams(req.query as Record<string, string | undefined>, req.params.id),
      );
    },
  );
}
