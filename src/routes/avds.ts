import type { FastifyInstance, FastifyReply } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { WebSocket as NodeWebSocket } from "ws";
import {
  listAvailableSystemImages,
  installSystemImage,
  uninstallSystemImage,
  acceptLicenses,
  listInstalledSystemImages,
} from "../services/avd-manager.js";
import type { AvailableSystemImage } from "../services/avd-manager.js";
import {
  AvdValidationError,
  getAvdHost,
  getSdkHostState,
  type AvdHost,
} from "../services/avd-host.js";
import { getHostRow, LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
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
  if (err instanceof HostRequestError) {
    if (err.statusCode === 404) {
      return reply.badRequest(`Host ${host.hostId} does not report AVDs — update its agent.`);
    }
    return forwardHostRequestError(reply, err);
  }
  return replyHostUnreachable(reply, host.hostId, err, what);
}

export const REMOTE_AVD_OPEN_TIMEOUT_MS = 15_000;

/**
 * Proxies an SDK operation WebSocket (system-image install/uninstall or
 * license acceptance) to an agent host. Messages pass through in both
 * directions, either side closing closes the other, and a stalled or
 * failed upstream answers `{type:"error", message}` and closes.
 */
export function proxyToRemoteAvdSocket(
  app: FastifyInstance,
  browserSocket: WebSocket,
  hostId: string,
  openUpstream: () => NodeWebSocket,
): void {
  const fail = (message: string): void => {
    if (browserSocket.readyState === browserSocket.OPEN) {
      browserSocket.send(JSON.stringify({ type: "error", message }));
      browserSocket.close();
    }
  };

  let upstream: NodeWebSocket;
  try {
    upstream = openUpstream();
  } catch (err) {
    app.log.error({ err, hostId }, "failed to open remote AVD WS upstream");
    fail(`Host ${hostId} is unreachable`);
    return;
  }

  const closeUpstream = () => {
    if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
      upstream.close();
    }
  };
  const closeBrowser = () => {
    if (browserSocket.readyState === browserSocket.OPEN) browserSocket.close();
  };

  // Buffer messages arriving from the browser while the upstream WS handshake
  // is still CONNECTING so the initial install/accept-licenses command is not
  // dropped before the agent connection opens.
  const pendingMessages: Array<{ data: unknown; isBinary: boolean }> = [];

  browserSocket.on("message", (data, isBinary) => {
    if (upstream.readyState === upstream.OPEN) {
      upstream.send(data as Parameters<NodeWebSocket["send"]>[0], { binary: isBinary });
    } else if (upstream.readyState === upstream.CONNECTING) {
      pendingMessages.push({ data, isBinary });
    }
  });
  browserSocket.on("close", () => {
    pendingMessages.length = 0;
    closeUpstream();
  });
  browserSocket.on("error", (err) => {
    app.log.warn({ err, hostId }, "AVD socket error");
  });

  const openTimer = setTimeout(() => {
    app.log.warn({ hostId }, "remote AVD ws upstream did not open in time");
    pendingMessages.length = 0;
    fail(`Host ${hostId} did not answer in time`);
    closeUpstream();
  }, REMOTE_AVD_OPEN_TIMEOUT_MS);
  openTimer.unref();

  upstream.on("open", () => {
    clearTimeout(openTimer);
    if (browserSocket.readyState !== browserSocket.OPEN) {
      pendingMessages.length = 0;
      closeUpstream();
      return;
    }
    for (const msg of pendingMessages) {
      if (upstream.readyState !== upstream.OPEN) break;
      upstream.send(msg.data as Parameters<NodeWebSocket["send"]>[0], { binary: msg.isBinary });
    }
    pendingMessages.length = 0;
  });
  upstream.on("close", () => {
    clearTimeout(openTimer);
    pendingMessages.length = 0;
    closeBrowser();
  });
  upstream.on("error", (err) => {
    clearTimeout(openTimer);
    pendingMessages.length = 0;
    app.log.error({ err, hostId }, "remote AVD ws upstream error");
    fail(`Host ${hostId} did not accept the AVD socket`);
  });
  upstream.on("message", (data, isBinary) => {
    if (browserSocket.readyState !== browserSocket.OPEN) return;
    browserSocket.send(data, { binary: isBinary });
  });
}

/**
 * Handles a `/ws/system-image-install` or `/internal/ws/system-image-install`
 * WebSocket against this host's own Android SDK.
 */
