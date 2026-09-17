import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import { attachSocketToDevice } from "../../src/routes/device.js";
import type { Device } from "../../src/services/device-manager.js";

// Hermes review on PR #1324 — routes/device.ts's WS backpressure/drop path
// (only ever drop a "data" video packet, never "configuration", and request
// a fresh keyframe via resetVideo() once a backlog clears) shipped with no
// test coverage. attachSocketToDevice is exported specifically for this —
// exercised directly against a fake Device/socket rather than through a real
// HTTP+WS upgrade (as test/routes/browser.test.ts does for its own route),
// since the logic under test lives entirely inside the onVideoPacket
// listener this function registers and needs no real DeviceManager/adb/
// scrcpy stack to reach.

const BACKPRESSURE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

class FakeSocket {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<{ data: unknown; binary: boolean }> = [];
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: unknown, opts?: { binary?: boolean }) {
    this.sent.push({ data, binary: opts?.binary ?? false });
  }

  close() {
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function makeFakeDevice(overrides?: {
  controller?: Record<string, (...args: never[]) => Promise<unknown>>;
}): {
  device: Device;
  emitVideoPacket: (packet: ScrcpyMediaStreamPacket) => void;
  emitExit: () => void;
  unsubscribeVideoSpy: ReturnType<typeof vi.fn>;
  unsubscribeExitSpy: ReturnType<typeof vi.fn>;
} {
  let videoListener: ((packet: ScrcpyMediaStreamPacket) => void) | undefined;
  let exitListener: (() => void) | undefined;
  const unsubscribeVideoSpy = vi.fn();
  const unsubscribeExitSpy = vi.fn();

  const device = {
    id: "1",
    avdName: "dev35",
    label: null,
    controller: overrides?.controller,
    onVideoPacket: vi.fn((listener: (packet: ScrcpyMediaStreamPacket) => void) => {
      videoListener = listener;
      return unsubscribeVideoSpy;
    }),
    onExit: vi.fn((listener: () => void) => {
      exitListener = listener;
      return unsubscribeExitSpy;
    }),
    toInfo: vi.fn(() => ({
      id: "1",
      avdName: "dev35",
      label: null,
      status: "streaming",
      serial: "emulator-5554",
      error: null,
    })),
  } as unknown as Device;

  return {
    device,
    emitVideoPacket: (packet) => videoListener?.(packet),
    emitExit: () => exitListener?.(),
    unsubscribeVideoSpy,
    unsubscribeExitSpy,
  };
}

function makeFakeApp(getOrCreate: ReturnType<typeof vi.fn>): FastifyInstance {
  return {
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    device: { getOrCreate },
  } as unknown as FastifyInstance;
}

function configPacket(): ScrcpyMediaStreamPacket {
  return { type: "configuration", data: new Uint8Array([1, 2, 3]) } as ScrcpyMediaStreamPacket;
}

function dataPacket(keyframe = false): ScrcpyMediaStreamPacket {
  return {
    type: "data",
    data: new Uint8Array([4, 5, 6]),
    keyframe,
  } as ScrcpyMediaStreamPacket;
}

describe("attachSocketToDevice", () => {
  let socket: FakeSocket;

  beforeEach(() => {
    socket = new FakeSocket();
  });

  it("sends video packets to the socket as binary frames", async () => {
    const { device, emitVideoPacket } = makeFakeDevice();
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    emitVideoPacket(configPacket());
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0].binary).toBe(true);
  });

  it("drops a data packet once buffered bytes exceed the backpressure threshold", async () => {
    const { device, emitVideoPacket } = makeFakeDevice();
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    socket.bufferedAmount = BACKPRESSURE_MAX_BUFFERED_BYTES + 1;
    emitVideoPacket(dataPacket());

    expect(socket.sent).toHaveLength(0);
  });

  it("never drops a configuration packet, even over the backpressure threshold", async () => {
    const { device, emitVideoPacket } = makeFakeDevice();
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    socket.bufferedAmount = BACKPRESSURE_MAX_BUFFERED_BYTES + 1;
    emitVideoPacket(configPacket());

    expect(socket.sent).toHaveLength(1);
  });

  it("requests a fresh keyframe via resetVideo() once the backlog clears after a drop", async () => {
    const resetVideo = vi.fn(async () => {});
    const { device, emitVideoPacket } = makeFakeDevice({ controller: { resetVideo } });
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    // Backlog builds up — a data packet is dropped.
    socket.bufferedAmount = BACKPRESSURE_MAX_BUFFERED_BYTES + 1;
    emitVideoPacket(dataPacket());
    expect(socket.sent).toHaveLength(0);
    expect(resetVideo).not.toHaveBeenCalled();

    // Backlog clears — the next data packet triggers resetVideo() and is
    // itself still sent (recovery, not a second drop).
    socket.bufferedAmount = 0;
    emitVideoPacket(dataPacket());
    expect(socket.sent).toHaveLength(1);
    expect(resetVideo).toHaveBeenCalledTimes(1);
  });

  it("fires resetVideo() only once per drop-then-recover episode, not on every subsequent packet", async () => {
    const resetVideo = vi.fn(async () => {});
    const { device, emitVideoPacket } = makeFakeDevice({ controller: { resetVideo } });
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    socket.bufferedAmount = BACKPRESSURE_MAX_BUFFERED_BYTES + 1;
    emitVideoPacket(dataPacket());
    socket.bufferedAmount = 0;
    emitVideoPacket(dataPacket());
    emitVideoPacket(dataPacket());
    emitVideoPacket(dataPacket());

    expect(resetVideo).toHaveBeenCalledTimes(1);
    // The recovery packet plus the two that followed it all went out.
    expect(socket.sent).toHaveLength(3);
  });

  it("logs a warning and keeps streaming when resetVideo() itself rejects", async () => {
    const resetVideo = vi.fn(async () => {
      throw new Error("resetVideo failed");
    });
    const { device, emitVideoPacket } = makeFakeDevice({ controller: { resetVideo } });
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    socket.bufferedAmount = BACKPRESSURE_MAX_BUFFERED_BYTES + 1;
    emitVideoPacket(dataPacket());
    socket.bufferedAmount = 0;
    emitVideoPacket(dataPacket());

    // resetVideo() rejecting is fire-and-forget from the listener's own
    // perspective — the packet that triggered recovery still goes out.
    expect(socket.sent).toHaveLength(1);
    await vi.waitFor(() => expect(app.log.warn).toHaveBeenCalled());
  });

  it("does not send or drop-track once the socket has closed", async () => {
    const { device, emitVideoPacket } = makeFakeDevice();
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    socket.close();
    emitVideoPacket(dataPacket());

    expect(socket.sent).toHaveLength(0);
  });

  it("unsubscribes video and exit listeners when the socket closes", async () => {
    const { device, unsubscribeVideoSpy, unsubscribeExitSpy } = makeFakeDevice();
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    expect(unsubscribeVideoSpy).not.toHaveBeenCalled();
    socket.close();
    expect(unsubscribeVideoSpy).toHaveBeenCalledTimes(1);
    expect(unsubscribeExitSpy).toHaveBeenCalledTimes(1);
  });

  it("sends an exited message and closes the socket when the device exits", async () => {
    const { device, emitExit } = makeFakeDevice();
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    emitExit();

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0].data as string)).toEqual({ type: "exited" });
    expect(socket.readyState).toBe(socket.CLOSED);
  });

  it("sends an error and closes the socket when getOrCreate() fails", async () => {
    const app = makeFakeApp(
      vi.fn(async () => {
        throw new Error("scope already running");
      }),
    );

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0].data as string)).toEqual({
      type: "error",
      message: "scope already running",
    });
    expect(socket.readyState).toBe(socket.CLOSED);
  });

  it("does nothing further if the socket already closed while getOrCreate() was in flight", async () => {
    const { device } = makeFakeDevice();
    let resolveGetOrCreate: (device: Device) => void;
    const getOrCreate = vi.fn(
      () =>
        new Promise<Device>((resolve) => {
          resolveGetOrCreate = resolve;
        }),
    );
    const app = makeFakeApp(getOrCreate);

    const attachPromise = attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    socket.readyState = socket.CLOSED;
    resolveGetOrCreate!(device);
    await attachPromise;

    expect(socket.sent).toHaveLength(0);
    expect(device.onVideoPacket).not.toHaveBeenCalled();
  });

  it("dispatches a tap input message through the scrcpy controller", async () => {
    const injectTouch = vi.fn(async () => {});
    const { device } = makeFakeDevice({ controller: { injectTouch } });
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "tap", x: 10, y: 20, videoWidth: 100, videoHeight: 200 })),
      false,
    );

    await vi.waitFor(() => expect(injectTouch).toHaveBeenCalledTimes(2));
  });

  it("logs a warning and keeps the connection open when input dispatch throws", async () => {
    const injectTouch = vi.fn(async () => {
      throw new Error("boom");
    });
    const { device } = makeFakeDevice({ controller: { injectTouch } });
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "tap", x: 10, y: 20, videoWidth: 100, videoHeight: 200 })),
      false,
    );

    await vi.waitFor(() => expect(app.log.warn).toHaveBeenCalled());
    expect(socket.readyState).toBe(socket.OPEN);
  });

  it("ignores malformed JSON and unknown/binary messages without crashing", async () => {
    const { device } = makeFakeDevice();
    const app = makeFakeApp(vi.fn(async () => device));

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 1,
      avdName: "dev35",
      label: null,
    });

    socket.emit("message", Buffer.from("not json{{{"), false);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "unknown-thing" })), false);
    socket.emit("message", Buffer.from([1, 2, 3]), true);

    expect(socket.readyState).toBe(socket.OPEN);
  });
});
