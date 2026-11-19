import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { getDeviceRow, type DeviceRow } from "../services/device-store.js";
import { getDeviceHost } from "../services/device-host.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { iosSimulatorAvailable } from "../services/device-kinds.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import {
  attachSocketToDevice,
  BACKPRESSURE_MAX_BUFFERED_BYTES,
  KEYFRAME_STALL_MS,
} from "../services/device-attach.js";

// The primary's half of the device panel: `/ws/device/:deviceId` serves the
// panel's socket for a device on THIS host, and proxies it to the agent that
// runs a device on another host (#3200).
//
// The socket attach itself — the device's video fan-out, the keyframe gating
// and the input proxy — lives in a service (services/device-attach.ts): the
// agent's own `/internal/ws/device/:id` route and the `device` stream over
// the outbound agent channel (#3273) run the SAME body, and a plugin may
// not import a route (issue #2413). Re-exported here so every existing
// importer keeps its path.
export { attachSocketToDevice } from "../services/device-attach.js";
export type { AttachDeviceParams } from "../services/device-attach.js";

/** How long the primary waits for an agent's device socket to open. */
export const REMOTE_DEVICE_OPEN_TIMEOUT_MS = 15_000;

/**
 * Relays the device panel's socket to the agent that runs the device (#3200),
 * modelled on routes/browser.ts's proxyToRemoteBrowser: control messages go
 * up, frames come down, and either side closing closes the other.
 *
 * It differs from the browser proxy where video differs from screenshots. A
 * dropped JPEG is repainted by the next one; a dropped H.264 delta corrupts
 * decoding until the next keyframe. So when the BROWSER side is backed up this
 * drops the frame, holds every delta until a keyframe has gone out, and asks
 * the agent for one — the same gate attachSocketToDevice applies on the
 * agent's own socket, which cannot see this hop's backlog. Everything else
 * (the agent's own keyframe gating on attach, the codec configuration
 * replay) stays agent-side, and binary frames pass through byte for byte.
 */
export async function proxyToRemoteDevice(
  app: FastifyInstance,
  deviceSocket: WebSocket,
  row: DeviceRow,
): Promise<void> {
  const { hostId } = row;
  const deviceId = row.id;
  const fail = (message: string): void => {
    if (deviceSocket.readyState === deviceSocket.OPEN) {
      deviceSocket.send(JSON.stringify({ type: "error", message }));
      deviceSocket.close();
    }
  };

  // Same get-or-create the local socket does, over REST first: it reattaches a
  // device that survived an agent restart and persists the port the agent
  // holds, which the socket's own attach cannot report back.
  let current: DeviceRow;
  try {
    await getDeviceHost(app, hostId).getOrCreate(row);
    current = getDeviceRow(app, deviceId) ?? row;
  } catch (err) {
    app.log.error({ err, hostId, deviceId }, "failed to start remote device for its socket");
    fail(err instanceof Error ? err.message : `Host ${hostId} is unreachable`);
    return;
  }
  if (deviceSocket.readyState !== deviceSocket.OPEN) return;

  let upstream: ReturnType<ReturnType<typeof getRemoteHostClient>["devices"]["openSocket"]>;
  try {
    upstream = getRemoteHostClient(app, hostId).devices.openSocket(String(deviceId), {
      kind: current.kind,
      ...(current.avdName !== null ? { avdName: current.avdName } : {}),
      ...(current.serial !== null ? { serial: current.serial } : {}),
      ...(current.name !== null ? { label: current.name } : {}),
      ...(current.port !== null ? { port: String(current.port) } : {}),
      ...(current.platform === "ios" && current.udid !== null
        ? { platform: "ios" as const, udid: current.udid }
        : {}),
    });
  } catch (err) {
    app.log.error({ err, hostId, deviceId }, "failed to open remote device WS upgrade");
    fail(`Host ${hostId} is unreachable`);
    return;
  }

  const closeUpstream = () => {
    if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
      upstream.close();
    }
  };
  const closeDevice = () => {
    if (deviceSocket.readyState === deviceSocket.OPEN) deviceSocket.close();
  };

  deviceSocket.on("message", (data, isBinary) => {
    if (upstream.readyState !== upstream.OPEN) return;
    if (upstream.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;
    upstream.send(data, { binary: isBinary });
  });
  deviceSocket.on("close", () => {
    stopStallTimer();
    closeUpstream();
  });
  // A socket error must not escape as an uncaught exception; the close that
  // follows tears everything down.
  deviceSocket.on("error", (err) => {
    app.log.warn({ err, hostId, deviceId }, "device socket error");
  });

  // An upstream that neither opens nor fails would hold this socket open for
  // nothing.
  const openTimer = setTimeout(() => {
    app.log.warn({ hostId, deviceId }, "remote device ws upstream did not open in time");
    closeUpstream();
    fail(`Host ${hostId} did not answer in time`);
  }, REMOTE_DEVICE_OPEN_TIMEOUT_MS);
  openTimer.unref();

  let awaitingKeyframe = false;
  let droppedSinceFrame = false;
  // A gated socket shows nothing until a keyframe arrives, and the one request
  // sent when the backlog clears can be lost (the agent had no controller yet,
  // or ignored it). The agent's own stall timer cannot help: its socket is not
  // gated. So re-ask until one comes, like attachSocketToDevice does.
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  const stopStallTimer = () => {
    if (stallTimer) clearInterval(stallTimer);
    stallTimer = null;
  };
  const startStallTimer = () => {
    if (stallTimer) return;
    stallTimer = setInterval(() => {
      if (upstream.readyState !== upstream.OPEN) return;
      app.log.warn({ hostId, deviceId }, "device proxy still waiting for a keyframe; asking again");
      upstream.send(JSON.stringify({ type: "requestKeyframe" }));
    }, KEYFRAME_STALL_MS);
    stallTimer.unref();
  };

  upstream.on("open", () => {
    clearTimeout(openTimer);
    if (deviceSocket.readyState !== deviceSocket.OPEN) closeUpstream();
  });
  upstream.on("close", () => {
    clearTimeout(openTimer);
    stopStallTimer();
    closeDevice();
  });
  upstream.on("error", (err) => {
    clearTimeout(openTimer);
    stopStallTimer();
    app.log.error({ err, hostId, deviceId }, "remote device ws upstream error");
    // Say why, instead of a bare disconnect (a refused upgrade lands here).
    fail(`Host ${hostId} did not accept the device socket`);
  });
  // A REFUSED socket is its own event: over the outbound channel the agent
  // answers a refusal (its own device gating said no) with a status, and the
  // channel socket reports it here rather than as an error — without this the
  // panel would see a bare disconnect over the channel where the inbound
  // transport says why.
  upstream.on("unexpected-response", (_req, res) => {
    clearTimeout(openTimer);
    stopStallTimer();
    app.log.warn(
      { hostId, deviceId, status: res.statusCode },
      "remote device ws upstream refused the socket",
    );
    fail(`Host ${hostId} did not accept the device socket`);
  });
  upstream.on("message", (data, isBinary) => {
    if (deviceSocket.readyState !== deviceSocket.OPEN) return;
    if (!isBinary) {
      // Control frames (`exited`, `clipboard`, `error`) are small and never
      // dropped.
      deviceSocket.send(data, { binary: false });
      return;
    }
    // [1 byte type][1 byte flags][payload]; see encodeVideoFrame.
    const head = data as Buffer;
    const isData = head[0] === 1;
    if (isData) {
      if (deviceSocket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) {
        droppedSinceFrame = true;
        awaitingKeyframe = true;
        startStallTimer();
        return;
      }
      if (droppedSinceFrame) {
        // The backlog just cleared: get a fresh keyframe rather than wait out
        // the encoder's own interval. Once per drop-then-recover episode.
        droppedSinceFrame = false;
        if (upstream.readyState === upstream.OPEN) {
          upstream.send(JSON.stringify({ type: "requestKeyframe" }));
        }
      }
      if (awaitingKeyframe) {
        if ((head[1] & 1) === 0) return;
        awaitingKeyframe = false;
        stopStallTimer();
      }
    }
    deviceSocket.send(data, { binary: true });
  });
}

