import type { FastifyInstance, FastifyReply } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import {
  listAvailableSystemImages,
  installSystemImage,
  uninstallSystemImage,
  acceptLicenses,
  licensesMayBePending,
  listInstalledSystemImages,
} from "../services/avd-manager.js";
import type { AvailableSystemImage } from "../services/avd-manager.js";
import { AvdValidationError, getAvdHost, type AvdHost } from "../services/avd-host.js";
import { getHostRow, LOCAL_HOST_ID } from "../services/host-registry.js";
import { HostRequestError } from "../services/remote-host-client.js";
import { forwardHostRequestError, replyHostUnreachable } from "../services/host-error-reply.js";

// AVD (Android Virtual Device) provisioning — the counterpart to
// routes/devices.ts (which only RUNS an AVD that already exists on the
// host). Deliberately a separate route module (file-per-route-module
// convention, see routes/devices.ts's own header) since this is provisioning
// state on the host's SDK install, not a `devices` DB row — creating an AVD
// here doesn't create a `devices` row; the user still adds a device for it
// afterward via the existing `POST /api/devices {avdName}`.

interface CreateAvdBody {
  hostId?: string;
  name?: string;
  systemImage?: string;
  deviceProfile?: string;
  sdcardSize?: string;
  ramSize?: string;
  dataPartitionSize?: string;
}

function resolveAvdHostId(app: FastifyInstance, requested: string | undefined): string | null {
  if (!requested || requested === LOCAL_HOST_ID) return LOCAL_HOST_ID;
  return getHostRow(app, requested) ? requested : null;
}

function replyAvdError(reply: FastifyReply, host: AvdHost, err: unknown, what: string) {
  if (host.isLocal || err instanceof AvdValidationError) {
    return reply.badRequest(err instanceof Error ? err.message : String(err));
  }
  if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
  return replyHostUnreachable(reply, host.hostId, err, what);
}

