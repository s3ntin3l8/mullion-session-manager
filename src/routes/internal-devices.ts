import type { FastifyInstance } from "fastify";
import { attachSocketToDevice } from "./device.js";
import {
  DEVICE_ID_PARAMS_SCHEMA,
  DEVICE_SPAWN_SCHEMA,
  DEVICE_TERMINATE_SCHEMA,
} from "./internal-schemas.js";
import { localDeviceKinds } from "../services/device-kinds.js";
import { isDeviceAction, performDeviceAction } from "../services/device-drivers/actions.js";
import { DeviceActionError } from "../services/device-drivers/types.js";
import type { DeviceKind } from "../services/device-drivers/types.js";
import type {
  DeviceKindsResponse,
  DeviceSpawnSpec,
  DeviceWsQuery,
  LiveDevicesResponse,
  SpawnDeviceResponse,
} from "../services/device-wire.js";

function isDeviceKind(value: unknown): value is DeviceKind {
  return value === "emulator" || value === "physical";
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
  }));

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
      if (spec.kind === "emulator" ? !app.deviceEmulatorEnabled : !app.devicePanelEnabled) {
        return reply.badRequest(
          spec.kind === "emulator"
            ? app.deviceEmulatorUnavailableMessage
            : app.devicePanelUnavailableMessage,
        );
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
        });
        return { info: device.toInfo(), port: device.port };
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }
    },
  );

  app.get<{ Reply: LiveDevicesResponse }>("/internal/devices/live", rateLimit, async () => ({
    devices: app.device.list(),
  }));

  // Same teardown the primary's own stop/delete runs locally. Not gated on
  // DEVICE_ENABLED: tearing a device down must keep working while the panel is
  // off. Idempotent: nothing running is ok.
  app.post<{ Params: { id: string }; Body: { kind: DeviceKind } }>(
    "/internal/devices/:id/terminate",
    {
      ...rateLimit,
      schema: { params: DEVICE_ID_PARAMS_SCHEMA, body: DEVICE_TERMINATE_SCHEMA },
    },
    async (request, reply) => {
      // Deliberately not caught: a failed teardown must reach the primary, which
      // keeps the row as the only handle to a possibly-surviving scope.
      await app.device.terminate(request.params.id, request.body.kind);
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
          return reply.send(app.httpErrors.createError(err.statusCode, err.message));
        }
        throw err;
      }
    },
  );

  // The agent's half of the device panel's video/input socket. The primary's
  // proxy (routes/device.ts) relays frames both ways; the keyframe gating and
  // the backpressure drop live in attachSocketToDevice, so they stay agent-side.
  app.get<{ Params: { id: string }; Querystring: DeviceWsQuery }>(
    "/internal/ws/device/:id",
    {
      websocket: true,
      config: rateLimit.config,
      schema: { params: DEVICE_ID_PARAMS_SCHEMA },
      preValidation: async (request, reply) => {
        const { kind } = request.query;
        if (!isDeviceKind(kind)) return reply.badRequest("kind must be emulator or physical");
        if (kind === "emulator" ? !app.deviceEmulatorEnabled : !app.devicePanelEnabled) {
          return reply.badRequest(
            kind === "emulator"
              ? app.deviceEmulatorUnavailableMessage
              : app.devicePanelUnavailableMessage,
          );
        }
        const { port } = request.query;
        if (port !== undefined && !/^[0-9]{1,5}$/.test(port)) {
          return reply.badRequest("port must be a number");
        }
      },
    },
    (socket, req) => {
      const { kind, avdName, serial, label, port } = req.query;
      void attachSocketToDevice(app, socket, {
        deviceId: Number(req.params.id),
        kind,
        avdName: avdName ?? null,
        serial: serial ?? null,
        label: label ?? null,
        port: port === undefined ? null : Number(port),
      });
    },
  );
}
