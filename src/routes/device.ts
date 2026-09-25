import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { eq } from "drizzle-orm";
import { AndroidKeyEventAction } from "@yume-chan/scrcpy";
import { AndroidMotionEventAction, AndroidMotionEventButton } from "@yume-chan/scrcpy";
import type { AndroidKeyCode, ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import { devices } from "../db/schema.js";
import type { Device, DeviceKind } from "../services/device-manager.js";

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
// packets). Device.onVideoPacket fans the SAME packet out to every attached
// socket's own listener (multiple panels/CLI viewers of one device is an
// explicitly supported case — see docs/device-panel.md), so without this,
// N listeners would each independently allocate-and-copy an identical
// frame on the hottest path in the whole feature (every video frame).
const encodedFrameCache = new WeakMap<ScrcpyMediaStreamPacket, Uint8Array>();

function encodeVideoFrame(packet: ScrcpyMediaStreamPacket): Uint8Array {
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

interface TapMessage {
  type: "tap";
  x: number;
  y: number;
  videoWidth: number;
  videoHeight: number;
}

interface TouchMessage {
  type: "touchDown" | "touchMove" | "touchUp";
  x: number;
  y: number;
  videoWidth: number;
  videoHeight: number;
  pointerId: number;
}

interface ScrollMessage {
  type: "scroll";
  x: number;
  y: number;
  videoWidth: number;
  videoHeight: number;
  scrollX: number;
  scrollY: number;
}

interface TextMessage {
  type: "text";
  text: string;
}

/** `androidKeyCode` is an AOSP `KEYCODE_*` numeric value — the frontend owns
 * mapping a browser KeyboardEvent to this, same division of labor as
 * `injectKeyCode`'s own doc comment implies (this route is a thin proxy,
 * not a keymap). */
interface KeyEventMessage {
  type: "keyEvent";
  androidKeyCode: number;
  action: "down" | "up";
}

interface BackMessage {
  type: "back";
}

type DeviceInputMessage =
  TapMessage | TouchMessage | ScrollMessage | TextMessage | KeyEventMessage | BackMessage;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseInputMessage(value: unknown): DeviceInputMessage | null {
  const v = value as Partial<DeviceInputMessage> | null;
  if (typeof v !== "object" || v === null || typeof v.type !== "string") return null;
  switch (v.type) {
    case "tap": {
      const m = v as Partial<TapMessage>;
      if (
        isFiniteNumber(m.x) &&
        isFiniteNumber(m.y) &&
        isFiniteNumber(m.videoWidth) &&
        isFiniteNumber(m.videoHeight)
      ) {
        return {
          type: "tap",
          x: m.x,
          y: m.y,
          videoWidth: m.videoWidth,
          videoHeight: m.videoHeight,
        };
      }
      return null;
    }
    case "touchDown":
    case "touchMove":
    case "touchUp": {
      const m = v as Partial<TouchMessage>;
      if (
        isFiniteNumber(m.x) &&
        isFiniteNumber(m.y) &&
        isFiniteNumber(m.videoWidth) &&
        isFiniteNumber(m.videoHeight) &&
        isFiniteNumber(m.pointerId)
      ) {
        return {
          type: v.type,
          x: m.x,
          y: m.y,
          videoWidth: m.videoWidth,
          videoHeight: m.videoHeight,
          pointerId: m.pointerId,
        };
      }
      return null;
    }
    case "scroll": {
      const m = v as Partial<ScrollMessage>;
      if (
        isFiniteNumber(m.x) &&
        isFiniteNumber(m.y) &&
        isFiniteNumber(m.videoWidth) &&
        isFiniteNumber(m.videoHeight) &&
        isFiniteNumber(m.scrollX) &&
        isFiniteNumber(m.scrollY)
      ) {
        return {
          type: "scroll",
          x: m.x,
          y: m.y,
          videoWidth: m.videoWidth,
          videoHeight: m.videoHeight,
          scrollX: m.scrollX,
          scrollY: m.scrollY,
        };
      }
      return null;
    }
    case "text": {
      const m = v as Partial<TextMessage>;
      return typeof m.text === "string" ? { type: "text", text: m.text } : null;
    }
    case "keyEvent": {
      const m = v as Partial<KeyEventMessage>;
      if (isFiniteNumber(m.androidKeyCode) && (m.action === "down" || m.action === "up")) {
        return { type: "keyEvent", androidKeyCode: m.androidKeyCode, action: m.action };
      }
      return null;
    }
    case "back":
      return { type: "back" };
    default:
      return null;
  }
}

async function dispatchInput(device: Device, message: DeviceInputMessage): Promise<void> {
  const controller = device.controller;
  if (!controller) return;
  switch (message.type) {
    case "tap":
      await controller.injectTouch({
        action: AndroidMotionEventAction.Down,
        pointerId: 0n,
        pointerX: message.x,
        pointerY: message.y,
        videoWidth: message.videoWidth,
        videoHeight: message.videoHeight,
        pressure: 1,
        actionButton: AndroidMotionEventButton.Primary,
        buttons: AndroidMotionEventButton.Primary,
      });
      await controller.injectTouch({
        action: AndroidMotionEventAction.Up,
        pointerId: 0n,
        pointerX: message.x,
        pointerY: message.y,
        videoWidth: message.videoWidth,
        videoHeight: message.videoHeight,
        pressure: 0,
        actionButton: AndroidMotionEventButton.Primary,
        buttons: AndroidMotionEventButton.None,
      });
      break;
    case "touchDown":
    case "touchMove":
    case "touchUp": {
      const action =
        message.type === "touchDown"
          ? AndroidMotionEventAction.Down
          : message.type === "touchMove"
            ? AndroidMotionEventAction.Move
            : AndroidMotionEventAction.Up;
      const down = message.type !== "touchUp";
      await controller.injectTouch({
        action,
        pointerId: BigInt(message.pointerId),
        pointerX: message.x,
        pointerY: message.y,
        videoWidth: message.videoWidth,
        videoHeight: message.videoHeight,
        pressure: down ? 1 : 0,
        actionButton: down ? AndroidMotionEventButton.Primary : AndroidMotionEventButton.None,
        buttons: down ? AndroidMotionEventButton.Primary : AndroidMotionEventButton.None,
      });
      break;
    }
    case "scroll":
      await controller.injectScroll({
        pointerX: message.x,
        pointerY: message.y,
        videoWidth: message.videoWidth,
        videoHeight: message.videoHeight,
        scrollX: message.scrollX,
        scrollY: message.scrollY,
        buttons: AndroidMotionEventButton.None,
      });
      break;
    case "text":
      await controller.injectText(message.text);
      break;
    case "keyEvent":
      await controller.injectKeyCode({
        action: message.action === "down" ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up,
        // The frontend owns mapping a browser key to an AOSP KEYCODE_* value
        // — this route just proxies whatever numeric value it's given, so
        // there's no closed set to validate against here.
        keyCode: message.androidKeyCode as AndroidKeyCode,
        repeat: 0,
        metaState: 0,
      });
      break;
    case "back":
      await controller.backOrScreenOn(AndroidKeyEventAction.Down);
      await controller.backOrScreenOn(AndroidKeyEventAction.Up);
      break;
  }
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
    device = await app.device.getOrCreate({
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
  const liveDevice: Device = device;
  let closed = false;
  let droppedSincePacket = false;
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
    liveDevice.controller?.resetVideo().catch((err) => {
      app.log.warn({ err, deviceId }, `device resetVideo ${reason} failed`);
    });
  }
  // Get the late joiner an IDR now rather than after the encoder's own
  // (possibly many-second) keyframe interval.
  requestKeyframe("on attach");
  const stallTimer = setTimeout(() => {
    if (closed || !awaitingKeyframe) return;
    app.log.warn(
      { deviceId, hasController: Boolean(liveDevice.controller) },
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

  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      app.log.warn({ deviceId }, "dropped malformed device control message");
      return;
    }
    const message = parseInputMessage(parsed);
    if (!message) return;
    dispatchInput(device, message).catch((err) => {
      app.log.warn({ err, deviceId }, "device input dispatch failed");
    });
  });

  socket.on("close", () => {
    closed = true;
    clearTimeout(stallTimer);
    unsubscribeVideo();
    unsubscribeExit();
  });
}

export async function deviceRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { deviceId: string } }>(
    "/ws/device/:deviceId",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!app.config.DEVICE_ENABLED) {
          return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
        }
        const deviceId = Number(request.params.deviceId);
        if (!Number.isInteger(deviceId)) {
          return reply.badRequest("deviceId path param is required");
        }
        const [row] = app.db.select().from(devices).where(eq(devices.id, deviceId)).all();
        if (!row) return reply.notFound(`No device ${deviceId}`);
        if (row.status === "killed") return reply.badRequest(`Device ${deviceId} was killed`);
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
      const [row] = app.db.select().from(devices).where(eq(devices.id, deviceId)).all();
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