export async function avdsRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { hostId?: string } }>("/api/avds", async (request, reply) => {
    const hostId = resolveAvdHostId(app, request.query?.hostId);
    if (hostId === null) return reply.badRequest(`Unknown host ${request.query?.hostId}`);
    const host = getAvdHost(app, hostId);
    try {
      const avds = await host.listAvds();
      return { avds };
    } catch (err) {
      return replyAvdError(reply, host, err, "listing AVDs");
    }
  });

  app.get<{ Querystring: { hostId?: string } }>("/api/system-images", async (request, reply) => {
    const hostId = resolveAvdHostId(app, request.query?.hostId);
    if (hostId === null) return reply.badRequest(`Unknown host ${request.query?.hostId}`);
    const host = getAvdHost(app, hostId);
    try {
      const systemImages = await host.listSystemImages();
      return { systemImages };
    } catch (err) {
      return replyAvdError(reply, host, err, "listing system images");
    }
  });

  // Not in the original plan's own route list, but needed by it anyway:
  // `deviceProfile` validation (POST /api/avds below) allowlists against
  // this same listing rather than a free-text regex, and the "New AVD"
  // frontend form needs somewhere to source its device-profile picker from
  // — duplicating a second hardcoded list would drift from whatever
  // `avdmanager list device` actually reports on this host.
  app.get<{ Querystring: { hostId?: string } }>("/api/device-profiles", async (request, reply) => {
    const hostId = resolveAvdHostId(app, request.query?.hostId);
    if (hostId === null) return reply.badRequest(`Unknown host ${request.query?.hostId}`);
    const host = getAvdHost(app, hostId);
    try {
      const deviceProfiles = await host.listDeviceProfiles();
      return { deviceProfiles };
    } catch (err) {
      return replyAvdError(reply, host, err, "listing device profiles");
    }
  });

  app.post<{ Body: CreateAvdBody }>("/api/avds", async (request, reply) => {
    const { hostId: requestedHostId, ...avdInput } = request.body ?? {};
    const hostId = resolveAvdHostId(app, requestedHostId);
    if (hostId === null) return reply.badRequest(`Unknown host ${requestedHostId}`);
    const host = getAvdHost(app, hostId);
    try {
      const result = await host.createAvd(avdInput);
      reply.code(201);
      return result;
    } catch (err) {
      return replyAvdError(reply, host, err, "creating the AVD");
    }
  });

  // ---------------------------------------------------------------------------
  // Available system images — lists installable images from Google's
  // repository. Cached in-memory (5-min TTL) to avoid hammering the network.
  // ---------------------------------------------------------------------------

  // Module-level cache for available system images. Keyed by a composite of
  // sdkmanagerPath + sdkRoot; value is [timestamp, images]. Five-minute TTL.
  const availableImagesCache = new Map<string, [number, AvailableSystemImage[]]>();
  const AVAILABLE_IMAGES_CACHE_TTL_MS = 5 * 60 * 1000;

  app.get("/api/system-images/available", async (_request, reply) => {
    if (!app.deviceEmulatorEnabled) {
      return reply.badRequest(app.deviceEmulatorUnavailableMessage);
    }
    if (!app.config.DEVICE_SDKMANAGER_PATH) {
      return reply.badRequest("DEVICE_SDKMANAGER_PATH is not configured.");
    }
    if (!app.config.DEVICE_ANDROID_SDK_ROOT) {
      return reply.badRequest("DEVICE_ANDROID_SDK_ROOT is not configured.");
    }

    const cacheKey = `${app.config.DEVICE_SDKMANAGER_PATH}:${app.config.DEVICE_ANDROID_SDK_ROOT}`;
    const cached = availableImagesCache.get(cacheKey);
    if (cached && Date.now() - cached[0] < AVAILABLE_IMAGES_CACHE_TTL_MS) {
      return { systemImages: cached[1] };
    }

    try {
      const systemImages = await listAvailableSystemImages(
        app.config.DEVICE_SDKMANAGER_PATH,
        app.config.DEVICE_ANDROID_SDK_ROOT,
      );
      availableImagesCache.set(cacheKey, [Date.now(), systemImages]);
      return { systemImages };
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  // ---------------------------------------------------------------------------
  // System image install/uninstall — WebSocket endpoint for streaming
  // progress of sdkmanager --install / --uninstall operations.
  // ---------------------------------------------------------------------------

  // Module-level guard: only one SDK operation at a time across all
  // connected clients. Tracked by a simple boolean since these operations
  // are global to the host's SDK install.
  let sdkOperationInProgress = false;

  app.get("/ws/system-image-install", { websocket: true }, (socket: WebSocket) => {
    let active = false;

    socket.on("message", async (raw) => {
      if (active) {
        socket.send(JSON.stringify({ type: "error", message: "Operation already in progress" }));
        return;
      }

      let msg: { type?: string; packagePath?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (msg.type !== "install" && msg.type !== "uninstall") {
        socket.send(
          JSON.stringify({ type: "error", message: 'type must be "install" or "uninstall"' }),
        );
        return;
      }

      if (!msg.packagePath || !msg.packagePath.startsWith("system-images;")) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid packagePath" }));
        return;
      }

      // The platform reason FIRST: on a platform the panel does not exist on,
      // "set DEVICE_ENABLED=true" would be advice that cannot help. Below
      // that, this socket's original combined message — its own contract,
      // asserted as such by this file's own tests.
      if (!app.deviceEmulatorSupported) {
        socket.send(
          JSON.stringify({ type: "error", message: app.deviceEmulatorUnavailableMessage }),
        );
        return;
      }

      if (!app.config.DEVICE_ENABLED || !app.config.DEVICE_SDKMANAGER_PATH) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "Device panel is disabled or DEVICE_SDKMANAGER_PATH is not configured",
          }),
        );
        return;
      }

      if (!app.config.DEVICE_ANDROID_SDK_ROOT) {
        socket.send(
          JSON.stringify({ type: "error", message: "DEVICE_ANDROID_SDK_ROOT is not configured" }),
        );
        return;
      }

      // Validate packagePath against the allowlist (installed + available).
      const installed = listInstalledSystemImages(app.config.DEVICE_ANDROID_SDK_ROOT);
      let available: AvailableSystemImage[];
      try {
        available = await listAvailableSystemImages(
          app.config.DEVICE_SDKMANAGER_PATH,
          app.config.DEVICE_ANDROID_SDK_ROOT,
        );
      } catch {
        available = [];
      }
      const allPaths = new Set([
        ...installed.map((img) => img.packagePath),
        ...available.map((img) => img.packagePath),
      ]);
      if (!allPaths.has(msg.packagePath)) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "packagePath is not in the installed or available images list",
          }),
        );
        return;
      }

      // Reject concurrent operations.
      if (sdkOperationInProgress) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "An SDK operation is already in progress",
          }),
        );
        return;
      }

      sdkOperationInProgress = true;
      active = true;
      const onLine = (line: string) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "progress", message: line }));
        }
      };

      try {
        if (msg.type === "install") {
          await installSystemImage(
            app.config.DEVICE_SDKMANAGER_PATH,
            app.config.DEVICE_ANDROID_SDK_ROOT,
            msg.packagePath,
            { onLine },
          );
        } else {
          await uninstallSystemImage(
            app.config.DEVICE_SDKMANAGER_PATH,
            app.config.DEVICE_ANDROID_SDK_ROOT,
            msg.packagePath,
            { onLine },
          );
        }
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "done" }));
        }
      } catch (err) {
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: err instanceof Error ? err.message : String(err),
              ...(err instanceof Error && "code" in err
                ? { code: (err as { code?: string }).code }
                : {}),
            }),
          );
        }
      } finally {
        sdkOperationInProgress = false;
        active = false;
        // Invalidate the available-images cache so the next GET refreshes
        // from the network — the just-installed/uninstalled image's
        // `installed` flag would otherwise stay stale for up to 5 min.
        availableImagesCache.clear();
      }
    });

    socket.on("close", () => {
      active = false;
    });
  });

  // ---------------------------------------------------------------------------
  // SDK license acceptance — WebSocket endpoint for streaming progress of
  // `sdkmanager --licenses`.
  // ---------------------------------------------------------------------------

  app.get("/ws/sdk-licenses", { websocket: true }, (socket: WebSocket) => {
    let active = false;

    socket.on("message", async (raw) => {
      if (active) {
        socket.send(
          JSON.stringify({ type: "error", message: "License acceptance already in progress" }),
        );
        return;
      }

      let msg: { type?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (msg.type !== "accept-licenses") {
        socket.send(JSON.stringify({ type: "error", message: 'type must be "accept-licenses"' }));
        return;
      }

      // The platform reason FIRST: on a platform the panel does not exist on,
      // "set DEVICE_ENABLED=true" would be advice that cannot help. Below
      // that, this socket's original combined message — its own contract,
      // asserted as such by this file's own tests.
      if (!app.deviceEmulatorSupported) {
        socket.send(
          JSON.stringify({ type: "error", message: app.deviceEmulatorUnavailableMessage }),
        );
        return;
      }

      if (!app.config.DEVICE_ENABLED || !app.config.DEVICE_SDKMANAGER_PATH) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "Device panel is disabled or DEVICE_SDKMANAGER_PATH is not configured",
          }),
        );
        return;
      }

      if (!app.config.DEVICE_ANDROID_SDK_ROOT) {
        socket.send(
          JSON.stringify({ type: "error", message: "DEVICE_ANDROID_SDK_ROOT is not configured" }),
        );
        return;
      }

      // Reject concurrent operations.
      if (sdkOperationInProgress) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "An SDK operation is already in progress",
          }),
        );
        return;
      }

      sdkOperationInProgress = true;
      active = true;
      const onLine = (line: string) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "progress", message: line }));
        }
      };

      try {
        await acceptLicenses(
          app.config.DEVICE_SDKMANAGER_PATH,
          app.config.DEVICE_ANDROID_SDK_ROOT,
          { onLine },
        );
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "done" }));
        }
      } catch (err) {
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      } finally {
        sdkOperationInProgress = false;
        active = false;
      }
    });

    socket.on("close", () => {
      active = false;
    });
  });

  // ---------------------------------------------------------------------------
  // License status — check whether licenses are pending.
  // ---------------------------------------------------------------------------

  app.get("/api/sdk-licenses/status", async (_request, reply) => {
    if (!app.deviceEmulatorEnabled) {
      return reply.badRequest(app.deviceEmulatorUnavailableMessage);
    }
    return { pending: licensesMayBePending() };
  });
}
