import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { getDeviceRow } from "../services/device-store.js";
import type { DeviceKind } from "../services/device-manager.js";
import { parseDeviceInput } from "../services/device-drivers/input.js";
import type {
  DeviceDriver,
  DeviceVideoPacket,
  TouchInput,
} from "../services/device-drivers/types.js";

// Streams a device's screen to the frontend DevicePane as binary H.264
// packets over WebSocket, and proxies touch/key/scroll input back —
// modeled on routes/browser.ts's attachSocketToBrowser (same preValidation-
// rejects-before-upgrade, per-connection-state-torn-down-on-close shape),
// but PUSH-based rather than poll-based: browser.ts captures a JPEG
// screenshot on a timer; a device's scrcpy stream instead delivers packets
// as they arrive from the emulator/phone's own encoder, fanned out from the
// one live Device (device-manager.ts) to however many WS clients are
// currently attached.
//
// Backpressure is NOT a blind "drop this tick" like browser.ts's — see
// DEVICE_ENABLED's own design note in the plan this shipped from: a JPEG
// screenshot is self-contained (the next tick fully repaints), but an H.264
// inter-frame is not — dropping one corrupts decode until the next IDR.  So
// this route only ever drops a `type: "data"` packet (never a
// `"configuration"` one, which carries SPS/PPS the decoder needs to even
// start), and once the backlog clears, asks the device for a fresh keyframe
// via `resetVideo()` rather than leaving the decoder to free-run corrupted
// until whatever the stream's own next natural keyframe interval is.
//
// The same reasoning applies to a NEW socket (a late joiner): it is sent the
// replayed config, then no delta frame until a keyframe has gone out on that
// socket, and a keyframe is requested on attach.

const BACKPRESSURE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

// How long a socket may sit gated on a keyframe before we log it and ask the
// device for another one. The gate silently drops every delta, and the pane
// can't tell "no keyframe yet" from "stream idle" — so a permanently-gated
// socket (the attach-time resetVideo() rejected, no controller, or the device
// ignored the request) would otherwise be invisible.
const KEYFRAME_STALL_MS = 5000;

// Wire framing for a video packet: [1 byte type][1 byte flags][payload].
// type: 0 = configuration (SPS/PPS), 1 = data. flags bit0 = keyframe.
// Deliberately doesn't carry `pts` — see the route's own header on why
// receive-time pacing is enough for a live, audio-less stream; add it here
// if audio ever lands and needs A/V sync.
//
// Cached per PACKET OBJECT (WeakMap, not a plain Map — no explicit eviction
// needed, and no cross-device corruption risk: Device.pumpVideo emits a
// fresh object per read, so a cache key is never reused across devices or
// packets). The driver's onVideoPacket fans the SAME packet out to every attached
// socket's own listener (multiple panels/CLI viewers of one device is an
// explicitly supported case — see docs/device-panel.md), so without this,
// N listeners would each independently allocate-and-copy an identical
// frame on the hottest path in the whole feature (every video frame).
const encodedFrameCache = new WeakMap<DeviceVideoPacket, Uint8Array>();

function encodeVideoFrame(packet: DeviceVideoPacket): Uint8Array {
  const cached = encodedFrameCache.get(packet);
  if (cached) return cached;
  const typeByte = packet.type === "configuration" ? 0 : 1;
  const flagsByte = packet.type === "data" && packet.keyframe ? 1 : 0;
  const out = new Uint8Array(2 + packet.data.byteLength);
  out[0] = typeByte;
  out[1] = flagsByte;
  out.set(packet.data, 2);
  encodedFrameCache.set(packet, out);
  return out;
}

export interface AttachDeviceParams {
  deviceId: number;
  kind: DeviceKind;
  avdName: string | null;
  serial: string | null;
  label: string | null;
  port: number | null;
}

/** Attaches a device WS socket to the live Device: gets-or-creates it via
 * DeviceManager, fans out video packets, proxies input. Exported for
 * tests. */
