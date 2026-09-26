/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { buildTestApp } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { devices } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { attachSocketToDevice } from "../../src/routes/device.js";
import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

class MockWebSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  OPEN = 1;
  CLOSED = 3;
  bufferedAmount = 0;
  sentMessages: Array<{ data: unknown; binary?: boolean }> = [];
  closeCalls = 0;

  send(data: unknown, opts?: { binary?: boolean }) {
    this.sentMessages.push({ data, binary: opts?.binary });
  }

  close() {
    this.closeCalls++;
    this.readyState = this.CLOSED;
    this.emit("close");
  }
}

const tmpDb = path.join(os.tmpdir(), `device-route-test-${process.pid}.db`);

describe("device route (/ws/device/:deviceId)", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DEVICE_ENABLED;
  });

  describe("preValidation guards", () => {
    it("rejects with 400 when DEVICE_ENABLED is unset", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/ws/device/1" });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("Device panel is disabled");
    });

    it("rejects with 400 when deviceId is not an integer", async () => {
      process.env.DEVICE_ENABLED = "true";
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/ws/device/abc" });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("deviceId path param is required");
    });

    it("rejects with 404 when device row does not exist", async () => {
      process.env.DEVICE_ENABLED = "true";
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/ws/device/999" });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("No device 999");
    });

    it("rejects with 400 when device is killed", async () => {
      process.env.DEVICE_ENABLED = "true";
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      const id = created.json().id;

      // Mark as killed
      app.db.update(devices).set({ status: "killed" }).where(eq(devices.id, id)).run();

      const res = await app.inject({ method: "GET", url: `/ws/device/${id}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("was killed");
    });
  });

  describe("attachSocketToDevice", () => {
    beforeEach(() => {
      process.env.DEVICE_ENABLED = "true";
    });

    it("sends error and closes socket when getOrCreate rejects", async () => {
      const app = await buildTestApp();
      vi.spyOn(app.device, "getOrCreate").mockRejectedValueOnce(new Error("Scope dead"));
      const socket = new MockWebSocket();

      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });

      expect(socket.sentMessages).toHaveLength(1);
      expect(JSON.parse(socket.sentMessages[0].data as string)).toEqual({
        type: "error",
        message: "Scope dead",
      });
      expect(socket.closeCalls).toBe(1);
    });

    it("does nothing if socket was closed before getOrCreate finishes", async () => {
      const app = await buildTestApp();
      const socket = new MockWebSocket();
      vi.spyOn(app.device, "getOrCreate").mockImplementationOnce(async () => {
        socket.readyState = socket.CLOSED;
        return {
          onVideoPacket: vi.fn(),
          onExit: vi.fn(),
        } as any;
      });

      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });

      expect(socket.sentMessages).toHaveLength(0);
    });

    it("streams video packets, applies WeakMap caching, and respects backpressure", async () => {
      const app = await buildTestApp();
      let videoListener: ((pkt: ScrcpyMediaStreamPacket) => void) | undefined;
      const unsubscribeVideo = vi.fn();
      const mockResetVideo = vi.fn().mockResolvedValue(undefined);

      const fakeDevice = {
        controller: { resetVideo: mockResetVideo },
        onVideoPacket: vi.fn((fn) => {
          videoListener = fn;
          return unsubscribeVideo;
        }),
        onExit: vi.fn(() => vi.fn()),
      };
      vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce(fakeDevice as any);

      const socket = new MockWebSocket();
      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });

      expect(videoListener).toBeDefined();

      // 1. Send configuration packet
      const configPkt: ScrcpyMediaStreamPacket = {
        type: "configuration",
        data: new Uint8Array([10, 20]),
      };
      videoListener!(configPkt);
      expect(socket.sentMessages).toHaveLength(1);
      const m1 = socket.sentMessages[0];
      expect(m1.binary).toBe(true);
      const b1 = m1.data as Uint8Array;
      expect(b1[0]).toBe(0); // configuration type byte
      expect(b1[1]).toBe(0); // flags byte
      expect(b1.slice(2)).toEqual(new Uint8Array([10, 20]));

      // Test WeakMap cache hit: same packet object
      videoListener!(configPkt);
      expect(socket.sentMessages[1].data).toBe(b1);

      // 2. Send keyframe data packet
      const keyframePkt: ScrcpyMediaStreamPacket = {
        type: "data",
        keyframe: true,
        data: new Uint8Array([30, 40]),
      };
      videoListener!(keyframePkt);
      const m2 = socket.sentMessages[2];
      const b2 = m2.data as Uint8Array;
      expect(b2[0]).toBe(1); // data type byte
      expect(b2[1]).toBe(1); // keyframe bit
      expect(b2.slice(2)).toEqual(new Uint8Array([30, 40]));

      // 3. Backpressure: set bufferedAmount > 4MB
      socket.bufferedAmount = 5 * 1024 * 1024;
      const dataPkt2: ScrcpyMediaStreamPacket = {
        type: "data",
        keyframe: false,
        data: new Uint8Array([50]),
      };
      videoListener!(dataPkt2);
      // Dropped! Length hasn't grown
      expect(socket.sentMessages).toHaveLength(3);

      // Config packets are never dropped even under backpressure
      videoListener!(configPkt);
      expect(socket.sentMessages).toHaveLength(4);

      // 4. Backpressure recovers: bufferedAmount drops to 0
      socket.bufferedAmount = 0;
      const dataPkt3: ScrcpyMediaStreamPacket = {
        type: "data",
        keyframe: false,
        data: new Uint8Array([60]),
      };
      videoListener!(dataPkt3);
      // The delta that triggered recovery is gated: the hole means it can't
      // decode until the next keyframe.
      expect(socket.sentMessages).toHaveLength(4);
      // resetVideo: once on attach, once more when the backlog clears
      expect(mockResetVideo).toHaveBeenCalledTimes(2);

      // 5. Deltas stay gated (and don't re-trigger resetVideo) until a keyframe
      videoListener!(dataPkt3);
      expect(socket.sentMessages).toHaveLength(4);
      expect(mockResetVideo).toHaveBeenCalledTimes(2);
      videoListener!(keyframePkt);
      expect(socket.sentMessages).toHaveLength(5);
      videoListener!(dataPkt3);
      expect(socket.sentMessages).toHaveLength(6);
      expect(mockResetVideo).toHaveBeenCalledTimes(2);
    });

    it("gates a late joiner on a keyframe and requests one on attach", async () => {
      const app = await buildTestApp();
      let videoListener: ((pkt: ScrcpyMediaStreamPacket) => void) | undefined;
      const mockResetVideo = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce({
        controller: { resetVideo: mockResetVideo },
        onVideoPacket: vi.fn((fn) => {
          videoListener = fn;
          return vi.fn();
        }),
        onExit: vi.fn(() => vi.fn()),
      } as any);

      const socket = new MockWebSocket();
      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });
      expect(mockResetVideo).toHaveBeenCalledTimes(1);

      const delta = (n: number): ScrcpyMediaStreamPacket => ({
        type: "data",
        keyframe: false,
        data: new Uint8Array([n]),
      });
      // Config always goes through; deltas don't until a keyframe.
      videoListener!({ type: "configuration", data: new Uint8Array([1]) });
      videoListener!(delta(2));
      videoListener!(delta(3));
      expect(socket.sentMessages).toHaveLength(1);

      videoListener!({ type: "data", keyframe: true, data: new Uint8Array([4]) });
      videoListener!(delta(5));
      expect(socket.sentMessages).toHaveLength(3);
    });

    it("warns and re-requests a keyframe when a socket stays gated past the stall timeout", async () => {
      vi.useFakeTimers();
      try {
        const app = await buildTestApp();
        const warn = vi.spyOn(app.log, "warn");
        const mockResetVideo = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce({
          controller: { resetVideo: mockResetVideo },
          onVideoPacket: vi.fn(() => vi.fn()),
          onExit: vi.fn(() => vi.fn()),
        } as any);
        await attachSocketToDevice(app, new MockWebSocket() as any, {
          deviceId: 1,
          avdName: "dev35",
          label: null,
          port: null,
        });
        expect(mockResetVideo).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5000);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ deviceId: 1, hasController: true }),
          expect.stringContaining("still waiting for a keyframe"),
        );
        expect(mockResetVideo).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not warn about a stall once a keyframe has gone out, or after close", async () => {
      vi.useFakeTimers();
      try {
        const app = await buildTestApp();
        const warn = vi.spyOn(app.log, "warn");
        let videoListener: ((pkt: ScrcpyMediaStreamPacket) => void) | undefined;
        const mockResetVideo = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(app.device, "getOrCreate").mockResolvedValue({
          controller: { resetVideo: mockResetVideo },
          onVideoPacket: vi.fn((fn) => {
            videoListener = fn;
            return vi.fn();
          }),
          onExit: vi.fn(() => vi.fn()),
        } as any);
        const params = { deviceId: 1, avdName: "dev35", label: null, port: null };

        const live = new MockWebSocket();
        await attachSocketToDevice(app, live as any, params);
        videoListener!({ type: "data", keyframe: true, data: new Uint8Array([1]) });

        const closing = new MockWebSocket();
        await attachSocketToDevice(app, closing as any, params);
        closing.close();

        await vi.advanceTimersByTimeAsync(10_000);
        expect(warn).not.toHaveBeenCalled();
        // one on-attach request per socket, no stall retries
        expect(mockResetVideo).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("logs, rather than throws, when the on-attach resetVideo rejects", async () => {
      const app = await buildTestApp();
      const warn = vi.spyOn(app.log, "warn");
      vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce({
        controller: { resetVideo: vi.fn().mockRejectedValue(new Error("nope")) },
        onVideoPacket: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
      } as any);

      await attachSocketToDevice(app, new MockWebSocket() as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });
      await new Promise((r) => setImmediate(r));
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 1 }),
        expect.stringContaining("on attach"),
      );
    });

    it("sends exited message and closes socket on device exit", async () => {
      const app = await buildTestApp();
      let exitListener: (() => void) | undefined;
      const fakeDevice = {
        onVideoPacket: vi.fn(() => vi.fn()),
        onExit: vi.fn((fn) => {
          exitListener = fn;
          return vi.fn();
        }),
      };
      vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce(fakeDevice as any);

      const socket = new MockWebSocket();
      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });

      expect(exitListener).toBeDefined();
      exitListener!();

      expect(socket.sentMessages).toHaveLength(1);
      expect(JSON.parse(socket.sentMessages[0].data as string)).toEqual({ type: "exited" });
      expect(socket.closeCalls).toBe(1);
    });

    it("handles incoming socket input messages and dispatches to controller", async () => {
      const app = await buildTestApp();
      const mockController = {
        resetVideo: vi.fn().mockResolvedValue(undefined),
        injectTouch: vi.fn().mockResolvedValue(undefined),
        injectScroll: vi.fn().mockResolvedValue(undefined),
        injectText: vi.fn().mockResolvedValue(undefined),
        injectKeyCode: vi.fn().mockResolvedValue(undefined),
        backOrScreenOn: vi.fn().mockResolvedValue(undefined),
        rotateDevice: vi.fn().mockResolvedValue(undefined),
      };
      const fakeDevice = {
        controller: mockController,
        onVideoPacket: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
      };
      vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce(fakeDevice as any);

      const socket = new MockWebSocket();
      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });

      // Binary message is ignored
      socket.emit("message", Buffer.from([1, 2, 3]), true);

      // Malformed JSON is ignored
      socket.emit("message", Buffer.from("not-json"), false);

      // Unknown message type is ignored
      socket.emit("message", Buffer.from(JSON.stringify({ type: "unknown" })), false);

      // 1. tap message
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "tap",
            x: 100,
            y: 200,
            videoWidth: 1080,
            videoHeight: 1920,
          }),
        ),
        false,
      );
      await vi.waitFor(() => expect(mockController.injectTouch).toHaveBeenCalledTimes(2));

      // 2. touchDown, touchMove, touchUp
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "touchDown",
            x: 10,
            y: 20,
            videoWidth: 1080,
            videoHeight: 1920,
            pointerId: 0,
          }),
        ),
        false,
      );
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "touchMove",
            x: 15,
            y: 25,
            videoWidth: 1080,
            videoHeight: 1920,
            pointerId: 0,
          }),
        ),
        false,
      );
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "touchUp",
            x: 20,
            y: 30,
            videoWidth: 1080,
            videoHeight: 1920,
            pointerId: 0,
          }),
        ),
        false,
      );
      await vi.waitFor(() => expect(mockController.injectTouch).toHaveBeenCalledTimes(5));

      // 3. scroll
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "scroll",
            x: 50,
            y: 50,
            videoWidth: 1080,
            videoHeight: 1920,
            scrollX: 0,
            scrollY: -10,
          }),
        ),
        false,
      );
      await vi.waitFor(() => expect(mockController.injectScroll).toHaveBeenCalledTimes(1));

      // 4. text
      socket.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "hello" })), false);
      await vi.waitFor(() => expect(mockController.injectText).toHaveBeenCalledWith("hello"));

      // 5. keyEvent
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "keyEvent", androidKeyCode: 4, action: "down" })),
        false,
      );
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "keyEvent", androidKeyCode: 4, action: "up" })),
        false,
      );
      await vi.waitFor(() => expect(mockController.injectKeyCode).toHaveBeenCalledTimes(2));

      // 6. back
      socket.emit("message", Buffer.from(JSON.stringify({ type: "back" })), false);
      await vi.waitFor(() => expect(mockController.backOrScreenOn).toHaveBeenCalledTimes(2));

      socket.emit("message", Buffer.from(JSON.stringify({ type: "rotate" })), false);
      await vi.waitFor(() => expect(mockController.rotateDevice).toHaveBeenCalledTimes(1));

      // 7. error handling when controller rejects
      mockController.injectText.mockRejectedValueOnce(new Error("input failed"));
      socket.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "fail" })), false);
      // Doesn't crash

      // 8. invalid keyEvent action
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "keyEvent", androidKeyCode: 4, action: "invalid" })),
        false,
      );

      // 9. invalid payload structures for tap, touchDown, scroll, text
      socket.emit("message", Buffer.from(JSON.stringify({ type: "tap", x: 10 })), false);
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "touchDown", x: 10, y: 20 })),
        false,
      );
      socket.emit("message", Buffer.from(JSON.stringify({ type: "scroll", x: 10, y: 20 })), false);
      socket.emit("message", Buffer.from(JSON.stringify({ type: "text", text: 123 })), false);
    });

    it("handles resetVideo rejection on backpressure recovery gracefully", async () => {
      const app = await buildTestApp();
      let videoListener: ((pkt: ScrcpyMediaStreamPacket) => void) | undefined;
      const fakeDevice = {
        controller: { resetVideo: vi.fn().mockRejectedValue(new Error("reset failed")) },
        onVideoPacket: vi.fn((fn) => {
          videoListener = fn;
          return vi.fn();
        }),
        onExit: vi.fn(() => vi.fn()),
      };
      vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce(fakeDevice as any);

      const socket = new MockWebSocket();
      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });

      // Cause backpressure drop
      socket.bufferedAmount = 5 * 1024 * 1024;
      videoListener!({ type: "data", keyframe: false, data: new Uint8Array([1]) });

      // Clear backpressure
      socket.bufferedAmount = 0;
      videoListener!({ type: "data", keyframe: false, data: new Uint8Array([2]) });

      // resetVideo rejected but caught without throwing
    });

    it("unsubscribes listeners on socket close", async () => {
      const app = await buildTestApp();
      const unsubscribeVideo = vi.fn();
      const unsubscribeExit = vi.fn();
      const fakeDevice = {
        onVideoPacket: vi.fn(() => unsubscribeVideo),
        onExit: vi.fn(() => unsubscribeExit),
      };
      vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce(fakeDevice as any);

      const socket = new MockWebSocket();
      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });

      socket.emit("close");

      expect(unsubscribeVideo).toHaveBeenCalledTimes(1);
      expect(unsubscribeExit).toHaveBeenCalledTimes(1);
    });

    it("stops forwarding video packets once the socket has already closed", async () => {
      const app = await buildTestApp();
      let videoListener: ((pkt: ScrcpyMediaStreamPacket) => void) | undefined;
      const fakeDevice = {
        onVideoPacket: vi.fn((fn) => {
          videoListener = fn;
          return vi.fn();
        }),
        onExit: vi.fn(() => vi.fn()),
      };
      vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce(fakeDevice as any);

      const socket = new MockWebSocket();
      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });

      socket.close();
      videoListener!({ type: "data", keyframe: false, data: new Uint8Array([1]) });

      expect(socket.sentMessages).toHaveLength(0);
    });

    it("logs a warning (and keeps the connection open) when input dispatch throws", async () => {
      const app = await buildTestApp();
      const mockController = {
        resetVideo: vi.fn().mockResolvedValue(undefined),
        injectText: vi.fn().mockRejectedValue(new Error("input failed")),
      };
      const fakeDevice = {
        controller: mockController,
        onVideoPacket: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
      };
      vi.spyOn(app.device, "getOrCreate").mockResolvedValueOnce(fakeDevice as any);
      const warnSpy = vi.spyOn(app.log, "warn");

      const socket = new MockWebSocket();
      await attachSocketToDevice(app, socket as any, {
        deviceId: 1,
        avdName: "dev35",
        label: null,
        port: null,
      });

      socket.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "fail" })), false);

      await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
      expect(socket.readyState).toBe(socket.OPEN);
    });
  });

  describe("real WebSocket upgrade handling", () => {
    it("connects to /ws/device/:id over WebSocket and executes upgrade handler", async () => {
      process.env.DEVICE_ENABLED = "true";
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      const id = created.json().id;

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("bad address");

      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/device/${id}`);
      await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
      expect(ws.readyState).toBe(ws.OPEN);
      ws.close();
      await app.close();
    });

    it("closes socket if row is killed before upgrade handler runs", async () => {
      process.env.DEVICE_ENABLED = "true";
      const app = await buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/devices",
        payload: { avdName: "dev35" },
      });
      const id = created.json().id;

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("bad address");

      // Mark row killed right before connection
      // But simulate TOCTOU by intercepting app.db.select in upgrade handler
      const origSelect = app.db.select.bind(app.db);
      let callCount = 0;
      vi.spyOn(app.db, "select").mockImplementation((...args: any[]) => {
        callCount++;
        // On the second select (inside the upgrade handler), return killed status
        if (callCount >= 2) {
          return {
            from: () => ({
              where: () => ({
                all: () => [{ id, avdName: "dev35", name: null, port: 5554, status: "killed" }],
              }),
            }),
          } as any;
        }
        return origSelect(...args);
      });

      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/device/${id}`);
      await new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
      expect(ws.readyState).toBe(ws.CLOSED);
      await app.close();
    });
  });
});
