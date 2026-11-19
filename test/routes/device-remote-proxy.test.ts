import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { DeviceRow } from "../../src/services/device-store.js";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import type * as DeviceHostModule from "../../src/services/device-host.js";
import type * as DeviceStoreModule from "../../src/services/device-store.js";

// Unit coverage for proxyToRemoteDevice (issue #3200): the primary's relay of a
// device panel socket to the agent that runs the device. Driven against fake
// EventEmitter sockets (same approach as terminal-remote-proxy.test.ts) so the
// open-timeout, the backpressure gate and the close races are deterministic.

class MockSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly CONNECTING = MockSocket.CONNECTING;
  readonly OPEN = MockSocket.OPEN;
  readonly CLOSED = MockSocket.CLOSED;

  readyState: number = MockSocket.OPEN;
  bufferedAmount = 0;
  sendSpy = vi.fn();
  closeSpy = vi.fn();

  send(data: unknown, opts?: unknown) {
    this.sendSpy(data, opts);
  }

  close() {
    this.closeSpy();
    this.readyState = MockSocket.CLOSED;
    this.emit("close");
  }

  open() {
    this.readyState = MockSocket.OPEN;
    this.emit("open");
  }
}

const openSocket = vi.fn();
const getOrCreate = vi.fn();
const getDeviceRowMock = vi.fn();

vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return { ...actual, getRemoteHostClient: vi.fn(() => ({ devices: { openSocket } })) };
});
vi.mock("../../src/services/device-host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DeviceHostModule>();
  return { ...actual, getDeviceHost: vi.fn(() => ({ getOrCreate })) };
});
vi.mock("../../src/services/device-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DeviceStoreModule>();
  return { ...actual, getDeviceRow: (...args: unknown[]) => getDeviceRowMock(...args) };
});

const { proxyToRemoteDevice, attachSocketToDevice, REMOTE_DEVICE_OPEN_TIMEOUT_MS } =
  await import("../../src/routes/device.js");

const OVER = 4 * 1024 * 1024 + 1;
const ROW = {
  id: 7,
  hostId: "agent-1",
  kind: "emulator",
  avdName: "dev35",
  serial: null,
  name: "Pixel",
  port: 5560,
  status: "active",
} as unknown as DeviceRow;

function fakeApp(): FastifyInstance {
  return { log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } } as unknown as FastifyInstance;
}

/** [type][flags][payload]: type 0 = configuration, 1 = data; flags bit0 = keyframe. */
function frame(type: 0 | 1, keyframe: boolean, payload = "x"): Buffer {
  return Buffer.concat([Buffer.from([type, keyframe ? 1 : 0]), Buffer.from(payload)]);
}

const sentFrames = (s: MockSocket) =>
  s.sendSpy.mock.calls
    .filter(([, o]) => (o as { binary?: boolean } | undefined)?.binary)
    .map(([d]) => d as Buffer);