export async function attachSocketToDevice(
  app: FastifyInstance,
  socket: WebSocket,
  { deviceId, kind, avdName, serial, label, port }: AttachDeviceParams,
): Promise<void> {
  let device;
  try {
    device = await app.device.getOrCreateDriver({
      id: String(deviceId),
      kind,
      avdName,
      serial,
      label,
      port,
    });
  } catch (err) {
    // Same shape as routes/browser.ts's attachSocketToBrowser on a
    // getOrLaunch() failure — most likely getOrCreate's own
    // isScopeAlive() pre-check finding a scope left running from before a
    // restart (see that method's own comment).
    app.log.error({ err, deviceId }, "failed to get-or-create device");
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "error", message: (err as Error).message }));
      socket.close();
    }
    return;
  }

  // The socket may already be gone by the time the (possibly slow)
  // getOrCreate() above resolves.
  if (socket.readyState !== socket.OPEN) return;

  // `device` is a `let` (assigned in the try above), so closures below would
  // otherwise see it as implicitly `any`.
  const liveDevice: DeviceDriver = device;
  let closed = false;
  let droppedSincePacket = false;
  // A socket can disappear while the frontend is holding a touch. Keep the
  // most recent point for each pointer so its close handler can release the
  // controller state even when the client cannot send touchUp itself.
  const activeTouches = new Map<number, TouchInput>();
  // A brand-new socket is a late joiner: Device.onVideoPacket replays only
  // the SPS/PPS config, so the next packet is normally a delta frame — and
  // the frontend's WebCodecs decoder throws on a delta before its first
  // keyframe, which permanently errors its stream (a blank panel). Hold
  // every delta back until a keyframe has actually gone out on this socket;
  // a backpressure drop re-arms it.
  let awaitingKeyframe = true;

  const unsubscribeVideo = device.onVideoPacket((packet) => {
    if (closed || socket.readyState !== socket.OPEN) return;
    if (packet.type === "data" && socket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) {
      droppedSincePacket = true;
      awaitingKeyframe = true;
      return;
    }
    if (droppedSincePacket && packet.type === "data") {
      // Backlog just cleared — ask for a fresh keyframe rather than let the
      // frontend decoder free-run against a stream with a hole in it. Fire
      // once per drop-then-recover episode, not on every packet.
      droppedSincePacket = false;
      requestKeyframe("after backpressure drop");
    }
    if (packet.type === "data") {
      if (awaitingKeyframe && !packet.keyframe) return;
      awaitingKeyframe = false;
    }
    socket.send(encodeVideoFrame(packet), { binary: true });
  });

  function requestKeyframe(reason: string): void {
    liveDevice.requestKeyframe().catch((err) => {
      app.log.warn({ err, deviceId }, `device resetVideo ${reason} failed`);
    });
  }
  // Get the late joiner an IDR now rather than after the encoder's own
  // (possibly many-second) keyframe interval.
  requestKeyframe("on attach");
  const stallTimer = setTimeout(() => {
    if (closed || !awaitingKeyframe) return;
    app.log.warn(
      { deviceId, hasController: liveDevice.hasLiveControl },
      "device socket still waiting for a keyframe; requesting another",
    );
    requestKeyframe("after keyframe stall");
  }, KEYFRAME_STALL_MS);
  stallTimer.unref();

  const unsubscribeExit = device.onExit(() => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "exited" }));
      // Nothing more will ever be sent on this socket — close it rather
      // than leaving it dangling open. The client's own "close" handler
      // (DevicePane.tsx) is what unsubscribes this route's video/exit
      // listeners below (via the socket "close" handler further down), so
      // not closing here would leak this Device's listener registrations
      // until the client happens to notice on its own.
      socket.close();
    }
  });

  // Live-only by design (no replay on attach, unlike onVideoPacket's config
  // packet): a reconnecting or second panel must never overwrite the user's
  // clipboard with a stale device value — same bug class as #1251.
  const unsubscribeClipboard = device.onClipboard((text) => {
    if (closed || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ type: "clipboard", text }));
  });

  socket.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      app.log.warn({ deviceId }, "dropped malformed device control message");
      return;
    }
    const message = parseDeviceInput(parsed);
    if (!message) return;
    if (message.type === "touchDown") activeTouches.set(message.pointerId, message);
    else if (message.type === "touchMove" && activeTouches.has(message.pointerId)) {
      activeTouches.set(message.pointerId, message);
    } else if (message.type === "touchUp") activeTouches.delete(message.pointerId);
    liveDevice.input(message).catch((err) => {
      app.log.warn({ err, deviceId }, "device input dispatch failed");
    });
  });

  socket.on("close", () => {
    closed = true;
    clearTimeout(stallTimer);
    unsubscribeVideo();
    unsubscribeExit();
    unsubscribeClipboard();
    for (const touch of activeTouches.values()) {
      liveDevice.input({ ...touch, type: "touchUp" }).catch((err) => {
        app.log.warn({ err, deviceId }, "device touch release on socket close failed");
      });
    }
    activeTouches.clear();
  });
}

export async function deviceRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { deviceId: string } }>(
    "/ws/device/:deviceId",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!app.devicePanelEnabled) {
          return reply.badRequest(app.devicePanelUnavailableMessage);
        }
        const deviceId = Number(request.params.deviceId);
        if (!Number.isInteger(deviceId)) {
          return reply.badRequest("deviceId path param is required");
        }
        const row = getDeviceRow(app, deviceId);
        if (!row) return reply.notFound(`No device ${deviceId}`);
        if (row.status === "killed") return reply.badRequest(`Device ${deviceId} was killed`);
        if (row.kind !== "physical" && !app.deviceEmulatorEnabled) {
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
      void attachSocketToDevice(app, socket, {
        deviceId,
        kind: row.kind,
        avdName: row.avdName,
        serial: row.serial,
        label: row.name,
        port: row.port,
      });
    },
  );
}
