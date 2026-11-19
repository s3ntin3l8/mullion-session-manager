import type { FastifyInstance } from "fastify";
import { LocalAvdHost } from "../services/avd-host.js";
import { attachSdkLicensesSocket, attachSystemImageInstallSocket } from "./avds.js";
import { AVD_CREATE_SCHEMA, type AvdCreateBody } from "./internal-schemas.js";

/**
 * The agent's AVD provisioning routes (issue #3272): list AVDs, installed
 * system images, device profiles, and create an AVD on this host's own
 * Android SDK. Registered from `internalRoutes` so they sit behind its
 * bearer/signature auth hook and share its rate limit.
 */
export function registerAvdRoutes(app: FastifyInstance, rateLimit: { config: object }): void {
  const local = new LocalAvdHost(app);

  app.get("/internal/avds", rateLimit, async (_request, reply) => {
    try {
      const avds = await local.listAvds();
      return { avds };
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/internal/system-images", rateLimit, async (_request, reply) => {
    try {
      const systemImages = await local.listSystemImages();
      return { systemImages };
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/internal/device-profiles", rateLimit, async (_request, reply) => {
    try {
      const deviceProfiles = await local.listDeviceProfiles();
      return { deviceProfiles };
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  app.post<{ Body: AvdCreateBody }>(
    "/internal/avds",
    { ...rateLimit, schema: { body: AVD_CREATE_SCHEMA } },
    async (request, reply) => {
      try {
        const result = await local.createAvd(request.body);
        reply.code(201);
        return result;
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }
    },
  );

  app.get("/internal/system-images/available", rateLimit, async (_request, reply) => {
    try {
      const systemImages = await local.listAvailableSystemImages();
      return { systemImages };
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/internal/sdk-licenses/status", rateLimit, async (_request, reply) => {
    try {
      return await local.sdkLicensesStatus();
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  app.get(
    "/internal/ws/system-image-install",
    { websocket: true, config: rateLimit.config },
    (socket) => {
      attachSystemImageInstallSocket(app, socket);
    },
  );

  app.get("/internal/ws/sdk-licenses", { websocket: true, config: rateLimit.config }, (socket) => {
    attachSdkLicensesSocket(app, socket);
  });
}
