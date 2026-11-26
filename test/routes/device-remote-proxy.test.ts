import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
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
const deviceInfo = vi.fn();
const getDeviceRowMock = vi.fn();

vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return { ...actual, getRemoteHostClient: vi.fn(() => ({ devices: { openSocket } })) };
});
vi.mock("../../src/services/device-host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DeviceHostModule>();
  return { ...actual, getDeviceHost: vi.fn(() => ({ getOrCreate, info: deviceInfo })) };
});
vi.mock("../../src/services/device-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DeviceStoreModule>();
  return { ...actual, getDeviceRow: (...args: unknown[]) => getDeviceRowMock(...args) };
});

const {
  proxyToRemoteDevice,
  attachSocketToDevice,
  REMOTE_DEVICE_OPEN_TIMEOUT_MS,
  REMOTE_DEVICE_START_TIMEOUT_MS,
  REMOTE_DEVICE_VIDEO_TIMEOUT_MS,
  REMOTE_DEVICE_STATUS_TIMEOUT_MS,
  REMOTE_DEVICE_SECOND_CHANCE_MS,
  REMOTE_DEVICE_BOOT_GRACE_MS,
  REFUSAL_BODY_TIMEOUT_MS,
} = await import("../../src/routes/device.js");

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

/** A real HTTP refusal, as `ws` hands it over: the body is unread. */
function httpRefusal(body: string): IncomingMessage {
  const socket = new Socket();
  const res = new IncomingMessage(socket);
  res.statusCode = 400;
  res.statusMessage = "Bad Request";
  res.push(body);
  res.push(null);
  return res;
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
    deviceInfo.mockReset().mockResolvedValue({ id: "7", status: "streaming", error: null });
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

    it("a refusal with no reason of its own falls back to the generic message, but a 404 names the old agent (#3273)", async () => {
      // The HTTP reason phrase ("Bad Request") tells the user nothing they
      // can act on, so it is dropped.
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

    it("an HTTP refusal's body carries the agent's reason (#3273)", async () => {
      // The inbound transport answers with Fastify's error body, whose
      // `message` is the agent's own reason — the same text the channel's
      // accept head carries in its message.
      const res = httpRefusal(
        JSON.stringify({
          statusCode: 400,
          error: "Bad Request",
          message: "Device panel is disabled — set DEVICE_ENABLED=true.",
        }),
      );
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      upstream.emit("unexpected-response", { method: "GET" }, res);
      await vi.waitFor(() => expect(browser.sendSpy).toHaveBeenCalled());
      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message:
          "Host agent-1 did not accept the device socket: Device panel is disabled — set DEVICE_ENABLED=true.",
      });
      // The upgrade request is still torn down, not left open.
      expect(upstream.closeSpy).toHaveBeenCalled();
    });

    it("a refusal body that is no reason leaves the generic message (#3273)", async () => {
      // A body that is not the agent's reason (not JSON, no message) is
      // dropped: the panel is told the refusal, not a guess.
      for (const body of ["not json", "{}", '{"message":42}', '{"message":"  "}']) {
        const panel = new MockSocket();
        const sock = new MockSocket();
        sock.readyState = MockSocket.CONNECTING;
        openSocket.mockReturnValue(sock);
        await proxyToRemoteDevice(fakeApp(), panel as unknown as WebSocket, ROW);
        sock.emit("unexpected-response", { method: "GET" }, httpRefusal(body));
        await vi.waitFor(() => expect(panel.sendSpy).toHaveBeenCalled());
        expect(JSON.parse(panel.sendSpy.mock.calls[0][0] as string)).toEqual({
          type: "error",
          message: "Host agent-1 did not accept the device socket",
        });
      }
    });

    it("a refusal whose body never arrives is still reported (#3273)", async () => {
      vi.useFakeTimers();
      // The body rides the same response as the status, so it is normally
      // there already; an agent that stalls must not leave the panel hanging.
      const res = new IncomingMessage(new Socket());
      res.statusCode = 400;
      res.statusMessage = "Bad Request";
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      upstream.emit("unexpected-response", { method: "GET" }, res);
      await vi.advanceTimersByTimeAsync(REFUSAL_BODY_TIMEOUT_MS);
      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: "Host agent-1 did not accept the device socket",
      });
      expect(upstream.closeSpy).toHaveBeenCalled();
    });

    it("a refusal body that errors is reported without a reason (#3273)", async () => {
      const res = httpRefusal("{}");
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      upstream.emit("unexpected-response", { method: "GET" }, res);
      res.destroy(new Error("socket hang up"));
      await vi.waitFor(() => expect(browser.sendSpy).toHaveBeenCalled());
      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: "Host agent-1 did not accept the device socket",
      });
    });

    it("a reason too long for the panel is cut (#3273)", async () => {
      const res = httpRefusal(JSON.stringify({ message: "x".repeat(600) }));
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      upstream.emit("unexpected-response", { method: "GET" }, res);
      await vi.waitFor(() => expect(browser.sendSpy).toHaveBeenCalled());
      expect(JSON.parse(browser.sendSpy.mock.calls[0][0] as string)).toEqual({
        type: "error",
        message: `Host agent-1 did not accept the device socket: ${"x".repeat(500)}…`,
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

    it("does not time out once the upstream opened and sent a keyframe", async () => {
      vi.useFakeTimers();
      await start();
      upstream.emit("message", frame(1, true), true);
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_BOOT_GRACE_MS * 2);
      expect(upstream.closeSpy).not.toHaveBeenCalled();
      expect(browser.closeSpy).not.toHaveBeenCalled();
      expect(deviceInfo).not.toHaveBeenCalled();
    });
  });

  // Issue #3526: no step of the relay may hang silently.
  describe("bounded relay steps (#3526)", () => {
    const textSent = (s: MockSocket) =>
      s.sendSpy.mock.calls
        .filter(([, o]) => !(o as { binary?: boolean } | undefined)?.binary)
        .map(([d]) => JSON.parse(d as string) as { type: string; message: string });

    it("fails the panel with a reason when getOrCreate never settles", async () => {
      vi.useFakeTimers();
      getOrCreate.mockReturnValue(new Promise(() => undefined));
      const app = fakeApp();
      const run = proxyToRemoteDevice(app, browser as unknown as WebSocket, ROW);
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_START_TIMEOUT_MS - 1);
      expect(browser.sendSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(textSent(browser)).toEqual([
        { type: "error", message: "Host agent-1 did not start device 7 in time" },
      ]);
      expect(browser.closeSpy).toHaveBeenCalledTimes(1);
      expect(openSocket).not.toHaveBeenCalled();
      expect(app.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "agent-1", deviceId: 7 }),
        "remote device did not start in time for its socket",
      );
    });

    it("logs the early return when the panel left while getOrCreate was pending", async () => {
      getOrCreate.mockImplementation(async () => {
        browser.readyState = MockSocket.CLOSED;
        return { info: undefined, port: null };
      });
      const app = fakeApp();
      await proxyToRemoteDevice(app, browser as unknown as WebSocket, ROW);
      expect(app.log.warn).toHaveBeenCalledWith(
        { hostId: "agent-1", deviceId: 7 },
        "device panel socket closed before the relay opened",
      );
    });

    it("tells the panel the reason when the upstream never opens, before closing it", async () => {
      vi.useFakeTimers();
      // A ChannelSocket in CONNECTING emits "close" synchronously from close().
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_OPEN_TIMEOUT_MS);
      expect(textSent(browser)).toEqual([
        { type: "error", message: "Host agent-1 did not answer in time" },
      ]);
    });

    it("asks why when an opened upstream sends no keyframe, and fails the panel", async () => {
      vi.useFakeTimers();
      const app = fakeApp();
      await proxyToRemoteDevice(app, browser as unknown as WebSocket, ROW);
      upstream.open();
      // A configuration packet alone is no video.
      upstream.emit("message", frame(0, false), true);
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_VIDEO_TIMEOUT_MS - 1);
      expect(deviceInfo).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(deviceInfo).toHaveBeenCalledWith(7);
      // One more chance: a keyframe is asked for, and the status checked again.
      expect(textSent(upstream)).toEqual([{ type: "requestKeyframe" }]);
      expect(textSent(browser)).toEqual([]);
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_SECOND_CHANCE_MS);
      expect(deviceInfo).toHaveBeenCalledTimes(2);
      expect(textSent(browser)).toEqual([
        {
          type: "error",
          message: "Host agent-1 reports device 7 streaming but sent this panel no video",
        },
      ]);
      expect(browser.closeSpy).toHaveBeenCalled();
      expect(upstream.closeSpy).toHaveBeenCalled();
      expect(app.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "agent-1", deviceId: 7, status: "streaming" }),
        "remote device ws upstream sent no video in time",
      );
    });

    it("keeps a booting device's panel waiting, within the boot grace", async () => {
      vi.useFakeTimers();
      deviceInfo.mockResolvedValue({ id: "7", status: "booting", error: null });
      const app = fakeApp();
      await proxyToRemoteDevice(app, browser as unknown as WebSocket, ROW);
      upstream.open();
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_VIDEO_TIMEOUT_MS * 3);
      expect(deviceInfo).toHaveBeenCalledTimes(3);
      // Warned once; the rechecks are info.
      const booting = "remote device still starting; its panel keeps waiting for video";
      expect(vi.mocked(app.log.warn).mock.calls.filter(([, m]) => m === booting)).toHaveLength(1);
      expect(vi.mocked(app.log.info).mock.calls.filter(([, m]) => m === booting)).toHaveLength(2);
      expect(browser.closeSpy).not.toHaveBeenCalled();
      // Video arrives: no further checks.
      upstream.emit("message", frame(1, true), true);
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_VIDEO_TIMEOUT_MS * 3);
      expect(deviceInfo).toHaveBeenCalledTimes(3);
      expect(browser.closeSpy).not.toHaveBeenCalled();
    });

    it("gives up on a device still booting past the boot grace", async () => {
      vi.useFakeTimers();
      deviceInfo.mockResolvedValue({ id: "7", status: "starting", error: null });
      await start();
      await vi.advanceTimersByTimeAsync(
        REMOTE_DEVICE_BOOT_GRACE_MS + REMOTE_DEVICE_VIDEO_TIMEOUT_MS,
      );
      expect(textSent(browser)).toEqual([
        {
          type: "error",
          message: `Device 7 on host agent-1 is still starting after ${REMOTE_DEVICE_BOOT_GRACE_MS / 1000} s`,
        },
      ]);
    });

    it("keeps the panel when the second chance brings a keyframe (a recovering stream)", async () => {
      vi.useFakeTimers();
      deviceInfo.mockResolvedValue({ id: "7", status: "error", error: "reopening" });
      await start();
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_VIDEO_TIMEOUT_MS);
      upstream.emit("message", frame(1, true), true);
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_SECOND_CHANCE_MS * 2);
      expect(deviceInfo).toHaveBeenCalledTimes(1);
      expect(textSent(browser)).toEqual([]);
      expect(browser.closeSpy).not.toHaveBeenCalled();
    });

    it("measures the video deadline from the upstream's open, not the panel's arrival", async () => {
      vi.useFakeTimers();
      await proxyToRemoteDevice(fakeApp(), browser as unknown as WebSocket, ROW);
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_OPEN_TIMEOUT_MS - 1);
      upstream.open();
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_VIDEO_TIMEOUT_MS - 1);
      expect(deviceInfo).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(deviceInfo).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        { id: "7", status: "error", error: "idb failed" },
        "Device 7 on host agent-1 failed: idb failed",
      ],
      [{ id: "7", status: "exited", error: null }, "Device 7 on host agent-1 has exited"],
      [undefined, "Host agent-1 is not running device 7"],
    ])("names the device's state %j when there is no video", async (info, message) => {
      vi.useFakeTimers();
      deviceInfo.mockResolvedValue(info);
      await start();
      await vi.advanceTimersByTimeAsync(
        REMOTE_DEVICE_VIDEO_TIMEOUT_MS + REMOTE_DEVICE_SECOND_CHANCE_MS,
      );
      expect(textSent(browser)).toEqual([{ type: "error", message }]);
    });

    it("bounds a status check that never answers", async () => {
      vi.useFakeTimers();
      deviceInfo.mockReturnValue(new Promise(() => undefined));
      await start();
      await vi.advanceTimersByTimeAsync(
        REMOTE_DEVICE_VIDEO_TIMEOUT_MS + REMOTE_DEVICE_STATUS_TIMEOUT_MS,
      );
      expect(textSent(browser)).toEqual([
        {
          type: "error",
          message: "Host agent-1 sent no video for device 7 and did not answer a status check",
        },
      ]);
    });

    it("does not report a panel that left while the status check ran", async () => {
      vi.useFakeTimers();
      let answer: (v: unknown) => void = () => undefined;
      deviceInfo.mockReturnValue(new Promise((r) => (answer = r)));
      await start();
      await vi.advanceTimersByTimeAsync(REMOTE_DEVICE_VIDEO_TIMEOUT_MS);
      browser.close();
      answer({ id: "7", status: "streaming", error: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(textSent(browser)).toEqual([]);
    });

    it.each([
      [false, "Host agent-1 closed the device socket before accepting it"],
      [true, "Host agent-1 closed the device socket before sending video"],
    ])("reports an upstream closed without video (opened: %s)", async (opened, message) => {
      const app = fakeApp();
      await proxyToRemoteDevice(app, browser as unknown as WebSocket, ROW);
      if (opened) upstream.open();
      upstream.close();
      expect(textSent(browser)).toEqual([{ type: "error", message }]);
      expect(app.log.warn).toHaveBeenCalledWith(
        { hostId: "agent-1", deviceId: 7, opened },
        "remote device ws upstream closed before any video",
      );
    });

    it("closes the panel without an error when the upstream ends after video", async () => {
      await start();
      upstream.emit("message", frame(1, true), true);
      upstream.close();
      expect(textSent(browser)).toEqual([]);
      expect(browser.closeSpy).toHaveBeenCalled();
    });

    it("logs and closes an upstream that opens after the panel left", async () => {
      const app = fakeApp();
      await proxyToRemoteDevice(app, browser as unknown as WebSocket, ROW);
      browser.readyState = MockSocket.CLOSED;
      upstream.open();
      expect(upstream.closeSpy).toHaveBeenCalled();
      expect(app.log.info).toHaveBeenCalledWith(
        { hostId: "agent-1", deviceId: 7 },
        "device panel socket closed before its upstream opened",
      );
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