describe("proxyToRemoteDevice (issue #3200)", () => {
  let browser: MockSocket;
  let upstream: MockSocket;

  beforeEach(() => {
    openSocket.mockReset();
    getOrCreate.mockReset().mockResolvedValue({ info: undefined, port: 5560 });
    getDeviceRowMock.mockReset().mockReturnValue(ROW);
    browser = new MockSocket();
    upstream = new MockSocket();
    upstream.readyState = MockSocket.CONNECTING;
    openSocket.mockReturnValue(upstream);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function start() {
    await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
    upstream.open();
  }

  it("get-or-creates the device first, then opens the upstream with the row's identity", async () => {
    await start();
    expect(getOrCreate).toHaveBeenCalledWith(ROW);
    expect(openSocket).toHaveBeenCalledWith("7", {
      kind: "emulator",
      avdName: "dev35",
      label: "Pixel",
      port: "5560",
    });
  });

  it("relays binary and text frames from the agent byte for byte", async () => {
    await start();
    const video = frame(1, true, "h264-bytes");
    upstream.emit("message", video, true);
    const text = Buffer.from('{"type":"clipboard","text":"hi"}');
    upstream.emit("message", text, false);

    expect(browser.sendSpy).toHaveBeenNthCalledWith(1, video, { binary: true });
    expect(browser.sendSpy).toHaveBeenNthCalledWith(2, text, { binary: false });
  });

  it("relays browser messages upstream, but drops them over the cap or while upstream is not open", async () => {
    await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
    const msg = Buffer.from('{"type":"touchDown"}');

    browser.emit("message", msg, false); // still CONNECTING
    expect(upstream.sendSpy).not.toHaveBeenCalled();

    upstream.open();
    browser.emit("message", msg, false);
    expect(upstream.sendSpy).toHaveBeenCalledWith(msg, { binary: false });

    upstream.bufferedAmount = OVER;
    browser.emit("message", msg, false);
    expect(upstream.sendSpy).toHaveBeenCalledTimes(1);

    upstream.bufferedAmount = 0;
    upstream.readyState = MockSocket.CLOSED;
    browser.emit("message", msg, false);
    expect(upstream.sendSpy).toHaveBeenCalledTimes(1);
  });

  describe("backpressure toward the browser", () => {
    it("drops data over the cap, keeps config, then asks for one keyframe and gates deltas until it", async () => {
      await start();
      const config = frame(0, false, "sps");
      const delta1 = frame(1, false, "d1");
      const delta2 = frame(1, false, "d2");
      const key = frame(1, true, "key");
      const delta3 = frame(1, false, "d3");

      browser.bufferedAmount = OVER;
      upstream.emit("message", delta1, true);
      upstream.emit("message", config, true);
      expect(sentFrames(browser)).toEqual([config]);
      expect(upstream.sendSpy).not.toHaveBeenCalled();

      // Backlog clears: a delta is held, and exactly one requestKeyframe goes up.
      browser.bufferedAmount = 0;
      upstream.emit("message", delta2, true);
      upstream.emit("message", delta2, true);
      expect(sentFrames(browser)).toEqual([config]);
      expect(upstream.sendSpy.mock.calls).toEqual([
        [JSON.stringify({ type: "requestKeyframe" }), undefined],
      ]);

      // The keyframe opens the gate; deltas flow again.
      upstream.emit("message", key, true);
      upstream.emit("message", delta3, true);
      expect(sentFrames(browser)).toEqual([config, key, delta3]);
      expect(upstream.sendSpy).toHaveBeenCalledTimes(1);
    });

    it("does not request a keyframe when nothing was dropped", async () => {
      await start();
      upstream.emit("message", frame(1, false), true);
      expect(sentFrames(browser)).toHaveLength(1);
      expect(upstream.sendSpy).not.toHaveBeenCalled();
    });

    it("keeps asking for a keyframe while gated, and stops once one arrives or the socket closes", async () => {
      vi.useFakeTimers();
      await start();
      const requests = () =>
        upstream.sendSpy.mock.calls.filter(
          ([d]) => d === JSON.stringify({ type: "requestKeyframe" }),
        ).length;

      browser.bufferedAmount = OVER;
      upstream.emit("message", frame(1, false), true); // dropped: the gate arms
      browser.bufferedAmount = 0;
      upstream.emit("message", frame(1, false), true); // the first request
      expect(requests()).toBe(1);

      // The request was lost: the proxy asks again on its own, every interval.
      vi.advanceTimersByTime(5000);
      expect(requests()).toBe(2);
      vi.advanceTimersByTime(5000);
      expect(requests()).toBe(3);

      // A keyframe opens the gate and ends the retries.
      upstream.emit("message", frame(1, true), true);
      vi.advanceTimersByTime(20_000);
      expect(requests()).toBe(3);
    });

    it("stops asking when the browser goes away while still gated", async () => {
      vi.useFakeTimers();
      await start();
      browser.bufferedAmount = OVER;
      upstream.emit("message", frame(1, false), true);
      browser.close();
      const before = upstream.sendSpy.mock.calls.length;
      vi.advanceTimersByTime(30_000);
      expect(upstream.sendSpy.mock.calls.length).toBe(before);
    });

    it("drops frames for a browser socket that is no longer open", async () => {
      await start();
      browser.readyState = 2;
      upstream.emit("message", frame(1, true), true);
      expect(browser.sendSpy).not.toHaveBeenCalled();
    });
  });

  describe("teardown", () => {
    it("closing the browser closes the upstream", async () => {
      await start();
      browser.close();
      expect(upstream.closeSpy).toHaveBeenCalledTimes(1);
    });

    it("an upstream close or error closes the browser", async () => {
      await start();
      upstream.emit("close");
      expect(browser.closeSpy).toHaveBeenCalledTimes(1);

      const browser2 = new MockSocket();
      const upstream2 = new MockSocket();
      openSocket.mockReturnValue(upstream2);
      await proxyToRemoteDevice(fakeApp(), browser2 as unknown as WebSocket, ROW);
      upstream2.open();
      upstream2.emit("error", new Error("boom"));
      expect(browser2.closeSpy).toHaveBeenCalledTimes(1);
      // The user is told why, not just disconnected (a refused upgrade lands here).
      expect(JSON.parse(browser2.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: "Host agent-1 did not accept the device socket",
      });
    });

    it("a refused socket says why, like a failed upgrade does (#3273)", async () => {
      // The outbound channel reports a refusal as its own event, not as an
      // error: the panel must be told, not just disconnected.
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      upstream.emit("unexpected-response", { method: "GET" }, { statusCode: 400 });
      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: "Host agent-1 did not accept the device socket",
      });
      expect(browser.closeSpy).toHaveBeenCalled();
    });

    it("a refusal tears the upgrade request down instead of leaving it open (#3273)", async () => {
      // ws aborts its own handshake ONLY when nothing listens for
      // 'unexpected-response': a listener owns the refusal, so the request and
      // its socket must be destroyed here. Left alone they stay open until the
      // agent's keep-alive timeout (72 s), one per refused panel open.
      const destroy = vi.fn();
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      upstream.emit("unexpected-response", { method: "GET" }, { statusCode: 400, destroy });
      expect(destroy).toHaveBeenCalled();
      // And the upstream must not stay in CONNECTING: either side closing
      // closes the other.
      expect(upstream.closeSpy).toHaveBeenCalled();
      expect(upstream.readyState).toBe(MockSocket.CLOSED);
    });

    it("a refusal carries the reason the agent gave (#3273)", async () => {
      // Over the outbound channel the refusal carries the agent's OWN reason —
      // the one its device gating produced.
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      upstream.emit(
        "unexpected-response",
        { method: "GET" },
        {
          statusCode: 400,
          statusMessage: "Device panel is disabled — set DEVICE_ENABLED=true.",
        },
      );
      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message:
          "Host agent-1 did not accept the device socket: Device panel is disabled — set DEVICE_ENABLED=true.",
      });
    });

    it("an HTTP refusal's status phrase is not a reason, but a 404 names the old agent (#3273)", async () => {
      // The inbound transport answers with the plain HTTP reason phrase, which
      // tells the user nothing they can act on.
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      upstream.emit(
        "unexpected-response",
        { method: "GET" },
        {
          statusCode: 400,
          statusMessage: "Bad Request",
        },
      );
      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: "Host agent-1 did not accept the device socket",
      });

      // A 404 means the agent does not know the device socket at all: it is
      // too old, and the panel says so.
      const browser2 = new MockSocket();
      const upstream2 = new MockSocket();
      upstream2.readyState = MockSocket.CONNECTING;
      openSocket.mockReturnValue(upstream2);
      await proxyToRemoteDevice(fakeApp(), browser2 as unknown as WebSocket, ROW);
      upstream2.emit(
        "unexpected-response",
        { method: "GET" },
        {
          statusCode: 404,
          statusMessage: "unknown stream",
        },
      );
      expect(JSON.parse(browser2.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: "Host agent-1 does not support the device socket — update its agent",
      });
    });

    it("reports a refusal once: the teardown error that follows is not a second failure", async () => {
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      upstream.emit(
        "unexpected-response",
        { method: "GET" },
        {
          statusCode: 400,
          statusMessage: "kind must be emulator or physical",
        },
      );
      // Closing the upstream makes ws emit an error of its own; the refusal
      // was already reported, with the agent's reason.
      upstream.emit(
        "error",
        new Error("WebSocket was closed before the connection was established"),
      );
      const frames = browser.sendSpy.mock.calls.filter(([d]) => typeof d === "string");
      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0]![0] as string)).toEqual({
        type: "error",
        message: "Host agent-1 did not accept the device socket: kind must be emulator or physical",
      });
    });

    it("tolerates a browser socket error without throwing", async () => {
      await start();
      expect(() => browser.emit("error", new Error("reset"))).not.toThrow();
    });
  });

  describe("failures before the relay is wired", () => {
    it("reports a rejecting getOrCreate to the browser and opens no upstream", async () => {
      getOrCreate.mockRejectedValue(new Error("Scope dead"));
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);

      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: "Scope dead",
      });
      expect(browser.closeSpy).toHaveBeenCalledTimes(1);
      expect(openSocket).not.toHaveBeenCalled();
    });

    it("opens no upstream when the browser closed while getOrCreate was pending", async () => {
      getOrCreate.mockImplementation(async () => {
        browser.readyState = MockSocket.CLOSED;
        return { info: undefined, port: null };
      });
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      expect(openSocket).not.toHaveBeenCalled();
      expect(browser.sendSpy).not.toHaveBeenCalled();
    });

    it("answers an upgrade that throws synchronously as an unreachable host", async () => {
      openSocket.mockImplementation(() => {
        throw new Error("nope");
      });
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: "Host agent-1 is unreachable",
      });
      expect(browser.closeSpy).toHaveBeenCalledTimes(1);
    });

    it("closes the upstream and sends an error when it never opens in time", async () => {
      vi.useFakeTimers();
      // A real ws aborting a handshake emits "close" asynchronously, after the
      // proxy has sent its error frame; keep that ordering here.
      upstream.close = () => {
        upstream.closeSpy();
        upstream.readyState = MockSocket.CLOSED;
        process.nextTick(() => upstream.emit("close"));
      };
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_OPEN_TIMEOUT_MS - 1);
      expect(upstream.closeSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(upstream.closeSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: "Host agent-1 did not answer in time",
      });
    });

    it("does not time out once the upstream opened", async () => {
      vi.useFakeTimers();
      await start();
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_OPEN_TIMEOUT_MS * 2);
      expect(upstream.closeSpy).not.toHaveBeenCalled();
      expect(browser.closeSpy).not.toHaveBeenCalled();
    });
  });
});

describe("attachSocketToDevice on the agent: the proxy's keyframe request", () => {
  it("asks the driver for a keyframe on a requestKeyframe message and never treats it as input", async () => {
    const driver = {
      hasLiveControl: true,
      requestKeyframe: vi.fn().mockResolvedValue(undefined),
      input: vi.fn().mockResolvedValue(undefined),
      onVideoPacket: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      onClipboard: vi.fn(() => vi.fn()),
    };
    const app = {
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      device: { getOrCreateDriver: vi.fn().mockResolvedValue(driver) },
    } as unknown as FastifyInstance;
    const socket = new MockSocket();

    await attachSocketToDevice(app, socket as unknown as WebSocket, {
      deviceId: 7,
      kind: "emulator",
      avdName: "dev35",
      serial: null,
      label: null,
      port: null,
    });
    expect(driver.requestKeyframe).toHaveBeenCalledTimes(1); // the attach-time one

    socket.emit("message", Buffer.from('{"type":"requestKeyframe"}'), false);
    expect(driver.requestKeyframe).toHaveBeenCalledTimes(2);
    expect(driver.input).not.toHaveBeenCalled();
    socket.emit("close");
  });
});