export async function deviceRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { deviceId: string } }>(
    "/ws/device/:deviceId",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const deviceId = Number(request.params.deviceId);
        const row = Number.isInteger(deviceId) ? getDeviceRow(app, deviceId) : undefined;
        // The local gates are this host's own config; a device on an agent host
        // is gated by that agent when its socket reaches it (#3200).
        if (!app.devicePanelEnabled && (!row || row.hostId === LOCAL_HOST_ID)) {
          return reply.badRequest(app.devicePanelUnavailableMessage);
        }
        if (!Number.isInteger(deviceId)) {
          return reply.badRequest("deviceId path param is required");
        }
        if (!row) return reply.notFound(`No device ${deviceId}`);
        if (row.status === "killed") return reply.badRequest(`Device ${deviceId} was killed`);
        // An iOS row is gated by iOS availability, never by the Android emulator gate.
        if (row.hostId === LOCAL_HOST_ID && row.platform === "ios") {
          if (!(await iosSimulatorAvailable(app))) {
            return reply.badRequest("iOS Simulator is not available on this host.");
          }
        } else if (
          row.hostId === LOCAL_HOST_ID &&
          row.kind !== "physical" &&
          !app.deviceEmulatorEnabled
        ) {
          return reply.badRequest(app.deviceEmulatorUnavailableMessage);
        }
      },
    },
    (socket, req) => {
      const deviceId = Number(req.params.deviceId);
      // preValidation above already confirmed this row exists and isn't
      // killed — re-checked here (the upgrade has already completed by this
      // point, so a TOCTOU race — e.g. DELETE /api/devices/:id landing
      // between preValidation and this handler — can't be reported as an
      // HTTP error anymore) the same way terminal.ts's own
      // resolveAndAttach does: close the socket rather than leaving it open
      // with nothing wired up, or throwing on `row` being undefined.
      const row = getDeviceRow(app, deviceId);
      if (!row || row.status === "killed") {
        app.log.warn({ deviceId }, "device ws attach failed after upgrade, closing");
        socket.close();
        return;
      }
      if (row.hostId !== LOCAL_HOST_ID) {
        void proxyToRemoteDevice(app, socket, row);
        return;
      }
      void attachSocketToDevice(app, socket, {
        deviceId,
        kind: row.kind,
        avdName: row.avdName,
        serial: row.serial,
        label: row.name,
        port: row.port,
        ...(row.platform === "ios" ? { platform: row.platform, udid: row.udid } : {}),
      });
    },
  );
}