export function attachSystemImageInstallSocket(app: FastifyInstance, socket: WebSocket): void {
  const state = getSdkHostState(app);
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
      socket.send(JSON.stringify({ type: "error", message: app.deviceEmulatorUnavailableMessage }));
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
    if (state.sdkOperationInProgress) {
      socket.send(
        JSON.stringify({
          type: "error",
          message: "An SDK operation is already in progress",
        }),
      );
      return;
    }

    state.sdkOperationInProgress = true;
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
      state.sdkOperationInProgress = false;
      active = false;
      // Invalidate the available-images cache so the next GET refreshes
      // from the network — the just-installed/uninstalled image's
      // `installed` flag would otherwise stay stale for up to 5 min.
      state.availableImagesCache.clear();
    }
  });

  socket.on("close", () => {
    active = false;
  });
}

/**
 * Handles a `/ws/sdk-licenses` or `/internal/ws/sdk-licenses` WebSocket
 * against this host's own Android SDK.
 */
export function attachSdkLicensesSocket(app: FastifyInstance, socket: WebSocket): void {
  const state = getSdkHostState(app);
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
      socket.send(JSON.stringify({ type: "error", message: app.deviceEmulatorUnavailableMessage }));
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
    if (state.sdkOperationInProgress) {
      socket.send(
        JSON.stringify({
          type: "error",
          message: "An SDK operation is already in progress",
        }),
      );
      return;
    }

    state.sdkOperationInProgress = true;
    active = true;
    const onLine = (line: string) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "progress", message: line }));
      }
    };

    try {
      await acceptLicenses(app.config.DEVICE_SDKMANAGER_PATH, app.config.DEVICE_ANDROID_SDK_ROOT, {
        onLine,
      });
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
      state.sdkOperationInProgress = false;
      active = false;
    }
  });

  socket.on("close", () => {
    active = false;
  });
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
  // repository. Cached in-memory (5-min TTL) on the target host.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { hostId?: string } }>(
    "/api/system-images/available",
    async (request, reply) => {
      const hostId = resolveAvdHostId(app, request.query?.hostId);
      if (hostId === null) return reply.badRequest(`Unknown host ${request.query?.hostId}`);
      const host = getAvdHost(app, hostId);
      try {
        const systemImages = await host.listAvailableSystemImages();
        return { systemImages };
      } catch (err) {
        return replyAvdError(reply, host, err, "listing available system images");
      }
    },
  );

  // ---------------------------------------------------------------------------
  // System image install/uninstall — WebSocket endpoint for streaming
  // progress of sdkmanager --install / --uninstall operations.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { hostId?: string } }>(
    "/ws/system-image-install",
    { websocket: true },
    (socket: WebSocket, request) => {
      const hostId = resolveAvdHostId(app, request.query?.hostId);
      if (hostId === null) {
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({ type: "error", message: `Unknown host ${request.query?.hostId}` }),
          );
          socket.close();
        }
        return;
      }
      if (hostId !== LOCAL_HOST_ID) {
        proxyToRemoteAvdSocket(app, socket, hostId, () =>
          getRemoteHostClient(app, hostId).avds.openInstallSocket(),
        );
        return;
      }
      attachSystemImageInstallSocket(app, socket);
    },
  );

  // ---------------------------------------------------------------------------
  // SDK license acceptance — WebSocket endpoint for streaming progress of
  // `sdkmanager --licenses`.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { hostId?: string } }>(
    "/ws/sdk-licenses",
    { websocket: true },
    (socket: WebSocket, request) => {
      const hostId = resolveAvdHostId(app, request.query?.hostId);
      if (hostId === null) {
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({ type: "error", message: `Unknown host ${request.query?.hostId}` }),
          );
          socket.close();
        }
        return;
      }
      if (hostId !== LOCAL_HOST_ID) {
        proxyToRemoteAvdSocket(app, socket, hostId, () =>
          getRemoteHostClient(app, hostId).avds.openLicensesSocket(),
        );
        return;
      }
      attachSdkLicensesSocket(app, socket);
    },
  );

  // ---------------------------------------------------------------------------
  // License status — check whether licenses are pending.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { hostId?: string } }>(
    "/api/sdk-licenses/status",
    async (request, reply) => {
      const hostId = resolveAvdHostId(app, request.query?.hostId);
      if (hostId === null) return reply.badRequest(`Unknown host ${request.query?.hostId}`);
      const host = getAvdHost(app, hostId);
      try {
        return await host.sdkLicensesStatus();
      } catch (err) {
        return replyAvdError(reply, host, err, "checking SDK license status");
      }
    },
  );
}
